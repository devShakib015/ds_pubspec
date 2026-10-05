'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { issueUrl, githubRepo, issueText } = require('../lib/issue');

test('githubRepo: repository and issue-tracker URL shapes', () => {
  assert.equal(githubRepo('https://github.com/aboutyou/dart_packages/tree/master/packages/sign_in_with_apple'), 'aboutyou/dart_packages');
  assert.equal(githubRepo('https://github.com/fluttercommunity/plus_plugins.git'), 'fluttercommunity/plus_plugins');
  assert.equal(githubRepo('https://github.com/juliansteenbakker/mobile_scanner/issues'), 'juliansteenbakker/mobile_scanner');
  assert.equal(githubRepo('https://gitlab.com/a/b'), null);
  assert.equal(githubRepo(null), null);
});

test('issueUrl: prefers the issue tracker, encodes a ready-to-edit issue', () => {
  const url = issueUrl('kotlin', {
    name: 'haptic_feedback', version: '0.6.4+3',
    repository: 'https://github.com/someone/haptic_feedback',
    issueTracker: 'https://github.com/someone/haptic_feedback_issues/issues',
  });
  assert.ok(url.startsWith('https://github.com/someone/haptic_feedback_issues/issues/new?title=Migrate%20plugin%20to%20built-in%20Kotlin&body='));
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.match(body, /^I'm using `haptic_feedback` 0\.6\.4\+3 in a Flutter app\./);
  assert.match(body, /for-plugin-authors/);
});

test('issueUrl: null when the package does not live on GitHub', () => {
  assert.equal(issueUrl('swiftpm', { name: 'x', repository: 'https://example.com/x' }), null);
});

test('issueText: SwiftPM wording names the CocoaPods date and the guide', () => {
  const { title, body } = issueText('swiftpm', 'health');
  assert.equal(title, 'Add Swift Package Manager support');
  assert.match(body, /^I'm using `health` in a Flutter app\./, 'no stray space without a version');
  assert.match(body, /2 December 2026/);
  assert.match(body, /swift-package-manager\/for-plugin-authors/);
});
