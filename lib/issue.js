'use strict';

// "Ask the author" links: a pre-filled GitHub issue the developer reads,
// edits and submits themselves. Nothing is ever filed automatically.

const GUIDES = {
  swiftpm: 'https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors',
  kotlin: 'https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors',
};

/** owner/repo from a GitHub repository or issue-tracker URL, else null. */
function githubRepo(url) {
  if (!url) return null;
  const m = String(url).match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function issueText(kind, pkg, version) {
  const using = `I'm using \`${pkg}\`${version ? ` ${version}` : ''} in a Flutter app.`;
  if (kind === 'swiftpm') {
    return {
      title: 'Add Swift Package Manager support',
      body: [
        using,
        '',
        'This version ships a podspec but no Package.swift, so Flutter falls back to CocoaPods for it. '
          + 'Flutter now uses Swift Package Manager by default, and the CocoaPods registry becomes read-only '
          + 'on 2 December 2026 (https://blog.cocoapods.org/CocoaPods-Specs-Repo/).',
        '',
        `Flutter's guide for plugin authors: ${GUIDES.swiftpm}`,
      ].join('\n'),
    };
  }
  return {
    title: 'Migrate plugin to built-in Kotlin',
    body: [
      using,
      '',
      "The plugin's Android build applies the Kotlin Gradle Plugin. AGP 9 removes support for applying it, "
        + 'so an app that sets `android.builtInKotlin=true` fails to build with this plugin '
        + '(https://github.com/flutter/flutter/issues/181383).',
      '',
      `Flutter's guide for plugin authors: ${GUIDES.kotlin}`,
    ].join('\n'),
  };
}

/**
 * @param {'swiftpm'|'kotlin'} kind
 * @param {{ name: string, version?: string|null, repository?: string|null, issueTracker?: string|null }} pkg
 * @returns {string|null} a github.com/…/issues/new URL, or null when the repo isn't on GitHub
 */
function issueUrl(kind, pkg) {
  const repo = githubRepo(pkg.issueTracker) || githubRepo(pkg.repository);
  if (!repo) return null;
  const { title, body } = issueText(kind, pkg.name, pkg.version);
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

module.exports = { issueUrl, githubRepo, issueText, GUIDES };
