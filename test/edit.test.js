'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replaceDependencyLine, raiseConstraintLine } = require('../lib/edit');

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

test('raising a floor keeps the caret, the quotes and the comment', () => {
  assert.equal(raiseConstraintLine('  cloud_firestore: ^6.6.0', 'cloud_firestore', '6.10.2'), '  cloud_firestore: ^6.10.2');
  assert.equal(raiseConstraintLine("  cloud_firestore: '^6.6.0' # db", 'cloud_firestore', '6.10.2'), "  cloud_firestore: '^6.10.2' # db");
  assert.equal(raiseConstraintLine('  "firebase_core": ^4.11.0', 'firebase_core', '4.15.2'), '  "firebase_core": ^4.15.2');
});

test('an exact pin stays a pin, at the new version', () => {
  assert.equal(raiseConstraintLine('  firebase_core: 4.11.0', 'firebase_core', '4.15.2'), '  firebase_core: 4.15.2');
});

test('ranges, any, block entries and other packages are refused, not guessed at', () => {
  for (const line of ['  cloud_firestore: ">=6.0.0 <7.0.0"', '  cloud_firestore: any', '  cloud_firestore:',
    '  cloud_firestore: {version: ^6.6.0}', '  http: ^1.2.0']) {
    assert.equal(raiseConstraintLine(line, 'cloud_firestore', '6.10.2'), null, line);
  }
});
