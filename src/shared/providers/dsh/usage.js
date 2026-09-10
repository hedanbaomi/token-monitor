'use strict';

/**
 * DeepSeek Harness (`dsh`) usage adapter — period totals and the contribution
 * graph, read from the harness's own transcripts.
 *
 * This exists because a v3 harness renames its transcript instead of rotating
 * it: sessions are now written to `session.v3.jsonl.zstd`, and tokscale's dsh
 * reader (4.15.x, still current at the time of writing) matches only the
 * unversioned `session.jsonl` / `session.jsonl.zstd`. Every session a v3
 * harness wrote was therefore invisible — the widget showed nothing at all for
 * a full day of `deepseek-v4.1-flash` traffic (2026-09-10), not merely a
 * mispriced row. Session Detail had the same fixed name list and could not open
 * those sessions either.
 *
 * Reading the transcripts ourselves also lets the aggregates keep matching what
 * tokscale reported for the sessions it could still see, which is the property
 * the tests pin: the record rules (fork seed prefix, replayed-line dedupe,
 * inclusive-output/reasoning convention) come from ./sessionDetail, which
 * documents each one against tokscale's dsh.rs, and the output is emitted as
 * tokscale-shaped JSON so the collector folds it in exactly like Proma's or
 * Qoder CN's local read.
 */

const fs = require('node:fs');
const path = require('node:path');
const { decodeSessionText, dshSessionFiles, resolveDshSessionsRoot } = require('./sessionFiles');
const { dshTranscriptRecords } = require('./sessionDetail');

const DSH_CLIENT = 'dsh';

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Cost for one model call from a per-token pricing map — the shape
// collector.js's resolveModelPricing() returns (toks / catalog rates per token,
// with the app's custom per-million overrides already converted by its caller).
// DSH transcripts carry no cost field, so this is the only source of a dollar
// value; an unknown model stays at 0 rather than borrowing an unrelated price.
function estimatedRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[row.model] || pricingByModel?.[normalizedModelId(row.model)];
  if (!pricing) return 0;
  return row.input * numberValue(pricing.inputCostPerToken)
    + row.output * numberValue(pricing.outputCostPerToken)
    + row.cacheRead * numberValue(pricing.cacheReadInputTokenCost)
    + row.cacheWrite * numberValue(pricing.cacheCreationInputTokenCost);
}

// Parsed rows per transcript, invalidated by (size, mtime). A watch tick
// re-reads this adapter every few seconds, and DSH transcripts are zstd frames
// that have to be decompressed whole — re-parsing 30 unchanged files per tick
// would burn more CPU than the scan it feeds. Appended bytes change the size, so
// a growing live session is still re-read the moment it grows.
const dshRowCache = new Map();

function readSessionRows(file, cache) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return [];
  }
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = cache?.get(file);
  if (cached && cached.signature === signature) return cached.rows;
  let text;
  try {
    text = decodeSessionText(file, fs.readFileSync(file));
  } catch (_) {
    return [];
  }
  const dirSessionId = path.basename(path.dirname(file));
  const parsed = dshTranscriptRecords(text, { sessionId: dirSessionId });
  const rows = [];
  for (const record of parsed.records) {
    if (record.kind !== 'usage') continue;
    rows.push({ sessionId: parsed.sessionId || dirSessionId, record });
  }
  // Cache the parsed records rather than finished rows: the session id has to
  // survive a header-less transcript, and keeping the dedupe key raw lets the
  // cross-file pass below stay the single place that decides identity.
  cache?.set(file, { signature, rows });
  return rows;
}

function dshSessionsRoot(options = {}) {
  return options.sessionsRoot || resolveDshSessionsRoot(options);
}

function dataDirPresent(options = {}) {
  try {
    return fs.statSync(dshSessionsRoot(options)).isDirectory();
  } catch (_) {
    return false;
  }
}

