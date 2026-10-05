'use strict';

// extension.js against a stand-in `vscode` module and a stubbed pub.dev:
// enough to prove activation finds pubspecs, that findings arrive as
// diagnostics on the right range, and that the quick fix and hover use them.
// The real editor is checked by hand before a release.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('fs');
const path = require('path');
const { makeWorld, lockFor } = require('./helpers');

function fakeVscode({ pubspecPath, config = {} }) {
  const sets = new Map();
  const commands = new Map();
  const providers = {};
  const state = new Map();
  const noop = () => ({ dispose() {} });
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
    }
  }
  class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
  class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
  class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } }
  class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } }
  class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
  const uriOf = (p) => ({ scheme: 'file', fsPath: p, toString: () => `file://${p}` });
  const api = {
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1 },
    CodeActionKind: { QuickFix: 'quickfix' },
    TextEditorRevealType: { InCenter: 2 },
    Position, Range, Diagnostic, CodeAction, WorkspaceEdit, MarkdownString, Hover,
    Selection: Range,
    Uri: { parse: (s) => ({ toString: () => s }), file: uriOf },
    env: { openExternal: async () => true },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
      terminals: [],
      showInformationMessage: async () => undefined,
      setStatusBarMessage: noop,
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, ds) => sets.set(uri.toString(), ds),
        delete: (uri) => sets.delete(uri.toString()),
        dispose() {},
      }),
      registerHoverProvider: (_sel, p) => { providers.hover = p; return { dispose() {} }; },
      registerCodeActionsProvider: (_sel, p) => { providers.actions = p; return { dispose() {} }; },
    },
    workspace: {
      textDocuments: [],
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
      findFiles: async () => [uriOf(pubspecPath)],
      createFileSystemWatcher: () => ({ onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {} }),
      onDidOpenTextDocument: noop, onDidSaveTextDocument: noop, onDidChangeConfiguration: noop,
    },
  };
  const context = {
    subscriptions: [],
    globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()] },
  };
  return { api, sets, commands, providers, context, uriOf };
}

const PUBDEV = {
  connectivity: { latest: { version: '3.0.6' }, versions: [{ version: '3.0.6' }], isDiscontinued: true, replacedBy: 'connectivity_plus' },
  connectivity_plus: { latest: { version: '7.1.1' }, versions: [{ version: '7.1.1' }] },
  http: { latest: { version: '1.2.0' }, versions: [{ version: '1.2.0' }] },
};

async function activateWith(world, pubspec, { versions = { connectivity: '3.0.6', http: '1.2.0' }, direct, packages = PUBDEV, scores = {} } = {}) {
  const pubspecPath = path.join(world.projectDir, 'pubspec.yaml');
  fs.writeFileSync(pubspecPath, pubspec);
  fs.writeFileSync(path.join(world.projectDir, 'pubspec.lock'), lockFor(versions, direct || Object.keys(versions)));
  const fake = fakeVscode({ pubspecPath });
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const originalCache = process.env.PUB_CACHE;
  process.env.PUB_CACHE = world.cacheDir;
  globalThis.fetch = async (url) => {
    const name = decodeURIComponent(String(url).split('/api/packages/')[1].split('/')[0]);
    const body = String(url).endsWith('/score')
      ? { grantedPoints: 160, maxPoints: 160, likeCount: 42, downloadCount30Days: 1000, tags: [], ...scores[name] }
      : packages[name];
    return { status: body ? 200 : 404, ok: !!body, headers: { get: () => null }, json: async () => body };
  };
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? fake.api : originalLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('../extension')];
  try {
    require('../extension').activate(fake.context);
  } finally {
    Module._load = originalLoad;
  }
  // Activation checks the workspace without blocking; wait for it to land.
  const key = fake.uriOf(pubspecPath).toString();
  for (let i = 0; i < 100 && !fake.sets.has(key); i++) await new Promise((r) => setTimeout(r, 10));
  return {
    ...fake, key, pubspecPath,
    restore() {
      globalThis.fetch = originalFetch;
      if (originalCache === undefined) delete process.env.PUB_CACHE; else process.env.PUB_CACHE = originalCache;
    },
  };
}

const PUBSPEC = 'name: app\ndependencies:\n  connectivity: ^3.0.0 # network\n  http: ^1.2.0\n';

test('activation turns findings into diagnostics on the dependency line', async () => {
  const w = makeWorld();
  const env = await activateWith(w, PUBSPEC);
  try {
    const ds = env.sets.get(env.key);
    assert.equal(ds.length, 1);
    assert.equal(ds[0].severity, 1, 'warning');
    assert.equal(ds[0].range.start.line, 2);
    assert.equal(ds[0].range.start.character, 2);
    assert.equal(ds[0].range.end.character, 14);
    assert.equal(ds[0].source, 'Pubspec Health');
    assert.equal(ds[0].code.value, 'discontinued');
  } finally { env.restore(); w.cleanup(); }
});

test('the quick fix swaps in the replacement at its latest version, comment kept', async () => {
  const w = makeWorld();
  const env = await activateWith(w, PUBSPEC);
  try {
    const lines = PUBSPEC.split('\n');
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: (i) => ({ text: lines[i] }) };
    const diag = env.sets.get(env.key)[0];
    const actions = await env.providers.actions.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
    const fix = actions.find((a) => a.title === 'Replace connectivity with connectivity_plus');
    assert.ok(fix, `got: ${actions.map((a) => a.title).join(' | ')}`);
    assert.equal(fix.edit.edits[0].text, '  connectivity_plus: ^7.1.1 # network');
    assert.ok(actions.some((a) => a.title === 'Open connectivity on pub.dev'));
  } finally { env.restore(); w.cleanup(); }
});

