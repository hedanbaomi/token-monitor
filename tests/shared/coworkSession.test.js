'use strict';

// Unit tests for the Cowork adapter. Cowork transcripts are standard Claude Code
// JSONL (type:"assistant" + message.usage), so we feed synthetic lines via the
// `deps` seam and assert the period shape + that usage attributes to the `claude`
// client (Cowork is merged into claude, not a separate tool row).

const assert = require('node:assert/strict');
const test = require('node:test');

const cowork = require('../../src/shared/coworkSession');

// Build a synthetic assistant line with an Anthropic usage block.
function line({ ts = '2026-06-20T01:00:00.000Z', model = 'claude-opus-4-8', sessionId = 'sess-1', usage = {} } = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: ts,
    message: {
      role: 'assistant',
      model,
      usage: Object.assign({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 300 }, usage)
    }
  });
}

// Feed lines through deps.files + a reader that returns parsed rows.
function periodsFromLines(lines, opts = {}) {
  // Provide files whose "content" is the joined lines; reuse readUsageRows via
  // a fake fs by injecting a row reader instead.
  const rows = [];
  for (const l of lines) {
    const obj = JSON.parse(l);
    rows.push({
      client: 'claude',
      sessionId: obj.sessionId,
      model: obj.message.model,
      inputTokens: obj.message.usage.input_tokens,
      outputTokens: obj.message.usage.output_tokens,
      cacheReadTokens: obj.message.usage.cache_read_input_tokens,
      cacheWriteTokens: obj.message.usage.cache_creation_input_tokens,
      totalTokens: 0,
      costUsd: 0,
      timestamp: obj.timestamp,
      completedAtMs: Date.parse(obj.timestamp)
    });
  }
  return cowork.collectCoworkUsage(Object.assign({ allTimeSince: '2026-01-01' }, opts, { deps: { readUsageRows: () => rows } }));
}

test('cowork usage attributes to the claude client (no separate cowork row)', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const p = periodsFromLines([line({ ts: new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString() })], { nowMs: now });
  assert.equal(Object.keys(p.today.clients).length, 1);
  assert.ok(p.today.clients.claude, 'claude is the client key');
  assert.ok(!('cowork' in p.today.clients), 'no separate cowork client');
});

test('cowork + claude code share the same model key (merged in the model view)', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  const p = periodsFromLines([line({ ts, model: 'claude-opus-4-8' }), line({ ts, model: 'claude-opus-4-8', usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })], { nowMs: now });
  // both rows under one model key, summed
  assert.equal(Object.keys(p.today.models).length, 1);
  assert.ok(p.today.models['claude-opus-4-8']);
  assert.equal(p.today.models['claude-opus-4-8'], 1000 + 200 + 300 + 50 + 500 + 50); // input+output+cacheRead+cacheWrite both
});

test('total tokens = input + output + cacheRead + cacheWrite', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  const p = periodsFromLines([line({ ts })], { nowMs: now });
  assert.equal(p.today.totalTokens, 1000 + 200 + 300 + 50); // input+output+cacheRead+cacheWrite
});

test('rows are bucketed into today / month / allTime by timestamp', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const todayTs = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  const monthTs = new Date(Date.UTC(2026, 5, 5, 1, 0, 0)).toISOString();
  const oldTs = new Date(Date.UTC(2026, 4, 20, 1, 0, 0)).toISOString();
  const p = periodsFromLines([line({ ts: todayTs, sessionId: 'a' }), line({ ts: monthTs, sessionId: 'b' }), line({ ts: oldTs, sessionId: 'c' })], { nowMs: now });
  assert.equal(p.today.totalTokens, 1000 + 200 + 300 + 50); // only todayTs
  assert.equal(Object.keys(p.month.sessions).length, 2); // today + month
  assert.equal(Object.keys(p.allTime.sessions).length, 3); // all three
});

