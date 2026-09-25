/**
 * Static checks on the workflow triggers, guarding against a recovery loop.
 *
 * The loop this exists to prevent:
 *
 *   watchdog finds the studio dead -> recovery runs -> url.json is committed
 *   -> the commit triggers workflows -> one of them runs the watchdog -> ...
 *
 * Today that loop cannot happen, for a reason that is easy to break by accident
 * and impossible to notice by reading a single workflow: an event raised by the
 * default GITHUB_TOKEN does not start new workflow runs, and the watchdog only
 * answers workflow_dispatch. So the guard that matters is not "url.json is
 * ignored" but "nothing can start the watchdog except a human".
 *
 * These assertions pin that. If someone later adds `push:` to watchdog.yml,
 * arms its schedule block, or wires recovery into a push-triggered workflow,
 * the loop becomes reachable and this test fails before it can.
 *
 * The YAML is read with a small purpose-built scanner rather than a YAML
 * library on purpose. The watchdog job in CI installs nothing - adding a
 * dependency would mean adding an install step, and these files are the very
 * ones whose triggers must not change casually. The scanner only needs to read
 * top-level `on:` keys, which is a much smaller problem than YAML, and the
 * checks below run against all seven real workflows, so a misread would show up
 * as a failing expectation rather than as silence.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/** Reads a workflow file as text. */
async function readWorkflow(name) {
  return readFile(join(WORKFLOWS_DIR, name), 'utf8');
}

/**
 * Extracts the `on:` block and the keys under it.
 *
 * Comments are stripped first, so a commented-out `schedule:` is correctly
 * invisible here - that is the whole point of the check on watchdog.yml. The
 * block runs from the `on:` line to the next top-level key.
 */
function parseTriggers(text) {
  const lines = text.split('\n');
  const isComment = (line) => /^\s*#/.test(line);
  const indentOf = (line) => line.length - line.trimStart().length;

  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) return { triggers: new Map(), block: '' };

  // The block ends at the next line that starts in column zero.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || isComment(line)) continue;
    if (indentOf(line) === 0) {
      end = i;
      break;
    }
  }

  const block = lines.slice(start + 1, end).filter((line) => line.trim() !== '' && !isComment(line));
  const indents = block.map(indentOf);
  const triggerIndent = Math.min(...indents);

  const triggers = new Map();
  for (const line of block) {
    if (indentOf(line) !== triggerIndent) continue;
    const key = line.trim().replace(/:.*$/, '');
    // Everything indented past the trigger key belongs to it.
    const from = block.indexOf(line);
    const body = [];
    for (let i = from + 1; i < block.length; i += 1) {
      if (indentOf(block[i]) <= triggerIndent) break;
      body.push(block[i].trim());
    }
    triggers.set(key, body.join('\n'));
  }
  return { triggers, block: block.join('\n') };
}

/** Names of the workflow files that answer to a given trigger. */
async function workflowsWithTrigger(trigger) {
  const names = (await readdir(WORKFLOWS_DIR)).filter((n) => n.endsWith('.yml'));
  const matching = [];
  for (const name of names) {
    const { triggers } = parseTriggers(await readWorkflow(name));
    if (triggers.has(trigger)) matching.push(name);
  }
  return matching.sort();
}

describe('workflow triggers: the watchdog cannot be started automatically', () => {
  it('watchdog.yml is only reachable by workflow_dispatch', async () => {
    const { triggers } = parseTriggers(await readWorkflow('watchdog.yml'));
    assert.ok(triggers.has('workflow_dispatch'), 'the manual trigger disappeared');
    assert.deepEqual(
      [...triggers.keys()].sort(),
      ['workflow_dispatch'],
      'the watchdog gained an automatic trigger; a recovery loop is now reachable',
    );
  });

  it('watchdog.yml has no push and no pull_request trigger', async () => {
    const { triggers } = parseTriggers(await readWorkflow('watchdog.yml'));
    assert.ok(!triggers.has('push'));
    assert.ok(!triggers.has('pull_request'));
  });

  it('watchdog.yml does not respond to a url.json commit', async () => {
    // The precise loop: recovery commits url.json, the commit must not start
    // the recovery again. Any push trigger at all on the watchdog reopens it.
    const publishers = await workflowsWithTrigger('push');
    assert.ok(
      !publishers.includes('watchdog.yml'),
      `watchdog.yml answers to push (via ${publishers.join(', ')})`,
    );
    assert.ok(!publishers.includes('publish-url-json.yml'));
  });
});

