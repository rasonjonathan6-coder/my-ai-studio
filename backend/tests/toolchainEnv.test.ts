import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.ts';
import { toolchainEnv } from '../src/services/commandRunner.ts';

/**
 * `toolchainEnv` must never advertise a Gradle home the sandbox cannot write to.
 * When the configured directory is unusable the helper substitutes an
 * in-container path; advertising the unusable one produces
 * "Could not create parent directory for lock file" from the Gradle wrapper,
 * which reads like a project failure but is an environment failure.
 */
test('toolchainEnv always returns a readable GRADLE_USER_HOME', async () => {
  const env = await toolchainEnv();
  assert.equal(typeof env.GRADLE_USER_HOME, 'string');
  assert.ok(env.GRADLE_USER_HOME.length > 0, 'GRADLE_USER_HOME must be a non-empty path');
});

test('toolchainEnv only sets JAVA_HOME/ANDROID_HOME when configured', async () => {
  const env = await toolchainEnv();
  if (config.javaHome) assert.equal(env.JAVA_HOME, config.javaHome);
  else assert.equal(env.JAVA_HOME, undefined);

  if (config.androidHome) {
    assert.equal(env.ANDROID_HOME, config.androidHome);
    assert.equal(env.ANDROID_SDK_ROOT, config.androidHome);
  } else {
    assert.equal(env.ANDROID_HOME, undefined);
  }
});
