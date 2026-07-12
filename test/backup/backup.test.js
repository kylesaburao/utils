'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  EXIT,
  InterruptedError,
  OperationContext,
  acquireDirectoryLocks,
  acquireRunLock,
  assertDirectoryUnchanged,
  backupFilename,
  backupFilenamePattern,
  cleanupStartupArtifacts,
  copyAtomically,
  createArchive,
  execute,
  formatBytes,
  measureDirectoryStorage,
  readAndValidate,
  resolveRunLockPath,
  shortTempPath,
} = require('../../src/backup/backup');

const SCRIPT = path.resolve(__dirname, '../../src/backup/backup.js');
const FIXED_DATE = new Date(2026, 6, 11, 12);

async function temporaryRoot(t, prefix = 'backup-test-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeDirectories(root, names) {
  const result = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
  await Promise.all(Object.values(result).map((directory) => fsp.mkdir(directory)));
  return result;
}

async function directoryDetails(directory, label) {
  const canonicalPath = await fsp.realpath(directory);
  const details = await fsp.stat(canonicalPath, { bigint: true });
  return {
    label,
    configuredPath: directory,
    canonicalPath,
    identity: `${details.dev}:${details.ino}`,
  };
}

function successfulArchiveFactory(contents = 'zip-data') {
  return () => {
    const archive = new EventEmitter();
    archive.pipe = (output) => { archive.output = output; };
    archive.directory = () => {};
    archive.finalize = async () => { archive.output.end(contents); };
    archive.abort = () => archive.output?.destroy();
    return archive;
  };
}

async function runCli(t, args, input = '', environment = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: controller.signal,
  });
  t.after(() => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  return { exitCode, stdout, stderr };
}

test('backupFilename sanitizes names and emits a stable dated filename', () => {
  assert.equal(
    backupFilename('/tmp/My: Project. ', FIXED_DATE),
    'My--Project.-_Backup_July112026.zip',
  );
  assert.equal(backupFilename('/', FIXED_DATE), 'Backup_Backup_July112026.zip');
});

test('backupFilename truncates long UTF-8 names on character boundaries with a stable hash', () => {
  const source = path.join('/tmp', '📁'.repeat(100));
  const first = backupFilename(source, FIXED_DATE);
  const second = backupFilename(source, FIXED_DATE);

  assert.equal(first, second);
  assert(Buffer.byteLength(first) <= 255);
  assert.match(first, /-[0-9a-f]{12}_Backup_July112026\.zip$/);
  assert(!first.includes('�'));
});

test('backupFilenamePattern matches every filename produced by the backup naming scheme', () => {
  const pattern = backupFilenamePattern();

  assert(pattern.test('Project.[1]_Backup_January012024.zip'));
  assert(pattern.test('Project.[1]_Backup_December312099.zip'));
  assert(pattern.test('Other_Backup_January012024.zip'));
  assert(pattern.test('long-name-a1b2c3d4e5f6_Backup_March032024.zip'));
  assert(!pattern.test('_Backup_January012024.zip'));
  assert(!pattern.test('Project.[1]_Backup_January322024.zip'));
  assert(!pattern.test('Project.[1]_Backup_Jan012024.zip'));
  assert(!pattern.test('Project.[1]_Backup_January012024.zip.tmp'));
});

test('measureDirectoryStorage totals nested files but counts matching backups at the target root', async (t) => {
  const root = await temporaryRoot(t);
  const nested = path.join(root, 'nested');
  await fsp.mkdir(nested);
  await Promise.all([
    fsp.writeFile(path.join(root, 'other-source_Backup_January012025.zip'), 'backup'),
    fsp.writeFile(path.join(root, 'another-file.zip'), 'other'),
    fsp.writeFile(path.join(nested, 'source_Backup_February022025.zip'), 'nested backup'),
  ]);
  const directory = await directoryDetails(root, 'targetDirectories[0]');

  const storage = await measureDirectoryStorage(
    directory,
    backupFilenamePattern(),
  );

  assert.deepEqual(storage, { totalBytes: 24n, backupBytes: 6n, backupCount: 1 });
});

