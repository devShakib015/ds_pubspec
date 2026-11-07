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
  const events = { watchers: {} };
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
      asRelativePath: (uri) => {
        const root = path.dirname(pubspecPath);
        return uri.fsPath.startsWith(root + path.sep) ? path.relative(root, uri.fsPath) : uri.fsPath;
      },
      createFileSystemWatcher: (glob) => {
        const on = (name) => (fn) => { (events.watchers[glob] ||= {})[name] = fn; return { dispose() {} }; };
        return { onDidChange: on('change'), onDidCreate: on('create'), onDidDelete: on('delete'), dispose() {} };
      },
      onDidOpenTextDocument: (fn) => { events.open = fn; return { dispose() {} }; },
      onDidSaveTextDocument: (fn) => { events.save = fn; return { dispose() {} }; },
      onDidChangeConfiguration: noop,
    },
  };
  const context = {
    subscriptions: [],
    globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()] },
  };
  return { api, sets, commands, providers, context, uriOf, events };
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
    ...fake, key, pubspecPath, fileUri: () => fake.uriOf(pubspecPath),
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

test('emudhra-firestore: raises the floors in the file, then saves and upgrades the FlutterFire packages', async () => {
  const w = makeWorld({ platforms: ['ios'], packages: { cloud_firestore: { version: '6.6.0' }, firebase_core: { version: '4.11.0' } } });
  fs.writeFileSync(path.join(w.projectDir, 'ios', 'Podfile.lock'), 'PODS:\n');
  const text = 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  cloud_firestore: ^6.5.0 # db\n  firebase_core: ^4.10.0\n';
  const env = await activateWith(w, text, {
    versions: { cloud_firestore: '6.6.0', firebase_core: '4.11.0' }, direct: ['cloud_firestore', 'firebase_core'],
    packages: {
      cloud_firestore: { latest: { version: '6.6.0' }, versions: [{ version: '6.6.0' }] },
      firebase_core: { latest: { version: '4.11.0' }, versions: [{ version: '4.11.0' }] },
    },
  });
  try {
    const ds = env.sets.get(env.key);
    assert.deepEqual(ds.map((d) => d.code.value), ['emudhra-firestore']);
    assert.equal(ds[0].severity, env.api.DiagnosticSeverity.Warning);
    const lines = text.split('\n');
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: (i) => ({ text: lines[i] }) };
    const actions = await env.providers.actions.provideCodeActions(doc, ds[0].range, { diagnostics: ds });
    const narrow = actions[0];
    assert.equal(narrow.title, 'Raise cloud_firestore to ^6.10.2 and firebase_core to ^4.15.2, then upgrade the FlutterFire packages');
    assert.equal(narrow.isPreferred, true);
    assert.deepEqual(narrow.edit.edits.map((e) => [e.range.start.line, e.text]),
      [[4, '  cloud_firestore: ^6.10.2 # db'], [5, '  firebase_core: ^4.15.2']]);
    assert.equal(narrow.command.command, 'pubspecHealth.saveAndRun');
    assert.equal(narrow.command.arguments[2],
      'flutter pub upgrade cloud_firestore firebase_core && pod update Firebase --project-directory=ios');
    const plain = actions.find((a) => a.title.startsWith('Upgrade everything'));
    assert.equal(plain.command.arguments[1], 'flutter pub upgrade && pod update Firebase --project-directory=ios');
    const notice = actions.find((a) => a.title === "Open Firebase's notice");
    assert.match(notice.command.arguments[0], /compromised-emudhra-intermediate-ca$/);

    // The command saves before pub reads the file from disk.
    const saved = [];
    const sent = [];
    env.api.workspace.textDocuments.push({ uri: doc.uri, isDirty: true, save: async () => { saved.push(true); return true; } });
    env.api.window.createTerminal = () => ({ name: 'x', show() {}, sendText: (l) => sent.push(l) });
    await env.commands.get('pubspecHealth.saveAndRun')(...narrow.command.arguments);
    assert.deepEqual(saved, [true]);
    assert.deepEqual(sent, [narrow.command.arguments[2]]);
  } finally { env.restore(); w.cleanup(); }
});

test('emudhra-firestore: a constraint it cannot rewrite falls back to the plain upgrade', async () => {
  const w = makeWorld({ platforms: ['ios'], packages: { cloud_firestore: { version: '6.6.0' } } });
  const text = 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  cloud_firestore: ">=6.0.0 <7.0.0"\n';
  const env = await activateWith(w, text, {
    versions: { cloud_firestore: '6.6.0' }, direct: ['cloud_firestore'],
    packages: { cloud_firestore: { latest: { version: '6.6.0' }, versions: [{ version: '6.6.0' }] } },
  });
  try {
    const ds = env.sets.get(env.key);
    const lines = text.split('\n');
    const doc = { uri: env.uriOf(env.pubspecPath), lineAt: (i) => ({ text: lines[i] }) };
    const titles = (await env.providers.actions.provideCodeActions(doc, ds[0].range, { diagnostics: ds })).map((a) => a.title);
    assert.ok(!titles.some((t) => t.startsWith('Raise')), titles.join(' | '));
    assert.ok(titles.includes('Upgrade everything within your constraints (flutter pub upgrade)'), titles.join(' | '));
  } finally { env.restore(); w.cleanup(); }
});

