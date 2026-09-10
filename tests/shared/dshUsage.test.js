'use strict';

// The DSH usage adapter reads the harness's own transcripts instead of asking
// tokscale, because a v3 harness writes `session.v3.jsonl.zstd` and tokscale's
// dsh reader matches only the unversioned pair. What has to hold, and is pinned
// here: a session that exists in both encodings is counted once, the periods
// bucket on the device's local midnight like every other client, the published
// output/reasoning split matches tokscale's dsh convention, and the parsed rows
// are cached until the file itself moves.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  buildDshHistoryGraph,
  buildDshPeriods,
  collectDshRows,
  dataDirPresent
} = require('../../src/shared/providers/dsh/usage');

const hasZstd = typeof zlib.zstdCompressSync === 'function';

function sessionLine(id, extra = {}) {
  return JSON.stringify({
    type: 'session',
    id,
    ...(extra.createdAt === undefined ? {} : { createdAt: extra.createdAt }),
    ...(extra.seedLength === undefined ? {} : { seedLength: extra.seedLength })
  });
}

function usageLine({
  time,
  seq = 1,
  id = 'msg-1',
  model = 'deepseek-v4-flash',
  provider = 'opencode-go',
  input = 10,
  output = 5,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0
}) {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: {
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning
      },
      message: { id, source: { provider, model } }
    }
  });
}