test('measureDirectoryStorage stats entries when directory types are unknown', async (t) => {
  const root = await temporaryRoot(t);
  const nested = path.join(root, 'nested');
  await fsp.mkdir(nested);
  await Promise.all([
    fsp.writeFile(path.join(root, 'source_Backup_January012025.zip'), 'backup'),
    fsp.writeFile(path.join(root, 'another-file.zip'), 'other'),
    fsp.writeFile(path.join(nested, 'contents.txt'), 'nested contents'),
  ]);
  await fsp.symlink(path.join(root, 'another-file.zip'), path.join(root, 'file-link'));
  const directory = await directoryDetails(root, 'targetDirectories[0]');
  const originalReaddir = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (...args) => {
    const entries = await originalReaddir(...args);
    if (!args[1]?.withFileTypes) return entries;
    return entries.map((entry) => ({
      name: entry.name,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }));
  });

  const storage = await measureDirectoryStorage(directory, backupFilenamePattern());

  assert.deepEqual(storage, { totalBytes: 26n, backupBytes: 6n, backupCount: 1 });
});

test('formatBytes presents byte counts with binary units', () => {
  assert.equal(formatBytes(0n), '0 B');
  assert.equal(formatBytes(1023n), '1023 B');
  assert.equal(formatBytes(1024n), '1.00 KiB');
  assert.equal(formatBytes(1536n), '1.50 KiB');
  assert.equal(formatBytes(1024n ** 3n), '1.00 GiB');
});

test('shortTempPath stays in its directory and uses the owned-artifact shape', () => {
  const first = shortTempPath('/tmp/output', 'copy');
  const second = shortTempPath('/tmp/output', 'copy');

  assert.equal(path.dirname(first), '/tmp/output');
  assert.match(path.basename(first), /^\.backup-copy-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i);
  assert.notEqual(first, second);
});

test('readAndValidate reports unreadable and malformed configurations', async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(readAndValidate(path.join(root, 'missing.json')), /Cannot read configuration file.*ENOENT/);

  const invalid = path.join(root, 'invalid.json');
  await fsp.writeFile(invalid, '{');
  await assert.rejects(readAndValidate(invalid), /contains invalid JSON/);
});

test('readAndValidate rejects each invalid configuration shape', async (t) => {
  const root = await temporaryRoot(t);
  const cases = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{ targetDirectories: ['target'] }, /"sourceDirectory" is required/],
    [{ sourceDirectory: 'source' }, /"targetDirectories" is required/],
    [{ sourceDirectory: 'source', targetDirectories: [] }, /"targetDirectories" is required/],
    [{ sourceDirectory: 'source', targetDirectories: [''] }, /"targetDirectories" is required/],
    [{ sourceDirectory: 'source', targetDirectories: ['target'], outputDirectory: 42 }, /"outputDirectory"/],
  ];

  for (const [index, [value, expected]] of cases.entries()) {
    const config = path.join(root, `config-${index}.json`);
    await fsp.writeFile(config, JSON.stringify(value));
    await assert.rejects(readAndValidate(config), expected);
  }
});

test('readAndValidate resolves relative paths and plans aliases without duplicate copies', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  const targetAlias = path.join(root, 'target-alias');
  await fsp.symlink(target, targetAlias, 'dir');
  const filename = backupFilename(source, FIXED_DATE);
  await fsp.writeFile(path.join(target, filename), 'old backup');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: './source',
    outputDirectory: './output',
    targetDirectories: ['./output', './target', './target-alias'],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);

  assert.equal(plan.source.canonicalPath, await fsp.realpath(source));
  assert.equal(plan.retainArchive, true);
  assert.equal(plan.archiveExists, false);
  assert.equal(plan.copyTargets.length, 1);
  assert.equal(plan.copyTargets[0].destination, path.join(await fsp.realpath(target), filename));
  assert.match(plan.previewTargets[0].action, /shared with outputDirectory/);
  assert.equal(plan.previewTargets[1].action, 'will be overwritten');
  assert.match(plan.previewTargets[2].action, /shared with targetDirectories\[1\]/);
  assert.deepEqual(plan.previewTargets[1].storage, {
    totalBytes: BigInt(Buffer.byteLength('old backup')),
    backupBytes: BigInt(Buffer.byteLength('old backup')),
    backupCount: 1,
  });
  assert.equal(plan.previewTargets[1].storage, plan.previewTargets[2].storage);
});

