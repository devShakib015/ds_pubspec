'use strict';

// Dart pub workspaces (Dart 3.6+). A member's pubspec says
// `resolution: workspace`, and the whole workspace shares one pubspec.lock at
// the root, which lists every package pub resolved but none of the members
// themselves. So a member's lock is found by climbing, and its sibling members
// (`ds_ui: any`) must never be looked up on pub.dev, where an unrelated
// package may have the same name.

const nodeFs = require('fs');
const nodePath = require('path');
const { parseLock } = require('./lockfile');

const RESOLUTION = /^resolution\s*:\s*['"]?workspace['"]?\s*(#.*)?$/m;
const WORKSPACE = /^workspace\s*:/m;
const NAME = /^name\s*:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/m;

/**
 * Where the lock for the package in `projectDir` lives, and the workspace's
 * members by name (empty outside a workspace).
 * @returns {{ lockPath: string, rootDir: string, members: Map<string, string> }}
 */
function resolveLock(projectDir, pubspecText, { fs = nodeFs } = {}) {
  let dir = projectDir;
  let text = pubspecText;
  // Nested workspaces resolve at the outermost root.
  for (let hops = 0; RESOLUTION.test(text) && hops < 16; hops++) {
    const root = findRoot(nodePath.dirname(dir), fs);
    if (!root) break;
    dir = root.dir;
    text = root.text;
  }
  let lockPath = nodePath.join(dir, 'pubspec.lock');
  // A package vendored into an app (path: third_party/x) has no lock of its
  // own: it's resolved as part of the app that uses it.
  if (dir === projectDir && read(fs, lockPath) === null) lockPath = lockResolving(projectDir, fs) || lockPath;
  return {
    lockPath,
    rootDir: nodePath.dirname(lockPath),
    members: WORKSPACE.test(text) ? membersOf(dir, text, fs) : new Map(),
  };
}

/** The nearest lock above `projectDir` that resolved it as a path package. */
function lockResolving(projectDir, fs) {
  const target = nodePath.resolve(projectDir);
  let dir = nodePath.dirname(target);
  for (let hops = 0; hops < 8; hops++) {
    const lockPath = nodePath.join(dir, 'pubspec.lock');
    const text = read(fs, lockPath);
    if (text !== null) {
      for (const pkg of parseLock(text).values()) {
        if (pkg.source !== 'path' || !pkg.path) continue;
        const at = pkg.relative || !nodePath.isAbsolute(pkg.path) ? nodePath.resolve(dir, pkg.path) : nodePath.resolve(pkg.path);
        if (at === target) return lockPath;
      }
    }
    const up = nodePath.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The nearest directory at or above `start` whose pubspec declares a workspace. */
function findRoot(start, fs) {
  let dir = start;
  for (;;) {
    const text = read(fs, nodePath.join(dir, 'pubspec.yaml'));
    if (text !== null && WORKSPACE.test(text)) return { dir, text };
    const up = nodePath.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** name -> directory for every member, including those of nested workspaces. */
function membersOf(rootDir, rootText, fs, out = new Map(), depth = 0) {
  for (const entry of workspaceEntries(rootText)) {
    for (const dir of expand(rootDir, entry, fs)) {
      const text = read(fs, nodePath.join(dir, 'pubspec.yaml'));
      if (text === null) continue;
      const m = NAME.exec(text);
      if (m && !out.has(m[1])) out.set(m[1], dir);
      if (depth < 8 && WORKSPACE.test(text)) membersOf(dir, text, fs, out, depth + 1);
    }
  }
  return out;
}

/** The paths listed under `workspace:`, in order. */
function workspaceEntries(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => WORKSPACE.test(l));
  const out = [];
  if (start < 0) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** A member path, with a trailing or embedded `*` matched one level deep. */
function expand(rootDir, entry, fs) {
  const parts = entry.split('/').filter(Boolean);
  let dirs = [rootDir];
  for (const part of parts) {
    if (!part.includes('*')) { dirs = dirs.map((d) => nodePath.join(d, part)); continue; }
    const re = new RegExp(`^${part.split('*').map(escape).join('.*')}$`);
    dirs = dirs.flatMap((d) => list(fs, d).filter((n) => re.test(n)).map((n) => nodePath.join(d, n)));
  }
  return dirs;
}

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const read = (fs, p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const list = (fs, p) => { try { return fs.readdirSync(p).sort(); } catch (_) { return []; } };

module.exports = { resolveLock, workspaceEntries };
