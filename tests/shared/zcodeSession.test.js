'use strict';

// Unit tests for the ZCode adapter. Uses the `deps` seam (readUsageRows) to feed
// synthetic usage rows without a real ZCode install, plus a real node:sqlite
// round-trip to exercise the DB read path when node:sqlite is available.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const zcode = require('../../src/shared/zcodeSession');

const DAY_MS = 24 * 60 * 60 * 1000;

function row(overrides = {}) {
  return Object.assign({
    client: 'zcode',
    sessionId: 'sess-1',
    model: 'builtin:bigmodel-coding-plan/GLM-5.2',
    providerId: 'builtin:bigmodel-coding-plan',
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    totalTokens: 165,
    costUsd: 0,
    timestamp: '',
    completedAtMs: 0
  }, overrides);
}

// --- period bucketing ------------------------------------------------------
test('collectZcodeUsage buckets rows into today / month / allTime by completedAt', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0); // 2026-06-20T12:00Z
  const todayMs = Date.UTC(2026, 5, 20, 1, 0, 0);
  const earlierThisMonth = Date.UTC(2026, 5, 5, 1, 0, 0);
  const lastMonth = Date.UTC(2026, 4, 20, 1, 0, 0);

  const rows = [
    row({ completedAtMs: todayMs, timestamp: new Date(todayMs).toISOString(), sessionId: 's-today' }),
    row({ completedAtMs: earlierThisMonth, timestamp: new Date(earlierThisMonth).toISOString(), sessionId: 's-month' }),
    row({ completedAtMs: lastMonth, timestamp: new Date(lastMonth).toISOString(), sessionId: 's-old' })
  ];

  const periods = zcode.collectZcodeUsage({
    nowMs: now,
    allTimeSince: '2026-01-01',
    deps: { readUsageRows: () => rows }
  });

  // today = only the todayMs row
  assert.equal(periods.today.totalTokens, 165);
  assert.equal(periods.today.clients.zcode, 165);
  assert.equal(Object.keys(periods.today.sessions).length, 1);
  assert.ok(periods.today.sessions['zcode:s-today']);

  // month = today + earlierThisMonth (2 rows)
  assert.equal(periods.month.totalTokens, 330);
  assert.equal(Object.keys(periods.month.sessions).length, 2);

  // allTime = all three (lastMonth is within 2026-01-01..now)
  assert.equal(periods.allTime.totalTokens, 495);
  assert.equal(Object.keys(periods.allTime.sessions).length, 3);
});

test('collectZcodeUsage strips the provider prefix from model ids', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  const rows = [row({ completedAtMs: ts, timestamp: new Date(ts).toISOString(), model: 'builtin:bigmodel-coding-plan/GLM-5.2' })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  assert.ok(periods.today.models['GLM-5.2'], 'bare model id is the breakdown key');
  assert.ok(!periods.today.models['builtin:bigmodel-coding-plan/GLM-5.2'], 'prefixed id is not used');
  assert.ok(periods.today.clientModels.zcode['GLM-5.2']);
});

test('collectZcodeUsage falls back to input+output when totalTokens is absent', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  // ZCode input is cache-inclusive, so total = input + output (NOT + cache).
  const rows = [row({ completedAtMs: ts, timestamp: new Date(ts).toISOString(), totalTokens: 0, inputTokens: 200, outputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 20 })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  assert.equal(periods.today.totalTokens, 300); // 200+100 only (cache not re-added)
});

test('collectZcodeUsage ignores rows with zero tokens and zero cost', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  const rows = [row({ completedAtMs: ts, timestamp: new Date(ts).toISOString(), totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  assert.equal(periods.today.totalTokens, 0);
  assert.equal(Object.keys(periods.today.sessions).length, 0);
});

test('allTimeSince excludes rows older than the anchor', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const oldMs = Date.UTC(2025, 0, 1, 0, 0, 0); // before the 2026-01-01 anchor
  const rows = [row({ completedAtMs: oldMs, timestamp: new Date(oldMs).toISOString() })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, allTimeSince: '2026-01-01', deps: { readUsageRows: () => rows } });
  assert.equal(periods.allTime.totalTokens, 0);
});

