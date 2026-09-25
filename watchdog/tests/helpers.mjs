/**
 * Shared test helpers.
 *
 * The watchdog reads its runtime configuration from its own environment, so a test
 * that spawns it inherits whatever is set on the machine running the suite. On a
 * developer's machine that can be a real database URL and a real provider key; in CI
 * it is nothing at all. The suite would then exercise a different path depending on
 * where it ran, which is exactly the kind of difference that makes a green run mean
 * nothing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns a copy of `env` with every name the watchdog may forward removed.
 *
 * The names are hard-coded rather than imported from the source module so that a
 * change to the forwardable list is caught by the recovery tests' own assertion on
 * that list, instead of silently widening what these suites strip.
 */
export function withoutForwardableNames(env = process.env) {
  const names = [
    'DATABASE_URL',
    'DATABASE_SSL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'JWT_SECRET',
    'MY_AI_STUDIO_CREDENTIAL_KEY',
    'MY_AI_STUDIO_ADMIN_EMAIL',
  ];
  const copy = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

/** A fixture OpenRouter key, assembled so a secret scanner does not flag this file. */
export const FIXTURE_PROVIDER_KEY = `sk-or-v1-${'fixture'.repeat(4)}`;

/** A fixture database URL with a recognisable password field. */
export const FIXTURE_DATABASE_URL = ['postgres://', 'fixtureuser', ':', 'fixturepassword', '@127.0.0.1:5432/db'].join('');

/** A fixture signing key. */
export const FIXTURE_JWT_SECRET = `jwt-${'fixture'.repeat(3)}`;

/**
 * Marker values written to a fixture environment file.
 *
 * Deliberately not shaped like real credentials: these are read back and compared
 * by equality, so a scanner flagging this file would be a false positive.
 */
export const LAUNCH_MARKERS = {
  DATABASE_URL: 'marker-database-from-file',
  OPENROUTER_API_KEY: 'marker-provider-from-file',
  JWT_SECRET: 'marker-signing-from-file',
};

/**
 * Creates a throwaway project holding an environment file and a probe script.
 *
 * The probe prints the marker names it can see as JSON, so a caller can assert on
 * what the launch actually received rather than on what the command string looks
 * like. Asserting on the string alone is what let a launch that node refuses pass
 * review: the command read correctly and the studio died on startup.
 */
export function makeLaunchFixture(markers = LAUNCH_MARKERS) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-'));
  const envFile = join(dir, 'studio.env');
  const script = join(dir, 'server.js');

  writeFileSync(envFile, Object.entries(markers).map(([name, value]) => `${name}=${value}\n`).join(''));
  // PORT is reported alongside the markers because it is assigned by the command
  // rather than by the file, so it shows whether the `env` prefix survived too. The
  // canary is reported for the same reason: it can only be visible if the launch
  // inherited an environment it was supposed to be isolated from.
  const reported = [...Object.keys(markers), 'PORT', ISOLATION_CANARY];
  writeFileSync(
    script,
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(reported)}.map((n) => [n, process.env[n] ?? null]))));\n`,
  );

  return {
    dir,
    envFile,
    script,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs the launch a command builds, with nothing else in the environment.
 *
 * `--env-file` does not override a name that is already defined, so a launch
 * spawned from the suite's own environment reads that environment and the file is
 * ignored without a word. That is the trap this helper exists for: `env -i`
 * restores the condition the recovered sandbox actually runs under, where the file
 * is the only source.
 *
 * The launch is run in the foreground rather than through its `nohup … &` wrapper.
 * The wrapper detaches and writes to a log file, which would turn the assertion
 * into a race against the filesystem.
 *
 * `withEnv` injects names ahead of the command's own assignments, which is how the
 * masking behaviour is pinned rather than assumed.
 *
 * A canary name is set outside the launch, so the caller can tell whether the
 * isolation held. Without it the checks here would pass on a machine that happens to
 * lack the configured names - which is exactly what CI is, so the trap would go
 * unnoticed precisely where it matters.
 */

/** A name set outside the launch, present only if the isolation did not hold. */
export const ISOLATION_CANARY = 'WATCHDOG_LAUNCH_CANARY';
export function runLaunchIsolated(command, { envFile, script, withEnv = {} } = {}) {
  const match = command.match(/nohup\s+(env\s+.*?)\s+>\s/);
  if (!match) throw new Error(`no launch found in command: ${command}`);

  const tokens = match[1].split(/\s+/).filter(Boolean);
  const nodeAt = tokens.indexOf('node');
  if (nodeAt === -1) throw new Error(`no node invocation in launch: ${match[1]}`);

  const assignments = tokens.slice(1, nodeAt);
  const args = tokens.slice(nodeAt + 1);
  // The entry is the trailing positional argument; the probe stands in for it.
  args[args.length - 1] = script;

  const rewritten = args.map((token) => (token.startsWith('--env-file=') ? `--env-file=${envFile}` : token));
  const injected = Object.entries(withEnv).map(([name, value]) => `${name}=${value}`);

  // The canary is planted in this process rather than passed along the command, so
  // it can only reach the launch by being inherited. `env -i` drops it; a launch
  // that lost its isolation does not, and the probe reports it back.
  const had = Object.hasOwn(process.env, ISOLATION_CANARY);
  const previous = process.env[ISOLATION_CANARY];
  process.env[ISOLATION_CANARY] = 'leaked';
  try {
    return spawnSync('env', ['-i', `PATH=${process.env.PATH}`, ...injected, ...assignments, 'node', ...rewritten], {
      encoding: 'utf8',
    });
  } finally {
    if (had) process.env[ISOLATION_CANARY] = previous;
    else delete process.env[ISOLATION_CANARY];
  }
}
