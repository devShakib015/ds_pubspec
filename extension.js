'use strict';

// The VS Code side: run lib/analyze.js over each pubspec.yaml and show what
// it finds. Everything that decides *what* to say lives in lib/, which knows
// nothing about the editor and is tested on its own.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { analyze } = require('./lib/analyze');
const { pubCacheDir } = require('./lib/pubcache');
const { createPubDevClient } = require('./lib/pubdev');
const { issueUrl } = require('./lib/issue');
const { resolveLock } = require('./lib/workspace');
const { replaceDependencyLine } = require('./lib/edit');

const SOURCE = 'Pubspec Health';
const DOCS = 'https://github.com/devShakib015/ds_pubspec#';
const OFFER = 'https://devshakib.jumyn.com/health-check?utm_source=ds-pubspec';
const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};
const IGNORE = '**/{.dart_tool,build,.symlinks,Pods,node_modules,.pub-cache,.fvm,ephemeral}/**';

function settings() {
  const c = vscode.workspace.getConfiguration('pubspecHealth');
  const disabled = new Set(c.get('disabledChecks', []));
  return {
    enabled: c.get('enable', true),
    checks: {
      discontinued: !disabled.has('discontinued'),
      retracted: !disabled.has('retracted'),
      outdated: !disabled.has('outdated'),
      swiftpm: !disabled.has('swiftpm'),
      'built-in-kotlin': !disabled.has('built-in-kotlin'),
    },
    cacheHours: Math.max(1, c.get('cacheHours', 12)),
  };
}

