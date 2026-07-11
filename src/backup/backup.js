#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { pipeline } = require('node:stream/promises');
const archiver = require('archiver');

const EXIT = Object.freeze({
  USAGE: 2,
  VALIDATION: 3,
  ARCHIVE: 4,
  COPY: 5,
  INTERRUPTED: 130,
});
const MAX_FILENAME_BYTES = 255;
const UUID_V4_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TEMPORARY_FILE_PATTERN = new RegExp(`^\\.backup-(?:archive|copy|lock)-${UUID_V4_PATTERN}\\.tmp$`, 'i');
const LOCK_FILENAME = '.backup.lock';
const LOCK_REGISTRY_DIRECTORY = path.join(os.tmpdir(), '.backup-directory-locks-v1');
const LOCK_REGISTRY_MUTEX = '.registry.lock';

class InterruptedError extends Error {
  constructor(signal = 'SIGINT') {
    super(`Interrupted by ${signal}; temporary-file cleanup was requested.`);
    this.name = 'InterruptedError';
    this.signal = signal;
    this.exitCode = signal === 'SIGTERM' ? 143 : EXIT.INTERRUPTED;
  }
}

function fail(message, exitCode) {
  console.error(`Error: ${message}`);
  process.exitCode = exitCode;
}

function usage() {
  console.error('Usage: node src/backup/backup.js <backup-config.local.json>');
}

