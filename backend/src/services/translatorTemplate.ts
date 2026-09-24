/**
 * Builds the source files for the `android-floating-translator` template.
 *
 * The file contents are generated from android-samples/translator by
 * scripts/sync-translator-template.ts, so there is one source of truth for the
 * Kotlin: the sample that CI actually compiles. This module only decides where
 * each file goes for a given project and swaps in the project's package name.
 */
import {
  TRANSLATOR_PACKAGE_PLACEHOLDER,
  TRANSLATOR_APP_LABEL_PLACEHOLDER,
  TRANSLATOR_PACKAGE_PATH_PLACEHOLDER,
  TRANSLATOR_TEMPLATE_FILES,
} from './translatorTemplateFiles.ts';

/** Files that belong under src/test rather than src/main. */
function isTestFile(relPath: string): boolean {
  return relPath.startsWith('app/src/test/');
}

/**
 * Rewrites the sample's package name and app label to the project's.
 *
 * The package appears in `package` declarations, import paths and directory
 * names, so a textual replacement is applied to both content and paths.
 */
export function withPackage(content: string, pkg: string, appLabel?: string): string {
  let out = content.split(TRANSLATOR_PACKAGE_PLACEHOLDER).join(pkg);
  if (appLabel !== undefined) {
    out = out.split(TRANSLATOR_APP_LABEL_PLACEHOLDER).join(appLabel);
  }
  return out;
}

/**
 * The full file map for a project. Paths are relative to the project root and
 * mirror the sample's layout, minus the Gradle wrapper (installed separately by
 * ensureGradleWrapper).
 */
export function translatorTemplateFiles(pkg: string, appLabel?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(TRANSLATOR_TEMPLATE_FILES)) {
    const path = rel.split(TRANSLATOR_PACKAGE_PATH_PLACEHOLDER).join(pkg.split('.').join('/'));
    out[path] = withPackage(content, pkg, appLabel);
  }
  return out;
}

/** Test sources, for callers that need them separately. */
export function translatorTestFiles(pkg: string, appLabel?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(TRANSLATOR_TEMPLATE_FILES)) {
    if (isTestFile(rel)) out[rel.split(TRANSLATOR_PACKAGE_PATH_PLACEHOLDER).join(pkg.split('.').join('/'))] = withPackage(content, pkg, appLabel);
  }
  return out;
}

export { TRANSLATOR_PACKAGE_PLACEHOLDER, TRANSLATOR_APP_LABEL_PLACEHOLDER, TRANSLATOR_PACKAGE_PATH_PLACEHOLDER };
