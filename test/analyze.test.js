'use strict';

// One test per check, and the other half that matters as much: the cases
// that look alarming and are fine must say nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyze');
const { appliesKgp, inspectPackage, hostedDirNames } = require('../lib/pubcache');
const { makeWorld, lockFor, fakePubDev } = require('./helpers');

const PUBSPEC = (lines) => `name: app\ndependencies:\n${lines.map((l) => `  ${l}\n`).join('')}`;
const ids = (r) => r.findings.map((f) => `${f.id}:${f.dep}`).sort();

const KGP_GRADLE = "plugins {\n  id 'com.android.library'\n  id 'kotlin-android'\n}\n";
const PLAIN_GRADLE = "plugins {\n  id 'com.android.library'\n}\n";

test('discontinued: says so, with the replacement the author named', async () => {
  const w = makeWorld();
  try {
    const r = await analyze({
      pubspecText: PUBSPEC(['connectivity: ^3.0.0', 'old_thing: ^1.0.0', 'fine: ^1.0.0']),
      lockText: lockFor({ connectivity: '3.0.6', old_thing: '1.0.0', fine: '1.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir,
      pubdev: fakePubDev({ packages: {
        connectivity: { latest: '3.0.6', isDiscontinued: true, replacedBy: 'connectivity_plus' },
        old_thing: { latest: '1.0.0', isDiscontinued: true },
        fine: { latest: '1.0.0' },
      } }),
    });
    assert.deepEqual(ids(r), ['discontinued:connectivity', 'discontinued:old_thing']);
    const c = r.findings.find((f) => f.dep === 'connectivity');
    assert.equal(c.data.replacedBy, 'connectivity_plus');
    assert.match(c.message, /connectivity_plus instead/);
    assert.equal(c.line, 2);
    assert.equal(c.start, 2);
  } finally { w.cleanup(); }
});

test('retracted: only when the *locked* version is the retracted one', async () => {
  const w = makeWorld();
  try {
    const pubdev = fakePubDev({ packages: {
      a: { latest: '1.2.0', retracted: ['1.1.0'] },
      b: { latest: '2.0.0', retracted: ['1.9.0'] },
    } });
    const r = await analyze({
      pubspecText: PUBSPEC(['a: ^1.0.0', 'b: ^2.0.0']),
      lockText: lockFor({ a: '1.1.0', b: '2.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev, checks: { outdated: false },
    });
    assert.deepEqual(ids(r), ['retracted:a']);
  } finally { w.cleanup(); }
});

test('outdated: a hint when a newer release exists, silent when current', async () => {
  const w = makeWorld();
  try {
    const r = await analyze({
      pubspecText: PUBSPEC(['old: ^1.0.0', 'current: ^2.0.0']),
      lockText: lockFor({ old: '1.0.0', current: '2.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir,
      pubdev: fakePubDev({ packages: { old: { latest: '1.4.0' }, current: { latest: '2.0.0' } } }),
    });
    assert.deepEqual(ids(r), ['outdated:old']);
    assert.equal(r.findings[0].severity, 'hint');
  } finally { w.cleanup(); }
});

test('swiftpm: a federated plugin is blamed on the line you wrote, with the upgrade', async () => {
  const w = makeWorld({
    platforms: ['ios'],
    packages: {
      shiny: { version: '1.0.0', deps: ['shiny_ios', 'shiny_platform_interface'],
        plugin: { ios: { default_package: 'shiny_ios' } } },
      shiny_ios: { version: '1.0.0', plugin: { ios: { pluginClass: 'ShinyPlugin' } },
        files: { 'ios/shiny_ios.podspec': 'Pod::Spec.new' } },
      shiny_platform_interface: { version: '1.0.0' },
      modern: { version: '2.0.0', plugin: { ios: { pluginClass: 'ModernPlugin' } },
        files: { 'ios/modern.podspec': 'x', 'ios/modern/Package.swift': '// swift-tools-version:5.9' } },
    },
  });
  try {
    const r = await analyze({
      pubspecText: PUBSPEC(['shiny: ^1.0.0', 'modern: ^2.0.0']),
      lockText: lockFor({ shiny: '1.0.0', shiny_ios: '1.0.0', shiny_platform_interface: '1.0.0', modern: '2.0.0' }, ['shiny', 'modern']),
      projectDir: w.projectDir, cacheDir: w.cacheDir,
      pubdev: fakePubDev({
        packages: { shiny_ios: { latest: '1.1.0' } },
        scores: { shiny_ios: { tags: ['is:swiftpm-plugin'] } },
      }),
      checks: { outdated: false },
    });
    assert.deepEqual(ids(r), ['swiftpm:shiny']);
    const f = r.findings[0];
    assert.deepEqual(f.data.packages, ['shiny_ios']);
    assert.deepEqual(f.data.upgrades, { shiny_ios: '1.1.0' });
    assert.match(f.message, /shiny_ios 1\.1\.0/);
    assert.equal(r.summary.cocoapodsOnly.length, 1);
  } finally { w.cleanup(); }
});

test('swiftpm: no "upgrade" advice when the lock already has the latest release', async () => {
  const w = makeWorld({
    platforms: ['ios'],
    packages: { stuck: { version: '1.1.0', plugin: { ios: { pluginClass: 'S' } }, files: { 'ios/stuck.podspec': 'x' } } },
  });
  try {
    const r = await analyze({
      pubspecText: PUBSPEC(['stuck: ^1.1.0']), lockText: lockFor({ stuck: '1.1.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir,
      // A stale or wrong tag must not produce "upgrade to the version you have".
      pubdev: fakePubDev({ packages: { stuck: { latest: '1.1.0' } }, scores: { stuck: { tags: ['is:swiftpm-plugin'] } } }),
    });
    assert.deepEqual(ids(r), ['swiftpm:stuck']);
    assert.deepEqual(r.findings[0].data.upgrades, {});
    assert.doesNotMatch(r.findings[0].message, /Newer releases/);
  } finally { w.cleanup(); }
});

test('swiftpm: silent for web-only stubs, Dart-only plugins, and apps without iOS/macOS', async () => {
  const packages = {
    // FlutterFire's web packages ship an iOS podspec but declare only web.
    thing_web: { version: '1.0.0', plugin: { web: { pluginClass: 'ThingWeb', fileName: 'thing_web.dart' } },
      files: { 'ios/thing_web.podspec': 'stub' } },
    dart_only: { version: '1.0.0', plugin: { ios: { dartPluginClass: 'DartOnly' } },
      files: { 'ios/dart_only.podspec': 'x' } },
  };
  const lock = lockFor({ thing_web: '1.0.0', dart_only: '1.0.0' });
  const spec = PUBSPEC(['thing_web: ^1.0.0', 'dart_only: ^1.0.0']);

  const withIos = makeWorld({ platforms: ['ios'], packages });
  const webOnlyApp = makeWorld({ platforms: ['web'], packages: { ...packages,
    real: { version: '1.0.0', plugin: { ios: { pluginClass: 'Real' } }, files: { 'ios/real.podspec': 'x' } } } });
  try {
    const a = await analyze({ pubspecText: spec, lockText: lock, projectDir: withIos.projectDir, cacheDir: withIos.cacheDir, pubdev: null });
    assert.deepEqual(ids(a), []);
    const b = await analyze({
      pubspecText: PUBSPEC(['real: ^1.0.0']), lockText: lockFor({ real: '1.0.0' }),
      projectDir: webOnlyApp.projectDir, cacheDir: webOnlyApp.cacheDir, pubdev: null,
    });
    assert.deepEqual(ids(b), [], 'no ios/ or macos/ folder, nothing to say');
  } finally { withIos.cleanup(); webOnlyApp.cleanup(); }
});

test('built-in Kotlin: info normally, an error once the app sets android.builtInKotlin=true', async () => {
  const packages = {
    legacy: { version: '1.0.0', plugin: { android: { package: 'x', pluginClass: 'Legacy' } },
      files: { 'android/build.gradle': KGP_GRADLE } },
    migrated: { version: '1.0.0', plugin: { android: { package: 'y', pluginClass: 'Migrated' } },
      files: { 'android/build.gradle': PLAIN_GRADLE } },
  };
  const input = (w) => ({
    pubspecText: PUBSPEC(['legacy: ^1.0.0', 'migrated: ^1.0.0']),
    lockText: lockFor({ legacy: '1.0.0', migrated: '1.0.0' }),
    projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev: null,
  });
  const off = makeWorld({ platforms: ['android'], packages });
  const on = makeWorld({ platforms: ['android'], packages, gradleProperties: 'android.builtInKotlin=true\nandroid.newDsl=true\n' });
  try {
    const a = await analyze(input(off));
    assert.deepEqual(ids(a), ['built-in-kotlin:legacy']);
    assert.equal(a.findings[0].severity, 'info');
    const b = await analyze(input(on));
    assert.equal(b.findings[0].severity, 'error');
    assert.match(b.findings[0].message, /builtInKotlin=true/);
  } finally { off.cleanup(); on.cleanup(); }
});

test('dev_dependencies never get native findings: they are not built into the app', async () => {
  const w = makeWorld({ platforms: ['ios', 'android'], packages: {
    tool: { version: '1.0.0', plugin: { ios: { pluginClass: 'T' }, android: { package: 't', pluginClass: 'T' } },
      files: { 'ios/tool.podspec': 'x', 'android/build.gradle': KGP_GRADLE } },
  } });
  try {
    const r = await analyze({
      pubspecText: 'name: app\ndev_dependencies:\n  tool: ^1.0.0\n',
      lockText: lockFor({ tool: '1.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev: null,
    });
    assert.deepEqual(ids(r), []);
  } finally { w.cleanup(); }
});

test('no pubspec.lock: one info finding, no guessing', async () => {
  const w = makeWorld({ platforms: ['ios'] });
  try {
    const r = await analyze({
      pubspecText: PUBSPEC(['a: ^1.0.0']), lockText: null,
      projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev: fakePubDev({ packages: { a: { latest: '1.0.0' } } }),
    });
    assert.deepEqual(ids(r), ['not-resolved:null']);
  } finally { w.cleanup(); }
});

test('a pub.dev outage costs the pub.dev checks, not the on-disk ones', async () => {
  const w = makeWorld({ platforms: ['android'], packages: {
    legacy: { version: '1.0.0', plugin: { android: { package: 'x', pluginClass: 'L' } },
      files: { 'android/build.gradle.kts': 'plugins {\n  id("com.android.library")\n  kotlin("android")\n}\n' } },
  } });
  try {
    const failing = { packageInfo: async () => { throw new Error('down'); }, scoreInfo: async () => { throw new Error('down'); } };
    const r = await analyze({
      pubspecText: PUBSPEC(['legacy: ^1.0.0']), lockText: lockFor({ legacy: '1.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev: failing,
    });
    assert.deepEqual(ids(r), ['built-in-kotlin:legacy']);
  } finally { w.cleanup(); }
});

test('appliesKgp: every way a Gradle file applies it, and comments that only mention it', () => {
  assert.equal(appliesKgp("apply plugin: 'kotlin-android'"), true);
  assert.equal(appliesKgp('apply plugin: "org.jetbrains.kotlin.android"'), true);
  assert.equal(appliesKgp('plugins {\n  id("org.jetbrains.kotlin.android")\n}'), true);
  assert.equal(appliesKgp('plugins { kotlin("android") }'), true);
  assert.equal(appliesKgp("plugins {\n  // id 'kotlin-android' — removed for built-in Kotlin\n}"), false);
  assert.equal(appliesKgp("/* apply plugin: 'kotlin-android' */\nplugins { id 'com.android.library' }"), false);
  assert.equal(appliesKgp("kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }"), false);
  assert.equal(appliesKgp('url "https://example.com/kotlin-android"'), false, 'not an id or apply');
  // Applied only below AGP 9 (health_bridge, sentry_flutter): migrated.
  assert.equal(appliesKgp("def isAgp9OrAbove = com.android.Version.ANDROID_GRADLE_PLUGIN_VERSION.tokenize('.')[0].toInteger() >= 9\n"
    + "apply plugin: 'com.android.library'\nif (!isAgp9OrAbove) {\n    apply plugin: 'kotlin-android'\n}"), false);
  assert.equal(appliesKgp("if (!builtInKotlin) {\n    apply plugin: 'kotlin-android'\n}"), false);
  assert.equal(appliesKgp("if (project.hasProperty('flavor')) {\n    apply plugin: 'kotlin-android'\n}"), true, 'an if about something else');
  assert.equal(appliesKgp("if (!isAgp9OrAbove) {\n    apply plugin: 'kotlin-android'\n}\napply plugin: 'org.jetbrains.kotlin.android'"), true, 'guarded once, applied again');
});

test('inspectPackage: a darwin/ shared source plugin with a Swift package', () => {
  const w = makeWorld({ packages: {
    shared: { version: '1.0.0', plugin: { ios: { pluginClass: 'S', sharedDarwinSource: 'true' }, macos: { pluginClass: 'S', sharedDarwinSource: 'true' } },
      files: { 'darwin/shared.podspec': 'x', 'darwin/shared/Package.swift': '// swift' } },
  } });
  try {
    const f = inspectPackage(`${w.cacheDir}/hosted/pub.dev/shared-1.0.0`);
    assert.deepEqual(f.darwin, { platforms: ['ios', 'macos'], podspec: true, swiftPackage: true, cocoapodsOnly: [] });
  } finally { w.cleanup(); }
});

test('swiftpm is per platform: only the platforms the app builds count', async () => {
  const packages = {
    // flutter_image_compress_macos: native on macOS only.
    mac_only: { version: '1.0.0', plugin: { macos: { pluginClass: 'M' } }, files: { 'macos/mac_only.podspec': 'x' } },
    // A Swift package for iOS, but macOS still on its podspec.
    half: { version: '1.0.0', plugin: { ios: { pluginClass: 'H' }, macos: { pluginClass: 'H' } },
      files: { 'ios/half.podspec': 'x', 'ios/half/Package.swift': '// swift', 'macos/half.podspec': 'x' } },
    // Shared darwin/ source with no Swift package: both platforms need CocoaPods.
    shared_old: { version: '1.0.0', plugin: { ios: { pluginClass: 'S', sharedDarwinSource: 'true' }, macos: { pluginClass: 'S', sharedDarwinSource: 'true' } },
      files: { 'darwin/shared_old.podspec': 'x' } },
  };
  const input = (w) => ({
    pubspecText: PUBSPEC(['mac_only: ^1.0.0', 'half: ^1.0.0', 'shared_old: ^1.0.0']),
    lockText: lockFor({ mac_only: '1.0.0', half: '1.0.0', shared_old: '1.0.0' }),
    projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev: null,
  });
  const iosApp = makeWorld({ platforms: ['ios'], packages });
  const macApp = makeWorld({ platforms: ['macos'], packages });
  try {
    assert.deepEqual(ids(await analyze(input(iosApp))), ['swiftpm:shared_old']);
    assert.deepEqual(ids(await analyze(input(macApp))).sort(), ['swiftpm:half', 'swiftpm:mac_only', 'swiftpm:shared_old']);
    const half = inspectPackage(`${iosApp.cacheDir}/hosted/pub.dev/half-1.0.0`);
    assert.deepEqual(half.darwin.cocoapodsOnly, ['macos']);
  } finally { iosApp.cleanup(); macApp.cleanup(); }
});

test('hostedDirNames: pub.dev and its old name, other servers by host', () => {
  assert.deepEqual(hostedDirNames('https://pub.dev'), ['pub.dev', 'pub.dartlang.org']);
  assert.deepEqual(hostedDirNames(null), ['pub.dev', 'pub.dartlang.org']);
  assert.deepEqual(hostedDirNames('https://dart.example.com'), ['dart.example.com']);
});

test('dependency_overrides: reported once, never as outdated, never for native code', async () => {
  const w = makeWorld({ platforms: ['ios'], packages: {
    cam: { version: '1.0.0', deps: ['cam_ios'] },
    cam_ios: { version: '1.0.0', plugin: { ios: { pluginClass: 'C' } }, files: { 'ios/cam_ios.podspec': 'x' } },
  } });
  try {
    const r = await analyze({
      pubspecText: 'name: app\ndependencies:\n  gone: ^1.0.0\n  cam: ^1.0.0\n'
        + 'dependency_overrides:\n  gone: 1.0.0\n  pinned_old: 1.0.0\n  sunset: 2.0.0\n  cam_ios: 1.0.0\n',
      lockText: lockFor({ gone: '1.0.0', cam: '1.0.0', cam_ios: '1.0.0', pinned_old: '1.0.0', sunset: '2.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir,
      pubdev: fakePubDev({ packages: {
        gone: { latest: '1.0.0', isDiscontinued: true },
        cam: { latest: '1.0.0' },
        cam_ios: { latest: '1.0.0' },
        pinned_old: { latest: '3.0.0' },
        sunset: { latest: '2.0.0', isDiscontinued: true },
      } }),
    });
    const where = r.findings.map((f) => `${f.id}:${f.dep}@${f.line}`).sort();
    assert.deepEqual(where, [
      'discontinued:gone@2',   // the dependencies line, not the override too
      'discontinued:sunset@7', // override-only: still worth knowing
      'swiftpm:cam@3',         // on the parent that pulls cam_ios in, not the override
    ]);
  } finally { w.cleanup(); }
});

test('a plugin the app lists itself is reported on its own line, not on everything that reaches it', async () => {
  const w = makeWorld({ platforms: ['android'], packages: {
    share: { version: '1.0.0', plugin: { android: { package: 's', pluginClass: 'S' } }, files: { 'android/build.gradle': KGP_GRADLE } },
    kit: { version: '1.0.0', deps: ['share', 'kit_android'] },
    kit_android: { version: '1.0.0', plugin: { android: { package: 'k', pluginClass: 'K' } }, files: { 'android/build.gradle': KGP_GRADLE } },
  } });
  try {
    const r = await analyze({
      pubspecText: PUBSPEC(['share: ^1.0.0', 'kit: ^1.0.0']),
      lockText: lockFor({ share: '1.0.0', kit: '1.0.0', kit_android: '1.0.0' }),
      projectDir: w.projectDir, cacheDir: w.cacheDir, pubdev: null,
    });
    const by = Object.fromEntries(r.findings.map((f) => [f.dep, f.data.packages]));
    assert.deepEqual(by, { share: ['share'], kit: ['kit_android'] });
  } finally { w.cleanup(); }
});
