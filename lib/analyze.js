'use strict';

// Decides what to say about a pubspec.yaml. Knows nothing about VS Code:
// takes text, a pub cache on disk and a pub.dev client, returns findings with
// line positions. extension.js turns them into diagnostics.

const nodeFs = require('fs');
const nodePath = require('path');
const { parsePubspec } = require('./pubspec');
const { parseLock } = require('./lockfile');
const { packageDir, inspectPackage } = require('./pubcache');
const { compareVersions } = require('./semver');

const COCOAPODS_FREEZE = '2 Dec 2026';

/**
 * @typedef {{
 *   id: 'discontinued'|'retracted'|'swiftpm'|'built-in-kotlin'|'outdated'|'not-resolved',
 *   severity: 'error'|'warning'|'info'|'hint',
 *   dep: string|null,
 *   line: number, start: number, end: number,
 *   message: string,
 *   data: Record<string, any>,
 * }} Finding
 */

const PUB_DEV = /^https?:\/\/pub\.(dev|dartlang\.org)\/?$/;

function isPubDev(dep) {
  return dep.source === 'hosted' && (!dep.hostedUrl || PUB_DEV.test(dep.hostedUrl));
}

const quoteList = (names) => {
  const q = names.map((n) => `${n}`);
  if (q.length <= 1) return q.join('');
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
};

/** Reads `android.builtInKotlin=true` from the app's gradle.properties. */
function builtInKotlinOn(projectDir, fs) {
  try {
    const props = fs.readFileSync(nodePath.join(projectDir, 'android', 'gradle.properties'), 'utf8');
    return /^\s*android\.builtInKotlin\s*=\s*true\s*$/m.test(props);
  } catch (_) {
    return false;
  }
}