// --- project attribution (Projects view) ------------------------------------
test('collectZcodeUsage stamps projectId/projectLabel from the session project map', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  const rows = [row({ completedAtMs: Date.parse(ts), timestamp: ts, sessionId: 'sess-proj' })];
  const projectMap = new Map([['sess-proj', { projectId: 'sha256:abc', projectLabel: 'my-project' }]]);
  const periods = zcode.collectZcodeUsage({
    nowMs: now,
    deps: { readUsageRows: () => rows, loadSessionProjects: () => projectMap }
  });
  const s = periods.today.sessions['zcode:sess-proj'];
  assert.ok(s, 'session exists');
  assert.equal(s.projectId, 'sha256:abc');
  assert.equal(s.projectLabel, 'my-project');
});

test('collectZcodeUsage leaves projectId empty when no project map is provided', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  const rows = [row({ completedAtMs: Date.parse(ts), timestamp: ts, sessionId: 'sess-noproj' })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  const s = periods.today.sessions['zcode:sess-noproj'];
  assert.equal(s.projectId, '');
  assert.equal(s.projectLabel, '');
});

// --- custom pricing -> cost ------------------------------------------------
test('collectZcodeUsage computes cost from a per-million pricing map (cache-inclusive input)', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  // ZCode input_tokens is cache-inclusive: 3M input contains 2M cacheRead,
  // so fresh input = 3M - 2M = 1M. Pricing: input 0.5/M, output 2/M, cacheRead 0.05/M.
  const rows = [row({
    completedAtMs: ts, timestamp: new Date(ts).toISOString(),
    model: 'builtin:bigmodel-coding-plan/GLM-5.2',
    inputTokens: 3_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0,
    totalTokens: 3_500_000
  })];
  const pricing = { 'GLM-5.2': { inputPerM: 0.5, outputPerM: 2, cacheReadPerM: 0.05 } };
  const periods = zcode.collectZcodeUsage({ nowMs: now, pricing, deps: { readUsageRows: () => rows } });
  // expected: 1M(fresh)*0.5 + 0.5M*2 + 2M*0.05 = 0.5 + 1.0 + 0.1 = 1.6
  assert.ok(Math.abs(periods.today.costUsd - 1.6) < 1e-6, `cost ${periods.today.costUsd} ~= 1.6`);
  assert.equal(periods.today.clientCosts.zcode, periods.today.costUsd);
  assert.equal(periods.today.modelCosts['GLM-5.2'], periods.today.costUsd);
});

test('collectZcodeUsage cost stays 0 when no pricing is configured', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  const rows = [row({ completedAtMs: ts, timestamp: new Date(ts).toISOString(), totalTokens: 1000 })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  assert.equal(periods.today.costUsd, 0);
  assert.equal(Object.keys(periods.today.clientCosts).length, 0);
});

