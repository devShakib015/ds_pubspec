'use strict';

// Reads the dependency sections of a pubspec.yaml well enough to put a
// diagnostic on the right line. Not a YAML parser: pubspecs use a small,
// regular subset (block maps, scalars, the odd flow map), and a real parser
// would cost a dependency for no gain.

const SECTIONS = ['dependencies', 'dev_dependencies', 'dependency_overrides'];

/** Drops a trailing `# comment`, leaving `#` inside quotes alone. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

const indentOf = (line) => line.length - line.trimStart().length;

/** `{sdk: flutter}` or `{path: ../x}` on one line. */
function parseFlowMap(value) {
  const inner = value.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out = {};
  for (const part of inner.split(',')) {
    const m = part.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/**
 * @typedef {{
 *   name: string,
 *   section: string,
 *   line: number,          // 0-based
 *   start: number,         // column where the name starts
 *   end: number,           // column after the name
 *   source: 'hosted'|'sdk'|'path'|'git',
 *   constraint: string|null,
 *   hostedUrl: string|null,
 *   path: string|null,
 * }} Dependency
 */

/**
 * @param {string} text the pubspec.yaml contents
 * @returns {{ name: string|null, deps: Dependency[] }}
 */
function parsePubspec(text) {
  const lines = text.split(/\r?\n/);
  /** @type {Dependency[]} */
  const deps = [];
  let packageName = null;
  let section = null;
  let entryIndent = null;
  /** @type {Dependency|null} */
  let current = null;
  let currentIndent = 0;
  let inHosted = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    if (!raw.trim()) continue;
    const indent = indentOf(raw);
    const body = raw.trim();

    if (indent === 0) {
      const top = body.match(/^([\w-]+)\s*:\s*(.*)$/);
      current = null;
      inHosted = false;
      entryIndent = null;
      section = top && SECTIONS.includes(top[1]) ? top[1] : null;
      if (top && top[1] === 'name') packageName = unquote(top[2]) || null;
      continue;
    }
    if (!section) continue;

    if (entryIndent === null) entryIndent = indent;

    if (indent === entryIndent) {
      const m = raw.match(/^(\s*)(["']?)([A-Za-z_][\w]*)\2\s*:\s*(.*)$/);
      if (!m) { current = null; continue; }
      const start = m[1].length + m[2].length;
      const value = m[4].trim();
      current = {
        name: m[3],
        section,
        line: i,
        start,
        end: start + m[3].length,
        source: 'hosted',
        constraint: null,
        hostedUrl: null,
        path: null,
      };
      currentIndent = indent;
      inHosted = false;
      if (value.startsWith('{')) {
        const map = parseFlowMap(value);
        if (map.sdk) current.source = 'sdk';
        else if (map.path) { current.source = 'path'; current.path = map.path; }
        else if (map.git) current.source = 'git';
        if (map.version) current.constraint = map.version;
        if (map.hosted) current.hostedUrl = map.hosted;
      } else if (value) {
        current.constraint = unquote(value);
      }
      deps.push(current);
      continue;
    }

    if (!current || indent <= currentIndent) continue;
    const kv = body.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = unquote(rawValue);
    if (key === 'sdk') current.source = 'sdk';
    else if (key === 'path') { current.source = 'path'; current.path = value; }
    else if (key === 'git') current.source = 'git';
    else if (key === 'version') current.constraint = value;
    else if (key === 'hosted') {
      inHosted = true;
      if (value) current.hostedUrl = value;
    } else if (key === 'url' && inHosted) current.hostedUrl = value;
  }

  return { name: packageName, deps };
}

module.exports = { parsePubspec, SECTIONS };