test('readAndValidate recognizes an existing retained archive', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output } = await makeDirectories(root, ['source', 'output']);
  const filename = backupFilename(source, FIXED_DATE);
  await fsp.writeFile(path.join(output, filename), 'previous');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);
  assert.equal(plan.retainArchive, true);
  assert.equal(plan.archiveExists, true);
  assert.deepEqual(plan.copyTargets, []);
});

test('readAndValidate rejects non-directories and output or target paths inside the source', async (t) => {
  const root = await temporaryRoot(t);
  const { source, target } = await makeDirectories(root, ['source', 'target']);
  const nestedOutput = path.join(source, 'output');
  await fsp.mkdir(nestedOutput);
  const regularFile = path.join(root, 'file');
  await fsp.writeFile(regularFile, 'not a directory');

  const fileConfig = path.join(root, 'file-config.json');
  await fsp.writeFile(fileConfig, JSON.stringify({ sourceDirectory: regularFile, targetDirectories: [target] }));
  await assert.rejects(readAndValidate(fileConfig), /sourceDirectory must be a directory/);

  const nestedConfig = path.join(root, 'nested-config.json');
  await fsp.writeFile(nestedConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: nestedOutput,
    targetDirectories: [target],
  }));
  await assert.rejects(readAndValidate(nestedConfig), /outputDirectory must not resolve to sourceDirectory/);

  for (const [index, targetDirectory] of [source, nestedOutput].entries()) {
    const nestedTargetConfig = path.join(root, `nested-target-config-${index}.json`);
    await fsp.writeFile(nestedTargetConfig, JSON.stringify({
      sourceDirectory: source,
      targetDirectories: [targetDirectory],
    }));
    await assert.rejects(readAndValidate(nestedTargetConfig), /targetDirectories\[0\] must not resolve to sourceDirectory/);
  }
});

test('readAndValidate rejects a directory where a destination file must go', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  await fsp.mkdir(path.join(target, backupFilename(source, FIXED_DATE)));
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));

  await assert.rejects(readAndValidate(config, FIXED_DATE), /Destination exists but is a directory/);
});

test('assertDirectoryUnchanged detects a replaced configured symlink', async (t) => {
  const root = await temporaryRoot(t);
  const { first, second } = await makeDirectories(root, ['first', 'second']);
  const configured = path.join(root, 'configured');
  await fsp.symlink(first, configured, 'dir');
  const directory = await directoryDetails(configured, 'targetDirectories[0]');
  await fsp.unlink(configured);
  await fsp.symlink(second, configured, 'dir');

  await assert.rejects(assertDirectoryUnchanged(directory), /no longer identifies the directory validated earlier/);
});

