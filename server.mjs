#!/usr/bin/env node
// Major Tom — terminal/server control system. Dependency-free (Node built-ins only).
// Manages tmux "instances" (one session per project) + a small JSON API + UI.
// Binds to the Tailscale IP (tailnet-only, WireGuard-encrypted). Password-gated.
// Live terminals (ttyd) run on localhost and are reverse-proxied through here so
// they inherit the same auth. See infra/command-center.md.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || join(HOME, 'Projects');
const PORT = Number(process.env.CC_PORT || 8787);
const STATE_FILE = join(__dirname, 'instances.json');
const AUTH_FILE = join(__dirname, 'auth.json');
const PUBLIC_DIR = join(__dirname, 'public');
const TTYD_BASE_PORT = 7700;
const TMUX = '/opt/homebrew/bin/tmux';
const TTYD = '/opt/homebrew/bin/ttyd';
const TAILSCALE = '/usr/local/bin/tailscale';
const CLAUDE_BIN = existsSync(join(HOME, '.local/bin/claude')) ? join(HOME, '.local/bin/claude') : 'claude';
const VAULT_BASE = process.env.VAULT_BASE || '/Users/you/Obsidian/vault';
const CMD_FILE = join(__dirname, 'commands.json');   // saved-commands library
const LOG_DIR = join(__dirname, 'logs');             // headless run logs
const uid = () => crypto.randomBytes(6).toString('hex');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // shell-quote a path for send-keys

// ---- helpers --------------------------------------------------------------
const sanitize = (s) => String(s).trim().replace(/[ .:]/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
// Group is a free-text display label (spaces allowed) — trimmed, control chars out, length-capped.
const groupName = (s) => { const v = String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40); return v || null; };
const P = (n) => `=${n}:`;   // pane/keys target (send-keys/capture-pane)
const S = (n) => `=${n}`;    // session target (has/kill/new/attach)
const j = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function run(cmd, args, opts = {}) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, ...opts }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || e.message || '').toString().trim() }; }
}
// ---- host registry --------------------------------------------------------
// Instances can live on this machine or on any other host in hosts.json. The
// LOCAL host is resolved at runtime by matching os.hostname(), so moving this
// server to another host (e.g. sv4) needs no code change — that host simply
// stops being remote and this one starts being remote.
const HOSTS_FILE = join(__dirname, 'hosts.json');
const SSH = '/usr/bin/ssh';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
function loadHosts() {
  try { return JSON.parse(readFileSync(HOSTS_FILE, 'utf8')).hosts || []; }
  catch { return []; }
}
let HOSTS = loadHosts();
const SELF_HOSTNAME = os.hostname().replace(/\.local$/, '');
// Fallback keeps a single-host install working even with no hosts.json.
const LOCAL_FALLBACK = { id: 'local', label: SELF_HOSTNAME, hostname: SELF_HOSTNAME, ssh: null,
  addr: '127.0.0.1', tmux: TMUX, ttyd: TTYD, projectsRoot: PROJECTS_ROOT, home: HOME, enabled: true };
const isLocal = (h) => !h.ssh || h.hostname === SELF_HOSTNAME;
function hostById(id) {
  if (!HOSTS.length) return LOCAL_FALLBACK;
  return HOSTS.find((h) => h.id === id) || HOSTS.find((h) => h.hostname === SELF_HOSTNAME) || HOSTS[0];
}
const localHost = () => HOSTS.find((h) => h.hostname === SELF_HOSTNAME) || LOCAL_FALLBACK;
const hostOf = (inst) => hostById(inst.host || localHost().id);

// Run a command on a host: directly when local, over ssh when not. Remote args
// are shell-quoted individually — ssh re-parses the command through a shell on
// the far side, so an unquoted arg containing spaces would split.
function hrun(host, cmd, args = [], opts = {}) {
  if (isLocal(host)) return run(cmd, args, opts);
  return run(SSH, [...SSH_OPTS, host.ssh, [cmd, ...args].map(shq).join(' ')], opts);
}
const tmuxOn = (host, ...args) => hrun(host, host.tmux || TMUX, args);
const sessionExistsOn = (host, name) => tmuxOn(host, 'has-session', '-t', S(name)).ok;

// Kept for the few call sites that are inherently local.
const tmux = (...args) => run(TMUX, args);
const sessionExists = (name) => tmux('has-session', '-t', S(name)).ok;
function tsIP() { const r = run(TAILSCALE, ['ip', '-4']); return r.ok ? r.out.split('\n')[0].trim() : '0.0.0.0'; }
let _host = null;
function tailnetHost() {
  if (_host) return _host;
  const r = run(TAILSCALE, ['status', '--json']);
  try { _host = JSON.parse(r.out).Self.DNSName.replace(/\.$/, ''); } catch { _host = os.hostname(); }
  return _host;
}
let BIND = process.env.CC_BIND || '0.0.0.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForTailnetIP() { for (let i = 0; i < 20; i++) { const ip = tsIP(); if (ip.startsWith('100.')) return ip; await sleep(2000); } return tsIP(); }

