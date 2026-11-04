# Changelog

## 0.1.2

- `emudhra-firestore`: the `cloud_firestore` in your lockfile still trusts the
  compromised eMudhra certificates on iOS, macOS or Windows. 6.10.1 fixed only
  iOS and macOS, so the check goes by the folders the app has. It lands on the
  dependency that pulls the package in when you don't list it yourself, and
  dev_dependencies are left out. No package advisory carries this one.
- Its quick fix runs a plain `flutter pub upgrade`. On a real app,
  `--major-versions cloud_firestore` fails because 7.1.0 needs `firebase_core` 5.1,
  and naming the package left it on 6.6.0, held by what else was locked.

## 0.1.1

- A plugin that applies the Kotlin Gradle Plugin only below AGP 9 is no longer
  reported. health_bridge and sentry_flutter wrap `apply plugin: 'kotlin-android'`
  in `if (!isAgp9OrAbove)` or `if (!builtInKotlin)` so they keep building on older
  AGP; 0.1.0 called that an error in apps with `android.builtInKotlin=true`, which
  build fine with them (wger). Only an `if` about the AGP version or built-in
  Kotlin counts as a guard.

## 0.1.0

First release.

- Discontinued packages, with a quick fix to the successor the author named.
- Retracted locked versions.
- Plugins without a Swift package in the locked version (CocoaPods only), found
  through the whole dependency tree and reported on the line you can change,
  with the newer release that has one when there is.
- Plugins that still apply the Kotlin Gradle Plugin; an error once
  `android.builtInKotlin=true`.
- Newer releases as faint hints.
- Pub workspaces: members are checked against the root's lock, sibling members
  are never looked up on pub.dev, and plugins reached through them are traced.
- Hovers with pub points, likes and downloads; a status bar summary; and a
  command to run the full flutter_health_check audit.
