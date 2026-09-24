'use strict';

// Reads ZCode token usage directly from the agent's own local store.
//
// ZCode persists per-LLM-call usage in a SQLite database at
//   ~/.zcode/cli/db/db.sqlite  (table `model_usage`)
// and as append-only JSONL "rollout" files at
//   ~/.zcode/cli/rollout/model-io-sess_*.jsonl  (one line per request)
//
// The DB is the authoritative, structured source (pre-aggregated per model call
// with input/output/reasoning/cache tokens + provider/model/session/timestamp),
// so we read it first. The JSONL rollout is a fallback for when the DB can't be
// opened (e.g. older ZCode builds). Either way we emit the neutral period shape
// produced by ./usage (emptyPeriod() + clients/models/clientModels/sessions maps)
// so the collector merges us exactly like a tokscale scan — see mergePeriods().
//
// This mirrors the discovery + read-only node:sqlite + deps-seam pattern used by
// ./opencodeLimits and ./opencodeSession (the only other DB-reading clients).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const ZCODE_CLIENT = 'zcode';

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------
// ZCODE_HOME points at the `.zcode` data root itself (so tests can stage a
// throwaway tree); when unset it defaults to ~/.zcode, matching ZCode's real
// install layout. The CLI runtime lives under <root>/cli.
function resolveDataDir(env = process.env) {
  const root = env.ZCODE_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.zcode');
  return path.join(root, 'cli');
}

function resolveDbDir(env = process.env) {
  return path.join(resolveDataDir(env), 'db');
}

function resolveRolloutDir(env = process.env) {
  return path.join(resolveDataDir(env), 'rollout');
}

function discoverDbPaths(deps = {}) {
  const env = deps.env || process.env;
  const override = String(env.ZCODE_DB || '').trim();
  if (override) {
    try { if (fs.statSync(override).isFile()) return [override]; } catch (_) { /* fall through */ }
  }
  const dir = resolveDbDir(env);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  // db.sqlite, plus any channel variants like db-<channel>.sqlite.
  return entries
    .filter((name) => /(^db)(-[A-Za-z0-9._-]+)?\.sqlite$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function discoverRolloutFiles(deps = {}) {
  const dir = resolveRolloutDir(deps.env || process.env);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  return entries
    .filter((name) => /^model-io-.*\.jsonl$/.test(name))
    .map((name) => path.join(dir, name));
}

function dataDirPresent(deps = {}) {
  return discoverDbPaths(deps).length > 0 || discoverRolloutFiles(deps).length > 0;
}

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 250');
  return db;
}

// ---------------------------------------------------------------------------
// Numbers / timestamps
// ---------------------------------------------------------------------------
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString();
}

