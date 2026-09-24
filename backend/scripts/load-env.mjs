/**
 * Loads the repository's .env for development.
 *
 * `node --env-file-if-exists=../.env` cannot be used with `--watch`: when the
 * file is absent Node tries to watch the path it could not open and the watcher
 * fails to initialise. On Node 22 that surfaced as
 * `ENOENT ... watch '<repo>/.env'`, and on Node 24 as an assertion failure in
 * FSWatcher.close. A fresh clone has no .env, so `npm run dev` crashed in CI and
 * for every new contributor before the server ever started.
 *
 * Loading the file from an imported module instead keeps the "optional" part
 * genuinely optional. The non-watch scripts (start, migrate, test) do not hit
 * this bug and still use --env-file-if-exists.
 */
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No .env is a supported state: the app reports unconfigured services rather
  // than failing to boot.
}