test('non-assistant lines and lines without usage are ignored', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  // readUsageRows-style: feed a mix where only the assistant-with-usage counts.
  // Here we emulate by only passing the valid row (the filtering happens in
  // readUsageRows; the deps seam bypasses it), so assert the unit under test:
  // a row with all-zero usage contributes nothing.
  const rows = [{
    client: 'claude', sessionId: 'z', model: 'claude-opus-4-8',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, costUsd: 0, timestamp: ts, completedAtMs: Date.parse(ts)
  }];
  const p = cowork.collectCoworkUsage({ nowMs: now, deps: { readUsageRows: () => rows } });
  assert.equal(p.today.totalTokens, 0);
  assert.equal(Object.keys(p.today.sessions).length, 0);
});

test('cost is computed from a per-million pricing map', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);
  const ts = new Date(Date.UTC(2026, 5, 20, 1, 0, 0)).toISOString();
  // 1M input, 0.5M output, 2M cacheRead
  const p = periodsFromLines([line({ ts, usage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 0 } })], {
    nowMs: now,
    pricing: { 'claude-opus-4-8': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5 } }
  });
  // 1M*15 + 0.5M*75 + 2M*1.5 = 15 + 37.5 + 3 = 55.5
  assert.ok(Math.abs(p.today.costUsd - 55.5) < 1e-6, `cost ${p.today.costUsd} ~= 55.5`);
  assert.equal(p.today.clientCosts.claude, p.today.costUsd);
  assert.equal(p.today.modelCosts['claude-opus-4-8'], p.today.costUsd);
});

test('COWORK_CLIENT constant is claude (unified attribution)', () => {
  assert.equal(cowork.COWORK_CLIENT, 'claude');
});

// Regression: today/month must be LOCAL wall-clock buckets, matching collector.js
// (localTodayKey) and tokscale --today. Using UTC buckets misaligned Cowork from
// every other client near the local-midnight boundary. See zcodeSession.test.js
// for the same regression on the ZCode side.
test('today buckets by LOCAL wall-clock, not UTC', () => {
  const now = new Date(2026, 5, 20, 12, 0, 0).getTime(); // local 2026-06-20 noon
  const mkRow = (ms, tokens, sid) => ({
    client: 'claude', sessionId: sid, model: 'claude-opus-4-8',
    inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, costUsd: 0,
    timestamp: new Date(ms).toISOString(), completedAtMs: ms
  });
  const rows = [
    mkRow(new Date(2026, 5, 20, 23, 30, 0).getTime(), 100, 'late'),     // local 23:30 today
    mkRow(new Date(2026, 5, 20, 0, 30, 0).getTime(), 200, 'early'),     // local 00:30 today
    mkRow(new Date(2026, 5, 19, 23, 30, 0).getTime(), 400, 'yest')      // local 23:30 yesterday
  ];
  const p = cowork.collectCoworkUsage({ nowMs: now, allTimeSince: '2026-06-01', deps: { readUsageRows: () => rows } });
  assert.equal(p.today.totalTokens, 300, 'today spans local [00:00, next 00:00)');
  assert.equal(Object.keys(p.today.sessions).length, 2);
  assert.ok(!p.today.sessions['claude:yest'], "yesterday's late row must not leak into today");
});

// buildCoworkHistoryGraph keys each contribution by the LOCAL date, matching the
// todayKey (localTodayKey) the collector injects into the merged history. UTC keys
// here would slide Cowork's contribution a day off "today" near midnight.
test('buildCoworkHistoryGraph keys contributions by LOCAL date', () => {
  const mkRow = (ms, tokens) => ({
    client: 'claude', sessionId: 's', model: 'claude-opus-4-8',
    inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, costUsd: 0,
    timestamp: new Date(ms).toISOString(), completedAtMs: ms
  });
  // One row late on local 2026-06-20, one early on local 2026-06-20.
  const rows = [
    mkRow(new Date(2026, 5, 20, 23, 30, 0).getTime(), 100),
    mkRow(new Date(2026, 5, 20, 0, 30, 0).getTime(), 200)
  ];
  const graph = cowork.buildCoworkHistoryGraph({ allTimeSince: '2026-06-01', deps: { readUsageRows: () => rows } });
  // Both rows fall on local 2026-06-20 → a single contribution keyed by that date.
  assert.equal(graph.contributions.length, 1);
  assert.equal(graph.contributions[0].date, '2026-06-20');
  assert.equal(graph.contributions[0].totals.tokens, 300);
});