// ---- auth (scrypt password + HMAC cookie) ---------------------------------
function loadAuth() { try { return JSON.parse(readFileSync(AUTH_FILE, 'utf8')); } catch { return null; } }
let auth = loadAuth();
function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  auth = { salt, hash, secret };
  writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
}
function verifyPassword(pw) {
  if (!auth) return false;
  const h = crypto.scryptSync(String(pw), auth.salt, 64).toString('hex');
  return h.length === auth.hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(auth.hash));
}
const token = () => crypto.createHmac('sha256', auth.secret).update('cc-authed-v1').digest('hex');
const cookieHeader = () => `cc_token=${token()}; HttpOnly; Path=/; Max-Age=7776000; SameSite=Lax`;
function parseCookies(req) { const h = req.headers.cookie || ''; const o = {}; h.split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }); return o; }
function isAuthed(req) {
  if (!auth) return false;
  const t = parseCookies(req).cc_token; if (!t) return false;
  const good = token();
  return t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
}

// ---- state ----------------------------------------------------------------
function loadState() { if (!existsSync(STATE_FILE)) return { instances: [] }; try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { instances: [] }; } }
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
let state = loadState();
// Backfill fields added after the first release so old records filter/sort cleanly.
(function migrate() {
  let dirty = false;
  for (const i of state.instances) {
    if (!('group' in i)) { i.group = null; dirty = true; }
    if (!('archived' in i)) { i.archived = false; dirty = true; }
    if (!('resume' in i)) { i.resume = true; dirty = true; }
    // Pre-multi-host instances all live on whatever machine this server runs on.
    if (!('host' in i)) { i.host = localHost().id; dirty = true; }
    if (!i.updatedAt) { i.updatedAt = i.createdAt || new Date().toISOString(); dirty = true; }
  }
  if (dirty) saveState(state);
})();
const touch = (inst) => { inst.updatedAt = new Date().toISOString(); };
const findInst = (name) => state.instances.find((i) => i.name === name);

