// Burnline's single on-disk store, shared by status.js and the
// list/reset helpers so all three read and write the exact same shape.
//
// Everything lives in ONE file, written with ONE atomic rename per
// statusLine tick. The previous layout (state/sessions.json plus one file
// per project per month) needed two writes per tick, and Claude Code does
// kill statusLine processes mid-run — orphaned `*.tmp` files were the
// evidence. A kill between the two writes left the project total updated
// but the session peak not, so the next tick added the same delta again.
// With a single file, a tick either fully lands or doesn't happen at all.
//
// Shape:
//   {
//     version: 2,
//     sessions: { <session_id>: { lastUsd, updatedAt } },
//     projects: { <slug>: { path, months: { "YYYY-MM": usd } } },
//     days: { "YYYY-MM-DD": usd },  // all projects, for today + sparkline
//     rateLimits: { five_hour, seven_day },  // last seen, see status.js
//     fiveHourSamples: { resetsAt, samples: [[ms, pct], ...] }
//   }
//
// Amounts are frozen in dollars at the moment they're observed. Nothing is
// ever repriced, so a future price change can't rewrite past months.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Lives inside Claude Code's config dir, so each account gets its own
// ledger: the documented way to run several accounts is one
// CLAUDE_CONFIG_DIR per account (e.g. `CLAUDE_CONFIG_DIR=~/.claude-work`),
// and Claude Code passes that variable down to the statusLine command.
const CONFIG_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DATA_ROOT = process.env.BURNLINE_DATA_DIR || path.join(CONFIG_HOME, 'burnline');
const LEDGER_FILE = path.join(DATA_ROOT, 'ledger.json');
const LOCK_FILE = path.join(DATA_ROOT, '.update.lock');
const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');

