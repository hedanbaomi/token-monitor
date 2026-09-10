'use strict';

// A parse-local client must record its own `today` partition, because a targeted
// watch tick rebuilds `today` from those partitions instead of scanning. DeepSeek
// Harness originally skipped that wiring: on a tick aimed at another client its
// partition came back empty, so dsh read as zero everywhere, and the widget's
// session archive then restored the missing sessions as *unclassified* — the
// accordion showed "输入 (缓存未命中)" as "未分类" with a 100% cache hit rate until
// the next full scan put the numbers back. These tests pin the partition wiring
// rather than the arithmetic, since the arithmetic was never wrong.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

function dshTranscriptLines(createdAtMs, callMs) {
  return [
    JSON.stringify({ type: 'session', id: 'session-partition', createdAt: createdAtMs }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      time: callMs,
      data: {
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 20000 },
        message: { id: 'm1', source: { provider: 'opencode-go', model: 'deepseek-v4-pro' } }
      }
    })
  ].join('\n');
}

async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-partition-'));
  try {
    return await run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function baseOptions(home, overrides = {}) {
  return {
    clients: 'dsh,codex',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'test-device',
    agentVersion: 'test',
    limitsEnabled: false,
    historyEnabled: false,
    homeDir: home,
    // DSH is read from its transcripts, so only the tokscale side needs a stub.
    runTokscale: async () => ({
      entries: [{ client: 'codex', sessionId: 'codex-session', model: 'gpt-5.6-luna', input: 5, output: 1, cost: 0.001 }]
    }),
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] }),
    anchorPersistenceEnabled: false,
    dailyHistoryArchiveEnabled: false,
    dailyHistoryArchiveWriteEnabled: false,
    ...overrides
  };
}

test('a targeted tick keeps DeepSeek Harness usage that it did not rescan', async () => {
  await withHome(async (home) => {
    const { collectUsageOnce: collect } = freshCollector();
    const dir = path.join(home, '.dsh', 'sessions', 'proj', 'session-partition');
    fs.mkdirSync(dir, { recursive: true });
    const createdAtMs = Date.now() - 60_000;
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${dshTranscriptLines(createdAtMs, createdAtMs + 1000)}\n`);

    let captured = null;
    const full = await collect(baseOptions(home, { onAnchorComputed: (value) => { captured = value; } }));
    const dshToday = full.today.clients?.dsh || 0;
    assert.equal(dshToday, 21100, 'the full tick reads 1000 + 100 + 20000 from the transcript');
    assert.deepEqual(Object.keys(full.today.sessions || {}).filter((key) => key.startsWith('dsh:')).length, 1);

    // The partition is what makes the next tick's rebuild survive.
    assert.equal(
      captured.todayPartitions?.dsh?.clients?.dsh,
      dshToday,
      'the anchor must carry the real dsh partition, not an empty placeholder'
    );

    const anchor = {
      dateKey: new Date().toLocaleDateString('sv-SE'),
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions,
      qoderCnPeriods: captured.qoderCnPeriods
    };

    const targeted = await collect(baseOptions(home, { targetClients: ['codex'], todayOnlyAnchor: anchor }));
    assert.equal(targeted.today.clients?.dsh, dshToday, 'a tick aimed at codex must not drop dsh from today');
    assert.equal(targeted.month.clients?.dsh, dshToday, 'nor from month');
    assert.equal(targeted.allTime.clients?.dsh, dshToday, 'nor from allTime');
    assert.equal(
      Object.keys(targeted.today.sessions || {}).filter((key) => key.startsWith('dsh:')).length,
      1,
      'the session must stay in the summary, or the archive restores it as unclassified'
    );
    // The restored copy is what flipped the breakdown: dsh must keep exact
    // components so the input split stays cache-hit vs cache-miss.
    assert.equal(targeted.today.capabilities?.tokenComponents, true);
    assert.equal(targeted.today.clientUnclassifiedTokens?.dsh || 0, 0);
  });
});

test('a tick targeted at DeepSeek Harness itself keeps its windows consistent', async () => {
  await withHome(async (home) => {
    const { collectUsageOnce: collect } = freshCollector();
    const dir = path.join(home, '.dsh', 'sessions', 'proj', 'session-partition');
    fs.mkdirSync(dir, { recursive: true });
    const createdAtMs = Date.now() - 60_000;
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${dshTranscriptLines(createdAtMs, createdAtMs + 1000)}\n`);

    let captured = null;
    const full = await collect(baseOptions(home, { onAnchorComputed: (value) => { captured = value; } }));
    const anchor = {
      dateKey: new Date().toLocaleDateString('sv-SE'),
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions,
      qoderCnPeriods: captured.qoderCnPeriods
    };

    // A growing transcript is the normal watch path for this client: the harness
    // appends, the watcher targets dsh, and the tick rescans only dsh's partition.
    fs.appendFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      time: createdAtMs + 2000,
      data: {
        usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 1000 },
        message: { id: 'm2', source: { provider: 'opencode-go', model: 'deepseek-v4-pro' } }
      }
    })}\n`);

    const targeted = await collect(baseOptions(home, { targetClients: ['dsh'], todayOnlyAnchor: anchor }));
    assert.equal(targeted.today.clients?.dsh, 22650, 'today picks up the appended call (500 + 50 + 1000) for the target');
    // month/allTime are the anchor plus the delta, so they advance with today
    // rather than losing the client entirely.
    assert.equal(targeted.month.clients?.dsh, targeted.today.clients?.dsh);
    assert.equal(targeted.allTime.clients?.dsh, targeted.today.clients?.dsh);
    assert.equal(full.month.clients?.dsh, 21100);
  });
});
