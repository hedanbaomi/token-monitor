'use strict';

const { DatabaseSync } = require('node:sqlite');

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  for (let index = 0; index < 10 && cursor < buffer.length; index += 1) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
  return null;
}

function encodeVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

function protobufFields(input) {
  const buffer = Buffer.from(input || []);
  const fields = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = cursor;
    const tag = readVarint(buffer, cursor);
    if (!tag) return null;
    cursor = tag.next;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (number <= 0) return null;
    let payloadStart = cursor;
    let payloadEnd;
    if (wireType === 0) {
      const value = readVarint(buffer, cursor);
      if (!value) return null;
      payloadEnd = value.next;
      cursor = payloadEnd;
    } else if (wireType === 1) {
      payloadEnd = cursor + 8;
      cursor = payloadEnd;
    } else if (wireType === 2) {
      const length = readVarint(buffer, cursor);
      if (!length || length.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      payloadStart = length.next;
      payloadEnd = payloadStart + Number(length.value);
      cursor = payloadEnd;
    } else if (wireType === 5) {
      payloadEnd = cursor + 4;
      cursor = payloadEnd;
    } else {
      return null;
    }
    if (payloadEnd > buffer.length) return null;
    fields.push({ start, end: cursor, number, wireType, payloadStart, payloadEnd });
  }
  return { buffer, fields };
}

function messagePayload(input, number) {
  const parsed = protobufFields(input);
  const field = parsed?.fields.find((candidate) => candidate.number === number && candidate.wireType === 2);
  return field ? parsed.buffer.subarray(field.payloadStart, field.payloadEnd) : null;
}

function varintValue(input, number) {
  const parsed = protobufFields(input);
  const field = parsed?.fields.find((candidate) => candidate.number === number && candidate.wireType === 0);
  if (!field) return null;
  return readVarint(parsed.buffer, field.payloadStart)?.value ?? null;
}

function encodeMessageField(number, payload) {
  const body = Buffer.from(payload);
  return Buffer.concat([
    encodeVarint((BigInt(number) << 3n) | 2n),
    encodeVarint(body.length),
    body
  ]);
}

function replaceFirstMessageField(input, number, transform) {
  const parsed = protobufFields(input);
  if (!parsed) return { buffer: Buffer.from(input || []), changed: false };
  const field = parsed.fields.find((candidate) => candidate.number === number && candidate.wireType === 2);
  if (!field) return { buffer: parsed.buffer, changed: false };
  const current = parsed.buffer.subarray(field.payloadStart, field.payloadEnd);
  const replacement = transform(current);
  if (!replacement || Buffer.from(replacement).equals(current)) return { buffer: parsed.buffer, changed: false };
  return {
    buffer: Buffer.concat([
      parsed.buffer.subarray(0, field.start),
      encodeMessageField(number, replacement),
      parsed.buffer.subarray(field.end)
    ]),
    changed: true
  };
}

function validTimestampPayload(payload) {
  if (!payload) return null;
  const seconds = varintValue(payload, 1);
  const nanos = varintValue(payload, 2) ?? 0n;
  if (seconds === null || seconds <= 0n || nanos < 0n || nanos > 999_999_999n) return null;
  return Buffer.from(payload);
}

function antigravityGenerationTimestampPayload(generationBlob) {
  const chatModel = messagePayload(generationBlob, 1);
  const generation = chatModel && messagePayload(chatModel, 9);
  return validTimestampPayload(generation && messagePayload(generation, 4));
}

function antigravityGenerationTimestampMs(generationBlob) {
  const timestamp = antigravityGenerationTimestampPayload(generationBlob);
  if (!timestamp) return null;
  const seconds = varintValue(timestamp, 1);
  const nanos = varintValue(timestamp, 2) ?? 0n;
  const milliseconds = seconds * 1000n + nanos / 1_000_000n;
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null;
}

function timestampPayloadFromGenerationStep(metadata) {
  return validTimestampPayload(messagePayload(metadata, 8));
}

function injectGenerationTimestamp(generationBlob, timestampPayload) {
  if (antigravityGenerationTimestampPayload(generationBlob)) return Buffer.from(generationBlob);
  const outer = replaceFirstMessageField(generationBlob, 1, (chatModel) => {
    const chat = replaceFirstMessageField(chatModel, 9, (generation) => (
      Buffer.concat([Buffer.from(generation), encodeMessageField(4, timestampPayload)])
    ));
    return chat.changed ? chat.buffer : chatModel;
  });
  return outer.changed ? outer.buffer : Buffer.from(generationBlob);
}

function repairAntigravityTimestampDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const generations = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
    const steps = db.prepare('SELECT metadata FROM steps WHERE step_type = 15 ORDER BY idx').all();
    if (generations.length !== steps.length) {
      return { generations: generations.length, repaired: 0, reason: 'step-count-mismatch' };
    }
    const hasSize = db.prepare('PRAGMA table_info(gen_metadata)').all().some((column) => column.name === 'size');
    const update = db.prepare(hasSize
      ? 'UPDATE gen_metadata SET data = ?, size = ? WHERE idx = ?'
      : 'UPDATE gen_metadata SET data = ? WHERE idx = ?');
    let repaired = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < generations.length; index += 1) {
        const generation = generations[index];
        if (antigravityGenerationTimestampPayload(generation.data)) continue;
        const timestamp = timestampPayloadFromGenerationStep(steps[index].metadata);
        if (!timestamp) continue;
        const next = injectGenerationTimestamp(generation.data, timestamp);
        if (next.equals(Buffer.from(generation.data))) continue;
        if (hasSize) update.run(next, next.length, generation.idx);
        else update.run(next, generation.idx);
        repaired += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    return { generations: generations.length, repaired, reason: null };
  } catch (error) {
    if (String(error?.message || '').includes('no such table')) {
      return { generations: 0, repaired: 0, reason: 'unsupported-schema' };
    }
    throw error;
  } finally {
    db.close();
  }
}

module.exports = {
  antigravityGenerationTimestampMs,
  repairAntigravityTimestampDatabase
};