// A pane's pane_pid is the SHELL. Claude runs as its child in its own process
// group, so `ps -g <pane_pid>` only ever returns /bin/zsh and never sees Claude.
// The old code therefore always fell through to a capture-pane text match — which
// reports TRUE for any dead pane whose scrollback still contains the word "claude"
// (exactly what tmux-resurrect leaves behind). Walk real descendants instead.
// Match `claude`, `claude rc`, `Claude` (some panes launch it capitalised) and the
// versioned binary `~/.local/share/claude/versions/<v> --print ...` that `claude rc`
// spawns. Case-insensitive on purpose.
const CLAUDE_CMD_RE = /(^|\/)claude( |$)|\/claude\/versions\//i;
// Ask the pane's tty, not the process tree. pane_tty is unique per pane, so every
// process on it belongs to that pane -- and Claude may sit anywhere in the tree:
// it is the pane process when it exec'd over the shell, a child when the shell
// stayed, and a grandchild under `claude rc`. One ps call per pane, not a walk.
function claudeRunning(host, name) {
  const r = tmuxOn(host, 'list-panes', '-t', P(name), '-F', '#{pane_tty}');
  if (!r.ok) return false;
  return r.out.split('\n').filter(Boolean).some((tty) => {
    const ps = hrun(host, '/bin/ps', ['-t', tty.replace(/^\/dev\//, ''), '-o', 'command=']);
    return ps.ok && ps.out.split('\n').some((c) => CLAUDE_CMD_RE.test(c.trim()));
  });
}

// `claude --continue` exits immediately ("No conversation found to continue") when
// the folder has no history, which would leave the pane at a dead shell. Gate on the
// on-disk transcript dir; if the encoding ever drifts we just fall back to a plain
// launch, which is the safe direction to fail.
const PROJECTS_HISTORY = join(HOME, '.claude', 'projects');
function hasHistory(host, folder) {
  const slug = String(folder).replace(/[^A-Za-z0-9]/g, '-');
  if (isLocal(host)) {
    try {
      const dir = join(PROJECTS_HISTORY, slug);
      return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.jsonl'));
    } catch { return false; }
  }
  const dir = `${host.home}/.claude/projects/${slug}`;
  return hrun(host, '/bin/sh', ['-c', `ls ${shq(dir)}/*.jsonl >/dev/null 2>&1 && echo yes || echo no`]).out === 'yes';
}

// Claude's TUI needs an unpredictable time to come up - far longer on a cold boot
// with several instances launching at once than the fixed 3.5s guess this replaces.
// Poll for the real input box, then send. Gives up rather than typing into nothing.
//
// Two traps this has to clear:
//  - Resuming an aged session interrupts startup with a chooser ("1. Resume from
//    summary (recommended) / 2. Resume full session as-is / 3. Don't ask me again").
//    It draws its own "> 1. Resume from summary" row, so testing for a bare prompt
//    character would match the MENU and fire keystrokes into it.
//  - So readiness means an EMPTY prompt line, which only the real input box has.
// We answer the chooser with its recommended option: at boot this can fire across
// every instance at once, and "resume full session" would replay each full
// transcript against the usage limits (the dialog warns about exactly that).
const RESUME_CHOOSER_RE = /Resume from summary|Resume full session/;
// "Ready" is the input BOX, identified structurally: a prompt line sitting
// directly under the box's horizontal rule. Matching the prompt line's CONTENT
// does not work — a resumed session shows an empty prompt, but a brand-new one
// shows placeholder hint text (`> Try "fix lint errors"`), and both menus draw
// prompt rows of their own. Requiring an empty prompt silently broke every NEW
// instance: readiness never fired, so /remote-control was never sent and Claude
// fell back to auto-naming the session <hostname>-<random-words>.
const PROMPT_RE = /^\s*\u276f/;
const RULE_RE = /^\s*\u2500{10,}/;
function isTuiReady(pane) {
  const lines = pane.split('\n');
  return lines.some((l, i) => PROMPT_RE.test(l) && i > 0 && RULE_RE.test(lines[i - 1]));
}
function whenClaudeReady(host, name, cb, tries = 90, answeredChooser = false) {
  const again = (why, answered = answeredChooser) => {
    if (tries <= 0) return console.log(`claude never became ready (${why}):`, name);
    setTimeout(() => whenClaudeReady(host, name, cb, tries - 1, answered), 1000);
  };
  if (!claudeRunning(host, name)) return again('process');
  const pane = tmuxOn(host, 'capture-pane', '-pt', P(name)).out || '';
  if (RESUME_CHOOSER_RE.test(pane)) {
    if (answeredChooser) return again('resume-chooser');      // answered once; let it settle
    console.log('answering resume chooser (summary):', name);
    tmuxOn(host, 'send-keys', '-t', P(name), 'Enter');
    return again('resume-chooser', true);
  }
  if (!isTuiReady(pane)) return again('tui');
  setTimeout(cb, 400);   // settle, so the first keystroke isn't eaten mid-render
}

// ---- ttyd (localhost; reverse-proxied through this server) -----------------
const ttyds = new Map();
function ttydPortFor(name) { const idx = state.instances.findIndex((i) => i.name === name); return TTYD_BASE_PORT + (idx < 0 ? state.instances.length : idx); }
function startTtyd(name) {
  if (ttyds.has(name)) return ttyds.get(name);
  const inst = findInst(name);
  const host = inst ? hostOf(inst) : localHost();
  const port = ttydPortFor(name);
  const ttydArgs = (bind) => ['-p', String(port), '-i', bind, '-b', `/term/${name}`,
    '-t', 'titleFixed=' + name, '-t', 'fontSize=15', '-W'];

  if (isLocal(host)) {
    const proc = spawn(host.ttyd || TTYD, [...ttydArgs('127.0.0.1'), host.tmux || TMUX, 'attach', '-t', S(name)],
      { detached: true, stdio: 'ignore' });
    proc.unref();
    const rec = { port, proc, path: `/term/${name}/` };
    ttyds.set(name, rec); return rec;
  }

  // Remote: start ttyd bound to the far side's LOOPBACK (never its LAN address —
  // ttyd has no auth of its own; binding it to that host's LAN address would hand
  // a shell to anyone on that subnet), then pull it over an ssh tunnel to our loopback,
  // where the existing /term/<name> reverse proxy already inherits our auth.
  const remoteCmd = [host.ttyd, ...ttydArgs('127.0.0.1'), host.tmux, 'attach', '-t', S(name)]
    .map(shq).join(' ');
  const rttyd = spawn(SSH, [...SSH_OPTS, host.ssh, `pkill -f ${shq('ttyd -p ' + port)} >/dev/null 2>&1; ${remoteCmd}`],
    { detached: true, stdio: 'ignore' });
  rttyd.unref();
  const tunnel = spawn(SSH, [...SSH_OPTS, '-N', '-L', `127.0.0.1:${port}:127.0.0.1:${port}`, host.ssh],
    { detached: true, stdio: 'ignore' });
  tunnel.unref();
  const rec = { port, proc: rttyd, tunnel, host: host.id, path: `/term/${name}/` };
  ttyds.set(name, rec);
  return rec;
}
function stopTtyd(name) {
  const t = ttyds.get(name); if (!t) return;
  for (const pr of [t.proc, t.tunnel]) {
    if (!pr) continue;
    try { process.kill(-pr.pid); } catch {}
    try { pr.kill(); } catch {}
  }
  // The ssh child dying does not necessarily reap ttyd on the far side.
  if (t.host) { const h = hostById(t.host); if (h && !isLocal(h)) hrun(h, '/usr/bin/pkill', ['-f', `ttyd -p ${t.port}`]); }
  ttyds.delete(name);
}

// ---- publish a port over the tailnet (TCP proxy BIND:port -> 127.0.0.1:port)
const proxies = new Map();
function publish(inst, port) {
  port = Number(port); if (!port) return { ok: false, err: 'invalid port' };
  const host = hostOf(inst);
  const target = isLocal(host) ? '127.0.0.1' : host.addr;   // where the app actually listens
  const key = `${inst.name}:${port}`;
  const url = `http://${tailnetHost()}:${port}/`;
  const record = () => { inst.publishedPorts = (inst.publishedPorts || []).filter((p) => p.port !== port).concat([{ port, url }]); saveState(state); };
  if (proxies.has(key)) { record(); return { ok: true, url }; }
  const srv = net.createServer((sock) => { const up = net.connect(port, target); const end = () => { sock.destroy(); up.destroy(); }; sock.on('error', end); up.on('error', end); sock.pipe(up); up.pipe(sock); });
  srv.on('error', (e) => { proxies.delete(key); if (e.code === 'EADDRINUSE') record(); });
  srv.listen(port, BIND, () => { proxies.set(key, srv); record(); });
  return { ok: true, url };
}
function unpublish(inst, port) { port = Number(port); const key = `${inst.name}:${port}`; const s = proxies.get(key); if (s) { try { s.close(); } catch {} proxies.delete(key); } inst.publishedPorts = (inst.publishedPorts || []).filter((p) => p.port !== port); saveState(state); }

// ---- pre-trust folder so Claude skips its trust dialog --------------------
const CLAUDE_JSON = join(HOME, '.claude.json');
function trustFolder(host, dir) {
  if (host && !isLocal(host)) return trustFolderRemote(host, dir);
  try {
    if (!existsSync(CLAUDE_JSON)) return;
    const d = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
    d.projects = d.projects || {};
    const cur = d.projects[dir] || {};
    if (cur.hasTrustDialogAccepted === true) return;
    d.projects[dir] = { allowedTools: [], ...cur, hasTrustDialogAccepted: true, projectOnboardingSeenCount: Math.max(1, cur.projectOnboardingSeenCount || 0) };
    const tmp = `${CLAUDE_JSON}.cc-tmp`; writeFileSync(tmp, JSON.stringify(d, null, 2)); renameSync(tmp, CLAUDE_JSON);
  } catch (e) { console.log('trustFolder error:', e.message); }
}
// Same pre-trust on a remote host. node isn't guaranteed there, so this is done
// with python3 (present on every Ubuntu image we target).
function trustFolderRemote(host, dir) {
  const py = [
    'import json,os,sys',
    `p=os.path.expanduser('~/.claude.json'); d=${'{}'}`,
    "d=json.load(open(p)) if os.path.exists(p) else {}",
    "d.setdefault('projects',{})",
    "cur=d['projects'].get(sys.argv[1],{})",
    "cur['hasTrustDialogAccepted']=True",
    "cur.setdefault('allowedTools',[])",
    "cur['projectOnboardingSeenCount']=max(1,cur.get('projectOnboardingSeenCount',0))",
    "d['projects'][sys.argv[1]]=cur",
    "open(p+'.tmp','w').write(json.dumps(d,indent=2)); os.replace(p+'.tmp',p)",
  ].join('\n');
  const r = hrun(host, '/usr/bin/python3', ['-c', py, dir]);
  if (!r.ok) console.log('trustFolderRemote error:', host.id, r.err || r.out);
}

// ---- lifecycle ------------------------------------------------------------
function powerOn(inst) {
  const host = hostOf(inst);
  if (isLocal(host)) { if (!existsSync(inst.folder)) mkdirSync(inst.folder, { recursive: true }); }
  else hrun(host, '/bin/mkdir', ['-p', inst.folder]);
  trustFolder(host, inst.folder);
  if (!sessionExistsOn(host, inst.name)) tmuxOn(host, 'new-session', '-d', '-s', inst.name, '-c', inst.folder);
  if (!inst.startClaude) return;
  if (claudeRunning(host, inst.name)) return;     // idempotent: never stack a second claude
  // The vault lives on the Mac only; remote hosts get no --add-dir.
  const vault = (isLocal(host) && inst.vaultFolder) ? join(VAULT_BASE, inst.vaultFolder) : null;
  if (vault) trustFolder(host, vault);     // so Claude can access the vault without a prompt
  // `resume` is a per-instance choice honoured on EVERY power-on, not just at boot.
  const base = (inst.resume !== false && hasHistory(host, inst.folder)) ? 'claude --continue' : 'claude';
  const launch = vault ? `${base} --add-dir ${shq(vault)}` : base;
  tmuxOn(host, 'send-keys', '-t', P(inst.name), launch, 'Enter');
  if (inst.remoteControl) whenClaudeReady(host, inst.name, () => remoteControl(host, inst.name, true));
}
function powerOff(inst) {
  const host = hostOf(inst);
  stopTtyd(inst.name);
  for (const p of inst.publishedPorts || []) unpublish(inst, p.port);
  tmuxOn(host, 'kill-session', '-t', S(inst.name));
}

// Turn remote-control ON (enable + label) or OFF (dismiss the confirm dialog).
// OFF: `/remote-control` opens a menu (❯ Continue by default) — navigate Up,Up to
// "Disconnect this session" and Enter. Keys must be sent SPACED, not in one burst
// (a single burst races the TUI render and lands on the wrong item).
// Connecting parks the TUI on a confirmation dialog ("Disconnect this session /
// Show QR code / Continue"). Left alone the pane never returns to the input box,
// so the instance looks wedged and later send-keys land in a menu. Esc is the
// dialog's own labelled "continue" action and, unlike Enter, cannot activate a
// different row if the highlight has moved.
const RC_DIALOG_RE = /Show QR code|Scan with your phone/;
function dismissRemoteDialog(host, name, tries = 30) {
  if (RC_DIALOG_RE.test(tmuxOn(host, 'capture-pane', '-pt', P(name)).out || '')) {
    tmuxOn(host, 'send-keys', '-t', P(name), 'Escape');
    return;
  }
  if (tries <= 0) return console.log('remote-control dialog never appeared:', name);
  setTimeout(() => dismissRemoteDialog(host, name, tries - 1), 1000);
}
function remoteControl(host, name, on) {
  const t = P(name);
  if (on) { tmuxOn(host, 'send-keys', '-t', t, `/remote-control ${name}`, 'Enter'); return dismissRemoteDialog(host, name); }
  tmuxOn(host, 'send-keys', '-t', t, '/remote-control', 'Enter');
  setTimeout(() => tmuxOn(host, 'send-keys', '-t', t, 'Up'), 1500);
  setTimeout(() => tmuxOn(host, 'send-keys', '-t', t, 'Up'), 2000);
  setTimeout(() => tmuxOn(host, 'send-keys', '-t', t, 'Enter'), 2500);
}

// List folders under ~/Projects INCLUDING nested subfolders (depth-limited,
// skipping heavy/noise dirs). Symlinks are skipped (avoids loops). Local disk → fast.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.output', '.venv', 'venv', 'env', '__pycache__', '.cache', '.turbo', 'coverage', 'vendor', 'target', '.svelte-kit', '.nuxt', '.pytest_cache', '.mypy_cache', '.gradle', 'Pods', '.idea', '.vscode']);
function listProjectFolders(hostId, maxDepth = 3, cap = 1000) {
  const host = hostById(hostId || localHost().id);
  if (!isLocal(host)) return listProjectFoldersRemote(host, maxDepth, cap);
  const out = [];
  const walk = (rel, depth) => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries; try { entries = readdirSync(join(PROJECTS_ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r); walk(r, depth + 1);
      if (out.length >= cap) return;
    }
  };
  walk('', 1);
  return out.sort();
}
// Remote equivalent: one `find` instead of a round-trip per directory.
function listProjectFoldersRemote(host, maxDepth = 3, cap = 1000) {
  const prune = [...SKIP_DIRS].map((d) => `-name ${shq(d)}`).join(' -o ');
  const cmd = `cd ${shq(host.projectsRoot)} 2>/dev/null && find . -mindepth 1 -maxdepth ${maxDepth} ` +
    `\\( ${prune} -o -name '.*' \\) -prune -o -type d -print 2>/dev/null | head -n ${cap}`;
  const r = hrun(host, '/bin/sh', ['-c', cmd]);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '')).sort();
}
// The vault is on iCloud. A launchd agent's SYNC iCloud read can block forever
// (CloudDocs), freezing the event loop — so scan ASYNC (libuv threadpool), cache
// the result, and hard-timeout. /api/state returns the cache and never blocks.
let vaultFoldersCache = [];
let vaultRefreshing = false;
async function refreshVaultFolders() {
  if (vaultRefreshing) return; vaultRefreshing = true;
  try {
    const fsp = await import('node:fs/promises');
    const scan = (async () => {
      const out = [];
      for (const a of await fsp.readdir(VAULT_BASE, { withFileTypes: true })) {
        if (a.name.startsWith('.') || !a.isDirectory()) continue; out.push(a.name);
        try { for (const b of await fsp.readdir(join(VAULT_BASE, a.name), { withFileTypes: true })) if (!b.name.startsWith('.') && b.isDirectory()) out.push(`${a.name}/${b.name}`); } catch {}
      }
      return out.sort();
    })();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('vault scan timeout')), 6000));
    vaultFoldersCache = await Promise.race([scan, timeout]);
  } catch (e) { console.log('vault scan:', e.message); } finally { vaultRefreshing = false; }
}

