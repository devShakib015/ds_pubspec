# Changelog

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