test('hover shows the locked and latest versions and pub.dev numbers', async () => {
  const w = makeWorld();
  const env = await activateWith(w, PUBSPEC);
  try {
    const doc = { uri: env.uriOf(env.pubspecPath) };
    const h = await env.providers.hover.provideHover(doc, { line: 3, character: 3 });
    assert.match(h.contents.value, /\*\*http\*\* · locked \*\*1\.2\.0\*\* · latest \*\*1\.2\.0\*\* · 160\/160 pub points · 42 likes/);
    assert.equal(await env.providers.hover.provideHover(doc, { line: 0, character: 1 }), null, 'not on a dependency');
  } finally { env.restore(); w.cleanup(); }
});

test('one line, three findings: each action once, the most specific title kept', async () => {
  const w = makeWorld({ platforms: ['ios', 'android'], packages: {
    cam: { version: '1.0.0', repository: 'https://github.com/example/cam',
      plugin: { ios: { pluginClass: 'Cam' }, android: { package: 'dev.cam', pluginClass: 'Cam' } },
      files: { 'ios/cam.podspec': 'x', 'android/build.gradle': "plugins {\n  id 'kotlin-android'\n}\n" } },
  } });
  const env = await activateWith(w, 'name: app\ndependencies:\n  cam: ^1.0.0\n', {
    versions: { cam: '1.0.0' },
    packages: { cam: { latest: { version: '1.1.0' }, versions: [{ version: '1.0.0' }, { version: '1.1.0' }] } },
    scores: { cam: { tags: ['is:swiftpm-plugin'] } },
  });
  try {
    const ds = env.sets.get(env.key);
    assert.deepEqual(ds.map((d) => d.code.value).sort(), ['built-in-kotlin', 'outdated', 'swiftpm']);
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: () => ({ text: '  cam: ^1.0.0' }) };
    const titles = (await env.providers.actions.provideCodeActions(doc, ds[0].range, { diagnostics: ds })).map((a) => a.title);
    assert.deepEqual(titles, [
      'Upgrade cam to 1.1.0 (has a Swift package)',
      'Ask the cam maintainers to migrate to built-in Kotlin (pre-filled GitHub issue)',
      'Open cam on pub.dev',
    ]);
  } finally { env.restore(); w.cleanup(); }
});

test('a transitive SwiftPM upgrade runs through the line it was reported on', async () => {
  const w = makeWorld({ platforms: ['ios'], packages: {
    shot: { version: '2.0.0', deps: ['shot_ios'] },
    shot_ios: { version: '1.0.0', plugin: { ios: { pluginClass: 'S' } }, files: { 'ios/shot_ios.podspec': 'x' } },
  } });
  const env = await activateWith(w, 'name: app\ndependencies:\n  shot: ^2.0.0\n', {
    versions: { shot: '2.0.0', shot_ios: '1.0.0' }, direct: ['shot'],
    packages: {
      shot: { latest: { version: '2.0.0' }, versions: [{ version: '2.0.0' }] },
      shot_ios: { latest: { version: '1.1.0' }, versions: [{ version: '1.0.0' }, { version: '1.1.0' }] },
    },
    scores: { shot_ios: { tags: ['is:swiftpm-plugin'] } },
  });
  try {
    const ds = env.sets.get(env.key);
    assert.deepEqual(ds.map((d) => d.code.value), ['swiftpm']);
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: () => ({ text: '  shot: ^2.0.0' }) };
    const actions = await env.providers.actions.provideCodeActions(doc, ds[0].range, { diagnostics: ds });
    const up = actions.find((a) => a.title.startsWith('Upgrade'));
    assert.equal(up.title, 'Upgrade shot (shot_ios 1.1.0 has a Swift package)');
    assert.deepEqual(up.command.arguments[1], 'dart pub upgrade --major-versions shot', 'never --major-versions on shot_ios');
  } finally { env.restore(); w.cleanup(); }
});

test('an override line gets no rename and no upgrade: pub upgrade cannot move it', async () => {
  const w = makeWorld();
  const env = await activateWith(w, 'name: app\ndependencies:\n  http: ^1.2.0\ndependency_overrides:\n  connectivity: 3.0.6\n');
  try {
    const ds = env.sets.get(env.key);
    assert.deepEqual(ds.map((d) => `${d.code.value}@${d.range.start.line}`), ['discontinued@4']);
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: () => ({ text: '  connectivity: 3.0.6' }) };
    const titles = (await env.providers.actions.provideCodeActions(doc, ds[0].range, { diagnostics: ds })).map((a) => a.title);
    assert.deepEqual(titles, ['Open connectivity on pub.dev']);
  } finally { env.restore(); w.cleanup(); }
});

test('nobody is asked to migrate a discontinued plugin', async () => {
  const w = makeWorld({ platforms: ['ios'], packages: {
    connectivity: { version: '3.0.6', repository: 'https://github.com/flutter/plugins',
      plugin: { ios: { pluginClass: 'C' } }, files: { 'ios/connectivity.podspec': 'x' } },
  } });
  const env = await activateWith(w, 'name: app\ndependencies:\n  connectivity: ^3.0.0\n', { versions: { connectivity: '3.0.6' } });
  try {
    const ds = env.sets.get(env.key);
    assert.deepEqual(ds.map((d) => d.code.value).sort(), ['discontinued', 'swiftpm']);
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: () => ({ text: '  connectivity: ^3.0.0' }) };
    const titles = (await env.providers.actions.provideCodeActions(doc, ds[0].range, { diagnostics: ds })).map((a) => a.title);
    assert.ok(!titles.some((t) => t.startsWith('Ask')), titles.join(' | '));
    assert.ok(titles.includes('Replace connectivity with connectivity_plus'));
  } finally { env.restore(); w.cleanup(); }
});
