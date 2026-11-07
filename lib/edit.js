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

/**
 * Raises the floor of `  name: ^6.6.0 # note` to `  name: ^6.10.2 # note`,
 * keeping indentation, quotes and the comment. An exact pin stays a pin at the
 * new version. Returns null for anything else (a block entry, a flow map, a
 * range, `any`) or a line that isn't [name]'s, so the caller can say so
 * instead of guessing.
 */
function raiseConstraintLine(line, name, floor) {
  const m = line.match(/^(\s*)(["']?)([A-Za-z_]\w*)\2(\s*):(\s*)(.*?)(\s+#.*)?$/);
  if (!m || m[3] !== name) return null;
  const [, indent, quote, , before, after, value, comment = ''] = m;
  const q = /^(["']).*\1$/.test(value) ? value[0] : '';
  const inner = q ? value.slice(1, -1) : value;
  const caret = /^\^\d+\.\d+\.\d+$/.test(inner);
  if (!caret && !/^\d+\.\d+\.\d+$/.test(inner)) return null;
  return `${indent}${quote}${name}${quote}${before}:${after || ' '}${q}${caret ? '^' : ''}${floor}${q}${comment}`;
}

module.exports = { replaceDependencyLine, raiseConstraintLine };
