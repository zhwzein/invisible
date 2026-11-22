/**
 * Bumps app version in package.json and syncs versionCode + versionName in android/app/build.gradle.
 * Usage:
 *   node scripts/bump-version.js [patch|minor|major]
 *   node scripts/bump-version.js --ci-run <run_number>
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
let gradle = fs.readFileSync(gradlePath, 'utf8');

const args = process.argv.slice(2);
const ciIndex = args.indexOf('--ci-run');

if (ciIndex !== -1 && args[ciIndex + 1]) {
  const runNum = Math.max(1, parseInt(args[ciIndex + 1], 10) || 1);
  const [maj, min] = String(pkg.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const nextVersion = `${maj}.${min}.${runNum}`;

  gradle = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${runNum}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${nextVersion}"`);
  fs.writeFileSync(gradlePath, gradle, 'utf8');
  console.log(`[version] CI build -> versionName=${nextVersion}, versionCode=${runNum}`);
  process.exit(0);
}

const bumpType = args[0] || 'patch';
let [major, minor, patch] = String(pkg.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);

if (bumpType === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bumpType === 'minor') {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const nextVersion = `${major}.${minor}.${patch}`;
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const codeMatch = gradle.match(/versionCode\s+(\d+)/);
const nextCode = codeMatch ? parseInt(codeMatch[1], 10) + 1 : 1;

gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${nextCode}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${nextVersion}"`);
fs.writeFileSync(gradlePath, gradle, 'utf8');

console.log(`[version] Bumped -> v${nextVersion} (Android versionCode ${nextCode})`);
