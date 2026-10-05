'use strict';

// The project the Marketplace preview shows. Every squiggle in preview.png
// comes from running lib/analyze.js over this, so the picture can't claim a
// check the code doesn't make. photo_squeeze, quick_scan_kit and
// vault_notes_store are made up (not on pub.dev); connectivity really is
// discontinued in favour of connectivity_plus.

const { analyze } = require('../lib/analyze');
const { makeWorld, lockFor, fakePubDev } = require('../test/helpers');

const PUBSPEC = `name: field_notes
description: Offline notes with photos and scanning.

environment:
  sdk: ^3.8.0

dependencies:
  flutter:
    sdk: flutter
  connectivity: ^3.0.6
  http: ^1.2.0
  photo_squeeze: ^1.4.0
  quick_scan_kit: ^5.2.0
  vault_notes_store: ^2.1.0

dev_dependencies:
  lints: ^6.0.0
`;

async function main() {
  const httpLatest = process.argv[2] || '1.5.0';
  const w = makeWorld({
    platforms: ['ios', 'android'],
    packages: {
      photo_squeeze: { version: '1.4.0', deps: ['photo_squeeze_ios'], plugin: { ios: { default_package: 'photo_squeeze_ios' } } },
      photo_squeeze_ios: { version: '1.0.2', plugin: { ios: { pluginClass: 'PhotoSqueezePlugin' } },
        files: { 'ios/photo_squeeze_ios.podspec': 'Pod::Spec.new' } },
      quick_scan_kit: { version: '5.2.0', plugin: { android: { package: 'dev.example.scan', pluginClass: 'QuickScanPlugin' } },
        files: { 'android/build.gradle': "plugins {\n  id 'com.android.library'\n  id 'kotlin-android'\n}\n" } },
      vault_notes_store: { version: '2.1.0' },
    },
  });
  try {
    const { findings } = await analyze({
      pubspecText: PUBSPEC,
      lockText: lockFor({
        connectivity: '3.0.6', http: '1.2.0', photo_squeeze: '1.4.0', photo_squeeze_ios: '1.0.2',
        quick_scan_kit: '5.2.0', vault_notes_store: '2.1.0', lints: '6.0.0',
      }),
      projectDir: w.projectDir, cacheDir: w.cacheDir,
      pubdev: fakePubDev({
        packages: {
          connectivity: { latest: '3.0.6', isDiscontinued: true, replacedBy: 'connectivity_plus' },
          http: { latest: httpLatest },
          photo_squeeze: { latest: '1.4.0' },
          photo_squeeze_ios: { latest: '1.1.0' },
          quick_scan_kit: { latest: '5.2.0' },
          vault_notes_store: { latest: '2.1.1', retracted: ['2.1.0'] },
          lints: { latest: '6.0.0' },
        },
        scores: { photo_squeeze_ios: { tags: ['is:swiftpm-plugin'] } },
      }),
    });
    process.stdout.write(JSON.stringify({ lines: PUBSPEC.replace(/\n$/, '').split('\n'), findings }));
  } finally {
    w.cleanup();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