// One row per billable model call, across every transcript of every session.
//
// A session can have two transcripts on disk at once: the pre-v3 file the
// harness stopped appending to and the re-encoded `session.<version>.jsonl.zstd`
// it writes now. They describe the same calls, so a call is identified by
// (session, time, routing, token signature) — the signature tokscale's own dsh
// dedupe uses — and the second copy of an identical call is dropped instead of
// counted twice.
function collectDshRows(options = {}) {
  const files = Array.isArray(options.files) ? options.files : dshSessionFiles(dshSessionsRoot(options));
  const cache = options.cache || dshRowCache;
  const rows = [];
  const seen = new Set();
  for (const file of files) {
    for (const cached of readSessionRows(file, cache)) {
      const record = cached.record;
      const tokens = record.tokens;
      const key = [
        cached.sessionId, record.timeMs, record.isSummary ? 'summary' : 'call',
        record.model, record.provider,
        tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning
      ].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        client: DSH_CLIENT,
        sessionId: cached.sessionId,
        model: record.model || 'dsh-unknown',
        provider: record.provider,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        reasoning: tokens.reasoning,
        messages: 1,
        createdAt: record.timeMs
      });
    }
  }
  // Sessions deleted on disk must not keep answering from the cache.
  if (cache && cache.size > 0) {
    const live = new Set(files);
    for (const key of cache.keys()) {
      if (!live.has(key)) cache.delete(key);
    }
  }
  return rows;
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

// Tokscale-compatible JSON, so extractUsageFromTokscale() builds the period
// (client/model/session breakdowns included) exactly as it does for a tokscale
// scan. Rows are filtered before per-model aggregation: a session that began
// before midnight would otherwise carry its earliest timestamp into today's
// window and drop today's usage from it.
function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  const allRows = (Array.isArray(options.rows) ? options.rows : collectDshRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown', model: row.model, provider: row.provider,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0, cost: 0,
        startedAt: 0, lastUsedAt: 0
      });
    }
    const m = bySessionModel.get(key);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.reasoning += row.reasoning;
    m.messages += Number(row.messages || 1);
    m.cost += estimatedRowCost(row, options.pricingByModel);
    if (!m.provider && row.provider) m.provider = row.provider;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  for (const m of bySessionModel.values()) {
    // tokscale reports dsh's output and reasoning as disjoint components (its
    // dsh.rs subtracts reasoning out of `output`, and the shared token math adds
    // it back for dsh), so the same split is emitted here; the totals close
    // either way, but the output bucket would otherwise double-count reasoning.
    const output = Math.max(0, m.output - m.reasoning);
    entries.push({
      client: DSH_CLIENT,
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: m.provider || '',
      input: m.input,
      output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: m.reasoning,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      performance: null
    });
    allInput += m.input;
    allOutput += output;
    allCacheRead += m.cacheRead;
    allCacheWrite += m.cacheWrite;
    allMessages += m.messages;
    allCost += m.cost;
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: allInput,
    totalOutput: allOutput,
    totalCacheRead: allCacheRead,
    totalCacheWrite: allCacheWrite,
    totalMessages: allMessages,
    totalCost: allCost,
    processingTimeMs: 0
  };
}

// Local midnight boundaries, matching every other period in the app (see
// coworkSession.js for why UTC bucketing slid a day's usage into its neighbour).
function buildDshPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectDshRows(options);
  const buildOptions = { rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Daily contributions for the dashboard's trend/history view. tokscale's graph
// is blind to the same versioned transcripts its scan is, so DSH's graph has to
// come from the same native rows or the dashboard's lifetime total would drift
// below the homepage period total — the exact mismatch zcode/cowork already hit.
function buildDshHistoryGraph(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : collectDshRows(options);
  const byDate = new Map();
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = row.model || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: DSH_CLIENT,
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    client.tokens.input += row.input;
    client.tokens.output += Math.max(0, row.output - row.reasoning);
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.tokens.reasoning += row.reasoning;
    client.cost += estimatedRowCost(row, options.pricingByModel);
    client.messages += Number(row.messages || 1);
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  DSH_CLIENT,
  buildDshHistoryGraph,
  dshRowCache,
  buildDshPeriods,
  buildTokscaleJson,
  collectDshRows,
  dataDirPresent,
  estimatedRowCost
};
