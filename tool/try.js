'use strict';

// Runs the analyzer on a real project from the command line, with the real
// pub cache and pub.dev:   node tool/try.js ~/Projects/Personal/pulse

const fs = require('fs');
const path = require('path');
const { analyze } = require('../lib/analyze');
const { pubCacheDir } = require('../lib/pubcache');
const { createPubDevClient } = require('../lib/pubdev');
const { resolveLock } = require('../lib/workspace');

async function main() {
  const projectDir = path.resolve(process.argv[2] || '.');
  const read = (f) => { try { return fs.readFileSync(path.join(projectDir, f), 'utf8'); } catch (_) { return null; } };
  const pubspecText = read('pubspec.yaml');
  if (!pubspecText) throw new Error(`no pubspec.yaml in ${projectDir}`);
  const started = Date.now();
  const { lockPath, members } = resolveLock(projectDir, pubspecText);
  let lockText = null;
  try { lockText = fs.readFileSync(lockPath, 'utf8'); } catch (_) { /* not resolved */ }
  const { findings, summary } = await analyze({
    pubspecText,
    lockText,
    projectDir,
    lockDir: path.dirname(lockPath),
    members,
    cacheDir: pubCacheDir(),
    pubdev: createPubDevClient(),
  });
  for (const f of findings) {
    console.log(`${String(f.line + 1).padStart(4)}  ${f.severity.padEnd(7)} ${f.id.padEnd(16)} ${f.message}`);
  }
  console.log(`\n${findings.length} findings in ${Date.now() - started} ms`);
  console.log(JSON.stringify(summary));
}

main().catch((e) => { console.error(e); process.exit(1); });