function writeTranscript(file, lines) {
  const body = `${lines.join('\n')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (file.endsWith('.zstd')) {
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
  } else {
    fs.writeFileSync(file, body, 'utf8');
  }
}

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-usage-'));
  try {
    return run(home, path.join(home, '.dsh', 'sessions'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('dataDirPresent follows DSH_HOME and the ~/.dsh default', () => {
  withHome((home, sessionsRoot) => {
    assert.equal(dataDirPresent({ homeDir: home }), false);
    fs.mkdirSync(sessionsRoot, { recursive: true });
    assert.equal(dataDirPresent({ homeDir: home }), true);
    assert.equal(dataDirPresent({ sessionsRoot }), true);
    // DSH_HOME names the harness home itself, not the sessions dir under it.
    assert.equal(dataDirPresent({ env: { DSH_HOME: path.join(home, '.dsh') }, homeDir: os.tmpdir() }), true);
  });
});

test('collectDshRows counts a session that is on disk in both encodings exactly once', { skip: !hasZstd }, () => {
  withHome((home, sessionsRoot) => {
    const dir = path.join(sessionsRoot, 'proj', 'session-1');
    const lines = [
      sessionLine('session-1', { createdAt: 1750000000000 }),
      usageLine({ time: 1750000005000, id: 'm1', input: 100, output: 50, cacheRead: 7 }),
      usageLine({ time: 1750000010000, id: 'm2', input: 200, output: 60, cacheRead: 8 })
    ];
    // The pre-v3 file the harness stopped appending to, plus the re-encode it
    // writes now: same calls, two files, one session.
    writeTranscript(path.join(dir, 'session.jsonl.zstd'), lines);
    writeTranscript(path.join(dir, 'session.v3.jsonl.zstd'), lines);

    const rows = collectDshRows({ homeDir: home });
    assert.equal(rows.length, 2, 'the re-encoded copy must not double the session');
    assert.deepEqual(rows.map((row) => row.input), [100, 200]);
    assert.deepEqual(rows.map((row) => row.sessionId), ['session-1', 'session-1']);
    assert.deepEqual(rows.map((row) => row.model), ['deepseek-v4-flash', 'deepseek-v4-flash']);
    assert.deepEqual(rows.map((row) => row.provider), ['opencode-go', 'opencode-go']);
  });
});

test('collectDshRows matches tokscale dsh semantics for forks and replayed records', () => {
  withHome((home, sessionsRoot) => {
    const dir = path.join(sessionsRoot, 'proj', 'session-fork');
    const replayed = usageLine({ time: 1750000020000, seq: 3, id: 'm2', input: 30, output: 9 });
    writeTranscript(path.join(dir, 'session.jsonl'), [
      sessionLine('session-fork', { createdAt: 1750000000000, seedLength: 2 }),
      // seq < seedLength: inherited from the parent, credited to the parent.
      usageLine({ time: 1750000004000, seq: 0, id: 'm0', input: 1, output: 1 }),
      usageLine({ time: 1750000007000, seq: 1, id: 'm1-seeded', input: 2, output: 2 }),
      // The fork's own first event is the one AT seq === seedLength.
      usageLine({ time: 1750000010000, seq: 2, id: 'm1', input: 20, output: 4 }),
      replayed,
      // dsh can replay an already-flushed line; tokscale dedupes it.
      replayed
    ]);

    const rows = collectDshRows({ homeDir: home });
    assert.equal(rows.length, 2, 'the seeded prefix and the replayed line are not billable here');
    assert.deepEqual(rows.map((row) => row.input), [20, 30]);
    assert.deepEqual(rows.map((row) => row.createdAt), [1750000010000, 1750000020000]);
  });
});

test('buildDshPeriods buckets on local midnight, like every other client', () => {
  const now = new Date(2026, 8, 10, 12, 0, 0);
  const atLocal = (...parts) => new Date(...parts).getTime();
  withHome((home, sessionsRoot) => {
    writeTranscript(path.join(sessionsRoot, 'proj', 'session-1', 'session.jsonl'), [
      sessionLine('session-1'),
      // 00:30 local today, 23:30 local yesterday, and 00:05 local on the 1st.
      usageLine({ time: atLocal(2026, 8, 10, 0, 30), id: 'today', input: 100, output: 10 }),
      usageLine({ time: atLocal(2026, 8, 9, 23, 30), id: 'yesterday', input: 200, output: 20 }),
      usageLine({ time: atLocal(2026, 8, 1, 0, 5), id: 'month-start', input: 400, output: 40 })
    ]);

    const periods = buildDshPeriods({ homeDir: home, now, allTimeSince: '2026-01-01' });
    assert.equal(periods.today.totalInput, 100);
    assert.equal(periods.today.totalMessages, 1);
    // Yesterday's 23:30 is inside the month but must not leak into today.
    assert.equal(periods.month.totalInput, 700);
    assert.equal(periods.month.totalMessages, 3);
    assert.equal(periods.allTime.totalInput, 700);
  });
});

test('buildDshPeriods prices rows per token and keeps unknown models at zero', () => {
  const now = new Date(2026, 8, 10, 12, 0, 0);
  withHome((home, sessionsRoot) => {
    writeTranscript(path.join(sessionsRoot, 'proj', 'session-1', 'session.jsonl'), [
      sessionLine('session-1'),
      usageLine({ time: new Date(2026, 8, 10, 1, 0).getTime(), id: 'known', input: 1_000_000, output: 100_000, cacheRead: 2_000_000, model: 'priced-model' }),
      usageLine({ time: new Date(2026, 8, 10, 2, 0).getTime(), id: 'unknown', input: 500_000, output: 0, model: 'unpriced-model' })
    ]);

    const json = buildDshPeriods({
      homeDir: home,
      now,
      allTimeSince: '2026-01-01',
      pricingByModel: {
        'priced-model': {
          inputCostPerToken: 2.84167e-7,
          outputCostPerToken: 8.525e-7,
          cacheReadInputTokenCost: 9.042e-9
        }
      }
    }).allTime;

    const priced = json.entries.find((entry) => entry.model === 'priced-model');
    assert.equal(priced.cost, 1_000_000 * 2.84167e-7 + 100_000 * 8.525e-7 + 2_000_000 * 9.042e-9);
    const unpriced = json.entries.find((entry) => entry.model === 'unpriced-model');
    assert.equal(unpriced.cost, 0, 'a model nobody can price must not borrow another rate');
  });
});

test('buildDshPeriods publishes reasoning disjoint from output, as tokscale does', () => {
  const now = new Date(2026, 8, 10, 12, 0, 0);
  withHome((home, sessionsRoot) => {
    writeTranscript(path.join(sessionsRoot, 'proj', 'session-1', 'session.jsonl'), [
      sessionLine('session-1'),
      usageLine({ time: new Date(2026, 8, 10, 1, 0).getTime(), input: 10, output: 100, cacheRead: 5, reasoning: 40 })
    ]);

    const entry = buildDshPeriods({ homeDir: home, now, allTimeSince: '2026-01-01' }).today.entries[0];
    // The shared token math adds dsh's reasoning back on top of `output`, so the
    // published bucket is the reasoning-free remainder: 100 - 40.
    assert.equal(entry.output, 60);
    assert.equal(entry.reasoning, 40);
    assert.equal(entry.input + entry.output + entry.reasoning + entry.cacheRead, 115);
  });
});

test('buildDshHistoryGraph emits per-day, per-model contributions', () => {
  withHome((home, sessionsRoot) => {
    const dayOne = new Date(2026, 8, 9, 10, 0).getTime();
    const dayTwo = new Date(2026, 8, 10, 10, 0).getTime();
    writeTranscript(path.join(sessionsRoot, 'proj', 'session-1', 'session.jsonl'), [
      sessionLine('session-1'),
      usageLine({ time: dayOne, id: 'a', model: 'deepseek-v4-pro', input: 10, output: 100, reasoning: 40 }),
      usageLine({ time: dayTwo, id: 'b', input: 20, output: 8 })
    ]);

    const graph = buildDshHistoryGraph({
      homeDir: home,
      allTimeSince: '2026-01-01',
      pricingByModel: { 'deepseek-v4-pro': { inputCostPerToken: 1e-6, outputCostPerToken: 1e-6 } }
    });
    assert.equal(graph.contributions.length, 2);
    const [first, second] = graph.contributions;
    assert.equal(first.clients[0].client, 'dsh');
    assert.equal(first.clients[0].modelId, 'deepseek-v4-pro');
    assert.equal(first.clients[0].tokens.output, 60);
    assert.equal(first.clients[0].tokens.reasoning, 40);
    assert.ok(Math.abs(first.clients[0].cost - (10e-6 + 100e-6)) < 1e-15);
    assert.equal(second.clients[0].modelId, 'deepseek-v4-flash');
    assert.equal(second.clients[0].tokens.output, 8);
  });
});

test('collectDshRows reuses parsed rows until the transcript moves', () => {
  const file = path.join(os.tmpdir(), 'tm-dsh-cache-check', 'session.jsonl');
  withHome((home, sessionsRoot) => {
    const transcript = path.join(sessionsRoot, 'proj', 'session-1', 'session.jsonl');
    writeTranscript(transcript, [sessionLine('session-1'), usageLine({ time: 1750000005000, input: 7, output: 3 })]);

    const cache = new Map();
    const fsApi = require('node:fs');
    const realReadFileSync = fsApi.readFileSync;
    let reads = 0;
    fsApi.readFileSync = (...args) => { reads += 1; return realReadFileSync(...args); };
    try {
      const first = collectDshRows({ homeDir: home, cache });
      assert.equal(first.length, 1);
      assert.equal(reads, 1);
      const second = collectDshRows({ homeDir: home, cache });
      assert.equal(second.length, 1);
      assert.equal(reads, 1, 'an unchanged transcript must not be decompressed again');

      // A growing live session changes size (and mtime), which must invalidate.
      writeTranscript(transcript, [
        sessionLine('session-1'),
        usageLine({ time: 1750000005000, input: 7, output: 3 }),
        usageLine({ time: 1750000009000, id: 'm2', input: 11, output: 4 })
      ]);
      const third = collectDshRows({ homeDir: home, cache });
      assert.equal(third.length, 2);
      assert.equal(reads, 2, 'an appended transcript must be re-read');
    } finally {
      fsApi.readFileSync = realReadFileSync;
    }
  });
  assert.equal(file.length > 0, true);
});