// ---- custom commands library ----------------------------------------------
function loadCommands() { try { return JSON.parse(readFileSync(CMD_FILE, 'utf8')); } catch { return []; } }
function saveCommands() { writeFileSync(CMD_FILE, JSON.stringify(commands, null, 2)); }
let commands = loadCommands();
const findCmd = (id) => commands.find((c) => c.id === id);

// Run one attachment. manual=false means the scheduler fired it.
// Returns a status string (also stored on att.lastRun).
function runAttachment(inst, att, { manual = false } = {}) {
  const cmd = findCmd(att.commandId);
  const stamp = (status, extra = {}) => { att.lastRun = { at: new Date().toISOString(), status, ...extra }; saveState(state); return status; };
  if (!cmd) return stamp('error: command was deleted');
  const host = hostOf(inst);
  const running = sessionExistsOn(host, inst.name);
  const headless = cmd.kind === 'claude' && cmd.runMode === 'headless';
  if (!running && !(manual && headless)) return stamp('skipped (instance off)');   // scheduled+off, or live/shell needs session

  if (cmd.kind === 'shell') { tmuxOn(hostOf(inst), 'send-keys', '-t', P(inst.name), cmd.text, 'Enter'); return stamp('sent (shell)'); }
  if (cmd.runMode === 'live') { tmuxOn(hostOf(inst), 'send-keys', '-t', P(inst.name), cmd.text, 'Enter'); return stamp('sent (live session)'); }

  // headless: claude -p, autonomous, logged
  const perm = cmd.permission === 'full' ? 'bypassPermissions' : 'acceptEdits';
  const args = ['-p', cmd.text, '--permission-mode', perm];
  if (inst.vaultFolder && isLocal(host)) args.push('--add-dir', join(VAULT_BASE, inst.vaultFolder));
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const logPath = join(LOG_DIR, `${inst.name}-${att.attachId}-${Date.now()}.log`);
    const fd = openSync(logPath, 'a');
    // Remote hosts run claude over ssh; the log still lands here so the UI can read it.
    const [bin, binArgs] = isLocal(host)
      ? [CLAUDE_BIN, args]
      : [SSH, [...SSH_OPTS, host.ssh, `cd ${shq(inst.folder)} && ${[`${host.home}/.local/bin/claude`, ...args].map(shq).join(' ')}`]];
    const child = spawn(bin, binArgs, { cwd: isLocal(host) ? inst.folder : undefined, detached: true, stdio: ['ignore', fd, fd] });
    child.on('exit', (code) => { att.lastRun = { at: new Date().toISOString(), status: code === 0 ? 'ok (headless)' : `error (exit ${code})`, log: logPath }; saveState(state); });
    child.unref();
    return stamp('running (headless)…', { log: logPath });
  } catch (e) { return stamp('error: ' + e.message); }
}