const dirExists = (fs, p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

/**
 * @param {{
 *   pubspecText: string,
 *   lockText: string|null,
 *   projectDir: string,
 *   cacheDir: string,
 *   pubdev: ReturnType<typeof import('./pubdev').createPubDevClient>|null,
 *   lockDir?: string,                  // where pubspec.lock is: a workspace's root
 *   members?: Map<string, string>,     // workspace members, name -> directory
 *   factsCache?: Map<string, any>,     // pub cache dir -> inspectPackage result
 *   fs?: typeof import('fs'),
 *   checks?: Partial<Record<Finding['id'], boolean>>,
 * }} input
 */
async function analyze(input) {
  const fs = input.fs || nodeFs;
  const enabled = (id) => !input.checks || input.checks[id] !== false;
  const { deps } = parsePubspec(input.pubspecText);
  const locked = input.lockText ? parseLock(input.lockText) : new Map();
  /** @type {Finding[]} */
  const findings = [];
  const summary = {
    discontinued: [], retracted: [], outdated: [],
    cocoapodsOnly: [], kgp: [], builtInKotlin: false, missing: [],
  };
  /** Where to report a problem upstream, for packages found on disk. */
  const links = new Map();
  const at = (dep) => ({ dep: dep.name, line: dep.line, start: dep.start, end: dep.end });

  // --- What pub.dev knows: discontinued, retracted, newer releases. ---------
  // Once there's a lock, only what pub actually fetched from pub.dev is asked
  // about there: a workspace member (`ds_ui: any`) or a path override can
  // share its name with an unrelated pub.dev package.
  const members = input.members || new Map();
  const fromPubDev = (name) => {
    if (members.has(name)) return false;
    if (!locked.size) return true;
    const l = locked.get(name);
    return !!l && l.source === 'hosted' && (!l.url || PUB_DEV.test(l.url));
  };
  // An override pins a version on purpose, and pub upgrade can't move it. A
  // package that's also a regular dependency is reported there, once.
  const listed = new Set(deps.filter((d) => d.section !== 'dependency_overrides').map((d) => d.name));
  const hosted = deps.filter((d) => isPubDev(d) && fromPubDev(d.name)
    && !(d.section === 'dependency_overrides' && listed.has(d.name)));
  if (input.pubdev) {
    const infos = await Promise.all(hosted.map((d) => input.pubdev.packageInfo(d.name).catch(() => null)));
    hosted.forEach((dep, i) => {
      const info = infos[i];
      if (!info) return;
      const lockedVersion = locked.get(dep.name) && locked.get(dep.name).version;

      if (enabled('discontinued') && info.isDiscontinued) {
        summary.discontinued.push(dep.name);
        findings.push({
          id: 'discontinued', severity: 'warning', ...at(dep),
          message: info.replacedBy
            ? `${dep.name} is discontinued. Its author recommends ${info.replacedBy} instead.`
            : `${dep.name} is discontinued and won't get further fixes.`,
          data: { replacedBy: info.replacedBy },
        });
      }
      if (enabled('retracted') && lockedVersion && info.retracted.includes(lockedVersion)) {
        summary.retracted.push(dep.name);
        findings.push({
          id: 'retracted', severity: 'warning', ...at(dep),
          message: `${dep.name} ${lockedVersion}, the version your lockfile pins, was retracted by its author. Upgrading picks a version they still stand behind.`,
          data: { version: lockedVersion },
        });
      }
      if (enabled('outdated') && lockedVersion && info.latest && dep.section !== 'dependency_overrides'
          && !info.isDiscontinued && compareVersions(lockedVersion, info.latest) < 0) {
        summary.outdated.push(dep.name);
        findings.push({
          id: 'outdated', severity: 'hint', ...at(dep),
          message: `${dep.name} ${info.latest} is out (you're on ${lockedVersion}).`,
          data: { latest: info.latest, locked: lockedVersion },
        });
      }
    });
  }

  // --- What's on disk: SwiftPM and built-in Kotlin readiness. ---------------
  const appDarwin = enabled('swiftpm')
    ? ['ios', 'macos'].filter((p) => dirExists(fs, nodePath.join(input.projectDir, p)))
    : [];
  const wantDarwin = appDarwin.length > 0;
  const wantAndroid = enabled('built-in-kotlin') && dirExists(fs, nodePath.join(input.projectDir, 'android'));

  if (locked.size && (wantDarwin || wantAndroid)) {
    /** @type {Map<string, import('./pubcache').PackageFacts>} */
    const facts = new Map();
    // A version in the pub cache never changes, so what it says can be kept
    // between checks; a path package or workspace member is read every time.
    const cache = input.factsCache;
    const inspect = (dir) => {
      const keep = cache && dir.startsWith(input.cacheDir + nodePath.sep);
      if (keep && cache.has(dir)) return cache.get(dir);
      const f = inspectPackage(dir, { fs });
      if (keep) cache.set(dir, f);
      return f;
    };
    const record = (name, f) => {
      facts.set(name, f);
      links.set(name, { repository: f.repository, issueTracker: f.issueTracker });
    };
    for (const pkg of locked.values()) {
      if (pkg.source === 'sdk') continue;
      // Relative path entries are relative to the lock, which in a workspace
      // is the root's, not this member's.
      const dir = packageDir(pkg, { cacheDir: input.cacheDir, projectDir: input.lockDir || input.projectDir, fs });
      if (!dir) { summary.missing.push(pkg.name); continue; }
      const f = inspect(dir);
      if (f) record(pkg.name, f);
    }
    // Workspace members aren't in the lock, but plugins reach the app through
    // them (an app's ds_ui pulls in whatever ds_ui depends on).
    for (const [name, dir] of members) {
      if (facts.has(name)) continue;
      const f = inspect(dir);
      if (f) record(name, f);
    }

    const cocoapodsOnly = new Set();
    const kgp = new Set();
    for (const [name, f] of facts) {
      if (f.darwin.cocoapodsOnly.some((p) => appDarwin.includes(p))) cocoapodsOnly.add(name);
      if (wantAndroid && f.android.appliesKgp) kgp.add(name);
    }
    summary.cocoapodsOnly = [...cocoapodsOnly].sort();
    summary.kgp = [...kgp].sort();
    summary.builtInKotlin = wantAndroid && builtInKotlinOn(input.projectDir, fs);

    // Which direct dependency pulls each offender in. A federated plugin's
    // iOS code lives in a package you never wrote down (url_launcher_ios), so
    // the finding goes on the line you *can* change.
    const reach = (root) => {
      const seen = new Set();
      const queue = [root];
      while (queue.length) {
        const n = queue.shift();
        if (seen.has(n)) continue;
        seen.add(n);
        const f = facts.get(n);
        if (f) for (const d of f.dependencies) if (locked.has(d) || members.has(d)) queue.push(d);
      }
      return seen;
    };

    // pub.dev's tag says whether the *latest* release of an offender has a
    // Swift package — the difference between "upgrade" and "wait". And a
    // discontinued offender will never migrate, so nobody should be asked to.
    const swiftpmLatest = new Map();
    const abandoned = new Set();
    if (input.pubdev && (cocoapodsOnly.size || kgp.size)) {
      await Promise.all([...new Set([...cocoapodsOnly, ...kgp])].map(async (name) => {
        const pkg = locked.get(name);
        if (!pkg || pkg.source !== 'hosted') return;
        const [score, info] = await Promise.all([
          cocoapodsOnly.has(name) ? input.pubdev.scoreInfo(name).catch(() => null) : null,
          input.pubdev.packageInfo(name).catch(() => null),
        ]);
        if (info && info.isDiscontinued) abandoned.add(name);
        if (score && info && score.tags.includes('is:swiftpm-plugin')
            && compareVersions(pkg.version, info.latest) < 0) {
          swiftpmLatest.set(name, info.latest);
        }
      }));
    }

    const direct = new Set(deps.filter((d) => d.section === 'dependencies').map((d) => d.name));
    for (const dep of deps) {
      // dev_dependencies are never built into the app, and an overridden
      // package is reported on the dependency that pulls it in.
      if (dep.section !== 'dependencies') continue;
      // A plugin the app lists itself is reported on its own line only, not
      // again on every other dependency that also pulls it in.
      const mine = (n) => n === dep.name || !direct.has(n);
      const reached = [...reach(dep.name)].filter(mine);
      const pods = reached.filter((n) => cocoapodsOnly.has(n)).sort((a, b) => (a === dep.name ? -1 : b === dep.name ? 1 : a.localeCompare(b)));
      const kotlin = reached.filter((n) => kgp.has(n)).sort((a, b) => (a === dep.name ? -1 : b === dep.name ? 1 : a.localeCompare(b)));

      if (pods.length) {
        const upgrades = pods.filter((n) => swiftpmLatest.has(n));
        const who = pods.length === 1 && pods[0] === dep.name ? dep.name : quoteList(pods);
        let message = `No Swift Package Manager support in ${who}${pods.length === 1 && pods[0] === dep.name ? ' (this version)' : ''}. `
          + `Flutter falls back to CocoaPods for ${pods.length === 1 ? 'it' : 'them'}, and the CocoaPods registry goes read-only on ${COCOAPODS_FREEZE}.`;
        if (upgrades.length) {
          message += ` Newer releases with SwiftPM: ${upgrades.map((n) => `${n} ${swiftpmLatest.get(n)}`).join(', ')}.`;
        }
        findings.push({
          id: 'swiftpm', severity: 'info', ...at(dep), message,
          data: {
            packages: pods,
            upgrades: Object.fromEntries(upgrades.map((n) => [n, swiftpmLatest.get(n)])),
            discontinued: pods.filter((n) => abandoned.has(n)),
          },
        });
      }
      if (kotlin.length) {
        const who = kotlin.length === 1 && kotlin[0] === dep.name ? dep.name : quoteList(kotlin);
        const on = summary.builtInKotlin;
        findings.push({
          id: 'built-in-kotlin', severity: on ? 'error' : 'info', ...at(dep),
          message: on
            ? `${who} still ${kotlin.length === 1 ? 'applies' : 'apply'} the Kotlin Gradle Plugin, which breaks the Android build now that android.builtInKotlin=true.`
            : `${who} still ${kotlin.length === 1 ? 'applies' : 'apply'} the Kotlin Gradle Plugin, so this app can't turn on AGP 9's built-in Kotlin yet.`,
          data: { packages: kotlin, builtInKotlin: on, discontinued: kotlin.filter((n) => abandoned.has(n)) },
        });
      }
    }
  }

  if (input.lockText === null && deps.length && enabled('not-resolved')) {
    const first = deps[0];
    findings.push({
      id: 'not-resolved', severity: 'info', dep: null, line: first.line, start: first.start, end: first.end,
      message: 'No pubspec.lock yet, so locked versions and plugin readiness can\'t be checked. Run flutter pub get.',
      data: {},
    });
  }

  /** The dependencies that are pub.dev packages: the only ones worth a hover. */
  const onPubDev = new Set(deps.filter((d) => isPubDev(d) && fromPubDev(d.name)).map((d) => d.name));
  return { findings, summary, deps, locked, links, onPubDev };
}

module.exports = { analyze, COCOAPODS_FREEZE };
