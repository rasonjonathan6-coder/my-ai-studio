/**
 * Regenerates the in-product Android translator template from the real sample app.
 *
 * `android-samples/translator` is the source of truth: it is what the CI workflow
 * builds and what was verified with Gradle. The product's generator needs the same
 * files as strings, and hand-copying Kotlin into TypeScript template literals is how
 * the template drifted into a stub in the first place. So the files are read from
 * disk and embedded with JSON.stringify, which escapes them correctly by
 * construction, and the result is checked in as generated code.
 *
 * Run: npm run sync:translator-template -w backend
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleRoot = path.resolve(here, '..', '..', 'android-samples', 'translator');
const outFile = path.resolve(here, '..', 'src', 'services', 'translatorTemplateFiles.ts');

/** The package the sample is written against; the product substitutes its own. */
const SAMPLE_PACKAGE = 'com.myaistudio.floatingtranslator';
const PACKAGE_PLACEHOLDER = '__PACKAGE__';
/** The package in directory form, which appears in source file paths. */
const SAMPLE_PACKAGE_PATH = SAMPLE_PACKAGE.split('.').join('/');
const PACKAGE_PATH_PLACEHOLDER = '__PACKAGE_PATH__';

/** Directories that are build output, caches, or installed separately. */
const EXCLUDED_DIRS = new Set(['build', '.gradle', '.kotlin']);

/** The wrapper is installed by ensureGradleWrapper, not written as a template file. */
const EXCLUDED_PATHS = new Set([
  'gradlew',
  'gradlew.bat',
  'gradle/wrapper/gradle-wrapper.jar',
  'gradle/wrapper/gradle-wrapper.properties',
  // The generator already builds these with the project's own app label and
  // package, so taking the sample's copies would reintroduce the sample's name.
  'settings.gradle.kts',
  'build.gradle.kts',
  'gradle.properties',
  'README.md',
]);

/** The sample's display name; the product substitutes the project's app label. */
const SAMPLE_APP_LABEL = 'Floating AI Translator';
const APP_LABEL_PLACEHOLDER = '__APP_LABEL__';

async function walk(dir: string, base = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...(await walk(path.join(dir, entry.name), rel)));
      continue;
    }
    if (EXCLUDED_PATHS.has(rel)) continue;
    out.push(rel);
  }
  return out;
}

async function main(): Promise<void> {
  const rels = (await walk(sampleRoot)).sort();
  if (rels.length === 0) {
    throw new Error(`no template files found under ${sampleRoot}`);
  }

  const parts: string[] = [];
  for (const rel of rels) {
    const content = await fs.readFile(path.join(sampleRoot, rel), 'utf8');
    // Substitute at generation time so the checked-in map stays readable, and
    // the generator can swap in the project's own package name.
    const stored = content
      .split(SAMPLE_PACKAGE)
      .join(PACKAGE_PLACEHOLDER)
      .split(SAMPLE_APP_LABEL)
      .join(APP_LABEL_PLACEHOLDER);
    // File paths use the slash form of the package, so they get their own
    // placeholder; the module rebuilds them from the project's package name.
    const relPath = rel.split(SAMPLE_PACKAGE_PATH).join(PACKAGE_PATH_PLACEHOLDER);
    parts.push(`  ${JSON.stringify(relPath)}: ${JSON.stringify(stored)},`);
  }

  const banner = `/**
 * GENERATED FILE - do not edit by hand.
 *
 * Source: android-samples/translator (the app the Android CI workflow builds).
 * Regenerate: npm run sync:translator-template -w backend
 *
 * The package name is written as ${PACKAGE_PLACEHOLDER} and the app name as
 * ${APP_LABEL_PLACEHOLDER}; both are replaced per project.
 */
export const TRANSLATOR_PACKAGE_PLACEHOLDER = ${JSON.stringify(PACKAGE_PLACEHOLDER)};
export const TRANSLATOR_APP_LABEL_PLACEHOLDER = ${JSON.stringify(APP_LABEL_PLACEHOLDER)};
export const TRANSLATOR_PACKAGE_PATH_PLACEHOLDER = ${JSON.stringify(PACKAGE_PATH_PLACEHOLDER)};

export const TRANSLATOR_TEMPLATE_FILES: Record<string, string> = {
`;

  await fs.writeFile(outFile, `${banner}${parts.join('\n')}\n};\n`, 'utf8');
  process.stdout.write(`wrote ${rels.length} files to ${outFile}\n`);
  for (const rel of rels) process.stdout.write(`  ${rel}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
