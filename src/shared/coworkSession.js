'use strict';

// Reads Claude Cowork (the agent/agent-mode feature of the Claude Desktop app)
// token usage from its local transcripts.
//
// Cowork runs an embedded Claude Code inside a per-session sandbox. Each sandbox
// writes standard Claude-Code-format JSONL transcripts:
//   type:"assistant" lines carry message.model + message.usage
//   ({input_tokens, output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens}) — the exact shape tokscale already parses for the
//   standalone Claude Code client.
//
// On Windows the Claude Desktop app is an MSIX package, so its data lives under
// %LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\Claude\
//   local-agent-mode-sessions\<session>\<workspace>\local_<vm>\...\
//     .claude\projects\<encoded-path>\<id>.jsonl   (per-project transcripts)
//     audit.jsonl                                   (per-workspace audit stream)
//
// tokscale does NOT scan these sandboxed paths (it only reads ~/.claude/projects),
// so Cowork usage is invisible unless read natively here — same situation as ZCode.
// audit.jsonl is the most reliable single stream (one per workspace, always
// appended), so we read every *.jsonl under the discovered roots.
//
// Output shape matches ./usage emptyPeriod() + the merge in ./collector.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Cowork runs an embedded Claude Code, so its tokens are the SAME Claude models
// as the standalone client (e.g. claude-opus-4-8). We attribute them to the
// `claude` client (NOT a separate `cowork` client) so the dashboard merges
// Claude Code + Cowork into a single `claude` tool row and a single
// `claude-opus-4-8` model row — matching how users think about it. The
// `cowork` identifier is only used as an internal key for the watch/merge wiring.
const COWORK_CLIENT = 'claude';

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------
// Resolve the Claude Desktop data root. Windows MSIX stores it under the package
// family dir; the non-MSIX installer (and macOS) use the plain Roaming dir.
function resolveClaudeDataRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const roots = [];
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    // MSIX package family dir: Packages\Claude_<publisher-hash>
    const packagesDir = path.join(localAppData, 'Packages');
    try {
      for (const entry of fs.readdirSync(packagesDir)) {
        if (/^Claude_/i.test(entry)) roots.push(path.join(packagesDir, entry, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch (_) { /* Packages dir absent */ }
    // Non-MSIX installer layout
    roots.push(path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    roots.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  }
  return roots;
}

function sessionsRoots(deps = {}) {
  const env = deps.env || process.env;
  const out = [];
  for (const root of resolveClaudeDataRoots(env)) {
    out.push(path.join(root, 'local-agent-mode-sessions'));
  }
  return out;
}

// Recursively collect every *.jsonl under the Cowork sessions roots. Each Cowork
// workspace fans out into deeply-nested per-session / per-vm sandboxes; walking
// the whole tree once per tick is cheap relative to parsing the (large) files.
function discoverTranscriptFiles(deps = {}) {
  const files = [];
  const seen = new Set();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (!seen.has(full)) { seen.add(full); files.push(full); }
      }
    }
  }
  for (const root of sessionsRoots(deps)) walk(root);
  return files;
}

function dataDirPresent(deps = {}) {
  return sessionsRoots(deps).some((dir) => { try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; } });
}

// ---------------------------------------------------------------------------
// Numbers / timestamps / periods
// ---------------------------------------------------------------------------
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptyPeriod() {
  return {
    totalTokens: 0,
    costUsd: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    clients: {},
    clientCosts: {},
    clientCacheReads: {},
    clientCacheWrites: {},
    clientOutputs: {},
    models: {},
    modelCosts: {},
    modelCacheReads: {},
    modelCacheWrites: {},
    modelOutputs: {},
    clientModels: {},
    clientModelCosts: {},
    sessions: {}
  };
}