// A session's last-seen cost must outlive any realistic `--resume` gap: a
// resumed session restores its previous total_cost_usd, so forgetting it
// would re-add the whole history as a fresh delta. (The old layout pruned
// after ~2 months, which made that a real risk.)
const SESSION_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderIsDead() {
  let pid;
  try {
    pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

// Serializes the whole read-decide-write transaction across concurrent
// statusLine ticks (and the reset helper). See docs/ARCHITECTURE.md §2.
//
// Claude Code cancels an in-flight statusLine script whenever a newer
// update fires, so a holder getting killed mid-transaction is routine, not
// exotic. The lock records its holder's pid; a lock whose holder is gone is
// taken over at once instead of making the next tick wait out the timeout
// (and likely get cancelled itself while waiting).
function withLock(fn) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (holderIsDead() || Date.now() > deadline) {
        try { fs.unlinkSync(LOCK_FILE); } catch {}
        continue;
      }
      sleepMs(5);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

function monthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function dayKey(date) {
  return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

// Slugified on the full absolute path (not just basename) so two projects
// with the same folder name never collide.
//
// Claude Code worktrees live at <repo>/.claude/worktrees/<name>; their spend
// belongs to the repo they were cut from, not to a throwaway directory.
function projectRoot(dir) {
  return String(dir || '').replace(/\/\.claude\/worktrees\/[^/]+(\/.*)?$/, '') || dir;
}

function projectSlug(dir) {
  const clean = String(dir || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = path.basename(dir || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown';
  const hash = crypto.createHash('sha1').update(clean).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

// Micro-dollar precision only strips float noise (0.22999999999999998).
// Rounding to the cent here — as the old code did on every tick — silently
// dropped every delta under half a cent, forever.
function roundMicro(n) {
  return Math.round(n * 1e6) / 1e6;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// One-time import of the v1 layout (<YYYY-MM>/<slug>.json + state/
// sessions.json). The old files are left in place untouched.
function migrateV1() {
  const ledger = { version: 2, sessions: {}, projects: {}, days: {} };
  let entries = [];
  try {
    entries = fs.readdirSync(DATA_ROOT).filter((d) => /^\d{4}-\d{2}$/.test(d));
  } catch {}
  for (const month of entries) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(DATA_ROOT, month)).filter((f) => f.endsWith('.json'));
    } catch {}
    for (const f of files) {
      const data = readJson(path.join(DATA_ROOT, month, f), null);
      if (!data || typeof data.totalUsd !== 'number') continue;
      const slug = f.replace(/\.json$/, '');
      const project = ledger.projects[slug] || (ledger.projects[slug] = { path: null, months: {} });
      if (data.path) project.path = data.path;
      project.months[month] = roundMicro((project.months[month] || 0) + data.totalUsd);
    }
  }
  const oldSessions = readJson(path.join(DATA_ROOT, 'state', 'sessions.json'), {});
  for (const [id, entry] of Object.entries(oldSessions)) {
    if (entry && typeof entry.lastSeenUsd === 'number') {
      ledger.sessions[id] = { lastUsd: entry.lastSeenUsd, updatedAt: entry.updatedAt || new Date().toISOString() };
    }
  }
  return ledger;
}

// Must be called under withLock when the result will be written back.
function loadLedger() {
  const ledger = readJson(LEDGER_FILE, null);
  if (ledger && ledger.version === 2) {
    ledger.sessions = ledger.sessions || {};
    ledger.projects = ledger.projects || {};
    ledger.days = ledger.days || {};
    // Early v2 ledgers stored the session baseline as `peakUsd`.
    for (const entry of Object.values(ledger.sessions)) {
      if (entry.lastUsd === undefined && typeof entry.peakUsd === 'number') {
        entry.lastUsd = entry.peakUsd;
        delete entry.peakUsd;
      }
    }
    return ledger;
  }
  return migrateV1();
}

function saveLedger(ledger, now = new Date()) {
  const cutoff = now.getTime() - SESSION_RETENTION_MS;
  for (const [id, entry] of Object.entries(ledger.sessions)) {
    const t = Date.parse(entry.updatedAt);
    if (Number.isFinite(t) && t < cutoff) delete ledger.sessions[id];
  }
  writeJsonAtomic(LEDGER_FILE, ledger);
}

// Records a delta against both the project's month and the global day.
function addSpend(ledger, slug, projectPath, date, deltaUsd) {
  const project = ledger.projects[slug] || (ledger.projects[slug] = { path: projectPath, months: {} });
  project.path = projectPath;
  const month = monthKey(date);
  project.months[month] = roundMicro((project.months[month] || 0) + deltaUsd);
  const day = dayKey(date);
  ledger.days[day] = roundMicro((ledger.days[day] || 0) + deltaUsd);
}

// Oldest first, ending today.
function lastDays(ledger, date, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() - i);
    out.push(ledger.days[dayKey(d)] || 0);
  }
  return out;
}

// Keeps the last ~45 minutes of 5-hour-window readings so the run-out
// projection can use the recent rate, not just the average since the
// window opened (which reads low after a quiet start). Returns the recent
// rate in %/ms, or null without a reading 10–45 minutes old to compare to.
const SAMPLE_KEEP_MS = 45 * 60000;
const SAMPLE_MIN_SPAN_MS = 10 * 60000;

function recordFiveHourSample(ledger, window, now) {
  const pct = Number(window.used_percentage);
  const resetsAt = Number(window.resets_at);
  if (!Number.isFinite(pct) || !Number.isFinite(resetsAt)) return { rate: null, changed: false };
  const t = now.getTime();
  let state = ledger.fiveHourSamples;
  let changed = false;
  // A different resets_at means a new window; old readings don't apply.
  if (!state || Math.abs(state.resetsAt - resetsAt) > 60) {
    state = ledger.fiveHourSamples = { resetsAt, samples: [] };
    changed = true;
  }
  const kept = state.samples.filter(([ms]) => t - ms <= SAMPLE_KEEP_MS);
  if (kept.length !== state.samples.length) changed = true;
  const last = kept[kept.length - 1];
  if (!last || last[1] !== pct || t - last[0] >= 60000) {
    kept.push([t, pct]);
    changed = true;
  }
  state.samples = kept;

  const base = kept.find(([ms]) => t - ms >= SAMPLE_MIN_SPAN_MS);
  const rate = base ? Math.max(0, (pct - base[1]) / (t - base[0])) : null;
  return { rate, changed };
}

// User settings, e.g. { "monthlyBudgetUsd": 300 }. Missing or broken
// config just means defaults.
function loadConfig() {
  const c = readJson(CONFIG_FILE, {});
  return c && typeof c === 'object' ? c : {};
}

function saveConfig(config) {
  writeJsonAtomic(CONFIG_FILE, config);
}

function projectMonth(ledger, slug, month) {
  const p = ledger.projects[slug];
  return (p && p.months[month]) || 0;
}

function projectAllTime(ledger, slug) {
  const p = ledger.projects[slug];
  if (!p) return 0;
  return Object.values(p.months).reduce((a, b) => a + b, 0);
}

function totalMonth(ledger, month) {
  return Object.keys(ledger.projects).reduce((sum, slug) => sum + projectMonth(ledger, slug, month), 0);
}

function totalAllTime(ledger) {
  return Object.keys(ledger.projects).reduce((sum, slug) => sum + projectAllTime(ledger, slug), 0);
}

module.exports = {
  DATA_ROOT,
  LEDGER_FILE,
  CONFIG_FILE,
  withLock,
  monthKey,
  dayKey,
  projectRoot,
  projectSlug,
  roundMicro,
  loadLedger,
  saveLedger,
  addSpend,
  lastDays,
  recordFiveHourSample,
  loadConfig,
  saveConfig,
  projectMonth,
  projectAllTime,
  totalMonth,
  totalAllTime,
};
