'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { collectUsageOnce } = require('../../src/shared/collector');

function row(client, sessionId, input) {
  return {
    client,
    sessionId,
    model: 'gemini-3.7-flash',
    provider: 'google',
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messageCount: 1,
    cost: 0
  };
}

test('Windows collection supplements Antigravity sessions missing from the RPC cache', async () => {
  const fallbackFlags = [];
  const summary = await collectUsageOnce({
    clients: 'antigravity',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-windows-fallback',
    platform: 'win32',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({
      entries: [row('antigravity', 'cached-session', 100)]
    }),
    collectAntigravityLocalUsage: async ({ flags }) => {
      fallbackFlags.push(flags);
      return {
        entries: [
          row('antigravity-cli', 'cached-session', 90),
          row('antigravity-cli', 'live-session', 7)
        ]
      };
    }
  });

  assert.deepEqual(fallbackFlags, [
    ['--today'],
    ['--month'],
    ['--since', '2026-01-01']
  ]);
  assert.equal(summary.today.clients.antigravity, 107);
  assert.equal(summary.month.clients.antigravity, 107);
  assert.equal(summary.allTime.clients.antigravity, 107);
  assert.equal(summary.today.sessions['antigravity:cached-session'].totalTokens, 100);
  assert.equal(summary.today.sessions['antigravity:live-session'].totalTokens, 7);
});

test('non-Windows collection does not invoke the Antigravity local fallback', async () => {
  let fallbackCalls = 0;
  const summary = await collectUsageOnce({
    clients: 'antigravity',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-darwin',
    platform: 'darwin',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    collectAntigravityLocalUsage: async () => {
      fallbackCalls += 1;
      return { entries: [row('antigravity-cli', 'should-not-appear', 7)] };
    }
  });

  assert.equal(fallbackCalls, 0);
  assert.equal(summary.today.clients.antigravity, undefined);
});

test('Windows fallback refreshes a stale RPC-cache session without double-counting it', async () => {
  const summary = await collectUsageOnce({
    clients: 'antigravity',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-stale-session',
    platform: 'win32',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [row('antigravity', 'live-session', 100)] }),
    collectAntigravityLocalUsage: async () => ({ entries: [row('antigravity-cli', 'live-session', 120)] })
  });

  assert.equal(summary.today.clients.antigravity, 120);
  assert.equal(summary.today.sessions['antigravity:live-session'].totalTokens, 120);
});

test('Windows fallback refuses to merge into aggregate-only primary usage', async () => {
  const summary = await collectUsageOnce({
    clients: 'antigravity',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-aggregate-only',
    platform: 'win32',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [], totalInput: 100 }),
    collectAntigravityLocalUsage: async () => ({ entries: [row('antigravity-cli', 'live-session', 120)] })
  });

  assert.equal(summary.today.totalTokens, 100);
  assert.equal(summary.today.clients.antigravity, undefined);
});

test('Windows fallback refuses to merge nested primary rows it cannot replace safely', async () => {
  const summary = await collectUsageOnce({
    clients: 'antigravity,codex',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-nested-primary',
    platform: 'win32',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({
      data: [row('antigravity', 'live-session', 100), row('codex', 'codex-session', 3)]
    }),
    collectAntigravityLocalUsage: async () => ({ entries: [row('antigravity-cli', 'live-session', 120)] })
  });

  assert.equal(summary.today.clients.antigravity, 100);
  assert.equal(summary.today.clients.codex, 3);
});

test('Windows fallback accepts threadId as an Antigravity session identity', async () => {
  const localRow = row('antigravity-cli', undefined, 7);
  localRow.threadId = 'thread-session';
  const summary = await collectUsageOnce({
    clients: 'antigravity',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-thread-session',
    platform: 'win32',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    collectAntigravityLocalUsage: async () => ({ entries: [localRow] })
  });

  assert.equal(summary.today.clients.antigravity, 7);
  assert.equal(summary.today.sessions['antigravity:thread-session'].totalTokens, 7);
});

test('targeted Antigravity refresh carries the local-session delta into broader periods', async () => {
  let anchor = null;
  let liveTokens = 7;
  const options = {
    clients: 'antigravity',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'antigravity-targeted-fallback',
    platform: 'win32',
    homeDir: 'Z:\\missing-antigravity-test-home',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({
      entries: [row('antigravity', 'cached-session', 100)]
    }),
    collectAntigravityLocalUsage: async () => ({
      entries: [row('antigravity-cli', 'live-session', liveTokens)]
    })
  };

  await collectUsageOnce({
    ...options,
    onAnchorComputed: (value) => { anchor = value.windowsPeriods; }
  });
  liveTokens = 12;
  const refreshed = await collectUsageOnce({
    ...options,
    targetClients: ['antigravity'],
    todayOnlyAnchor: anchor
  });

  assert.equal(refreshed.today.clients.antigravity, 112);
  assert.equal(refreshed.month.clients.antigravity, 112);
  assert.equal(refreshed.allTime.clients.antigravity, 112);
});
