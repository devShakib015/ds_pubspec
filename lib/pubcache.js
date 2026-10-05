'use strict';

// Finds the exact version pubspec.lock resolved to in the local pub cache and
// reads what the score API can't tell you about it: whether *this* version
// ships a Swift package, and whether its Android build applies the Kotlin
// Gradle Plugin. pub.dev's `is:swiftpm-plugin` tag only describes the latest
// release, and the lock is often behind it.

const nodeFs = require('fs');
const nodePath = require('path');
const os = require('os');
const { parseYamlMaps } = require('./yamlmap');

/** Where `pub` keeps downloaded packages: PUB_CACHE, else the platform default. */
function pubCacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.PUB_CACHE) return env.PUB_CACHE;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || nodePath.join(home, 'AppData', 'Local');
    return nodePath.join(local, 'Pub', 'Cache');
  }
  return nodePath.join(home, '.pub-cache');
}

/** pub names a hosted server's directory after its host: hosted/pub.dev. */
function hostedDirNames(url) {
  let host = 'pub.dev';
  try {
    if (url) host = new URL(url).host.replace(/:/g, '%3A');
  } catch (_) { /* keep the default */ }
  // Caches written before pub.dev was renamed still use the old name.
  return host === 'pub.dev' ? ['pub.dev', 'pub.dartlang.org'] : [host];
}

/**
 * The directory holding a locked package's sources, or null when it isn't
 * on disk (not fetched yet, or an SDK package).
 * @param {import('./lockfile').LockedPackage} pkg
 */
function packageDir(pkg, { cacheDir, projectDir, fs = nodeFs }) {
  const exists = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  if (pkg.source === 'hosted' && pkg.version) {
    for (const host of hostedDirNames(pkg.url)) {
      const dir = nodePath.join(cacheDir, 'hosted', host, `${pkg.name}-${pkg.version}`);
      if (exists(dir)) return dir;
    }
    return null;
  }
  if (pkg.source === 'path' && pkg.path) {
    const dir = pkg.relative || !nodePath.isAbsolute(pkg.path)
      ? nodePath.resolve(projectDir, pkg.path)
      : pkg.path;
    return exists(dir) ? dir : null;
  }
  if (pkg.source === 'git' && pkg.url && pkg.resolvedRef) {
    const repo = pkg.url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '');
    const dir = nodePath.join(cacheDir, 'git', `${repo}-${pkg.resolvedRef}`, pkg.path || '.');
    return exists(dir) ? dir : null;
  }
  return null;
}

// Comments can mention the plugin ("// no longer applies kotlin-android"), so
// they are removed before looking for it.
function stripGradleComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const KGP_PATTERNS = [
  /\bid\s*\(?\s*["'](?:kotlin-android|org\.jetbrains\.kotlin\.android)["']/,
  /\bapply\s+plugin\s*:\s*["'](?:kotlin-android|org\.jetbrains\.kotlin\.android)["']/,
  /\bkotlin\s*\(\s*["']android["']\s*\)/,
];

/** True when this Gradle build applies the Kotlin Gradle Plugin. */
function appliesKgp(gradleSource) {
  const src = stripGradleComments(gradleSource);
  return KGP_PATTERNS.some((re) => re.test(src));
}

// Native code means a `pluginClass` or an FFI plugin. A platform with only
// `dartPluginClass` is Dart, and one with only `default_package` endorses a
// federated implementation that is checked as a package of its own.
function isNativePlatform(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return Boolean(entry.pluginClass || entry.ffiPlugin === 'true' || entry.ffiPlugin === true);
}

/**
 * @typedef {{
 *   name: string,
 *   dependencies: string[],
 *   repository: string|null,
 *   issueTracker: string|null,
 *   darwin: { platforms: string[], podspec: boolean, swiftPackage: boolean, cocoapodsOnly: string[] },
 *   android: { native: boolean, appliesKgp: boolean },
 * }} PackageFacts
 */

/**
 * @param {string} dir a package root
 * @returns {PackageFacts|null}
 */
function inspectPackage(dir, { fs = nodeFs } = {}) {
  let text;
  try {
    text = fs.readFileSync(nodePath.join(dir, 'pubspec.yaml'), 'utf8');
  } catch (_) {
    return null;
  }
  const spec = parseYamlMaps(text);
  const plugin = spec.flutter && spec.flutter.plugin;
  const platforms = (plugin && plugin.platforms) || {};
  const list = (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } };
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

  // Per platform, because that's how Flutter builds them: an iOS app uses the
  // plugin's ios/ (or darwin/, with sharedDarwinSource) and never its macos/.
  // A plugin can have a Swift package for one and only a podspec for the other.
  const darwinPlatforms = ['ios', 'macos'].filter((p) => isNativePlatform(platforms[p]));
  const cocoapodsOnly = [];
  let podspec = false;
  let swiftPackage = false;
  for (const p of darwinPlatforms) {
    const shared = platforms[p].sharedDarwinSource === 'true' || platforms[p].sharedDarwinSource === true;
    const base = nodePath.join(dir, shared ? 'darwin' : p);
    let pod = false;
    let swift = false;
    for (const entry of list(base)) {
      if (entry.endsWith('.podspec')) pod = true;
      if (isFile(nodePath.join(base, entry, 'Package.swift'))) swift = true;
    }
    if (pod && !swift) cocoapodsOnly.push(p);
    podspec = podspec || pod;
    swiftPackage = swiftPackage || swift;
  }

  const androidNative = isNativePlatform(platforms.android);
  let kgp = false;
  if (androidNative) {
    for (const file of ['build.gradle', 'build.gradle.kts']) {
      try {
        if (appliesKgp(fs.readFileSync(nodePath.join(dir, 'android', file), 'utf8'))) kgp = true;
      } catch (_) { /* that variant isn't there */ }
    }
  }

  const deps = spec.dependencies && typeof spec.dependencies === 'object'
    ? Object.keys(spec.dependencies)
    : [];

  return {
    name: typeof spec.name === 'string' ? spec.name : nodePath.basename(dir),
    dependencies: deps,
    repository: typeof spec.repository === 'string' ? spec.repository
      : (typeof spec.homepage === 'string' ? spec.homepage : null),
    issueTracker: typeof spec.issue_tracker === 'string' ? spec.issue_tracker : null,
    darwin: { platforms: darwinPlatforms, podspec, swiftPackage, cocoapodsOnly },
    android: { native: androidNative, appliesKgp: kgp },
  };
}

module.exports = { pubCacheDir, packageDir, inspectPackage, appliesKgp, hostedDirNames };