// ---- scheduler (per-minute) -----------------------------------------------
function dayMatches(days, dow) { if (!days || days === 'daily') return true; if (days === 'weekdays') return dow >= 1 && dow <= 5; if (Array.isArray(days)) return days.includes(dow); return true; }
function schedulerTick() {
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const minuteKey = `${now.toDateString()} ${cur}`, dow = now.getDay();
  for (const inst of state.instances) { if (inst.archived) continue; for (const att of inst.commands || []) {
    const s = att.schedule;
    if (!s || att.enabled === false || s.time !== cur || !dayMatches(s.days, dow) || att.lastFiredMinute === minuteKey) continue;
    att.lastFiredMinute = minuteKey; saveState(state);
    console.log('schedule fire:', inst.name, att.attachId, cur);
    runAttachment(inst, att, { manual: false });
  } }
}
function view(inst) { const host = hostOf(inst); const running = sessionExistsOn(host, inst.name); return { ...inst, running, claudeRunning: running ? claudeRunning(host, inst.name) : false, hostId: host.id, hostLabel: host.label, ttydPath: ttyds.has(inst.name) ? `/term/${inst.name}/` : null }; }

// ---- HTTP -----------------------------------------------------------------
function body(req) { return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, m = req.method;

  // --- auth endpoints (open) ---
  if (p === '/api/auth-status') return j(res, 200, { configured: !!auth, authed: isAuthed(req) });
  if (p === '/api/set-password' && m === 'POST') { const b = await body(req); if (auth && !isAuthed(req)) return j(res, 401, { error: 'already configured' }); if (!b.password || String(b.password).length < 4) return j(res, 400, { error: 'password must be at least 4 characters' }); setPassword(b.password); res.setHeader('Set-Cookie', cookieHeader()); return j(res, 200, { ok: true }); }
  if (p === '/api/login' && m === 'POST') { const b = await body(req); if (!verifyPassword(b.password)) return j(res, 401, { error: 'wrong password' }); res.setHeader('Set-Cookie', cookieHeader()); return j(res, 200, { ok: true }); }
  if (p === '/api/logout' && m === 'POST') { res.setHeader('Set-Cookie', 'cc_token=; Path=/; Max-Age=0'); return j(res, 200, { ok: true }); }

  // --- gate everything else that's sensitive ---
  const sensitive = p.startsWith('/api/') || p.startsWith('/term/');
  if (sensitive && !isAuthed(req)) { if (p.startsWith('/term/')) { res.writeHead(401); return res.end('auth required'); } return j(res, 401, { error: 'unauthorized' }); }

  // --- ttyd reverse proxy (authed) ---
  if (p.startsWith('/term/')) {
    const name = p.split('/')[2];
    const ti = findInst(name);
    if (!ti || !sessionExistsOn(hostOf(ti), name)) { res.writeHead(404); return res.end('instance not running'); }
    const rec = startTtyd(name);
    const pr = http.request({ host: '127.0.0.1', port: rec.port, path: req.url, method: m, headers: req.headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    pr.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    return req.pipe(pr);
  }

  // --- API ---
  if (p === '/api/state') {
    const hostId = url.searchParams.get('host') || localHost().id;
    const h = hostById(hostId);
    return j(res, 200, { host: tailnetHost(), bind: BIND, projectsRoot: h.projectsRoot, folders: listProjectFolders(hostId),
      hosts: HOSTS.filter((x) => x.enabled !== false).map((x) => ({ id: x.id, label: x.label, local: isLocal(x) })),
      selfHost: localHost().id, vaultBase: VAULT_BASE, vaultFolders: vaultFoldersCache,
      commandsLibrary: commands, instances: state.instances.map(view) });
  }
  if (p === '/api/mkdir' && m === 'POST') { const b = await body(req); const rel = String(b.path || '').replace(/\.\./g, '').replace(/^\/+/, '').trim(); if (!rel) return j(res, 400, { error: 'path required' }); const abs = resolve(PROJECTS_ROOT, rel); if (!abs.startsWith(PROJECTS_ROOT)) return j(res, 400, { error: 'path must be under Projects' }); try { mkdirSync(abs, { recursive: true }); return j(res, 200, { ok: true, path: rel }); } catch (e) { return j(res, 500, { error: e.message }); } }
  if (p === '/api/commands' && m === 'GET') return j(res, 200, commands);
  if (p === '/api/commands' && m === 'POST') { const b = await body(req); if (!b.name || !b.text) return j(res, 400, { error: 'name and text required' }); const c = { id: uid(), name: String(b.name), kind: b.kind === 'shell' ? 'shell' : 'claude', text: String(b.text), runMode: b.runMode === 'live' ? 'live' : 'headless', permission: b.permission === 'full' ? 'full' : 'acceptEdits', createdAt: new Date().toISOString() }; commands.push(c); saveCommands(); return j(res, 200, c); }
  const mCmdDel = p.match(/^\/api\/commands\/([^/]+)$/);
  if (mCmdDel && m === 'DELETE') { const id = mCmdDel[1]; commands = commands.filter((c) => c.id !== id); saveCommands(); for (const i of state.instances) i.commands = (i.commands || []).filter((a) => a.commandId !== id); saveState(state); return j(res, 200, { ok: true }); }
  if (p === '/api/instances' && m === 'POST') {
    const b = await body(req); const name = sanitize(b.name);
    if (!name) return j(res, 400, { error: 'name required' });
    if (findInst(name)) return j(res, 409, { error: 'instance exists' });
    const h = HOSTS.find((x) => x.id === b.host) || localHost();
    const root = h.projectsRoot;
    const folder = b.newFolder ? `${root}/${name}` : (b.folder ? resolve(root, b.folder) : `${root}/${name}`);
    if (!folder.startsWith(root)) return j(res, 400, { error: 'folder must be under Projects' });
    const now = new Date().toISOString();
    const inst = { name, folder, host: h.id, autostart: !!b.autostart, remoteControl: !!b.remoteControl, startClaude: b.startClaude !== false, resume: b.resume !== false, vaultFolder: b.vaultFolder || null, group: groupName(b.group), archived: false, commands: [], publishedPorts: [], createdAt: now, updatedAt: now };
    state.instances.push(inst); saveState(state);
    if (b.startNow) powerOn(inst);
    return j(res, 200, view(inst));
  }
  // command attachments: /api/instances/:name/commands[/:attachId[/run]]
  const mAtt = p.match(/^\/api\/instances\/([^/]+)\/commands(?:\/([^/]+?))?(\/run)?$/);
  if (mAtt) {
    const inst = findInst(decodeURIComponent(mAtt[1])); if (!inst) return j(res, 404, { error: 'not found' });
    inst.commands = inst.commands || []; const attId = mAtt[2], isRun = !!mAtt[3];
    if (!attId && m === 'POST') { const b = await body(req); if (!findCmd(b.commandId)) return j(res, 400, { error: 'unknown command' }); const att = { attachId: uid(), commandId: b.commandId, schedule: b.schedule || null, enabled: true, lastRun: null }; inst.commands.push(att); saveState(state); return j(res, 200, view(inst)); }
    if (attId) {
      const att = inst.commands.find((a) => a.attachId === attId); if (!att) return j(res, 404, { error: 'attachment not found' });
      if (isRun && m === 'POST') return j(res, 200, { status: runAttachment(inst, att, { manual: true }) });
      if (m === 'PATCH') { const b = await body(req); if ('schedule' in b) att.schedule = b.schedule || null; if ('enabled' in b) att.enabled = !!b.enabled; saveState(state); return j(res, 200, view(inst)); }
      if (m === 'DELETE') { inst.commands = inst.commands.filter((a) => a.attachId !== attId); saveState(state); return j(res, 200, { ok: true }); }
    }
  }

  const mInst = p.match(/^\/api\/instances\/([^/]+)(\/[a-z-]+)?$/);
  if (mInst) {
    const inst = findInst(decodeURIComponent(mInst[1])); if (!inst) return j(res, 404, { error: 'not found' });
    const action = mInst[2];
    if (!action && m === 'DELETE') { powerOff(inst); state.instances = state.instances.filter((i) => i !== inst); saveState(state); return j(res, 200, { ok: true }); }
    if (action === '/power' && m === 'POST') { const b = await body(req); b.on ? powerOn(inst) : powerOff(inst); touch(inst); saveState(state); return j(res, 200, view(inst)); }
    if (action === '/group' && m === 'POST') { const b = await body(req); inst.group = groupName(b.group); touch(inst); saveState(state); return j(res, 200, view(inst)); }
    // Archiving parks an instance out of the main list. A running one is powered off
    // first, otherwise a hidden tmux session would keep running with no way to reach it.
    if (action === '/archive' && m === 'POST') { const b = await body(req); inst.archived = !!b.on; if (inst.archived && sessionExistsOn(hostOf(inst), inst.name)) powerOff(inst); touch(inst); saveState(state); return j(res, 200, view(inst)); }
    if (action === '/send' && m === 'POST') { const b = await body(req); tmuxOn(hostOf(inst), 'send-keys', '-t', P(inst.name), String(b.keys ?? ''), 'Enter'); return j(res, 200, { ok: true }); }
    if (action === '/exit-claude' && m === 'POST') { tmuxOn(hostOf(inst), 'send-keys', '-t', P(inst.name), '/exit', 'Enter'); return j(res, 200, { ok: true }); }
    if (action === '/remote-control' && m === 'POST') { const b = await body(req); inst.remoteControl = !!b.on; touch(inst); saveState(state); if (sessionExistsOn(hostOf(inst), inst.name)) remoteControl(hostOf(inst), inst.name, !!b.on); return j(res, 200, view(inst)); }
    // Moving hosts is only safe while stopped: the tmux session lives on the old host.
    if (action === '/host' && m === 'POST') { const b = await body(req);
      if (sessionExistsOn(hostOf(inst), inst.name)) return j(res, 400, { error: 'power the instance off before moving it' });
      const h = HOSTS.find((x) => x.id === b.host); if (!h) return j(res, 400, { error: 'unknown host' });
      inst.host = h.id; touch(inst); saveState(state); return j(res, 200, view(inst)); }
    if (action === '/resume' && m === 'POST') { const b = await body(req); inst.resume = !!b.on; touch(inst); saveState(state); return j(res, 200, view(inst)); }
    if (action === '/autostart' && m === 'POST') { const b = await body(req); inst.autostart = !!b.on; touch(inst); saveState(state); return j(res, 200, view(inst)); }
    if (action === '/vault' && m === 'POST') { const b = await body(req); inst.vaultFolder = b.folder || null; touch(inst); saveState(state); return j(res, 200, view(inst)); }
    if (action === '/terminal' && m === 'POST') { if (!sessionExistsOn(hostOf(inst), inst.name)) return j(res, 400, { error: 'instance not running' }); const r = startTtyd(inst.name); return j(res, 200, { path: r.path }); }
    if (action === '/output' && m === 'GET') { const r = tmuxOn(hostOf(inst), 'capture-pane', '-pt', P(inst.name)); return j(res, 200, { output: r.out || '(no output / not running)' }); }
    if (action === '/publish' && m === 'POST') { const b = await body(req); return j(res, 200, publish(inst, b.port)); }
    if (action === '/publish' && m === 'DELETE') { const b = await body(req); unpublish(inst, b.port); return j(res, 200, { ok: true }); }
  }

  // --- static UI (open: shell + login screen, nothing sensitive) ---
  const file = p === '/' ? '/index.html' : p;
  const fp = join(PUBLIC_DIR, file.replace(/\.\./g, ''));
  if (existsSync(fp) && statSync(fp).isFile()) {
    const ext = fp.split('.').pop();
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'text/plain' });
    return res.end(readFileSync(fp));
  }
  j(res, 404, { error: 'not found' });
});

