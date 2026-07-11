# ZIP backup utility

Node.js 20.6.0 or newer is required. Install dependencies once:

```sh
npm install
```

Copy the committed [`backup-config.json`](../../backup-config.json) template to the ignored local configuration, then edit the local copy:

```sh
cp backup-config.json backup-config.local.json
```

Run the backup with the local configuration:

```sh
npm run backup -- ./backup-config.local.json
```

`sourceDirectory` and every `targetDirectories` entry are required. `outputDirectory` is optional and defaults to the operating system's temporary directory. Relative paths are resolved from the configuration file's directory; absolute paths are used as written. All configured directories must already exist. The source must be readable and searchable, and output/target directories must be writable and searchable.

The utility resolves directory aliases and rejects an output directory that is the source or anywhere below it. Equivalent targets are deduplicated. A target that resolves to the output directory shares the completed output archive and is not copied onto itself; the preview identifies every shared or skipped destination. If the output directory is not also a target, it is treated only as staging and the completed ZIP is removed after replication, including when replication fails.

After validation, exclusive-lock acquisition, and startup cleanup, the script prints the source, generated filename, output path, target paths, and create/overwrite behavior. It asks `Proceed? [y/N]` and creates no backup unless the answer is exactly `Y`, `y`, or `yes`. The archive name is `<folder>_Backup_<Month><DD><YYYY>.zip`, for example `My-Documents_Backup_July112026.zip`. Names too long for common 255-byte filesystem component limits are shortened with a deterministic hash while preserving the date suffix.

Archive and copy data are streamed asynchronously. When the output directory is staging-only, the archive keeps its `.backup-archive-<uuid>.tmp` name until every target has been replicated and is then removed; it is renamed to the dated ZIP name only when the output directory is itself a target. Copies are installed through a short temporary file in each target directory followed by an atomic rename where the platform supports it.

Before cleanup or writing, the utility registers the source as read-only and the output and target trees as writable in a shared lock registry, then acquires an exclusive `.backup.lock` in every distinct output and target directory. A concurrent run is rejected when either run could write to the other run's source, output, or target tree, including parent/child overlaps; overlapping read-only source trees remain safe. Locks owned by a process that is no longer running on the same host are reclaimed. With those locks held, startup removes utility-owned temporary files left by a previous forced termination. Temporary files and locks are removed on normal completion, errors, `SIGINT`, and `SIGTERM`, with a synchronous process-exit fallback; failures are reported and retained for that fallback retry. Archive warnings are treated as failures so omitted or unreadable content is never silently distributed. `SIGKILL` and sudden power loss cannot run exit cleanup, so the next startup reclaims the abandoned lock and removes its temporary files.

The utility records each configured directory's canonical path and filesystem device/inode identity during validation and checks it again before writing. It also performs work through the validated canonical paths, which prevents a replaced configuration-path symlink from redirecting a write. Portable Node.js APIs do not provide all descriptor-relative filesystem operations needed to eliminate every time-of-check/time-of-use race. Configured directories and their parent directories therefore must not be writable by untrusted users.

One ZIP stream is one DEFLATE workload. Increasing `UV_THREADPOOL_SIZE` does not make that stream multicore, so no worker-pool tuning is recommended for this utility.
