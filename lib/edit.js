'use strict';

// Text edits the quick fixes make, kept out of extension.js so they can be
// tested without an editor.

/**
 * Rewrites `  old_pkg: ^1.0.0 # note` as `  new_pkg: ^2.3.0 # note`, keeping
 * indentation, quotes and the trailing comment. Returns null for a block entry
 * (`old_pkg:` followed by `path:`/`git:`/`hosted:` lines) or a flow map, where
 * only the name can safely change.
 *
 * @param {string} line the whole line
 * @param {number} start column where the name starts
 * @param {number} end column after the name
 */
function replaceDependencyLine(line, start, end, replacement, latest) {
  const m = line.slice(end).match(/^(["']?)(\s*):(\s*)(.*?)(\s+#.*)?$/);
  if (!m) return null;
  const [, closeQuote, before, after, value, comment = ''] = m;
  if (!value || value.startsWith('{')) return null;
  const q = (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0] ? value[0] : '';
  return `${line.slice(0, start)}${replacement}${closeQuote}${before}:${after || ' '}${q}^${latest}${q}${comment}`;
}

module.exports = { replaceDependencyLine };