describe('workflow triggers: the schedule stays disarmed', () => {
  it('watchdog.yml has no active schedule', async () => {
    const { triggers } = parseTriggers(await readWorkflow('watchdog.yml'));
    assert.ok(
      !triggers.has('schedule'),
      'the watchdog schedule is armed: it would now create sandboxes unattended',
    );
  });

  it('the schedule block is present but commented out', async () => {
    // Asserting both halves: the schedule must be absent from the triggers and
    // still visible as a commented block. Otherwise a deletion would pass the
    // previous test while silently removing the documented intent.
    const text = await readWorkflow('watchdog.yml');
    assert.match(text, /^\s*#\s*schedule:/m, 'the commented schedule block was removed');
    assert.doesNotMatch(text, /^\s*schedule:/m, 'an uncommented schedule: line appeared');
  });

  it('publish-url-json.yml is not reachable automatically either', async () => {
    const { triggers } = parseTriggers(await readWorkflow('publish-url-json.yml'));
    assert.deepEqual([...triggers.keys()].sort(), ['workflow_dispatch']);
    assert.ok(!triggers.has('schedule'));
    assert.ok(!triggers.has('push'));
  });
});

describe('workflow triggers: the Android build stays narrow', () => {
  it('build-apk.yml runs only on android-samples or its own changes', async () => {
    const { triggers } = parseTriggers(await readWorkflow('build-apk.yml'));
    const push = triggers.get('push');
    assert.ok(push, 'build-apk.yml no longer has a push trigger');
    assert.match(push, /paths:/);
    assert.match(push, /android-samples\/\*\*/);
  });

  it('build-apk.yml is not triggered by url.json', async () => {
    // A url.json-only commit must not start an Android build: it has nothing to
    // do with the APK, and it would be a false trigger on every recovery.
    const { triggers } = parseTriggers(await readWorkflow('build-apk.yml'));
    const push = triggers.get('push');
    assert.doesNotMatch(push, /url\.json/);

    // pull_request carries the same path filters, so it is checked too rather
    // than assumed. Comparing the paths rather than the whole body is what
    // makes this meaningful: push legitimately also carries `branches`, so an
    // equality on the whole body would fail for the wrong reason.
    const pathsOf = (body) => {
      const lines = body.split('\n');
      const at = lines.findIndex((line) => line.trim() === 'paths:');
      assert.notEqual(at, -1, 'no paths: filter found');
      return lines.slice(at + 1).join('\n');
    };
    const pullRequest = triggers.get('pull_request');
    assert.ok(pullRequest, 'pull_request lost its filters');
    assert.doesNotMatch(pullRequest, /url\.json/);
    assert.match(pullRequest, /android-samples\/\*\*/);
    assert.equal(pathsOf(push), pathsOf(pullRequest), 'push and pull_request paths diverged');
  });

  it('no workflow mentions url.json in a path filter', async () => {
    const names = (await readdir(WORKFLOWS_DIR)).filter((n) => n.endsWith('.yml'));
    for (const name of names) {
      const { block } = parseTriggers(await readWorkflow(name));
      assert.doesNotMatch(block, /url\.json/, `${name} filters on url.json`);
    }
  });
});

describe('workflow triggers: the set of push-triggered workflows', () => {
  it('is exactly the expected four, none of them a recovery path', async () => {
    // Pinned rather than merely checked, so adding a push trigger to a new
    // workflow is a deliberate act that has to be reflected here.
    assert.deepEqual(await workflowsWithTrigger('push'), [
      'build-apk.yml',
      'build.yml',
      'security.yml',
      'test.yml',
    ]);
  });

  it('none of them can reach recoverStudio', async () => {
    const pushers = await workflowsWithTrigger('push');
    for (const name of pushers) {
      const text = await readWorkflow(name);
      // The recovery is only reachable through watchdog.mjs without --plan.
      assert.doesNotMatch(text, /watchdog\.mjs(?!\s+--plan)/, `${name} invokes the recovery`);
      assert.doesNotMatch(text, /recoverStudio/, `${name} imports the recovery`);
    }
  });
});

/**
 * The rebuild budget has to reach the next run, which makes the ordering of the
 * steps load-bearing: a restore placed after the check, or an upload placed
 * before it, would leave the budget empty every time while still looking
 * correct to a reader skimming the file.
 */
describe('workflow wiring: the budget survives between runs', () => {
  /** The job's steps, in order, as parsed. */
  async function steps() {
    const text = await readWorkflow('watchdog.yml');
    // Deliberately no YAML dependency, matching the rest of this file: the
    // watchdog job installs nothing, so a parser that needed installing would
    // change the very file under test.
    const block = text.slice(text.indexOf('steps:'));
    const found = [];
    for (const line of block.split('\n')) {
      const match = /^\s*-\s+(?:name:\s*(.+)|uses:\s*(.+))$/.exec(line);
      if (match) found.push({ name: match[1] ?? null, uses: match[2] ?? null });
    }
    return { found, text };
  }

  /** Index of the first step whose name or action matches. */
  function indexOf(found, needle) {
    return found.findIndex(
      (step) => (step.name && step.name.includes(needle)) || (step.uses && step.uses.includes(needle)),
    );
  }

  it('restores the budget before the watchdog runs', async () => {
    const { found } = await steps();
    const restore = indexOf(found, 'Restore the rebuild budget');
    const check = indexOf(found, 'Check the studio');
    assert.notEqual(restore, -1, 'the restore step is gone');
    assert.notEqual(check, -1, 'the check step is gone');
    assert.ok(restore < check, 'the budget is restored after the studio is checked');
  });

  it('saves the budget after the watchdog runs', async () => {
    const { found } = await steps();
    const check = indexOf(found, 'Check the studio');
    const recover = indexOf(found, 'Recover when dead');
    const save = indexOf(found, 'Save the rebuild budget');
    assert.notEqual(save, -1, 'the save step is gone');
    assert.ok(save > check, 'the budget is saved before the studio is checked');
    assert.ok(save > recover, 'the budget is saved before the recovery that spends it');
  });

  it('saves the budget even when the run fails', async () => {
    // A failed run still spent quota, so an upload gated on success would let
    // repeated failures bypass the daily cap.
    const text = await readWorkflow('watchdog.yml');
    const at = text.indexOf('Save the rebuild budget');
    const step = text.slice(at, text.indexOf('- name:', at));
    assert.match(step, /if:\s*always\(\)/, 'the budget upload is not guarded by always()');
  });

  it('uploads under a stable name and restores the same one', async () => {
    const text = await readWorkflow('watchdog.yml');
    // Both halves must agree, or the restore would look for an artifact that is
    // never written and quietly start empty on every run.
    const uploads = [...text.matchAll(/name:\s*(watchdog-state)\b/g)].map((m) => m[1]);
    assert.equal(uploads.length, 1, 'the budget artifact is uploaded under an unexpected number of names');
    assert.match(text, /artifacts\?name=watchdog-state/, 'the restore does not look up watchdog-state');
  });

  it('uses one state path for the check and the recovery', async () => {
    const text = await readWorkflow('watchdog.yml');
    // The whole line, not \S+: the value is `${{ runner.temp }}/...`, which
    // contains spaces, so a single-token match would stop at `${{`.
    const paths = [...text.matchAll(/WATCHDOG_STATE_PATH:\s*(.+)/g)].map((m) => m[1].trim());
    assert.ok(paths.length >= 2, 'the state path is set in fewer places than expected');
    // One value, used everywhere: a divergence would let the check read a
    // different budget from the one the recovery writes.
    assert.equal(new Set(paths).size, 1, `the state path diverges: ${[...new Set(paths)].join(', ')}`);
    // And it is the directory the restore step writes to, so the artifact
    // actually lands where the watchdog looks.
    assert.match(paths[0], /runner\.temp/, 'the state path is no longer in the runner temp directory');
  });

  it('reads a previous artifact with an explicit token, not the default scope', async () => {
    // download-artifact only sees the current run, so the restore must go
    // through the API with a token and pick the newest artifact itself.
    const text = await readWorkflow('watchdog.yml');
    const at = text.indexOf('Restore the rebuild budget');
    const step = text.slice(at, text.indexOf('- name: Test the watchdog', at));
    assert.match(step, /GH_TOKEN:/, 'the restore step has no token');
    assert.match(step, /actions\/artifacts\?name=/, 'the restore does not list artifacts');
    assert.match(step, /artifacts\[0\]/, 'the restore does not take the newest artifact');
  });

  it('keeps the concurrency guard intact', async () => {
    // Two runs could each decide the studio is dead and rebuild, which is the
    // duplication the budget cannot prevent on its own: both would read the same
    // budget before either had written to it.
    const text = await readWorkflow('watchdog.yml');
    assert.match(text, /concurrency:/);
    assert.match(text, /group:\s*watchdog/);
  });

  it('asks for contents: write and actions: read', async () => {
    // `contents: write` is what lets a successful rebuild publish the new URL.
    // Without it the recovery would rebuild a runtime and then be unable to tell
    // any installed APK where it is; without `actions: read` it could not read the
    // budget artifact that stops it rebuilding on every run.
    //
    // Both are pinned, and so is the absence of anything broader, because the
    // scope a watchdog holds is the blast radius of a bug in it.
    const text = await readWorkflow('watchdog.yml');
    const block = text.slice(text.indexOf('permissions:'), text.indexOf('concurrency:'));
    assert.match(block, /contents:\s*write/, 'the rebuilt URL could not be published');
    assert.match(block, /actions:\s*read/, 'the budget artifact could not be read');
    // Nothing else is granted. An automated commit of one file does not need to
    // open or merge pull requests, publish packages or manage issues.
    const granted = [...block.matchAll(/^\s{2}([a-z-]+):\s*(\S+)$/gm)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(granted.sort(), ['actions:read', 'contents:write']);
  });
});

/**
 * The recovery path is the one step that spends quota and writes to the
 * repository, so its exact text is pinned. A `--dry-run` here would publish
 * nothing while reporting success, and an unconditional `exit 0` would report a
 * failed recovery as green - both are the failure modes this pins against.
 */
describe('workflow: the recovery path publishes for real', () => {
  /** The `run:` script of the named step. */
  async function stepScript(name) {
    const text = await readWorkflow('watchdog.yml');
    const at = text.indexOf(`- name: ${name}`);
    assert.notEqual(at, -1, `the step "${name}" is gone`);
    const next = text.indexOf('\n      - name:', at);
    const body = text.slice(at, next === -1 ? undefined : next);
    const runAt = body.indexOf('run: |');
    assert.notEqual(runAt, -1, `the step "${name}" has no run script`);
    return body.slice(runAt);
  }

  it('does not use --dry-run on the recovery path', async () => {
    const script = await stepScript('Recover when dead');
    assert.doesNotMatch(
      script,
      /--dry-run/,
      'the recovery path would rebuild the studio and publish nothing',
    );
    // And it really does run the watchdog with the publish path armed.
    assert.match(script, /watchdog\.mjs/);
    assert.doesNotMatch(script, /--plan\b/, 'the recovery step must not run plan-only');
  });

  it('reports a rebuilt studio (exit 2) as a successful job, not a failure', async () => {
    // The watchdog's codes are 0 healthy, 2 rebuilt, 1 needs attention. A rebuild
    // that committed and pushed a working url.json is a success, but GitHub reads
    // any non-zero step exit as a failed job, so a completed recovery used to go
    // red. Run 36152058679 did exactly that: cycle finished with action "rebuilt",
    // url.json published, and the job still showed failure. A run that is red for
    // every recovery trains people to ignore red, which is how a real failure gets
    // missed. The translation is what this pins.
    const script = await stepScript('Recover when dead');

    // 0 and 2 both leave the step with success.
    assert.match(
      script,
      /if \[ "\$code" -eq 0 \] \|\| \[ "\$code" -eq 2 \]; then\s*\n\s*exit 0/,
      'a rebuilt studio (2) is still reported as a failed job',
    );
  });

  it('still fails the job on the watchdog code that means a real error', async () => {
    // The counterpart of the test above: translating 2 to success must not blunt 1.
    // Code 1 is a recovery that needs a human - a rejected push, a missing
    // credential, a build that never started - and it must keep failing the job.
    const script = await stepScript('Recover when dead');
    assert.match(
      script,
      /\n\s*exit 1\s*$/m,
      'a real error no longer fails the job',
    );
    // And nothing in the step can turn an arbitrary code into success: the only
    // `exit 0` is the one guarded by the 0-or-2 test.
    const exits = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^exit\b/.test(line));
    assert.deepEqual(
      exits,
      ['exit 0', 'exit 1'],
      `the step decides its status with an unexpected set of exits: ${JSON.stringify(exits)}`,
    );
  });

  it('never masks a real error with a blanket success', async () => {
    const script = await stepScript('Recover when dead');
    // A bare `exit 0` with no guard in front of it would report every failure -
    // including a rejected push - as green. The success exit must therefore sit
    // inside the 0-or-2 guard, never on its own.
    const lines = script.split('\n');
    const successAt = lines.findIndex((line) => /^\s*exit 0\s*$/.test(line));
    assert.notEqual(successAt, -1, 'the step has no success exit at all');
    assert.match(
      lines[successAt - 1],
      /-eq 0 \] \|\| \[ "\$code" -eq 2 \]; then/,
      'the success exit is not guarded by the condition that defines success',
    );
  });

  it('still passes the watchdog exit code through as the step output', async () => {
    const script = await stepScript('Recover when dead');
    assert.match(script, /echo "exit_code=\$code" >> "\$GITHUB_OUTPUT"/);
  });

  it('captures stderr in the log it uploads, not just stdout', async () => {
    // The watchdog writes error and warning lines to stderr (log.mjs picks the
    // stream by level), so a bare `node ... | tee file` recorded only stdout.
    // Run 36143455348 failed on a missing credential and uploaded a 0-byte
    // watchdog-log artifact - the exact failure the artifact is meant to
    // explain. `2>&1` is what makes the uploaded log worth keeping.
    const script = await stepScript('Recover when dead');
    const pipeline = script.split('\n').find((line) => /watchdog\.mjs/.test(line));
    assert.ok(pipeline, 'the recovery step no longer runs the watchdog');
    assert.match(
      pipeline,
      /watchdog\.mjs\s+2>&1\s*\|/,
      'stderr is not merged into the uploaded log, so warnings and errors are lost',
    );
    // node must stay the first element of the pipeline, otherwise
    // PIPESTATUS[0] is some other command's code and a failed recovery would
    // be reported as a success.
    assert.match(pipeline, /^\s*node\s/, "the exit code captured is not the watchdog's");
  });

  /** Runs a shell snippet, resolving with its exit code. */
  function shellExit(snippet) {
    return new Promise((done, fail) => {
      const child = spawn('bash', ['-c', snippet], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => {
        stderr += c;
      });
      child.on('error', fail);
      child.on('close', (code) => done({ code, stderr }));
    });
  }

  /**
   * The step's status decision, executed for real.
   *
   * The assertions above read the script's text; this one runs the very lines that
   * decide success or failure, for each of the watchdog's codes, so the mapping is
   * demonstrated rather than described. The snippet is the tail of the recovery
   * script - the part after the watchdog has run - with `code` supplied directly,
   * because the point under test is the translation, not the recovery.
   */
  async function stepStatusFor(watchdogCode) {
    const script = await stepScript('Recover when dead');
    const lines = script.split('\n');
    // The decision is everything from the guard to the end of the step: the part
    // that turns the watchdog's code into the step's own status. Taking it from
    // the script rather than hardcoding it means these tests fail if the mapping
    // is edited, which is the regression they exist to catch.
    const start = lines.findIndex((line) => /if \[ "\$code" -eq 0 \]/.test(line));
    assert.notEqual(start, -1, 'the step no longer decides its status from $code');
    const decision = lines
      .slice(start)
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.trim() !== '')
      .map((line) => line.trim())
      .join('\n');

    const { code, stderr } = await shellExit(`code=${watchdogCode}\n${decision}`);
    assert.equal(stderr, '', `the decision block wrote to stderr: ${stderr}`);
    return code;
  }

  it('maps 0, 2 and 1 to the right job status when the decision runs', async () => {
    // 0 healthy, 2 rebuilt, 1 needs attention. Only 1 is a failure.
    assert.equal(await stepStatusFor(0), 0, 'a healthy studio must leave the job green');
    assert.equal(
      await stepStatusFor(2),
      0,
      'a completed rebuild must leave the job green, not red',
    );
    assert.equal(await stepStatusFor(1), 1, 'a real error must keep failing the job');
  });

  it('does not turn an unexpected code into a success', async () => {
    // Anything the watchdog is not documented to emit is treated as a problem, so a
    // crash reported as some other code cannot pass for a healthy run.
    assert.equal(await stepStatusFor(3), 1, 'an undocumented code was reported as success');
    assert.equal(await stepStatusFor(137), 1, 'a killed run was reported as success');
  });


  it('keeps the schedule commented out', async () => {
    // Enabling this lets the recovery, the commit and the push all run
    // unattended. That is an operational decision, not a side effect of a commit.
    const text = await readWorkflow('watchdog.yml');
    const on = text.slice(text.indexOf('on:'), text.indexOf('permissions:'));
    assert.doesNotMatch(on, /^\s{2}schedule:/m, 'the schedule is armed');
    assert.match(text, /^\s*#\s*schedule:/m, 'the schedule block was removed rather than kept inert');
  });

  it('keeps the concurrency guard closed to cancellation', async () => {
    const text = await readWorkflow('watchdog.yml');
    const block = text.slice(text.indexOf('concurrency:'), text.indexOf('jobs:'));
    assert.match(block, /group:\s*watchdog/);
    // cancel-in-progress would kill a run midway through a publish, after the
    // commit but before the push, leaving the branch and the runtime disagreeing.
    assert.match(block, /cancel-in-progress:\s*false/);
  });
});
