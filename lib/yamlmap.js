'use strict';

// Just enough YAML to read a *dependency's* pubspec.yaml: nested block maps
// and scalars. Sequences and block scalars (`description: >-`) are skipped,
// which is fine — nothing this extension needs lives in either.

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

/**
 * @param {string} text
 * @returns {Record<string, any>} nested plain objects; scalars are strings
 */
function parseYamlMaps(text) {
  const root = {};
  /** @type {{indent: number, obj: Record<string, any>}[]} */
  const stack = [{ indent: -1, obj: root }];
  let skipDeeperThan = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (skipDeeperThan !== null) {
      if (indent > skipDeeperThan) continue;
      skipDeeperThan = null;
    }
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    if (body.startsWith('-')) {
      // A sequence item and anything nested under it: not needed here.
      skipDeeperThan = indent;
      continue;
    }
    const m = body.match(/^(["']?)([^"':]+)\1\s*:(?:\s+(.*))?$/) || body.match(/^(["']?)([^"':]+)\1\s*:$/);
    if (!m) continue;
    const key = m[2].trim();
    const value = (m[3] || '').trim();
    const parent = stack[stack.length - 1].obj;
    if (!value) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else if (/^[|>][-+]?\d*$/.test(value)) {
      parent[key] = '';
      skipDeeperThan = indent;
    } else if (value.startsWith('{') && value.endsWith('}')) {
      const map = {};
      for (const part of value.slice(1, -1).split(',')) {
        const kv = part.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
        if (kv) map[unquote(kv[1])] = unquote(kv[2]);
      }
      parent[key] = map;
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

module.exports = { parseYamlMaps };
