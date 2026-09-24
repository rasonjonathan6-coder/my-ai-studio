/**
 * Real tests for the GitHub workflow-selection configuration.
 *
 * Config is read once at module load, so each case runs in a real child process
 * with its own environment - including the variables a GitHub Actions runner
 * injects - and reads back the resolved values. Nothing is mocked.
 *
 * The property under test is that the app never lets the runner's environment
 * decide which workflow it dispatches. `GITHUB_WORKFLOW` and
 * `GITHUB_WORKFLOW_REF` are Actions built-ins: on a runner the first holds that
 * run's own display name ("test", "build", ...) and the second holds
 * "owner/repo/.github/workflows/x.yml@refs/heads/main". Because a process
 * variable beats --env-file, reading them made the app dispatch a workflow that
 * does not exist and report actions:false, and turned the publish branch into a
 * string that cannot be a ref. This was observed on this repository's own CI
 * run 36057197633, where the capability probe asserted actions:false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BACKEND = new URL('..', import.meta.url).pathname;

/** The environment a GitHub Actions runner sets for a job running test.yml. */
const RUNNER_ENV = {
  GITHUB_WORKFLOW: 'test',
  GITHUB_WORKFLOW_REF: 'rasonjonathan6-coder/my-ai-studio/.github/workflows/test.yml@refs/heads/main',
  GITHUB_WORKFLOW_SHA: 'daf15e79be02fd47071f39e6fff7e2a90515e627',
  GITHUB_JOB: 'backend',
  CI: 'true',
};

function resolve(env: Record<string, string>): { workflow: string; ref: string } {
  const script = `const { config } = await import('${BACKEND}src/config/index.ts');
    console.log(JSON.stringify({ workflow: config.githubWorkflow, ref: config.githubWorkflowRef }));`;
  const out = execFileSync(
    'node',
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      env: { ...process.env, ...RUNNER_ENV, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(out.trim().split('\n').pop() as string);
}

test('the runner workflow name does not leak into the dispatched workflow', () => {
  const { workflow } = resolve({});
  assert.equal(
    workflow,
    'android-build.yml',
    'GITHUB_WORKFLOW on a runner is the running job\'s own name and must be ignored',
  );
});

test('the runner workflow ref does not become the publish branch', () => {
  const { ref } = resolve({});
  assert.equal(ref, '', 'GITHUB_WORKFLOW_REF is a file@ref path on a runner, never a usable branch');
});

test('an explicit app-named workflow is honoured', () => {
  const { workflow } = resolve({ MY_AI_STUDIO_GITHUB_WORKFLOW: 'build-apk.yml' });
  assert.equal(workflow, 'build-apk.yml');
});

test('an explicit app-named ref is honoured', () => {
  const { ref } = resolve({ MY_AI_STUDIO_GITHUB_WORKFLOW_REF: 'my-ai-studio-build' });
  assert.equal(ref, 'my-ai-studio-build');
});

test('the app-named key wins over the runner built-in', () => {
  const { workflow, ref } = resolve({
    MY_AI_STUDIO_GITHUB_WORKFLOW: 'android-build.yml',
    MY_AI_STUDIO_GITHUB_WORKFLOW_REF: 'release-branch',
  });
  assert.equal(workflow, 'android-build.yml');
  assert.equal(ref, 'release-branch');
});