function msFromIso(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

// UTC boundaries, matching how usage.js buckets periods (utcDayKey/utcMonthKey).
function utcDayBoundsMs(nowMs) {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { startMs: start, endMs: start + 24 * 60 * 60 * 1000 };
}
function utcMonthBoundsMs(nowMs) {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { startMs: start, endMs: end };
}

// ---------------------------------------------------------------------------
// Period construction (shape matches ./usage emptyPeriod())
// ---------------------------------------------------------------------------
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

// The canonical ZCode model id (e.g. "builtin:bigmodel-coding-plan/GLM-5.2")
// carries a provider prefix that is noisy on the dashboard. Surface the bare
// model id ("GLM-5.2"); keep the raw one out of the breakdown keys.
function normalizeModel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return 'zcode-unknown';
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

// Cost for one usage row, from a custom-pricing map keyed by model id. Pricing
// values are per-million tokens (same convention as the custom-pricing UI and
// tokscale's custom-pricing.json). ZCode's model_usage table carries no cost, so
// without this the GLM-5.2 etc. rows would always show $0 — unlike tokscale,
// ZCode is read natively and never sees tokscale's pricing file. Returns 0 when
// no pricing is configured for the model.
function costForRow(row, model, pricing) {
  if (!pricing) return 0;
  const p = pricing[model];
  if (!p) return 0;
  const perM = 1e6;
  let cost = 0;
  if (p.inputPerM) cost += (num(row.inputTokens) / perM) * p.inputPerM;
  if (p.outputPerM) cost += (num(row.outputTokens) / perM) * p.outputPerM;
  if (p.cacheReadPerM) cost += (num(row.cacheReadTokens) / perM) * p.cacheReadPerM;
  return cost;
}

// Accumulates a single usage row into a period, mirroring the additive logic in
// usage.js extractUsageFromTokscale (input + output + cacheRead + cacheWrite
// = total; reasoning is informational and already a subset of output).
function addRowInto(period, row, sessionId, pricing) {
  const model = normalizeModel(row.model);
  // Prefer the provider's total; fall back to the sum of components.
  const input = num(row.inputTokens);
  const output = num(row.outputTokens);
  const cacheRead = num(row.cacheReadTokens);
  const cacheWrite = num(row.cacheWriteTokens);
  const total = num(row.totalTokens) || (input + output + cacheRead + cacheWrite);
  // ZCode rows carry no cost; derive it from the custom-pricing map (if any).
  const cost = num(row.costUsd) || costForRow(row, model, pricing);
  if (total <= 0 && cost <= 0) return;

  period.totalTokens += total;
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;

  period.clients[ZCODE_CLIENT] = (period.clients[ZCODE_CLIENT] || 0) + total;
  if (cacheRead > 0) period.clientCacheReads[ZCODE_CLIENT] = (period.clientCacheReads[ZCODE_CLIENT] || 0) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[ZCODE_CLIENT] = (period.clientCacheWrites[ZCODE_CLIENT] || 0) + cacheWrite;
  if (output > 0) period.clientOutputs[ZCODE_CLIENT] = (period.clientOutputs[ZCODE_CLIENT] || 0) + output;
  if (cost > 0) period.clientCosts[ZCODE_CLIENT] = (period.clientCosts[ZCODE_CLIENT] || 0) + cost;

  period.models[model] = (period.models[model] || 0) + total;
  if (cacheRead > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cacheRead;
  if (cacheWrite > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cacheWrite;
  if (output > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + output;
  if (cost > 0) period.modelCosts[model] = (period.modelCosts[model] || 0) + cost;

  if (!period.clientModels[ZCODE_CLIENT]) period.clientModels[ZCODE_CLIENT] = {};
  period.clientModels[ZCODE_CLIENT][model] = (period.clientModels[ZCODE_CLIENT][model] || 0) + total;
  if (!period.clientModelCosts[ZCODE_CLIENT]) period.clientModelCosts[ZCODE_CLIENT] = {};
  if (cost > 0) period.clientModelCosts[ZCODE_CLIENT][model] = (period.clientModelCosts[ZCODE_CLIENT][model] || 0) + cost;

  const key = `${ZCODE_CLIENT}:${sessionId}`;
  const session = period.sessions[key] || {
    client: ZCODE_CLIENT,
    sessionId,
    totalTokens: 0,
    costUsd: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: num(row.reasoningTokens),
    startedAt: row.timestamp || '',
    lastUsedAt: row.timestamp || '',
    models: {},
    modelCosts: {},
    providers: {}
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
// DB read path (authoritative)
// ---------------------------------------------------------------------------
const MODEL_USAGE_SQL =
  `SELECT session_id        AS sessionId,
          provider_id       AS providerId,
          model_id          AS model,
          status,
          completed_at      AS completedAt,
          started_at        AS startedAt,
          input_tokens      AS inputTokens,
          output_tokens     AS outputTokens,
          reasoning_tokens  AS reasoningTokens,
          cache_creation_input_tokens AS cacheCreationTokens,
          cache_read_input_tokens     AS cacheReadTokens,
          computed_total_tokens        AS totalTokens,
          raw_usage_json    AS rawUsageJson
   FROM model_usage
   WHERE completed_at IS NOT NULL`;

function rowFromDbRecord(r) {
  // ZCode's input_tokens already EXCLUDES cache_read (it is the bare prompt
  // size), and cache_read_input_tokens / cache_creation_input_tokens are
  // reported separately — same convention as Claude/OpenCode. exposeTotal in
  // usage.js sums input + output + cacheRead + cacheWrite, so feed those
  // components directly; cache_creation maps to cacheWrite.
  const cacheWrite = num(r.cacheCreationTokens);
  return {
    client: ZCODE_CLIENT,
    sessionId: String(r.sessionId || ''),
    model: r.model,
    providerId: r.providerId,
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    reasoningTokens: num(r.reasoningTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWriteTokens: cacheWrite,
    totalTokens: num(r.totalTokens),
    costUsd: 0,
    timestamp: isoFromMs(r.completedAt),
    completedAtMs: num(r.completedAt)
  };
}

function readUsageRowsFromDb(deps = {}) {
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return [];
  const rows = [];
  for (const dbPath of discoverDbPaths(deps)) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      // Feature-detect: older DBs may not have the table yet.
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_usage'").get();
      if (!hasTable) continue;
      for (const r of db.prepare(MODEL_USAGE_SQL).all()) rows.push(rowFromDbRecord(r));
    } catch (_) { /* skip unreadable db */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// JSONL rollout fallback (one line per LLM request)
// ---------------------------------------------------------------------------
function rowFromRolloutLine(obj) {
  const usage = (obj.response && obj.response.usage) || {};
  const modelNode = obj.model || {};
  return {
    client: ZCODE_CLIENT,
    sessionId: String(obj.sessionId || ''),
    model: modelNode.modelId,
    providerId: modelNode.providerId,
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    reasoningTokens: num(usage.reasoningTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    totalTokens: num(usage.totalTokens),
    costUsd: 0,
    timestamp: obj.completedAt || '',
    completedAtMs: msFromIso(obj.completedAt)
  };
}

function readUsageRowsFromRollout(deps = {}) {
  const rows = [];
  for (const file of discoverRolloutFiles(deps)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch (_) { continue; }
      if (!obj || !obj.response || !obj.response.usage) continue;
      rows.push(rowFromRolloutLine(obj));
    }
  }
  return rows;
}

function readUsageRows(deps = {}) {
  // DB first; fall back to JSONL if the DB has nothing (or can't be opened).
  const readDb = deps.readUsageRowsFromDb || readUsageRowsFromDb;
  const dbRows = readDb(deps);
  if (dbRows.length > 0) return dbRows;
  const readRollout = deps.readUsageRowsFromRollout || readUsageRowsFromRollout;
  return readRollout(deps);
}

// ---------------------------------------------------------------------------
// Public API: build today / month / allTime periods
// ---------------------------------------------------------------------------
// Bucket bounds are computed once from nowMs. A row belongs to a period when its
// completedAt falls inside that period's [start, end) window. allTime mirrors the
// collector's `allTimeSince` anchor (default 2024-01-01) so we don't rescan the
// entire history on machines that predate ZCode's usage tracking.
function collectZcodeUsage(options = {}) {
  const deps = options.deps || {};
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const allTimeSinceMs = msFromIso(options.allTimeSince || '2024-01-01') || Date.UTC(2024, 0, 1);
  // Optional model->price map ({ modelId: { inputPerM, outputPerM, cacheReadPerM } },
  // per-million tokens) from the app's custom-pricing setting. ZCode rows carry no
  // cost, so without this the dashboard would always show $0 for GLM-5.2 etc.
  const pricing = options.pricing || null;

  const today = emptyPeriod();
  const month = emptyPeriod();
  const allTime = emptyPeriod();

  const day = utcDayBoundsMs(nowMs);
  const mon = utcMonthBoundsMs(nowMs);

  const rows = (deps.readUsageRows || readUsageRows)(deps);
  for (const row of rows) {
    const ts = row.completedAtMs || msFromIso(row.timestamp);
    if (!ts) continue;
    const sid = row.sessionId || 'zcode-session';
    if (ts >= day.startMs && ts < day.endMs) addRowInto(today, row, sid, pricing);
    if (ts >= mon.startMs && ts < mon.endMs) addRowInto(month, row, sid, pricing);
    if (ts >= allTimeSinceMs) addRowInto(allTime, row, sid, pricing);
  }
  return { today, month, allTime };
}

module.exports = {
  ZCODE_CLIENT,
  collectZcodeUsage,
  dataDirPresent,
  discoverDbPaths,
  discoverRolloutFiles,
  readUsageRows,
  readUsageRowsFromDb,
  readUsageRowsFromRollout,
  resolveDataDir,
  resolveDbDir,
  resolveRolloutDir
};
