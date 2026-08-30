'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  antigravityGenerationTimestampMs,
  repairAntigravityTimestampDatabase
} = require('../../src/shared/antigravityTimestampRepair');
const {
  antigravityLocalMirrorHome,
  resetAntigravityLocalMirrors
} = require('../../src/shared/antigravityLocalMirror');

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function varintField(number, value) {
  return Buffer.concat([varint((number << 3) | 0), varint(value)]);
}

function messageField(number, payload) {
  return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
}

function timestamp(seconds, nanos = 0) {
  return Buffer.concat([varintField(1, seconds), varintField(2, nanos)]);
}

function generationBlob(existingTimestamp = null) {
  const generation = Buffer.concat([
    varintField(2, 1),
    ...(existingTimestamp ? [messageField(4, existingTimestamp)] : []),
    messageField(10, Buffer.from([0x08, 0x01]))
  ]);
  const usage = Buffer.concat([varintField(1, 100), varintField(9, 20)]);
  const chatModel = Buffer.concat([messageField(4, usage), messageField(9, generation)]);
  return messageField(1, chatModel);
}

function stepMetadata(stepTimestamp) {
  return messageField(8, stepTimestamp);
}

function fixtureDatabase(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-antigravity-repair-test-'));
  const dbPath = path.join(dir, 'conversation.db');
  const db = new DatabaseSync(dbPath);
  db.exec([
    'CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)',
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)'
  ].join(';'));
  const insertGeneration = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  const insertStep = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)');
  for (const [index, row] of rows.entries()) {
    insertGeneration.run(index, row.generation, row.generation.length);
    insertStep.run(index * 2 + 2, row.step);
  }
  db.close();
  t.after(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    fs.rmdirSync(dir);
  });
  return dbPath;
}

test('repairs missing Antigravity generation timestamps from matching generation steps', (t) => {
  const first = timestamp(1_787_639_377, 886_000_000);
  const second = timestamp(1_787_639_439, 112_000_000);
  const dbPath = fixtureDatabase(t, [
    { generation: generationBlob(), step: stepMetadata(first) },
    { generation: generationBlob(), step: stepMetadata(second) }
  ]);

  const result = repairAntigravityTimestampDatabase(dbPath);
  assert.deepEqual(result, { generations: 2, repaired: 2, reason: null });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
  db.close();
  assert.equal(antigravityGenerationTimestampMs(rows[0].data), 1_787_639_377_886);
  assert.equal(antigravityGenerationTimestampMs(rows[1].data), 1_787_639_439_112);
});

test('preserves an existing generation timestamp', (t) => {
  const existing = timestamp(1_787_557_904, 100_000_000);
  const replacement = timestamp(1_787_639_377, 900_000_000);
  const dbPath = fixtureDatabase(t, [
    { generation: generationBlob(existing), step: stepMetadata(replacement) }
  ]);

  const result = repairAntigravityTimestampDatabase(dbPath);
  assert.deepEqual(result, { generations: 1, repaired: 0, reason: null });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT data FROM gen_metadata').get();
  db.close();
  assert.equal(antigravityGenerationTimestampMs(row.data), 1_787_557_904_100);
});

test('fails closed when generation and step counts cannot be paired', (t) => {
  const dbPath = fixtureDatabase(t, [
    { generation: generationBlob(), step: stepMetadata(timestamp(1_787_639_377)) }
  ]);
  const db = new DatabaseSync(dbPath);
  db.exec('DELETE FROM steps');
  db.close();

  const result = repairAntigravityTimestampDatabase(dbPath);
  assert.deepEqual(result, { generations: 1, repaired: 0, reason: 'step-count-mismatch' });
});

test('reuses a repaired local mirror until the source database changes', (t) => {
  t.after(resetAntigravityLocalMirrors);
  const dbPath = fixtureDatabase(t, [
    { generation: generationBlob(), step: stepMetadata(timestamp(1_787_639_377, 886_000_000)) }
  ]);
  const sourceRoot = path.dirname(dbPath);

  const firstHome = antigravityLocalMirrorHome(sourceRoot);
  const mirrorDb = path.join(firstHome, '.gemini', 'antigravity-cli', 'conversations', path.basename(dbPath));
  const firstStat = fs.statSync(mirrorDb);
  let db = new DatabaseSync(mirrorDb, { readOnly: true });
  let rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
  db.close();
  assert.equal(antigravityGenerationTimestampMs(rows[0].data), 1_787_639_377_886);

  const secondHome = antigravityLocalMirrorHome(sourceRoot);
  assert.equal(secondHome, firstHome);
  assert.equal(fs.statSync(mirrorDb).mtimeMs, firstStat.mtimeMs);

  db = new DatabaseSync(dbPath);
  const generation = generationBlob();
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, generation, generation.length);
  db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)')
    .run(4, stepMetadata(timestamp(1_787_639_439, 112_000_000)));
  db.close();

  antigravityLocalMirrorHome(sourceRoot);
  db = new DatabaseSync(mirrorDb, { readOnly: true });
  rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
  db.close();
  assert.equal(rows.length, 2);
  assert.equal(antigravityGenerationTimestampMs(rows[1].data), 1_787_639_439_112);
});

test('keeps the last good mirror and retries when a source snapshot cannot be paired', (t) => {
  t.after(resetAntigravityLocalMirrors);
  const dbPath = fixtureDatabase(t, [
    { generation: generationBlob(), step: stepMetadata(timestamp(1_787_639_377, 886_000_000)) }
  ]);
  const sourceRoot = path.dirname(dbPath);
  const mirrorHome = antigravityLocalMirrorHome(sourceRoot);
  const mirrorDb = path.join(
    mirrorHome,
    '.gemini',
    'antigravity-cli',
    'conversations',
    path.basename(dbPath)
  );

  let db = new DatabaseSync(dbPath);
  const generation = generationBlob();
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, generation, generation.length);
  db.close();

  const messages = [];
  antigravityLocalMirrorHome(sourceRoot, { logger: (message) => messages.push(message) });
  antigravityLocalMirrorHome(sourceRoot, { logger: (message) => messages.push(message) });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /step-count-mismatch/);

  db = new DatabaseSync(mirrorDb, { readOnly: true });
  const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(antigravityGenerationTimestampMs(rows[0].data), 1_787_639_377_886);
});