// --- JSONL rollout fallback ------------------------------------------------
test('readUsageRowsFromRollout parses response.usage per line', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zrollout-'));
  try {
    fs.mkdirSync(path.join(fakeHome, 'cli', 'rollout'), { recursive: true });
    const file = path.join(fakeHome, 'cli', 'rollout', 'model-io-sess-abc.jsonl');
    const line = JSON.stringify({
      completedAt: '2026-06-20T01:00:00.000Z',
      sessionId: 'sess-abc',
      model: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
      response: { usage: { inputTokens: 431, outputTokens: 283, totalTokens: 714, cacheReadTokens: 64, cacheWriteTokens: 0 } }
    });
    // an ignored non-usage line + a blank line must be skipped
    fs.writeFileSync(file, `${line}\n{"nope":true}\n\n`, 'utf8');

    const rows = zcode.readUsageRowsFromRollout({ env: { ZCODE_HOME: fakeHome } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inputTokens, 431);
    assert.equal(rows[0].totalTokens, 714);
    assert.equal(rows[0].cacheReadTokens, 64);
    assert.equal(rows[0].sessionId, 'sess-abc');
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// --- DB read path (needs node:sqlite) --------------------------------------
const maybeSqlite = sqlite ? test : test.skip;

const tmpDbDirs = [];
maybeSqlite.after(() => {
  for (const dir of tmpDbDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Build a synthetic ~/.zcode/cli/db/db.sqlite with a model_usage table.
function makeZcodeDb(rows) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcodedb-'));
  tmpDbDirs.push(tmp);
  const file = path.join(tmp, 'db.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE model_usage (
    id TEXT, session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT,
    status TEXT, completed_at INTEGER, started_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, raw_usage_json TEXT
  )`);
  const ins = db.prepare(`INSERT INTO model_usage
    (id, session_id, turn_id, provider_id, model_id, status, completed_at, started_at,
     input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
     cache_read_input_tokens, computed_total_tokens, raw_usage_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  rows.forEach((r, i) => ins.run(
    'mu' + i, r.sessionId, 'turn', r.providerId, r.model, 'completed',
    r.completedAt, r.completedAt, r.inputTokens, r.outputTokens, r.reasoningTokens,
    r.cacheCreationTokens || 0, r.cacheReadTokens, r.totalTokens,
    JSON.stringify({ inputTokens: r.inputTokens, outputTokens: r.outputTokens })
  ));
  db.close();
  return { dir: tmp, file };
}

// Stand up a fake ~/.zcode/cli/db layout (so discoverDbPaths finds it) and copy
// a built db into it.
function stageZcodeHome(dbDir) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zhome-'));
  tmpDbDirs.push(fakeHome);
  fs.mkdirSync(path.join(fakeHome, 'cli', 'db'), { recursive: true });
  fs.copyFileSync(path.join(dbDir, 'db.sqlite'), path.join(fakeHome, 'cli', 'db', 'db.sqlite'));
  return fakeHome;
}

maybeSqlite('readUsageRowsFromDb maps cache_creation_input_tokens to cacheWrite', () => {
  const { dir } = makeZcodeDb([
    { sessionId: 's1', providerId: 'glm', model: 'GLM-5.2', completedAt: Date.UTC(2026, 5, 20, 1, 0, 0), inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, cacheCreationTokens: 300, cacheReadTokens: 50, totalTokens: 1550 }
  ]);
  const fakeHome = stageZcodeHome(dir);
  const rows = zcode.readUsageRowsFromDb({ env: { ZCODE_HOME: fakeHome } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cacheWriteTokens, 300, 'cache_creation maps to cacheWrite');
  assert.equal(rows[0].cacheReadTokens, 50);
  assert.equal(rows[0].totalTokens, 1550);
});

maybeSqlite('collectZcodeUsage reads end-to-end from a synthetic db', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const { dir } = makeZcodeDb([
    { sessionId: 'sess-x', providerId: 'builtin:bigmodel-coding-plan', model: 'builtin:bigmodel-coding-plan/GLM-5.2', completedAt: Date.UTC(2026, 5, 20, 2, 0, 0), inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 50, totalTokens: 1250 }
  ]);
  const fakeHome = stageZcodeHome(dir);
  const periods = zcode.collectZcodeUsage({ nowMs: now, allTimeSince: '2026-01-01', deps: { env: { ZCODE_HOME: fakeHome } } });
  assert.equal(periods.today.totalTokens, 1250);
  assert.equal(periods.today.clients.zcode, 1250);
  assert.ok(periods.today.sessions['zcode:sess-x']);
});

maybeSqlite('dataDirPresent is true when a rollout dir has model-io files', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zhome3-'));
  tmpDbDirs.push(fakeHome);
  fs.mkdirSync(path.join(fakeHome, 'cli', 'rollout'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, 'cli', 'rollout', 'model-io-sess-1.jsonl'), '{}', 'utf8');
  assert.equal(zcode.dataDirPresent({ env: { ZCODE_HOME: fakeHome } }), true);
  assert.equal(zcode.dataDirPresent({ env: { ZCODE_HOME: path.join(os.tmpdir(), 'definitely-missing-zcode') } }), false);
});

// --- session detail (readSessionEvents) -------------------------------------
// Build a synthetic db with turn_usage + input_history + tool_usage so we can
// exercise the per-turn breakdown path without a real ZCode install.
function makeZcodeSessionDb({ sessionId, turns = [], prompts = [], tools = [] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcodesess-'));
  tmpDbDirs.push(tmp);
  const file = path.join(tmp, 'db.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE turn_usage (
    session_id TEXT, turn_id TEXT, user_message_id TEXT, started_at INTEGER, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, computed_total_tokens INTEGER
  )`);
  db.exec(`CREATE TABLE input_history (id TEXT, session_id TEXT, text TEXT, time_created INTEGER)`);
  db.exec(`CREATE TABLE tool_usage (id TEXT, session_id TEXT, turn_id TEXT, tool_name TEXT)`);

  const insT = db.prepare(`INSERT INTO turn_usage (session_id, turn_id, user_message_id, started_at, completed_at, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  turns.forEach((t) => insT.run(sessionId, t.turnId, t.userMessageId || null, t.startedAt, t.completedAt, t.input, t.output, t.reasoning || 0, t.cacheWrite || 0, t.cacheRead, t.total));

  const insP = db.prepare(`INSERT INTO input_history (id, session_id, text, time_created) VALUES (?,?,?,?)`);
  prompts.forEach((p, i) => insP.run('ih' + i, sessionId, p.text, p.ms));

  const insTool = db.prepare(`INSERT INTO tool_usage (id, session_id, turn_id, tool_name) VALUES (?,?,?,?)`);
  let ti = 0;
  for (const t of tools) insTool.run('tu' + (ti++), sessionId, t.turnId, t.name);

  db.close();
  return { dir: tmp, file };
}

maybeSqlite('readSessionEvents returns found:false for an unknown session', () => {
  const { dir } = makeZcodeSessionDb({ sessionId: 's1', turns: [] });
  const fakeHome = stageZcodeHome(dir);
  const r = zcode.readSessionEvents('s-other', { env: { ZCODE_HOME: fakeHome } });
  assert.equal(r.found, false);
  assert.equal(r.events.length, 0);
});

maybeSqlite('readSessionEvents emits prompt+turn events with prompt text from input_history', () => {
  const t0 = Date.UTC(2026, 5, 20, 1, 0, 0);
  const { dir } = makeZcodeSessionDb({
    sessionId: 'sess-d',
    prompts: [{ ms: t0 - 1, text: 'fix the bug' }],
    turns: [{ turnId: 'turn-1', startedAt: t0, completedAt: t0 + 1000, input: 300, output: 50, cacheRead: 200, cacheWrite: 0, total: 350 }],
    tools: [{ turnId: 'turn-1', name: 'Read' }, { turnId: 'turn-1', name: 'Bash' }]
  });
  const fakeHome = stageZcodeHome(dir);
  const r = zcode.readSessionEvents('sess-d', { env: { ZCODE_HOME: fakeHome } });
  assert.equal(r.found, true);
  // prompt + turn = 2 events
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].kind, 'prompt');
  assert.equal(r.events[0].text, 'fix the bug');
  assert.equal(r.events[1].kind, 'turn');
  // input is cache-inclusive: freshInput = 300 - 200 = 100
  assert.equal(r.events[1].tokens.input, 100);
  assert.equal(r.events[1].tokens.cacheRead, 200);
  assert.equal(r.events[1].tokens.output, 50);
  assert.deepEqual(r.events[1].tools.sort(), ['Bash', 'Read']);
});

maybeSqlite('readSessionEvents works with no input_history (prompts degrade gracefully)', () => {
  const t0 = Date.UTC(2026, 5, 20, 1, 0, 0);
  const { dir } = makeZcodeSessionDb({
    sessionId: 'sess-e',
    prompts: [],
    turns: [{ turnId: 'turn-1', startedAt: t0, completedAt: t0 + 1000, input: 100, output: 10, cacheRead: 0, total: 110 }]
  });
  const fakeHome = stageZcodeHome(dir);
  const r = zcode.readSessionEvents('sess-e', { env: { ZCODE_HOME: fakeHome } });
  assert.equal(r.found, true);
  assert.equal(r.events.length, 1); // just the turn, no prompt
  assert.equal(r.events[0].kind, 'turn');
});

maybeSqlite('readSessionDetail wires zcode into grouped exchanges', () => {
  const { readSessionDetail } = require('../../src/shared/sessionDetail');
  const t0 = Date.UTC(2026, 5, 20, 1, 0, 0);
  const { dir } = makeZcodeSessionDb({
    sessionId: 'sess-f',
    prompts: [{ ms: t0 - 1, text: 'hello' }],
    turns: [{ turnId: 'turn-1', startedAt: t0, completedAt: t0 + 1000, input: 300, output: 50, cacheRead: 200, total: 350 }]
  });
  const fakeHome = stageZcodeHome(dir);
  const r = readSessionDetail({ client: 'zcode', sessionId: 'sess-f', period: 'total', deps: { env: { ZCODE_HOME: fakeHome } } });
  assert.equal(r.found, true);
  assert.equal(r.client, 'zcode');
  assert.equal(r.exchanges.length, 1);
  assert.equal(r.exchanges[0].promptPreview, 'hello');
  assert.equal(r.exchanges[0].turnCount, 1);
});