test('cleanupStartupArtifacts removes only current archive and copy temporary files', async (t) => {
  const root = await temporaryRoot(t);
  const output = await directoryDetails(root, 'outputDirectory');
  const ownedArchive = path.join(root, '.backup-archive-12345678-1234-4abc-8def-123456789abc.tmp');
  const ownedCopy = path.join(root, '.backup-copy-abcdefab-cdef-4abc-9def-abcdefabcdef.tmp');
  const legacyLockMetadata = path.join(root, '.backup-lock-fedcbafe-dcba-4321-abcd-fedcbafedcba.tmp');
  const broadLookalike = path.join(root, '.backup-copy-a.tmp');
  const unrelated = path.join(root, '.backup-other-abcdef.tmp');
  const lookalikeDirectory = path.join(root, '.backup-copy-directory.tmp');
  await Promise.all([
    fsp.writeFile(ownedArchive, 'stale'),
    fsp.writeFile(ownedCopy, 'stale'),
    fsp.writeFile(legacyLockMetadata, 'keep'),
    fsp.writeFile(broadLookalike, 'keep'),
    fsp.writeFile(unrelated, 'keep'),
    fsp.mkdir(lookalikeDirectory),
  ]);

  await cleanupStartupArtifacts({ output, targets: [output] });

  assert.deepEqual((await fsp.readdir(root)).sort(), [
    path.basename(broadLookalike),
    path.basename(legacyLockMetadata),
    path.basename(unrelated),
    path.basename(lookalikeDirectory),
  ].sort());
});

test('OperationContext interrupts once, notifies handlers, and exposes signal exit codes', async () => {
  const context = new OperationContext();
  let calls = 0;
  context.onAbort((error) => {
    calls += 1;
    assert(error instanceof InterruptedError);
  });

  await context.interrupt('SIGTERM');
  await context.interrupt('SIGINT');

  assert.equal(calls, 1);
  assert.equal(context.interruption.exitCode, 143);
  assert.throws(() => context.throwIfInterrupted(), /Interrupted by SIGTERM/);
});

test('OperationContext immediately notifies handlers registered after interruption', async () => {
  const context = new OperationContext();
  await context.interrupt('SIGINT');
  let delivered;

  context.onAbort((error) => { delivered = error; });

  assert.equal(delivered, context.interruption);
});

test('OperationContext cleanup removes successfully tracked artifacts', async (t) => {
  const root = await temporaryRoot(t);
  const artifact = path.join(root, 'temporary');
  await fsp.writeFile(artifact, 'data');
  const context = new OperationContext();
  context.track(artifact);

  assert.deepEqual(await context.cleanup(), []);
  assert.equal(context.temporaryPaths.size, 0);
  await assert.rejects(fsp.access(artifact), { code: 'ENOENT' });
});

test('OperationContext retains failed asynchronous cleanup for a synchronous retry', async (t) => {
  const root = await temporaryRoot(t);
  const nonDirectory = path.join(root, 'file');
  await fsp.writeFile(nonDirectory, 'content');
  const impossiblePath = path.join(nonDirectory, 'child');
  const context = new OperationContext();
  context.track(impossiblePath);

  const asynchronousFailures = await context.cleanup();
  assert.equal(asynchronousFailures.length, 1);
  assert(context.temporaryPaths.has(impossiblePath));

  const synchronousFailures = context.cleanupSync();
  assert.equal(synchronousFailures.length, 1);
  assert(context.temporaryPaths.has(impossiblePath));
});

test('createArchive writes output and untracks only after the caller installs it', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-test.tmp');
  const context = new OperationContext();

  await createArchive(root, destination, context, { archiveFactory: successfulArchiveFactory('archive bytes') });

  assert.equal(await fsp.readFile(destination, 'utf8'), 'archive bytes');
  assert(context.temporaryPaths.has(destination));
});

test('createArchive treats warnings as failures and includes the omitted entry', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-warning.tmp');
  const context = new OperationContext();
  const archiveFactory = () => {
    const archive = new EventEmitter();
    archive.pipe = (output) => { archive.output = output; };
    archive.directory = () => {};
    archive.finalize = () => { archive.emit('warning', { path: 'secret.txt', code: 'EACCES' }); };
    archive.abort = () => archive.output.destroy();
    return archive;
  };

  await assert.rejects(
    createArchive(root, destination, context, { archiveFactory }),
    /Archiver warning for secret\.txt: EACCES/,
  );
  assert(context.temporaryPaths.has(destination));
  assert.deepEqual(await context.cleanup(), []);
});