// Local wall-clock boundaries — see zcodeSession.js for rationale. The collector
// buckets today/month in the device's own timezone (localTodayKey /
// computePeriodWindows, tokscale --today), so Cowork must match or its periods
// drift from the rest of the dashboard around the UTC-midnight boundary.
function localDayBoundsMs(nowMs) {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { startMs: start, endMs: start + 24 * 60 * 60 * 1000 };
}
function localMonthBoundsMs(nowMs) {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { startMs: start, endMs: end };
}
// Local 'YYYY-MM-DD' for a timestamp — matches collector's localTodayKey shape.
function localDateKeyFromMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function msFromIso(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

// Normalize model id (Claude Code/Cowork already stores bare ids like
// "claude-opus-4-8"; keep as-is, lowercased for stable breakdown keys).
function normalizeModel(modelId) {
  return String(modelId || '').trim() || 'claude-unknown';
}

// Cost for one usage record from a per-million pricing map (same convention as
// zcodeSession — Cowork transcripts carry no cost field either).
function costForUsage(usage, model, pricing) {
  if (!pricing) return 0;
  const p = pricing[model];
  if (!p) return 0;
  const perM = 1e6;
  let cost = 0;
  if (p.inputPerM) cost += (num(usage.input_tokens) / perM) * p.inputPerM;
  if (p.outputPerM) cost += (num(usage.output_tokens) / perM) * p.outputPerM;
  if (p.cacheReadPerM) cost += (num(usage.cache_read_input_tokens) / perM) * p.cacheReadPerM;
  return cost;
}

// ---------------------------------------------------------------------------
// Per-record accumulation
// ---------------------------------------------------------------------------
// Each transcript line is one assistant turn with a usage block. A "row" is the
// neutral shape consumed by addRowInto (mirrors zcodeSession).
function rowFromAssistantLine(obj, file) {
  const message = obj.message || {};
  const usage = message.usage || {};
  return {
    client: COWORK_CLIENT,
    sessionId: String(obj.sessionId || path.basename(file, '.jsonl') || 'cowork-session'),
    model: normalizeModel(message.model),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    totalTokens: 0, // computed below (input + output + cacheRead + cacheWrite)
    costUsd: 0,    // computed from pricing in addRowInto
    timestamp: obj.timestamp || '',
    completedAtMs: msFromIso(obj.timestamp)
  };
}

function addRowInto(period, row, pricing) {
  const model = row.model;
  const input = num(row.inputTokens);
  const output = num(row.outputTokens);
  const cacheRead = num(row.cacheReadTokens);
  const cacheWrite = num(row.cacheWriteTokens);
  const total = input + output + cacheRead + cacheWrite;
  const cost = num(row.costUsd) || costForUsage({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead }, model, pricing);
  if (total <= 0 && cost <= 0) return;

  period.totalTokens += total;
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;

  period.clients[COWORK_CLIENT] = (period.clients[COWORK_CLIENT] || 0) + total;
  if (cacheRead > 0) period.clientCacheReads[COWORK_CLIENT] = (period.clientCacheReads[COWORK_CLIENT] || 0) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[COWORK_CLIENT] = (period.clientCacheWrites[COWORK_CLIENT] || 0) + cacheWrite;
  if (output > 0) period.clientOutputs[COWORK_CLIENT] = (period.clientOutputs[COWORK_CLIENT] || 0) + output;
  if (cost > 0) period.clientCosts[COWORK_CLIENT] = (period.clientCosts[COWORK_CLIENT] || 0) + cost;

  period.models[model] = (period.models[model] || 0) + total;
  if (cacheRead > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cacheRead;
  if (cacheWrite > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cacheWrite;
  if (output > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + output;
  if (cost > 0) period.modelCosts[model] = (period.modelCosts[model] || 0) + cost;

  if (!period.clientModels[COWORK_CLIENT]) period.clientModels[COWORK_CLIENT] = {};
  period.clientModels[COWORK_CLIENT][model] = (period.clientModels[COWORK_CLIENT][model] || 0) + total;
  if (!period.clientModelCosts[COWORK_CLIENT]) period.clientModelCosts[COWORK_CLIENT] = {};
  if (cost > 0) period.clientModelCosts[COWORK_CLIENT][model] = (period.clientModelCosts[COWORK_CLIENT][model] || 0) + cost;

  const key = `${COWORK_CLIENT}:${row.sessionId}`;
  const session = period.sessions[key] || {
    client: COWORK_CLIENT, sessionId: row.sessionId,
    totalTokens: 0, costUsd: 0, messageCount: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    startedAt: row.timestamp || '', lastUsedAt: row.timestamp || '',
    models: {}, modelCosts: {}, providers: {}
  };
  session.totalTokens += total;
  session.costUsd += cost;
  session.inputTokens += input;
  session.outputTokens += output;
  session.cacheReadTokens += cacheRead;
  session.cacheWriteTokens += cacheWrite;
  session.messageCount += 1;
  session.models[model] = (session.models[model] || 0) + total;
  if (cost > 0) session.modelCosts[model] = (session.modelCosts[model] || 0) + cost;
  if (row.timestamp) {
    if (!session.lastUsedAt || row.timestamp > session.lastUsedAt) session.lastUsedAt = row.timestamp;
    if (!session.startedAt || row.timestamp < session.startedAt) session.startedAt = row.timestamp;
  }
  period.sessions[key] = session;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Read all assistant usage records across every Cowork transcript file. `deps`
// lets tests inject the file list + a line reader.
function readUsageRows(deps = {}) {
  const files = deps.files || discoverTranscriptFiles(deps);
  const rows = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch (_) { continue; }
      if (!obj || obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
      rows.push(rowFromAssistantLine(obj, file));
    }
  }
  return rows;
}

function collectCoworkUsage(options = {}) {
  const deps = options.deps || {};
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const allTimeSinceMs = msFromIso(options.allTimeSince || '2024-01-01') || Date.UTC(2024, 0, 1);
  const pricing = options.pricing || null;

  const today = emptyPeriod();
  const month = emptyPeriod();
  const allTime = emptyPeriod();

  const day = localDayBoundsMs(nowMs);
  const mon = localMonthBoundsMs(nowMs);

  const rows = (deps.readUsageRows || readUsageRows)(deps);
  for (const row of rows) {
    const ts = row.completedAtMs || msFromIso(row.timestamp);
    if (!ts) continue;
    if (ts >= day.startMs && ts < day.endMs) addRowInto(today, row, pricing);
    if (ts >= mon.startMs && ts < mon.endMs) addRowInto(month, row, pricing);
    if (ts >= allTimeSinceMs) addRowInto(allTime, row, pricing);
  }
  return { today, month, allTime };
}

// Build a tokscale-graph-shaped {contributions, timeMetrics} from Cowork's
// transcripts, so the dashboard's trends/history (which reads tokscale graph)
// can include Cowork's contribution. tokscale's graph never sees Cowork (it
// scans ~/.claude/projects, not the Cowork sandbox), so without this the
// dashboard's lifetime total undercounts vs. the homepage period total.
// Each contribution row is one day; Cowork is attributed to the `claude`
// client (matching collectCoworkUsage) so it merges into Claude's stack.
function buildCoworkHistoryGraph(options = {}) {
  const deps = options.deps || {};
  const allTimeSinceMs = msFromIso(options.allTimeSince || '2024-01-01') || Date.UTC(2024, 0, 1);
  const rows = (deps.readUsageRows || readUsageRows)(deps);
  const byDay = new Map(); // 'YYYY-MM-DD' -> { tokens, cost }
  for (const row of rows) {
    const ts = row.completedAtMs || msFromIso(row.timestamp);
    if (!ts || ts < allTimeSinceMs) continue;
    // Cowork is standard Claude format (input EXCLUDES cache), so the total is
    // input + output + cacheRead + cacheWrite — matching addRowInto above. Do NOT
    // apply the zcode cache-inclusive shortcut here (that undercounts by ~all the cache).
    const input = num(row.inputTokens);
    const output = num(row.outputTokens);
    const cacheRead = num(row.cacheReadTokens);
    const cacheWrite = num(row.cacheWriteTokens);
    const total = input + output + cacheRead + cacheWrite;
    if (total <= 0) continue;
    // Local-date key, matching the todayKey the collector injects into the
    // merged history (localTodayKey) and every other client's day bucket.
    // Using UTC here (toISOString) would slide Cowork's contribution one day
    // off the dashboard's "today" near the UTC-midnight boundary.
    const day = localDateKeyFromMs(ts);
    let d = byDay.get(day);
    if (!d) { d = { tokens: 0, cost: 0 }; byDay.set(day, d); }
    d.tokens += total;
    d.cost += num(row.costUsd);
  }
  const contributions = [];
  for (const [date, d] of byDay) {
    contributions.push({
      date,
      totals: { tokens: d.tokens, cost: d.cost },
      tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      clients: [{ client: 'claude', modelId: 'cowork', tokens: { totalTokens: d.tokens }, cost: d.cost, messages: 0 }]
    });
  }
  contributions.sort((a, b) => a.date < b.date ? -1 : 1);
  return { contributions };
}

module.exports = {
  COWORK_CLIENT,
  buildCoworkHistoryGraph,
  collectCoworkUsage,
  dataDirPresent,
  discoverTranscriptFiles,
  readUsageRows,
  resolveClaudeDataRoots,
  sessionsRoots
};
