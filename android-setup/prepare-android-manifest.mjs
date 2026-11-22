import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Extracts <uses-permission ... />, <uses-feature ... />, and <queries>...</queries>
 * declarations from the template manifest and merges any missing entries into the
 * target AndroidManifest.xml cleanly and idempotently.
 */
export function mergeAndroidManifestPermissions(targetManifestXml, templateManifestXml) {
  if (!targetManifestXml.includes('</manifest>')) {
    throw new Error('Target AndroidManifest.xml is missing a closing </manifest> tag.');
  }

  const additions = [];

  const permissionRegex = /<uses-permission\b[\s\S]*?\/>/g;
  const templatePermissions = templateManifestXml.match(permissionRegex) || [];
  for (const tag of templatePermissions) {
    const nameMatch = tag.match(/android:name="([^"]+)"/);
    if (!nameMatch) continue;
    const permName = nameMatch[1];
    if (!targetManifestXml.includes(`android:name="${permName}"`)) {
      additions.push(`    ${tag.replace(/\s+/g, ' ').trim()}`);
    }
  }

  const featureRegex = /<uses-feature\b[\s\S]*?\/>/g;
  const templateFeatures = templateManifestXml.match(featureRegex) || [];
  for (const tag of templateFeatures) {
    const nameMatch = tag.match(/android:name="([^"]+)"/);
    if (!nameMatch) continue;
    const featureName = nameMatch[1];
    if (!targetManifestXml.includes(`android:name="${featureName}"`)) {
      additions.push(`    ${tag.replace(/\s+/g, ' ').trim()}`);
    }
  }

  const queriesMatch = templateManifestXml.match(/<queries>[\s\S]*?<\/queries>/);
  if (queriesMatch && !targetManifestXml.includes('<queries>')) {
    additions.push(`    ${queriesMatch[0].trim()}`);
  }

  if (additions.length === 0) {
    return targetManifestXml;
  }

  const block = `\n    <!-- Merged from android-setup/AndroidManifest.permissions.xml -->\n${additions.join('\n')}\n`;
  const closingIdx = targetManifestXml.lastIndexOf('</manifest>');
  return `${targetManifestXml.slice(0, closingIdx)}${block}${targetManifestXml.slice(closingIdx)}`;
}

export function applyManifestPermissionsToAndroidProject(rootDir = ROOT_DIR) {
  const safeRoot = path.resolve(rootDir);
  const templatePath = path.resolve(safeRoot, 'android-setup', 'AndroidManifest.permissions.xml');
  const manifestPath = path.resolve(
    safeRoot,
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml'
  );

  if (!templatePath.startsWith(safeRoot + path.sep) || !manifestPath.startsWith(safeRoot + path.sep)) {
    throw new Error('Resolved Android manifest path escaped workspace boundary.');
  }

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Permissions template not found at ${templatePath}`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Generated AndroidManifest.xml not found at ${manifestPath}. Run "npx cap add android" first.`
    );
  }

  const templateXml = fs.readFileSync(templatePath, 'utf8');
  const currentXml = fs.readFileSync(manifestPath, 'utf8');
  const mergedXml = mergeAndroidManifestPermissions(currentXml, templateXml);

  if (mergedXml === currentXml) {
    return { updated: false, manifestPath };
  }

  fs.writeFileSync(manifestPath, mergedXml, 'utf8');
  return { updated: true, manifestPath };
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const result = applyManifestPermissionsToAndroidProject(ROOT_DIR);
  console.log(
    result.updated
      ? `Updated Android manifest permissions: ${result.manifestPath}`
      : `Android manifest permissions already up to date: ${result.manifestPath}`
  );
}