const isPubspec = (uri) => uri && uri.scheme === 'file' && path.basename(uri.fsPath) === 'pubspec.yaml';
const usesFlutter = (deps) => deps.some((d) => d.name === 'flutter' && d.source === 'sdk');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel(SOURCE);
  const collection = vscode.languages.createDiagnosticCollection('pubspec-health');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'pubspecHealth.showSummary';
  context.subscriptions.push(output, collection, status);

  // pub.dev answers live in globalState, so a window reload doesn't cost a
  // fresh round of requests (and a 429).
  const PREFIX = 'pubdev:';
  const store = {
    get: (k) => context.globalState.get(PREFIX + k),
    set: (k, v) => context.globalState.update(PREFIX + k, v),
  };
  let pubdev = createPubDevClient({ store, ttlMs: settings().cacheHours * 3600 * 1000 });

  /** @type {Map<string, Awaited<ReturnType<typeof analyze>> & { projectDir: string }>} */
  const results = new Map();
  // inspectPackage results for pub cache folders, which never change.
  const factsCache = new Map();
  const timers = new Map();

  async function check(uri) {
    const key = uri.toString();
    const s = settings();
    if (!s.enabled) { collection.delete(uri); results.delete(key); updateStatus(); return; }
    const projectDir = path.dirname(uri.fsPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    let pubspecText;
    try {
      pubspecText = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
    } catch (_) {
      collection.delete(uri); results.delete(key); updateStatus(); return;
    }
    // A pub workspace member shares the root's lock.
    const { lockPath, members } = resolveLock(projectDir, pubspecText);
    let lockText = null;
    try { lockText = fs.readFileSync(lockPath, 'utf8'); } catch (_) { /* not resolved */ }

    try {
      const result = await analyze({
        pubspecText, lockText, projectDir, lockDir: path.dirname(lockPath), members, factsCache,
        cacheDir: pubCacheDir(), pubdev, checks: s.checks,
      });
      results.set(key, { ...result, projectDir, lockPath });
      collection.set(uri, result.findings.map((f) => {
        const d = new vscode.Diagnostic(
          new vscode.Range(f.line, f.start, f.line, f.end), f.message, SEVERITY[f.severity]);
        d.source = SOURCE;
        d.code = { value: f.id, target: vscode.Uri.parse(DOCS + f.id) };
        return d;
      }));
    } catch (e) {
      output.appendLine(`[${new Date().toISOString()}] ${uri.fsPath}: ${e && e.stack || e}`);
    }
    updateStatus();
  }

  const soon = (uri) => {
    if (!isPubspec(uri)) return;
    const key = uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); check(uri); }, 600));
  };

  async function checkWorkspace() {
    const files = await vscode.workspace.findFiles('**/pubspec.yaml', IGNORE, 200);
    await Promise.all(files.map(check));
  }

  function updateStatus() {
    // Plugins are counted once however many pubspecs they reach: a workspace
    // whose thirty apps share one CocoaPods-only plugin has one to wait on.
    let warn = 0; let errors = 0;
    const pods = new Set();
    const kotlin = new Set();
    for (const r of results.values()) {
      for (const f of r.findings) {
        if (f.severity === 'error') errors++;
        else if (f.severity === 'warning') warn++;
        if (f.id === 'swiftpm') for (const p of f.data.packages) pods.add(p);
        if (f.id === 'built-in-kotlin') for (const p of f.data.packages) kotlin.add(p);
      }
    }
    if (!results.size || (warn + pods.size + kotlin.size + errors) === 0) { status.hide(); return; }
    const parts = [];
    if (errors) parts.push(`$(error) ${errors}`);
    if (warn) parts.push(`$(warning) ${warn}`);
    if (pods.size) parts.push(`${pods.size} CocoaPods-only`);
    if (kotlin.size) parts.push(`${kotlin.size} KGP`);
    status.text = `$(package) ${parts.join(' · ')}`;
    status.tooltip = 'Pubspec Health: discontinued or retracted packages, plugins without Swift Package Manager '
      + 'support (CocoaPods only), and plugins still applying the Kotlin Gradle Plugin. Click for details.';
    status.show();
  }

  // --- Hover: what pub.dev knows about the package under the cursor. ------
  const hover = vscode.languages.registerHoverProvider(
    { scheme: 'file', pattern: '**/pubspec.yaml' },
    {
      async provideHover(doc, pos) {
        const r = results.get(doc.uri.toString());
        if (!r) return null;
        const dep = r.deps.find((d) => d.line === pos.line && pos.character >= d.start && pos.character <= d.end);
        if (!dep || !r.onPubDev.has(dep.name)) return null;
        const [info, score] = await Promise.all([
          pubdev.packageInfo(dep.name).catch(() => null),
          pubdev.scoreInfo(dep.name).catch(() => null),
        ]);
        if (!info) return null;
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = false;
        const locked = r.locked.get(dep.name);
        const facts = [];
        facts.push(locked && locked.version ? `locked **${locked.version}**` : 'not resolved yet');
        if (info.latest) facts.push(`latest **${info.latest}**`);
        if (score) {
          if (score.grantedPoints !== null) facts.push(`${score.grantedPoints}/${score.maxPoints} pub points`);
          if (score.likes !== null) facts.push(`${score.likes.toLocaleString()} likes`);
          if (score.downloads30d !== null) facts.push(`${score.downloads30d.toLocaleString()} downloads (30 days)`);
        }
        md.appendMarkdown(`**${dep.name}** · ${facts.join(' · ')}\n\n`);
        if (info.isDiscontinued) {
          md.appendMarkdown(`$(warning) Discontinued${info.replacedBy ? `; the author recommends **${info.replacedBy}**` : ''}.\n\n`);
        }
        for (const f of r.findings.filter((x) => x.dep === dep.name && (x.id === 'swiftpm' || x.id === 'built-in-kotlin'))) {
          md.appendMarkdown(`$(info) ${f.message}\n\n`);
        }
        const page = `https://pub.dev/packages/${dep.name}`;
        md.appendMarkdown(`[pub.dev](${page}) · [Changelog](${page}/changelog) · [Versions](${page}/versions)`);
        return new vscode.Hover(md, new vscode.Range(dep.line, dep.start, dep.line, dep.end));
      },
    });

  // --- Quick fixes. ---------------------------------------------------------
  const actions = vscode.languages.registerCodeActionsProvider(
    { scheme: 'file', pattern: '**/pubspec.yaml' },
    {
      async provideCodeActions(doc, _range, ctx) {
        const r = results.get(doc.uri.toString());
        if (!r) return [];
        // One line can carry several findings (outdated, swiftpm and
        // built-in-kotlin on the same plugin), and VS Code asks about all of
        // them at once. Worst first, and each action once: two that run the
        // same command or open the same page are the same action.
        const out = new Map();
        const pages = new Map();
        const add = (key, a) => { if (!out.has(key)) out.set(key, a); };
        const tool = usesFlutter(r.deps) ? 'flutter' : 'dart';
        const diags = ctx.diagnostics.filter((d) => d.source === SOURCE).sort((a, b) => a.severity - b.severity);
        for (const diag of diags) {
          const id = diag.code && diag.code.value;
          const f = r.findings.find((x) => x.id === id && x.line === diag.range.start.line);
          if (!f) continue;
          const dep = f.dep;
          const upgrade = (title, line) => add(line, command(title, diag, 'pubspecHealth.runInTerminal', [r.projectDir, line]));
          // pub upgrade can't move an override, and renaming one makes no sense.
          const pinned = r.deps.some((d) => d.line === f.line && d.section === 'dependency_overrides');

          if (id === 'discontinued' && f.data.replacedBy && !pinned) {
            const replacement = f.data.replacedBy;
            const info = await pubdev.packageInfo(replacement).catch(() => null);
            const a = new vscode.CodeAction(`Replace ${dep} with ${replacement}`, vscode.CodeActionKind.QuickFix);
            const edit = new vscode.WorkspaceEdit();
            const line = doc.lineAt(f.line).text;
            const rewritten = info && info.latest
              ? replaceDependencyLine(line, f.start, f.end, replacement, info.latest)
              : null;
            if (rewritten !== null) {
              edit.replace(doc.uri, new vscode.Range(f.line, 0, f.line, line.length), rewritten);
            } else {
              // A block entry (path:, git:, hosted:): rename only, keep the rest.
              edit.replace(doc.uri, new vscode.Range(f.line, f.start, f.line, f.end), replacement);
            }
            a.edit = edit;
            a.diagnostics = [diag];
            a.isPreferred = true;
            add(`replace:${dep}`, a);
          }

          if (id === 'retracted' && !pinned) {
            upgrade(`Upgrade ${dep} (${tool} pub upgrade ${dep})`, `${tool} pub upgrade ${dep}`);
          }

          if (id === 'swiftpm') {
            // Always through the line's own package: pub upgrade --major-versions
            // refuses transitive packages, and a plain upgrade of one can't move
            // what its parent pins (flutter_image_compress_common 1.1.1 arrives
            // with flutter_image_compress 2.5.1, not on its own).
            const ups = Object.entries(f.data.upgrades || {});
            const own = ups.find(([pkg]) => pkg === dep);
            const others = ups.filter(([pkg]) => pkg !== dep).map(([pkg, version]) => `${pkg} ${version}`);
            if (own) {
              upgrade(`Upgrade ${dep} to ${own[1]} (has a Swift package)`, `${tool} pub upgrade --major-versions ${dep}`);
            } else if (others.length) {
              upgrade(`Upgrade ${dep} (${others.join(', ')} ${others.length === 1 ? 'has a Swift package' : 'have Swift packages'})`,
                `${tool} pub upgrade --major-versions ${dep}`);
            }
          }

          if (id === 'outdated') {
            upgrade(`Upgrade ${dep} to ${f.data.latest}, rewriting the constraint if needed`,
              `${tool} pub upgrade --major-versions ${dep}`);
          }

          if (id === 'swiftpm' || id === 'built-in-kotlin') {
            const kind = id === 'swiftpm' ? 'swiftpm' : 'kotlin';
            // Not when a release already fixes it, and not for a discontinued
            // package: its maintainers have said there won't be another.
            const stuck = f.data.packages.filter((p) => !(f.data.upgrades || {})[p]
              && !(f.data.discontinued || []).includes(p));
            const ask = kind === 'swiftpm' ? 'for Swift Package Manager support' : 'to migrate to built-in Kotlin';
            for (const pkg of stuck) {
              const locked = r.locked.get(pkg);
              const link = r.links.get(pkg) || {};
              const url = issueUrl(kind, { name: pkg, version: locked && locked.version, ...link });
              const target = url || link.repository || `https://pub.dev/packages/${pkg}`;
              add(target, command(url ? `Ask the ${pkg} maintainers ${ask} (pre-filled GitHub issue)` : `Open ${pkg}'s repository`,
                diag, 'pubspecHealth.openExternal', [target]));
            }
          }

          if (dep && !pages.has(dep)) {
            pages.set(dep, command(`Open ${dep} on pub.dev`, diag, 'pubspecHealth.openExternal', [`https://pub.dev/packages/${dep}`]));
          }
        }
        return [...out.values(), ...pages.values()];
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });

  function command(title, diag, id, args) {
    const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    a.command = { title, command: id, arguments: args };
    a.diagnostics = [diag];
    return a;
  }

  function terminalFor(cwd) {
    const name = `Pubspec Health · ${path.basename(cwd)}`;
    return vscode.window.terminals.find((t) => t.name === name)
      || vscode.window.createTerminal({ name, cwd });
  }

  // --- Commands. ------------------------------------------------------------
  context.subscriptions.push(
    hover, actions,
    vscode.commands.registerCommand('pubspecHealth.openExternal', (url) => vscode.env.openExternal(vscode.Uri.parse(url))),
    vscode.commands.registerCommand('pubspecHealth.runInTerminal', (cwd, line) => {
      const t = terminalFor(cwd);
      t.show();
      t.sendText(line);
    }),
    vscode.commands.registerCommand('pubspecHealth.refresh', async () => {
      for (const k of context.globalState.keys()) if (k.startsWith(PREFIX)) await context.globalState.update(k, undefined);
      factsCache.clear();
      pubdev = createPubDevClient({ store, ttlMs: settings().cacheHours * 3600 * 1000 });
      await checkWorkspace();
      vscode.window.setStatusBarMessage('Pubspec Health: re-checked against pub.dev', 3000);
    }),
    vscode.commands.registerCommand('pubspecHealth.showSummary', async () => {
      const items = [];
      for (const [key, r] of results) {
        const uri = vscode.Uri.parse(key);
        for (const f of r.findings.filter((x) => x.severity !== 'hint')) {
          items.push({
            label: `${f.severity === 'error' ? '$(error)' : f.severity === 'warning' ? '$(warning)' : '$(info)'} ${f.dep || path.basename(r.projectDir)}`,
            description: f.id,
            detail: f.message,
            uri, line: f.line,
          });
        }
      }
      if (!items.length) { vscode.window.showInformationMessage('Pubspec Health: nothing to report.'); return; }
      const pick = await vscode.window.showQuickPick(items, { matchOnDetail: true, placeHolder: 'Pubspec Health findings' });
      if (pick) {
        const doc = await vscode.workspace.openTextDocument(pick.uri);
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(pick.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand('pubspecHealth.runHealthCheck', async (uri) => {
      const target = uri && isPubspec(uri) ? uri
        : (vscode.window.activeTextEditor && isPubspec(vscode.window.activeTextEditor.document.uri)
          ? vscode.window.activeTextEditor.document.uri
          : (await vscode.workspace.findFiles('pubspec.yaml', IGNORE, 1))[0]);
      if (!target) { vscode.window.showWarningMessage('Open a Flutter project (a folder with pubspec.yaml) first.'); return; }
      const dir = path.dirname(target.fsPath);
      const installed = await new Promise((resolve) => {
        cp.exec('fhc --version', { timeout: 20000 }, (err) => resolve(!err));
      });
      if (!installed) {
        const choice = await vscode.window.showInformationMessage(
          'The full health check uses flutter_health_check (fhc), a free CLI on pub.dev. Install it?',
          'Install', 'What does it check?');
        if (choice === 'Install') {
          const t = terminalFor(dir);
          t.show();
          t.sendText('dart pub global activate flutter_health_check && fhc .');
        } else if (choice === 'What does it check?') {
          vscode.env.openExternal(vscode.Uri.parse('https://pub.dev/packages/flutter_health_check'));
        }
        return;
      }
      const t = terminalFor(dir);
      t.show();
      t.sendText('fhc .');
      const choice = await vscode.window.showInformationMessage(
        'fhc is auditing this app against current App Store and Google Play rules. The report lands in health-report.html.',
        'Open report', 'Get it reviewed by a person');
      if (choice === 'Open report') {
        vscode.env.openExternal(vscode.Uri.file(path.join(dir, 'health-report.html')));
      } else if (choice === 'Get it reviewed by a person') {
        vscode.env.openExternal(vscode.Uri.parse(OFFER));
      }
    }),
  );

  // --- When to re-check. ----------------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => { if (isPubspec(doc.uri) && !results.has(doc.uri.toString())) soon(doc.uri); }),
    vscode.workspace.onDidSaveTextDocument((doc) => soon(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('pubspecHealth')) return;
      pubdev = createPubDevClient({ store, ttlMs: settings().cacheHours * 3600 * 1000 });
      checkWorkspace();
    }),
  );
  // pub get rewrites the lock, and with it everything locked-version based —
  // for every member, when it's a workspace's.
  const lockWatcher = vscode.workspace.createFileSystemWatcher('**/pubspec.lock');
  const fromLock = (lockUri) => {
    soon(vscode.Uri.file(path.join(path.dirname(lockUri.fsPath), 'pubspec.yaml')));
    for (const [key, r] of results) if (r.lockPath === lockUri.fsPath) soon(vscode.Uri.parse(key));
  };
  lockWatcher.onDidChange(fromLock);
  lockWatcher.onDidCreate(fromLock);
  lockWatcher.onDidDelete(fromLock);
  const specWatcher = vscode.workspace.createFileSystemWatcher('**/pubspec.yaml', true, false, false);
  specWatcher.onDidChange(soon);
  specWatcher.onDidDelete((u) => { collection.delete(u); results.delete(u.toString()); updateStatus(); });
  context.subscriptions.push(lockWatcher, specWatcher);

  checkWorkspace();
}

function deactivate() {}

module.exports = { activate, deactivate };