function resolveConfigPath(value, configDirectory) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configDirectory, value);
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent, child) {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function identityOf(details) {
  return `${details.dev}:${details.ino}`;
}

async function validateDirectory(configuredPath, label, accessMode) {
  let canonicalPath;
  let details;
  try {
    canonicalPath = await fsp.realpath(configuredPath);
    details = await fsp.stat(canonicalPath, { bigint: true });
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be accessed: ${configuredPath} (${error.code || error.message})`);
  }
  if (!details.isDirectory()) {
    throw new Error(`${label} must be a directory: ${configuredPath}`);
  }
  try {
    await fsp.access(canonicalPath, accessMode);
  } catch (error) {
    const requirement = accessMode & fs.constants.W_OK
      ? 'writable and searchable so files can be created and renamed'
      : 'readable and searchable so its contents can be enumerated';
    throw new Error(`${label} must be ${requirement}: ${configuredPath} (${error.code || error.message})`);
  }
  return {
    label,
    configuredPath,
    canonicalPath,
    identity: identityOf(details),
  };
}

async function assertDirectoryUnchanged(directory) {
  let canonicalPath;
  let details;
  try {
    canonicalPath = await fsp.realpath(directory.configuredPath);
    details = await fsp.stat(canonicalPath, { bigint: true });
  } catch (error) {
    throw new Error(`${directory.label} changed or became inaccessible after validation: ${directory.configuredPath} (${error.code || error.message})`);
  }
  if (!details.isDirectory() || comparablePath(canonicalPath) !== comparablePath(directory.canonicalPath) ||
      identityOf(details) !== directory.identity) {
    throw new Error(`${directory.label} no longer identifies the directory validated earlier: ${directory.configuredPath}`);
  }
}

function safeFolderName(folderName) {
  const safe = folderName.replaceAll(' ', '-').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/g, '');
  return safe || 'Backup';
}

function truncateUtf8(value, maximumBytes) {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function backupFilename(sourceDirectory, now = new Date()) {
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now);
  const day = String(now.getDate()).padStart(2, '0');
  const year = String(now.getFullYear());
  const name = safeFolderName(path.basename(sourceDirectory));
  const suffix = `_Backup_${month}${day}${year}.zip`;
  const candidate = `${name}${suffix}`;
  if (Buffer.byteLength(candidate) <= MAX_FILENAME_BYTES) return candidate;

  const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
  const marker = `-${digest}`;
  const prefixBudget = MAX_FILENAME_BYTES - Buffer.byteLength(marker) - Buffer.byteLength(suffix);
  return `${truncateUtf8(name, prefixBudget)}${marker}${suffix}`;
}

async function pathKind(destination, label) {
  try {
    const details = await fsp.stat(destination);
    if (details.isDirectory()) throw new Error(`${label} exists but is a directory: ${destination}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readAndValidate(configPath, now = new Date()) {
  let contents;
  try {
    contents = await fsp.readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read configuration file ${configPath}: ${error.code || error.message}`);
  }

  let config;
  try {
    config = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Configuration file contains invalid JSON: ${error.message}`);
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('Configuration must be a JSON object.');
  }
  if (typeof config.sourceDirectory !== 'string' || !config.sourceDirectory.trim()) {
    throw new Error('"sourceDirectory" is required and must be a non-empty string.');
  }
  if (!Array.isArray(config.targetDirectories) || config.targetDirectories.length === 0 ||
      config.targetDirectories.some((directory) => typeof directory !== 'string' || !directory.trim())) {
    throw new Error('"targetDirectories" is required and must be a non-empty array of non-empty strings.');
  }
  if (config.outputDirectory !== undefined && (typeof config.outputDirectory !== 'string' || !config.outputDirectory.trim())) {
    throw new Error('"outputDirectory", when provided, must be a non-empty string.');
  }

  const configDirectory = path.dirname(configPath);
  const sourceConfigured = resolveConfigPath(config.sourceDirectory, configDirectory);
  const outputConfigured = config.outputDirectory
    ? resolveConfigPath(config.outputDirectory, configDirectory)
    : os.tmpdir();
  const targetConfigured = config.targetDirectories.map((directory) => resolveConfigPath(directory, configDirectory));
  const source = await validateDirectory(sourceConfigured, 'sourceDirectory', fs.constants.R_OK | fs.constants.X_OK);
  const output = await validateDirectory(outputConfigured, 'outputDirectory', fs.constants.W_OK | fs.constants.X_OK);
  const targets = await Promise.all(targetConfigured.map((directory, index) =>
    validateDirectory(directory, `targetDirectories[${index}]`, fs.constants.W_OK | fs.constants.X_OK)));

  if (isWithin(source.canonicalPath, output.canonicalPath)) {
    throw new Error(`outputDirectory must not resolve to sourceDirectory or one of its subdirectories: ${output.configuredPath} -> ${output.canonicalPath}`);
  }
  for (const target of targets) {
    if (isWithin(source.canonicalPath, target.canonicalPath)) {
      throw new Error(`${target.label} must not resolve to sourceDirectory or one of its subdirectories: ${target.configuredPath} -> ${target.canonicalPath}`);
    }
  }

  const filename = backupFilename(source.canonicalPath, now);
  const archivePath = path.join(output.canonicalPath, filename);
  const retainArchive = targets.some((target) => target.identity === output.identity);
  const archiveExists = retainArchive ? await pathKind(archivePath, 'Archive output path') : false;
  const seen = new Map([[output.identity, 'outputDirectory']]);
  const previewTargets = [];
  const copyTargets = [];
  for (const target of targets) {
    const destination = path.join(target.canonicalPath, filename);
    const sharedWith = seen.get(target.identity);
    if (sharedWith) {
      previewTargets.push({ directory: target, destination, action: `shared with ${sharedWith}; no additional copy` });
      continue;
    }
    seen.set(target.identity, target.label);
    const exists = await pathKind(destination, 'Destination');
    const item = { directory: target, destination, action: exists ? 'will be overwritten' : 'will be created' };
    previewTargets.push(item);
    copyTargets.push(item);
  }

  return { source, output, targets, filename, archivePath, archiveExists, retainArchive, previewTargets, copyTargets };
}

function shortTempPath(directory, kind = 'work') {
  return path.join(directory, `.backup-${kind}-${crypto.randomUUID()}.tmp`);
}

function printPreview(plan) {
  console.log('Backup execution preview');
  console.log(`  Source: ${plan.source.canonicalPath}`);
  console.log(`  ZIP filename: ${plan.filename}`);
  if (plan.retainArchive) {
    console.log(`  Archive output: ${plan.archivePath} — ${plan.archiveExists ? 'will be overwritten' : 'will be created'}`);
  } else {
    console.log(`  Archive output: temporary staging in ${plan.output.canonicalPath}; removed after replication`);
  }
  console.log('  Targets:');
  for (const target of plan.previewTargets) console.log(`    ${target.destination} — ${target.action}`);
}

async function confirmExecution(context) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const unregister = context.onAbort(() => prompt.close());
  try {
    process.stdout.write('Proceed? [y/N] ');
    for await (const answer of prompt) {
      const response = answer.trim();
      context.throwIfInterrupted();
      return response === 'Y' || response === 'y' || response === 'yes';
    }
    context.throwIfInterrupted();
    return false;
  } finally {
    unregister();
    prompt.close();
  }
}

class OperationContext {
  constructor() {
    this.temporaryPaths = new Set();
    this.abortHandlers = new Set();
    this.interruption = null;
  }

  track(temporaryPath) {
    this.temporaryPaths.add(temporaryPath);
  }

  untrack(temporaryPath) {
    this.temporaryPaths.delete(temporaryPath);
  }

  onAbort(handler) {
    if (this.interruption) {
      try {
        Promise.resolve(handler(this.interruption)).catch(() => {});
      } catch {}
      return () => {};
    }
    this.abortHandlers.add(handler);
    return () => this.abortHandlers.delete(handler);
  }

  throwIfInterrupted() {
    if (this.interruption) throw this.interruption;
  }

  async interrupt(signal) {
    if (this.interruption) return;
    this.interruption = new InterruptedError(signal);
    const handlers = [...this.abortHandlers].map(async (handler) => handler(this.interruption));
    await Promise.allSettled(handlers);
  }

  async cleanup() {
    const paths = [...this.temporaryPaths];
    const results = await Promise.allSettled(paths.map((temporaryPath) => fsp.rm(temporaryPath, { force: true })));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') this.temporaryPaths.delete(paths[index]);
    });
    return results
      .map((result, index) => result.status === 'rejected' ? { path: paths[index], error: result.reason } : null)
      .filter(Boolean);
  }

  cleanupSync() {
    const failures = [];
    for (const temporaryPath of this.temporaryPaths) {
      try {
        fs.rmSync(temporaryPath, { force: true });
        this.temporaryPaths.delete(temporaryPath);
      } catch (error) {
        failures.push({ path: temporaryPath, error });
      }
    }
    return failures;
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function lockIsAbandoned(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (error instanceof SyntaxError) return true;
    return false;
  }
  if (!owner || owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  return !processIsRunning(owner.pid);
}

async function removeAbandonedLock(lockPath) {
  const claimPath = `${lockPath}.${crypto.randomUUID()}.stale`;
  try {
    await fsp.link(lockPath, claimPath);
    const [lockDetails, claimDetails] = await Promise.all([fsp.stat(lockPath), fsp.stat(claimPath)]);
    if (lockDetails.dev !== claimDetails.dev || lockDetails.ino !== claimDetails.ino) return false;
    await fsp.unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fsp.rm(claimPath, { force: true }).catch(() => {});
  }
}

class DirectoryLocks {
  constructor(locks, token, registryClaimPath = null) {
    this.locks = locks;
    this.token = token;
    this.registryClaimPath = registryClaimPath;
  }

  async release() {
    const failures = [];
    for (const lockPath of [...this.locks].reverse()) {
      try {
        const owner = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
        if (owner.token === this.token) await fsp.unlink(lockPath);
        this.locks.delete(lockPath);
      } catch (error) {
        if (error.code === 'ENOENT') this.locks.delete(lockPath);
        else failures.push({ path: lockPath, error });
      }
    }
    if (this.registryClaimPath) {
      try {
        const owner = JSON.parse(await fsp.readFile(this.registryClaimPath, 'utf8'));
        if (owner.token === this.token) await fsp.unlink(this.registryClaimPath);
        this.registryClaimPath = null;
      } catch (error) {
        if (error.code === 'ENOENT') this.registryClaimPath = null;
        else failures.push({ path: this.registryClaimPath, error });
      }
    }
    return failures;
  }

  releaseSync() {
    const failures = [];
    for (const lockPath of [...this.locks].reverse()) {
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (owner.token === this.token) fs.unlinkSync(lockPath);
        this.locks.delete(lockPath);
      } catch (error) {
        if (error.code === 'ENOENT') this.locks.delete(lockPath);
        else failures.push({ path: lockPath, error });
      }
    }
    if (this.registryClaimPath) {
      try {
        const owner = JSON.parse(fs.readFileSync(this.registryClaimPath, 'utf8'));
        if (owner.token === this.token) fs.unlinkSync(this.registryClaimPath);
        this.registryClaimPath = null;
      } catch (error) {
        if (error.code === 'ENOENT') this.registryClaimPath = null;
        else failures.push({ path: this.registryClaimPath, error });
      }
    }
    return failures;
  }
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function lockClaims(plan) {
  const claims = [];
  if (plan.source) claims.push({ access: 'source', path: plan.source.canonicalPath, label: plan.source.label });
  const writable = new Map();
  for (const directory of [plan.output, ...plan.targets]) writable.set(directory.identity, directory);
  for (const directory of writable.values()) {
    claims.push({ access: 'write', path: directory.canonicalPath, label: directory.label });
  }
  return claims;
}

function conflictingClaims(leftClaims, rightClaims) {
  for (const left of leftClaims) {
    for (const right of rightClaims) {
      if ((left.access === 'write' || right.access === 'write') && pathsOverlap(left.path, right.path)) {
        return { left, right };
      }
    }
  }
  return null;
}

async function writeExclusiveJson(file, value) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireRegistryMutex(token) {
  await fsp.mkdir(LOCK_REGISTRY_DIRECTORY, { recursive: true });
  const mutexPath = path.join(LOCK_REGISTRY_DIRECTORY, LOCK_REGISTRY_MUTEX);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await writeExclusiveJson(mutexPath, { pid: process.pid, hostname: os.hostname(), token });
      return mutexPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await lockIsAbandoned(mutexPath) && await removeAbandonedLock(mutexPath)) continue;
      if (Date.now() >= deadline) throw new Error('Timed out while coordinating backup directory locks.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function releaseOwnedLock(lockPath, token) {
  try {
    const owner = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    if (owner.token === token) await fsp.unlink(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function acquireRegistryClaim(plan, token) {
  const mutexPath = await acquireRegistryMutex(token);
  try {
    const claims = lockClaims(plan);
    const entries = await fsp.readdir(LOCK_REGISTRY_DIRECTORY, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const claimPath = path.join(LOCK_REGISTRY_DIRECTORY, entry.name);
      let owner;
      try {
        owner = JSON.parse(await fsp.readFile(claimPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (!owner || typeof owner.hostname !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
        await fsp.rm(claimPath, { force: true });
        continue;
      }
      if (owner.hostname === os.hostname() && !processIsRunning(owner.pid)) {
        await fsp.rm(claimPath, { force: true });
        continue;
      }
      const conflict = conflictingClaims(claims, Array.isArray(owner.claims) ? owner.claims : []);
      if (conflict) {
        throw new Error(
          `Another backup run owns an overlapping directory: ${conflict.left.path} (${conflict.left.label}) ` +
          `overlaps ${conflict.right.path} (${conflict.right.label}).`,
        );
      }
    }
    const claimPath = path.join(LOCK_REGISTRY_DIRECTORY, `${token}.json`);
    await writeExclusiveJson(claimPath, { pid: process.pid, hostname: os.hostname(), token, claims });
    return claimPath;
  } finally {
    await releaseOwnedLock(mutexPath, token);
  }
}

async function acquireDirectoryLocks(plan) {
  const directories = new Map();
  for (const directory of [plan.output, ...plan.targets]) directories.set(directory.identity, directory);
  const ordered = [...directories.values()].sort((left, right) =>
    comparablePath(left.canonicalPath).localeCompare(comparablePath(right.canonicalPath)));
  const token = crypto.randomUUID();
  const locks = new DirectoryLocks(new Set(), token);

  try {
    for (const directory of [plan.source, ...ordered].filter(Boolean)) await assertDirectoryUnchanged(directory);
    locks.registryClaimPath = await acquireRegistryClaim(plan, token);
    for (const directory of ordered) {
      await assertDirectoryUnchanged(directory);
      const lockPath = path.join(directory.canonicalPath, LOCK_FILENAME);
      for (;;) {
        let handle;
        const metadataPath = shortTempPath(directory.canonicalPath, 'lock');
        try {
          handle = await fsp.open(metadataPath, 'wx');
          await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }));
          await handle.sync();
          await handle.close();
          handle = null;
          await fsp.link(metadataPath, lockPath);
          locks.locks.add(lockPath);
          break;
        } catch (error) {
          if (handle) await handle.close().catch(() => {});
          if (error.code !== 'EEXIST') throw error;
          if (await lockIsAbandoned(lockPath) && await removeAbandonedLock(lockPath)) continue;
          try {
            await fsp.access(lockPath);
          } catch (accessError) {
            if (accessError.code === 'ENOENT') continue;
            throw accessError;
          }
          throw new Error(`Another backup run owns ${directory.canonicalPath} (lock: ${lockPath}).`);
        } finally {
          await fsp.rm(metadataPath, { force: true }).catch(() => {});
        }
      }
    }
    return locks;
  } catch (error) {
    await locks.release();
    const releaseFailures = locks.releaseSync();
    if (releaseFailures.length) {
      error.message += ` Also failed to release ${releaseFailures.length} backup lock(s).`;
    }
    throw error;
  }
}

async function cleanupStartupArtifacts(plan) {
  const directories = new Map();
  for (const directory of [plan.output, ...plan.targets]) directories.set(directory.identity, directory);

  for (const directory of directories.values()) {
    await assertDirectoryUnchanged(directory);
    const entries = await fsp.readdir(directory.canonicalPath, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && TEMPORARY_FILE_PATTERN.test(entry.name))
      .map((entry) => fsp.rm(path.join(directory.canonicalPath, entry.name), { force: true })));
  }
}

function archiveWarningMessage(error) {
  const entry = error.path || error.file || error.entry;
  const reason = error.message || error.code || 'source content was omitted';
  return `Archiver warning${entry ? ` for ${entry}` : ''}: ${reason}`;
}

function createArchive(sourceDirectory, archivePath, context, dependencies = {}) {
  const archiveFactory = dependencies.archiveFactory || archiver;
  const outputFactory = dependencies.outputFactory || ((file) => fs.createWriteStream(file, { flags: 'wx' }));
  context.track(archivePath);
  return new Promise((resolve, reject) => {
    let output;
    try {
      output = outputFactory(archivePath);
    } catch (error) {
      reject(error);
      return;
    }
    let archive;
    try {
      archive = archiveFactory('zip', { zlib: { level: 9 } });
    } catch (error) {
      output.once('close', () => reject(error));
      output.destroy();
      return;
    }
    let failure = null;
    let settled = false;
    let unregister = () => {};

    const settle = () => {
      if (settled) return;
      settled = true;
      unregister();
      failure ? reject(failure) : resolve();
    };
    const abort = (error) => {
      if (!failure) failure = error;
      try { archive.abort(); } catch {}
      if (!output.destroyed) output.destroy();
      if (output.closed) queueMicrotask(settle);
    };
    const closed = new Promise((resolveClosed) => output.once('close', resolveClosed));
    output.once('close', settle);
    output.once('error', abort);
    archive.once('error', abort);
    archive.on('warning', (error) => abort(new Error(archiveWarningMessage(error))));
    unregister = context.onAbort((error) => {
      abort(error);
      return closed;
    });
    if (failure) return;
    try {
      archive.pipe(output);
      archive.directory(sourceDirectory, false);
      Promise.resolve(archive.finalize()).catch(abort);
    } catch (error) {
      abort(error);
    }
  });
}

async function copyAtomically(source, target, context, dependencies = {}) {
  const temporary = shortTempPath(target.directory.canonicalPath, 'copy');
  const controller = new AbortController();
  const unregister = context.onAbort(() => controller.abort());
  context.track(temporary);
  try {
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(target.directory);
    const input = (dependencies.createReadStream || fs.createReadStream)(source);
    const output = (dependencies.createWriteStream || fs.createWriteStream)(temporary, { flags: 'wx' });
    await pipeline(input, output, { signal: controller.signal });
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(target.directory);
    await fsp.rename(temporary, target.destination);
    context.untrack(temporary);
  } catch (error) {
    context.throwIfInterrupted();
    throw error;
  } finally {
    unregister();
  }
}

async function execute(plan, context, dependencies = {}) {
  const temporaryArchive = shortTempPath(plan.output.canonicalPath, 'archive');
  let replicationSource = temporaryArchive;
  try {
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(plan.source);
    await assertDirectoryUnchanged(plan.output);
    await createArchive(plan.source.canonicalPath, temporaryArchive, context, dependencies.archive);
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(plan.source);
    await assertDirectoryUnchanged(plan.output);
    if (plan.retainArchive) {
      await fsp.rename(temporaryArchive, plan.archivePath);
      context.untrack(temporaryArchive);
      replicationSource = plan.archivePath;
    }
  } catch (error) {
    context.throwIfInterrupted();
    const archiveLocation = plan.retainArchive ? plan.archivePath : plan.output.canonicalPath;
    error.message = `Failed to create archive in ${archiveLocation}: ${error.message}`;
    error.exitCode = EXIT.ARCHIVE;
    throw error;
  }

  const copied = [];
  try {
    for (const target of plan.copyTargets) {
      try {
        await copyAtomically(replicationSource, target, context, dependencies.copy);
        copied.push(target.destination);
      } catch (error) {
        context.throwIfInterrupted();
        error.message = `Failed to copy archive to ${target.destination}: ${error.message}`;
        error.exitCode = EXIT.COPY;
        throw error;
      }
    }
    return copied;
  } finally {
    if (!plan.retainArchive) {
      await fsp.rm(temporaryArchive, { force: true });
      context.untrack(temporaryArchive);
    }
  }
}

function reportCleanupFailures(failures) {
  for (const failure of failures) {
    console.error(`Error: Failed to remove temporary artifact ${failure.path}: ${failure.error.code || failure.error.message}`);
  }
  if (failures.length && !process.exitCode) process.exitCode = EXIT.ARCHIVE;
}

function reportCleanupRetries(failures) {
  for (const failure of failures) {
    console.error(`Warning: Asynchronous cleanup failed for ${failure.path}; retrying synchronously: ${failure.error.code || failure.error.message}`);
  }
}

async function main() {
  const argument = process.argv[2];
  if (!argument || process.argv.length !== 3) {
    usage();
    fail('Provide exactly one configuration file path.', EXIT.USAGE);
    return;
  }

  let plan;
  try {
    plan = await readAndValidate(path.resolve(argument));
    printPreview(plan);
  } catch (error) {
    fail(error.message, EXIT.VALIDATION);
    return;
  }

  const context = new OperationContext();
  let locks;
  const onSigint = () => { void context.interrupt('SIGINT'); };
  const onSigterm = () => { void context.interrupt('SIGTERM'); };
  const onExit = () => {
    context.cleanupSync();
    locks?.releaseSync();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.once('exit', onExit);
  try {
    if (!await confirmExecution(context)) {
      console.log('Backup cancelled; no files were changed.');
      return;
    }
    try {
      context.throwIfInterrupted();
      locks = await acquireDirectoryLocks(plan);
      context.throwIfInterrupted();
      await cleanupStartupArtifacts(plan);
      context.throwIfInterrupted();
    } catch (error) {
      if (!error.exitCode) error.exitCode = EXIT.VALIDATION;
      throw error;
    }
    const copied = await execute(plan, context);
    console.log('Backup complete:');
    if (plan.retainArchive) console.log(`  Archive: ${plan.archivePath}`);
    else console.log(`  Staging archive removed from: ${plan.output.canonicalPath}`);
    for (const destination of copied) console.log(`  Copy: ${destination}`);
  } catch (error) {
    fail(error.message, error.exitCode || EXIT.ARCHIVE);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    reportCleanupRetries(await context.cleanup());
    reportCleanupFailures(context.cleanupSync());
    if (locks) {
      reportCleanupRetries(await locks.release());
      reportCleanupFailures(locks.releaseSync());
    }
    process.removeListener('exit', onExit);
  }
}

if (require.main === module) {
  main().catch((error) => fail(`Unexpected failure: ${error.message}`, error.exitCode || EXIT.ARCHIVE));
}

module.exports = {
  EXIT,
  InterruptedError,
  OperationContext,
  assertDirectoryUnchanged,
  backupFilename,
  copyAtomically,
  cleanupStartupArtifacts,
  acquireDirectoryLocks,
  createArchive,
  execute,
  readAndValidate,
  shortTempPath,
};