test('createArchive does not start an archive for an already interrupted context', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-interrupted.tmp');
  const context = new OperationContext();
  await context.interrupt('SIGTERM');
  let started = false;
  const archiveFactory = () => {
    const archive = successfulArchiveFactory()();
    archive.directory = () => { started = true; };
    return archive;
  };

  await assert.rejects(createArchive(root, destination, context, { archiveFactory }), /Interrupted by SIGTERM/);

  assert.equal(started, false);
  assert(context.temporaryPaths.has(destination));
  assert.deepEqual(await context.cleanup(), []);
});

test('copyAtomically overwrites the destination and leaves no temporary artifact', async (t) => {
  const root = await temporaryRoot(t);
  const { target } = await makeDirectories(root, ['target']);
  const source = path.join(root, 'source.zip');
  const destination = path.join(target, 'backup.zip');
  await fsp.writeFile(source, 'new contents');
  await fsp.writeFile(destination, 'old contents');
  const directory = await directoryDetails(target, 'targetDirectories[0]');
  const context = new OperationContext();

  await copyAtomically(source, { directory, destination }, context);

  assert.equal(await fsp.readFile(destination, 'utf8'), 'new contents');
  assert.equal(context.temporaryPaths.size, 0);
  assert.deepEqual(await fsp.readdir(target), ['backup.zip']);
});

test('copyAtomically tracks partial output after a stream failure for later cleanup', async (t) => {
  const root = await temporaryRoot(t);
  const { target } = await makeDirectories(root, ['target']);
  const directory = await directoryDetails(target, 'targetDirectories[0]');
  const destination = path.join(target, 'backup.zip');
  const context = new OperationContext();
  const createReadStream = () => new Readable({
    read() { this.destroy(new Error('read failed')); },
  });

  await assert.rejects(
    copyAtomically('unused', { directory, destination }, context, { createReadStream }),
    /read failed/,
  );
  assert.equal(context.temporaryPaths.size, 1);
  await assert.rejects(fsp.access(destination), { code: 'ENOENT' });
  assert.deepEqual(await context.cleanup(), []);
  assert.deepEqual(await fsp.readdir(target), []);
});

test('execute replicates a staging-only archive directly from its temporary path', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const destination = path.join(targetPath, 'backup.zip');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath: path.join(outputPath, 'backup.zip'),
    retainArchive: false,
    copyTargets: [{ directory: target, destination }],
  };
  let replicationSource;
  const createReadStream = (sourcePath) => {
    replicationSource = sourcePath;
    return fs.createReadStream(sourcePath);
  };

  await execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory() },
    copy: { createReadStream },
  });

  assert.equal(path.dirname(replicationSource), output.canonicalPath);
  assert.match(
    path.basename(replicationSource),
    /^\.backup-archive-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i,
  );
  assert.equal(await fsp.readFile(destination, 'utf8'), 'zip-data');
  assert.deepEqual(await fsp.readdir(outputPath), []);
  assert.equal(context.temporaryPaths.size, 0);
});

test('execute retains the archive, overwrites it atomically, and replicates from it', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const archivePath = path.join(outputPath, 'backup.zip');
  const destination = path.join(targetPath, 'backup.zip');
  await fsp.writeFile(archivePath, 'old archive');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath,
    retainArchive: true,
    copyTargets: [{ directory: target, destination }],
  };

  const copied = await execute(plan, context, { archive: { archiveFactory: successfulArchiveFactory() } });

  assert.deepEqual(copied, [destination]);
  assert.equal(await fsp.readFile(archivePath, 'utf8'), 'zip-data');
  assert.equal(await fsp.readFile(destination, 'utf8'), 'zip-data');
  assert.equal(context.temporaryPaths.size, 0);
});

test('execute classifies archive creation failures and leaves cleanup to the context', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath } = await makeDirectories(root, ['source', 'output']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const context = new OperationContext();
  const plan = { source, output, targets: [], archivePath: path.join(outputPath, 'backup.zip'), retainArchive: false, copyTargets: [] };

  await assert.rejects(
    execute(plan, context, { archive: { outputFactory: () => { throw new Error('disk full'); } } }),
    (error) => error.exitCode === EXIT.ARCHIVE && /Failed to create archive.*disk full/.test(error.message),
  );
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(await context.cleanup(), []);
});

