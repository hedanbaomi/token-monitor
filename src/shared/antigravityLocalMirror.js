'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { repairAntigravityTimestampDatabase } = require('./antigravityTimestampRepair');

const mirrors = new Map();
let exitCleanupInstalled = false;
let stagingSequence = 0;

function statFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return 'missing';
  }
}

function databaseFingerprint(dbPath) {
  return `${statFingerprint(dbPath)}|wal=${statFingerprint(`${dbPath}-wal`)}`;
}

function sqlString(value) {
  const quote = String.fromCharCode(39);
  return quote + String(value).replaceAll(quote, quote + quote) + quote;
}

function consistentSqliteSnapshot(sourcePath, targetPath) {
  const stagedPath = `${targetPath}.stage-${process.pid}-${stagingSequence += 1}`;
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout = 2000');
      source.exec(`VACUUM INTO ${sqlString(stagedPath)}`);
    } finally {
      source.close();
    }
    const repair = repairAntigravityTimestampDatabase(stagedPath);
    if (repair.reason) return { published: false, repair };
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.renameSync(stagedPath, targetPath);
    return { published: true, repair };
  } finally {
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  }
}

function createMirror(sourceRoot) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-antigravity-mirror-'));
  const conversationsDir = path.join(tempHome, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  return { sourceRoot, tempHome, conversationsDir, fingerprints: new Map() };
}

function cleanupMirror(mirror) {
  try {
    for (const entry of fs.readdirSync(mirror.conversationsDir, { withFileTypes: true })) {
      if (entry.isFile()) fs.unlinkSync(path.join(mirror.conversationsDir, entry.name));
    }
  } catch (_) {}
  for (const dir of [
    mirror.conversationsDir,
    path.dirname(mirror.conversationsDir),
    path.dirname(path.dirname(mirror.conversationsDir)),
    mirror.tempHome
  ]) {
    try { fs.rmdirSync(dir); } catch (_) {}
  }
}

function resetAntigravityLocalMirrors() {
  for (const mirror of mirrors.values()) cleanupMirror(mirror);
  mirrors.clear();
}

function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once('exit', resetAntigravityLocalMirrors);
}

function antigravityLocalMirrorHome(sourceRoot, options = {}) {
  const resolvedRoot = path.resolve(sourceRoot);
  let mirror = mirrors.get(resolvedRoot);
  if (!mirror) {
    mirror = createMirror(resolvedRoot);
    mirrors.set(resolvedRoot, mirror);
    installExitCleanup();
  }

  const databaseNames = fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.db'))
    .map((entry) => entry.name)
    .sort();
  const currentNames = new Set(databaseNames);
  for (const [name] of mirror.fingerprints) {
    if (currentNames.has(name)) continue;
    const targetPath = path.join(mirror.conversationsDir, name);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    mirror.fingerprints.delete(name);
  }

  for (const name of databaseNames) {
    const sourcePath = path.join(resolvedRoot, name);
    const targetPath = path.join(mirror.conversationsDir, name);
    const fingerprint = databaseFingerprint(sourcePath);
    if (mirror.fingerprints.get(name) === fingerprint && fs.existsSync(targetPath)) continue;
    try {
      const snapshot = consistentSqliteSnapshot(sourcePath, targetPath);
      if (!snapshot.published) {
        if (typeof options.logger === 'function') {
          options.logger(`antigravity timestamp mirror skipped ${name}: ${snapshot.repair.reason}`);
        }
        continue;
      }
      mirror.fingerprints.set(name, fingerprint);
    } catch (error) {
      if (typeof options.logger === 'function') {
        options.logger(`antigravity timestamp mirror failed ${name}: ${error.message}`);
      }
    }
  }
  return mirror.tempHome;
}

module.exports = {
  antigravityLocalMirrorHome,
  resetAntigravityLocalMirrors
};