// --- WebSocket upgrade → proxy to ttyd (authed) ---
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (!p.startsWith('/term/') || !isAuthed(req)) { socket.destroy(); return; }
  const rec = ttyds.get(p.split('/')[2]); if (!rec) { socket.destroy(); return; }
  const up = net.connect(rec.port, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    up.write('\r\n'); if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});

// ---- boot reconcile -------------------------------------------------------
// A session existing is NOT proof it's alive: it can come back from a
// tmux-resurrect restore as a bare shell, or Claude may have crashed or been
// /exit-ed. Adopt those too instead of skipping them.
function reconcile() {
  for (const inst of state.instances) {
    if (!inst.autostart || inst.archived) continue;
    const host = hostOf(inst);
    if (sessionExistsOn(host, inst.name) && (!inst.startClaude || claudeRunning(host, inst.name))) continue;
    console.log('autostart:', inst.name);
    powerOn(inst);
  }
}

async function start() {
  run('/usr/bin/pkill', ['-f', TTYD]);   // sweep orphan ttyd from a prior run (ports freed)
  if (!process.env.CC_BIND) BIND = await waitForTailnetIP();
  server.listen(PORT, BIND, () => { console.log(`Major Tom: http://${tailnetHost()}:${PORT}  (bind ${BIND}, auth ${auth ? 'set' : 'NOT set'})`); setTimeout(reconcile, 1500); setInterval(schedulerTick, 30000); refreshVaultFolders(); setInterval(refreshVaultFolders, 300000); });
}
start();
