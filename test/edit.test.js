'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replaceDependencyLine } = require('../lib/edit');

const swap = (line, name) => {
  const start = line.indexOf(name);
  return replaceDependencyLine(line, start, start + name.length, 'connectivity_plus', '7.1.1');
};

test('a plain entry: name and constraint change, indentation stays', () => {
  assert.equal(swap('  connectivity: ^3.0.0', 'connectivity'), '  connectivity_plus: ^7.1.1');
});

test('keeps a trailing comment and quoted values', () => {
  assert.equal(swap('  connectivity: "^3.0.0" # network state', 'connectivity'), '  connectivity_plus: "^7.1.1" # network state');
});

test('a quoted name keeps its closing quote', () => {
  assert.equal(swap('  "connectivity": ^3.0.0', 'connectivity'), '  "connectivity_plus": ^7.1.1');
});

test('block entries and flow maps are left to a rename', () => {
  assert.equal(swap('  connectivity:', 'connectivity'), null);
  assert.equal(swap('  connectivity: {path: ../c}', 'connectivity'), null);
});