test('execute classifies copy failures and always removes a staging-only archive', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const destination = path.join(targetPath, 'backup.zip');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath: path.join(outputPath, 'backup.zip'),
    retainArchive: false,
    copyTargets: [{ directory: target, destination }],
  };
  const createReadStream = () => new Readable({ read() { this.destroy(new Error('copy read failed')); } });

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory() },
      copy: { createReadStream },
    }),
    (error) => error.exitCode === EXIT.COPY && /Failed to copy archive.*copy read failed/.test(error.message),
  );
  assert.deepEqual(await fsp.readdir(outputPath), []);
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(await context.cleanup(), []);
});

test('execute preserves a copy failure when staging cleanup also fails', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath: path.join(outputPath, 'backup.zip'),
    retainArchive: false,
    copyTargets: [{ directory: target, destination: path.join(targetPath, 'backup.zip') }],
  };

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory() },
      copy: { createReadStream: () => new Readable({ read() { this.destroy(new Error('copy failed')); } }) },
      removeFile: async () => { throw new Error('cleanup failed'); },
    }),
    (error) => error.exitCode === EXIT.COPY &&
      /Failed to copy archive.*copy failed.*Cleanup also failed.*cleanup failed/.test(error.message),
  );
  assert.equal(context.temporaryPaths.size, 2);
  assert.deepEqual(await context.cleanup(), []);
});

test('run lock rejects a second active backup and releases cleanly', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');

  const first = await acquireRunLock(lockPath);
  await assert.rejects(acquireRunLock(lockPath), /Another backup run may already be active/);
  assert.deepEqual(await first.release(), []);
  await assert.rejects(fsp.access(lockPath), { code: 'ENOENT' });
});

test('run lock path uses the home directory independently of TMPDIR', () => {
  assert.equal(
    resolveRunLockPath({ TMPDIR: '/different-temporary-directory' }, '/user-owned-home'),
    path.join('/user-owned-home', '.backup-tool.lock'),
  );
});

test('run lock path honors an absolute override and rejects a relative override', () => {
  const absolute = path.resolve('/test-locks', '.backup-tool.lock');
  assert.equal(resolveRunLockPath({ BACKUP_LOCK_PATH: absolute }, '/unused-home'), absolute);
  assert.throws(
    () => resolveRunLockPath({ BACKUP_LOCK_PATH: 'relative.lock' }, '/unused-home'),
    /BACKUP_LOCK_PATH must be an absolute path/,
  );
});

test('resolved singleton lock paths conflict and the compatibility export is releasable', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');
  const resolved = resolveRunLockPath({ BACKUP_LOCK_PATH: lockPath }, '/unused-home');
  const first = await acquireRunLock(resolved);

  await assert.rejects(acquireRunLock(resolved), /Another backup run may already be active/);
  assert.deepEqual(await first.release(), []);

  const originalLockPath = process.env.BACKUP_LOCK_PATH;
  process.env.BACKUP_LOCK_PATH = lockPath;
  try {
    const compatible = await acquireDirectoryLocks({ ignored: true });
    assert.equal(typeof compatible.release, 'function');
    assert.equal(typeof compatible.releaseSync, 'function');
    assert.deepEqual(await compatible.release(), []);
  } finally {
    if (originalLockPath === undefined) delete process.env.BACKUP_LOCK_PATH;
    else process.env.BACKUP_LOCK_PATH = originalLockPath;
  }
});

test('run lock leaves stale ownership decisions to the local operator', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');
  const staleOwner = JSON.stringify({
    pid: 99_999_999,
    hostname: os.hostname(),
    token: 'abandoned',
  });
  await fsp.writeFile(lockPath, staleOwner);

  await assert.rejects(acquireRunLock(lockPath), /inspect and remove this stale lock manually/);
  assert.equal(await fsp.readFile(lockPath, 'utf8'), staleOwner);
});

