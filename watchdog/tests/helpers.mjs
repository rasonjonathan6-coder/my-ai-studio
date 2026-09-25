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
