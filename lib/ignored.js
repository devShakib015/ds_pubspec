'use strict';

// Folders whose pubspecs aren't the project's own: build output (an iOS build
// with Swift Package Manager copies every plugin into build/ios/SourcePackages,
// example apps included), plugin symlinks and the pub cache. They have no lock
// of their own and aren't anyone's to change, so a finding there is only noise.

const IGNORED_DIRS = ['.dart_tool', 'build', '.symlinks', 'Pods', 'node_modules', '.pub-cache', '.fvm', 'ephemeral'];

/** The same list as a findFiles exclude, so the two can't drift apart. */
const IGNORE_GLOB = `**/{${IGNORED_DIRS.join(',')}}/**`;

/**
 * Whether a file sits inside one of those folders. Pass its path from the
 * workspace folder, not from the disk root: a project kept under ~/build is
 * still a project.
 * @param {string} relativePath
 */
function inIgnoredDir(relativePath) {
  return relativePath.split(/[\\/]/).slice(0, -1).some((part) => IGNORED_DIRS.includes(part));
}

module.exports = { IGNORE_GLOB, inIgnoredDir };