test('run lock release does not delete a lock whose ownership token changed', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');
  const lock = await acquireRunLock(lockPath);
  await fsp.writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: 'replacement' }));

  assert.deepEqual(await lock.release(), []);
  assert.equal(JSON.parse(await fsp.readFile(lockPath, 'utf8')).token, 'replacement');
});

test('CLI returns usage and validation exit codes with actionable errors', async (t) => {
  const usage = await runCli(t, []);
  assert.equal(usage.exitCode, EXIT.USAGE);
  assert.match(usage.stderr, /Usage:/);
  assert.match(usage.stderr, /Provide exactly one configuration file path/);

  const root = await temporaryRoot(t);
  const invalidConfig = path.join(root, 'invalid.json');
  await fsp.writeFile(invalidConfig, '{}');
  const validation = await runCli(t, [invalidConfig]);
  assert.equal(validation.exitCode, EXIT.VALIDATION);
  assert.match(validation.stderr, /"sourceDirectory" is required/);
});

test('CLI rejects a relative BACKUP_LOCK_PATH before creating a lock', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-lock-validation-');
  const { source, output } = await makeDirectories(root, ['source', 'output']);
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const result = await runCli(t, [config], 'yes\n', { BACKUP_LOCK_PATH: 'relative.lock' });

  assert.equal(result.exitCode, EXIT.VALIDATION);
  assert.match(result.stderr, /BACKUP_LOCK_PATH must be an absolute path/);
  assert.deepEqual(await fsp.readdir(output), []);
});

test('CLI cancellation leaves backup directories untouched', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-cancel-');
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  const existingTemporary = path.join(target, '.backup-copy-00000000-0000-4000-8000-000000000000.tmp');
  await fsp.writeFile(existingTemporary, 'must remain untouched');
  await fsp.writeFile(path.join(target, 'source_Backup_January012025.zip'), '1234567890');
  await fsp.writeFile(path.join(target, 'unrelated.txt'), 'abc');
  const nested = path.join(target, 'nested');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(nested, 'contents.txt'), 'hello');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));

  const result = await runCli(t, [config], 'n\n');

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Targets \(1\)\n-----------\n1\. .*source_Backup_.*\.zip\n   Action             will be created/);
  assert.match(result.stdout, /Existing contents  39 B\n   Matching backups   10 B in 1 backup/);
  assert.match(result.stdout, /Proceed\? \[y\/N\] \nCANCELLED — No files were changed\./);
  assert.equal(await fsp.readFile(existingTemporary, 'utf8'), 'must remain untouched');
  assert.deepEqual(await fsp.readdir(output), []);
  assert.deepEqual((await fsp.readdir(target)).sort(), [
    path.basename(existingTemporary),
    'nested',
    'source_Backup_January012025.zip',
    'unrelated.txt',
  ].sort());
});

test('CLI creates a real ZIP, reports completion, and releases its lock', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-success-');
  const { source, output } = await makeDirectories(root, ['source', 'output']);
  await fsp.writeFile(path.join(source, 'hello.txt'), 'hello from the backup');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const lockPath = path.join(root, '.backup-tool.lock');
  const result = await runCli(t, [config], 'yes\n', { BACKUP_LOCK_PATH: lockPath });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Backup preview\n==============/);
  assert.match(result.stdout, /Backup complete\n===============/);
  assert.match(result.stdout, /Replicated copies \(0\)/);
  const entries = await fsp.readdir(output);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^source_Backup_[A-Z][a-z]+\d{2}\d{4}\.zip$/);
  const header = Buffer.alloc(4);
  const handle = await fsp.open(path.join(output, entries[0]), 'r');
  await handle.read(header, 0, 4, 0);
  await handle.close();
  assert.equal(header.toString('hex'), '504b0304');
  await assert.rejects(fsp.access(lockPath), { code: 'ENOENT' });
});
