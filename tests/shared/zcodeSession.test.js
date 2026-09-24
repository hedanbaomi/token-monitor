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

test('collectZcodeUsage sums components when totalTokens is absent', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  const rows = [row({ completedAtMs: ts, timestamp: new Date(ts).toISOString(), totalTokens: 0, inputTokens: 200, outputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 20 })];
  const periods = zcode.collectZcodeUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  assert.equal(periods.today.totalTokens, 350); // 200+100+30+20
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

// --- custom pricing -> cost ------------------------------------------------
test('collectZcodeUsage computes cost from a per-million pricing map', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = Date.UTC(2026, 5, 20, 1, 0, 0);
  // 1M input + 0.5M output + 2M cacheRead
  const rows = [row({
    completedAtMs: ts, timestamp: new Date(ts).toISOString(),
    model: 'builtin:bigmodel-coding-plan/GLM-5.2',
    inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0,
    totalTokens: 3_500_000
  })];
  const pricing = { 'GLM-5.2': { inputPerM: 0.5, outputPerM: 2, cacheReadPerM: 0.05 } };
  const periods = zcode.collectZcodeUsage({ nowMs: now, pricing, deps: { readUsageRows: () => rows } });
  // expected: 1M*0.5 + 0.5M*2 + 2M*0.05 = 0.5 + 1.0 + 0.1 = 1.6
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
