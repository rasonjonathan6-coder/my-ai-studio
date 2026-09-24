import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  translatorTemplateFiles,
  translatorTestFiles,
  withPackage,
  TRANSLATOR_PACKAGE_PLACEHOLDER,
  TRANSLATOR_APP_LABEL_PLACEHOLDER,
} from '../src/services/translatorTemplate.ts';
import { androidTemplateFiles } from '../src/services/templates.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sampleRoot = path.join(repoRoot, 'android-samples', 'translator');
const generatedFile = path.join(repoRoot, 'backend', 'src', 'services', 'translatorTemplateFiles.ts');

/** The sample's own package and label, which the placeholders stand in for. */
const SAMPLE_PACKAGE = 'com.myaistudio.floatingtranslator';
const SAMPLE_LABEL = 'Floating AI Translator';

test('the shipped template is the verified sample app, not a reduced copy', () => {
  const files = translatorTemplateFiles(SAMPLE_PACKAGE, SAMPLE_LABEL);
  // Each of these is a distinct capability the audit found missing from the old
  // stub. If one disappears, the template has regressed again.
  const required = [
    'app/src/main/java/com/myaistudio/floatingtranslator/TranslatorCore.kt',
    'app/src/main/java/com/myaistudio/floatingtranslator/TranslatorAccessibilityService.kt',
    'app/src/main/java/com/myaistudio/floatingtranslator/OverlayView.kt',
    'app/src/main/java/com/myaistudio/floatingtranslator/TranslationClient.kt',
    'app/src/main/res/xml/accessibility_service_config.xml',
    'app/src/test/java/com/myaistudio/floatingtranslator/TranslatorCoreTest.kt',
  ];
  for (const rel of required) {
    assert.ok(rel in files, `template is missing ${rel}`);
  }
});

test('the template carries the real injection and overlay logic', () => {
  const files = translatorTemplateFiles(SAMPLE_PACKAGE, SAMPLE_LABEL);
  const service = files['app/src/main/java/com/myaistudio/floatingtranslator/TranslatorAccessibilityService.kt'];
  // The old stub only read event.text into a variable. These are the calls that
  // make it a working translator.
  assert.match(service, /ACTION_SET_TEXT/);
  assert.match(service, /findFocus\(AccessibilityNodeInfo\.FOCUS_INPUT\)/);
  assert.match(service, /injectIntoField/);

  const overlay = files['app/src/main/java/com/myaistudio/floatingtranslator/OverlayView.kt'];
  assert.match(overlay, /TYPE_APPLICATION_OVERLAY/);
  assert.match(overlay, /Read last/);
});

test('the accessibility config declares the events the service subscribes to', () => {
  const files = translatorTemplateFiles(SAMPLE_PACKAGE, SAMPLE_LABEL);
  const config = files['app/src/main/res/xml/accessibility_service_config.xml'];
  // Without typeViewFocused there is no focused field to inject into.
  assert.match(config, /typeViewFocused/);
  assert.match(config, /canRetrieveWindowContent="true"/);
});

test('no provider key is embedded in the template', () => {
  const files = translatorTemplateFiles(SAMPLE_PACKAGE, SAMPLE_LABEL);
  const all = Object.values(files).join('\n');
  for (const needle of ['sk-or-', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'BEGIN PRIVATE KEY']) {
    assert.ok(!all.includes(needle), `template leaks ${needle}`);
  }
});

test('the package name is substituted in both paths and content', () => {
  const pkg = 'com.example.myapp';
  const files = translatorTemplateFiles(pkg, 'My App');
  assert.ok('app/src/main/java/com/example/myapp/TranslatorCore.kt' in files);
  const core = files['app/src/main/java/com/example/myapp/TranslatorCore.kt'];
  assert.match(core, /^package com\.example\.myapp$/m);
  // No placeholder should survive into a generated project.
  const all = Object.values(files).join('\n');
  assert.ok(!all.includes(TRANSLATOR_PACKAGE_PLACEHOLDER));
  assert.ok(!all.includes(TRANSLATOR_APP_LABEL_PLACEHOLDER));
  assert.match(all, /My App/);
});

test('the app label is substituted where the sample named itself', () => {
  const files = translatorTemplateFiles(SAMPLE_PACKAGE, 'Mon Traducteur');
  const strings = files['app/src/main/res/values/strings.xml'];
  assert.match(strings, /Mon Traducteur/);
  assert.ok(!strings.includes(SAMPLE_LABEL));
});

test('test files are separated from main files', () => {
  const tests = translatorTestFiles(SAMPLE_PACKAGE, SAMPLE_LABEL);
  assert.ok(Object.keys(tests).length > 0);
  for (const rel of Object.keys(tests)) {
    assert.ok(rel.startsWith('app/src/test/'), `${rel} should be a test source`);
  }
});

test('withPackage leaves unrelated text untouched', () => {
  assert.equal(withPackage('hello', 'com.x'), 'hello');
});

test('androidTemplateFiles returns the full translator project', () => {
  const files = androidTemplateFiles('android-floating-translator', 'My Translator');
  // Files the generator owns, which must sit alongside the synced sources.
  for (const rel of ['settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'app/build.gradle.kts', 'app/src/main/AndroidManifest.xml']) {
    assert.ok(rel in files, `generated project is missing ${rel}`);
  }
  assert.ok(Object.keys(files).some((rel) => rel.endsWith('TranslatorCore.kt')));
  // The manifest must reference the resource that the config file provides.
  assert.match(files['app/src/main/AndroidManifest.xml'], /@xml\/accessibility_service_config/);
  assert.ok('app/src/main/res/xml/accessibility_service_config.xml' in files);
});

/**
 * Guards the generated file against drift: run the sync script and confirm the
 * checked-in output is identical. Without this, editing the sample would silently
 * leave the shipped template stale - which is exactly how it became a stub.
 */
test('the generated template file is in sync with the sample app', async () => {
  const before = await fs.readFile(generatedFile, 'utf8');
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', path.join(repoRoot, 'backend', 'scripts', 'sync-translator-template.ts')],
      (err, _stdout, stderr) => (err ? reject(new Error(String(stderr))) : resolve()),
    );
  });
  const after = await fs.readFile(generatedFile, 'utf8');
  assert.equal(after, before, 'translatorTemplateFiles.ts is stale; run npm run sync:translator-template');
});

test('every generated source file exists on disk in the sample', async () => {
  const files = translatorTemplateFiles(SAMPLE_PACKAGE, SAMPLE_LABEL);
  for (const rel of Object.keys(files)) {
    await fs.access(path.join(sampleRoot, rel));
  }
});