// soon() waits 600 ms before it checks, so "nothing happened" needs that long.
const settled = () => new Promise((r) => setTimeout(r, 700));

function pubspecUnderBuild(env, ...parts) {
  const file = path.join(path.dirname(env.pubspecPath), 'build', ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'name: copied\ndependencies:\n  http: ^1.2.0\n');
  return env.uriOf(file);
}

test('a pubspec in a build folder is never checked, however it is reached', async () => {
  const w = makeWorld();
  const env = await activateWith(w, PUBSPEC);
  try {
    const before = [...env.sets.keys()];
    const copied = pubspecUnderBuild(env, 'ios', 'SourcePackages', 'checkouts', 'foo', 'pubspec.yaml');
    const lock = pubspecUnderBuild(env, 'x', 'pubspec.lock');
    pubspecUnderBuild(env, 'x', 'pubspec.yaml');

    env.events.watchers['**/pubspec.yaml'].change(copied);
    env.events.watchers['**/pubspec.lock'].create(lock);
    env.events.watchers['**/pubspec.lock'].change(lock);
    env.events.open({ uri: copied });
    env.events.save({ uri: copied });
    await settled();

    assert.deepEqual([...env.sets.keys()], before);
  } finally { env.restore(); w.cleanup(); }
});

test('the project\'s own pubspec is still checked again when it changes', async () => {
  const w = makeWorld();
  const env = await activateWith(w, PUBSPEC);
  try {
    assert.equal(env.sets.get(env.key)[0].range.start.line, 2);
    fs.writeFileSync(env.pubspecPath, `# first\n${PUBSPEC}`);
    env.events.watchers['**/pubspec.yaml'].change(env.fileUri());
    await settled();
    assert.equal(env.sets.get(env.key)[0].range.start.line, 3);
  } finally { env.restore(); w.cleanup(); }
});

test('a project that lives under a folder called build is still a project', async () => {
  const w = makeWorld();
  w.projectDir = path.join(w.projectDir, 'build', 'app');
  fs.mkdirSync(w.projectDir, { recursive: true });
  const env = await activateWith(w, PUBSPEC);
  try {
    fs.writeFileSync(env.pubspecPath, `# first\n${PUBSPEC}`);
    env.events.watchers['**/pubspec.yaml'].change(env.fileUri());
    await settled();
    assert.equal(env.sets.get(env.key)[0].range.start.line, 3);
  } finally { env.restore(); w.cleanup(); }
});

test('opening a pubspec from the pub cache, outside the workspace, adds nothing', async () => {
  const w = makeWorld();
  const outside = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ds-pubspec-'));
  const env = await activateWith(w, PUBSPEC);
  try {
    const before = [...env.sets.keys()];
    const file = path.join(outside, '.pub-cache', 'hosted', 'pub.dev', 'http-1.2.0', 'pubspec.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'name: http\ndependencies:\n  meta: ^1.0.0\n');
    env.events.open({ uri: env.uriOf(file) });
    await settled();
    assert.deepEqual([...env.sets.keys()], before);
  } finally { env.restore(); w.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('inIgnoredDir goes by whole folder names, and the glob lists the same ones', () => {
  const { inIgnoredDir, IGNORE_GLOB } = require('../lib/ignored');
  for (const p of [
    'build/ios/SourcePackages/checkouts/foo/example/pubspec.yaml',
    'packages/app/build/x/pubspec.yaml',
    'ios/.symlinks/plugins/foo/pubspec.yaml',
    'linux/flutter/ephemeral/.plugin_symlinks/foo/pubspec.yaml',
    '/Users/me/.pub-cache/hosted/pub.dev/foo-1.0.0/pubspec.yaml',
    'build\\x\\pubspec.yaml',
  ]) assert.equal(inIgnoredDir(p), true, p);
  for (const p of ['pubspec.yaml', 'packages/app/pubspec.yaml', 'builder/pubspec.yaml', 'my_build/pubspec.yaml', 'build']) {
    assert.equal(inIgnoredDir(p), false, p);
  }
  assert.equal(IGNORE_GLOB, '**/{.dart_tool,build,.symlinks,Pods,node_modules,.pub-cache,.fvm,ephemeral}/**');
});
