#!/usr/bin/env node
// Burnline statusLine script.
//
// Claude Code hooks never receive cost data — only the statusLine command
// gets `cost.total_cost_usd` via stdin. So read, persist, and render all
// have to live in this one script; there is no separate observer to hand
// bookkeeping off to. See docs/ARCHITECTURE.md for the full reasoning
// behind every decision below.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = process.env.BURNLINE_DATA_DIR || path.join(os.homedir(), '.claude', 'burnline');
const STATE_FILE = path.join(DATA_ROOT, 'state', 'sessions.json');
const LOCK_FILE = path.join(DATA_ROOT, '.update.lock');

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// statusLine ticks fire frequently, and Claude Code can invoke overlapping
// ticks for the same session (e.g. rapid refreshes during heavy tool use).
// Without this, concurrent invocations race on the read-modify-write cycle
// across state/sessions.json and the per-project total file: session
// state is overwrite-only so it tends to self-correct, but the project
// total is an accumulation — any write lost to a race is gone forever,
// silently undercounting more the longer a session runs. So the whole
// read-decide-write transaction below is serialized behind a lockfile
// rather than left to race.
function withLock(fn) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.closeSync(fs.openSync(LOCK_FILE, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) {
        // The previous holder likely crashed without releasing the lock —
        // steal it rather than let every future statusLine tick hang.
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

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function monthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Slugified on the full absolute path (not just basename) so two projects
// with the same folder name (e.g. two different "api/" checkouts) never
// collide into the same spend file.
function projectSlug(dir) {
  const clean = String(dir || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = path.basename(dir || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown';
  const hash = crypto.createHash('sha1').update(clean).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write via a temp file + rename so a status line refresh that races with
// a crash (or another concurrent Claude Code window) can never leave a
// half-written, unparseable spend file behind.
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadSessionState() {
  return readJson(STATE_FILE, {});
}

// Session state only needs to remember the current and previous month —
// old entries are pruned on write so this file stays small forever without
// needing a separate cleanup job.
function saveSessionState(state, currentMonth, previousMonth) {
  const keep = {};
  for (const [id, entry] of Object.entries(state)) {
    if (entry.month === currentMonth || entry.month === previousMonth) {
      keep[id] = entry;
    }
  }
  writeJsonAtomic(STATE_FILE, keep);
}

function projectFilePath(month, slug) {
  return path.join(DATA_ROOT, month, `${slug}.json`);
}

// Round to the cent before persisting — repeated float addition (e.g.
// 0.18 + 0.05) otherwise leaves artifacts like 0.22999999999999998 sitting
// in the JSON files on disk, even though display already masks it with
// toFixed(2).
function roundToCent(n) {
  return Math.round(n * 100) / 100;
}

// `path` is the real cwd the slug was derived from — stored alongside the
// total so anything displaying tracked projects (status line, the
// burnline-status/burnline-reset commands) can show a human-readable
// location instead of just the opaque hashed slug. Written on every
// update so a project's path stays current even if the same slug somehow
// saw a slightly different (but slug-equivalent) cwd string.
function addToProjectTotal(month, slug, deltaUsd, cwd) {
  const file = projectFilePath(month, slug);
  const current = readJson(file, { totalUsd: 0 });
  const totalUsd = roundToCent((current.totalUsd || 0) + deltaUsd);
  writeJsonAtomic(file, { totalUsd, path: cwd, updatedAt: new Date().toISOString() });
  return totalUsd;
}

function monthTotal(month) {
  const dir = path.join(DATA_ROOT, month);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let sum = 0;
  for (const f of files) {
    const data = readJson(path.join(dir, f), { totalUsd: 0 });
    sum += data.totalUsd || 0;
  }
  return sum;
}

function money(n) {
  return `$${(n || 0).toFixed(2)}`;
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  const now = new Date();
  const currentMonth = monthKey(now);
  const previousMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  const sessionId = payload.session_id || 'unknown-session';
  const modelName = (payload.model && payload.model.display_name) || 'Claude';
  const cwd = (payload.workspace && (payload.workspace.current_dir || payload.workspace.project_dir)) || payload.cwd || 'unknown';
  const slug = projectSlug(cwd);

  const rawCost = payload.cost && payload.cost.total_cost_usd;
  const costIsValid = typeof rawCost === 'number' && Number.isFinite(rawCost);

  // rate_limits is only ever present for Pro/Max subscription plans (which
  // are rate-limited, not metered); its absence means pay-per-token API
  // billing. Same number either way, different label.
  const isSubscription = Object.prototype.hasOwnProperty.call(payload, 'rate_limits');
  const label = isSubscription ? 'equivalent' : 'actual';

  // Everything from reading prior state through writing the new totals is
  // one transaction — it has to run under the lock as a unit, or two
  // concurrent ticks can each read the same stale prevEntry and both
  // "correctly" compute a delta that, applied together, double-counts or
  // (via the project file's read-add-write) loses one of the two updates.
  const { sessionTotalUsd, projectMonthUsd, totalMonthUsd } = withLock(() => {
    const state = loadSessionState();
    const prevEntry = state[sessionId];

    // A missing/malformed cost field is a bad payload, not a genuine "$0"
    // reading — treating it as 0 would both misreport the session figure
    // and corrupt the tracked peak, causing the next *valid* tick to be
    // double-counted as a fresh delta. So on invalid input, fall back to
    // the last known value and skip touching persisted state entirely.
    const sessionTotalUsd = costIsValid ? rawCost : (prevEntry ? prevEntry.lastSeenUsd : 0);

    if (costIsValid) {
      // `lastSeenUsd` holds the highest total_cost_usd ever observed for
      // this session, not just the most recent tick's value. That makes
      // this order-independent: concurrent statusLine invocations for the
      // same session can be serialized by the lock in whatever order they
      // happen to acquire it — not necessarily the order Claude Code fired
      // them in — and peak-tracking still converges to the correct total
      // regardless of that order. A "most recent wins" scheme (the
      // previous design) breaks under exactly that reordering: an
      // out-of-order lower reading looks identical to a genuine /clear
      // reset and gets double-added. A same-session-id drop in
      // total_cost_usd — the thing that old design's reset branch was
      // for — is no longer something to build around: as of Claude Code
      // v2.1.211+, /clear starts a new session_id, so within one
      // session_id the value should only ever climb.
      const peakUsd = prevEntry ? prevEntry.lastSeenUsd : 0;
      const delta = sessionTotalUsd > peakUsd ? sessionTotalUsd - peakUsd : 0;

      if (delta > 0) {
        addToProjectTotal(currentMonth, slug, delta, cwd);
      }

      state[sessionId] = {
        lastSeenUsd: Math.max(sessionTotalUsd, peakUsd),
        month: currentMonth,
        slug,
        updatedAt: now.toISOString(),
      };
      saveSessionState(state, currentMonth, previousMonth);
    }

    const projectMonthUsd = readJson(projectFilePath(currentMonth, slug), { totalUsd: 0 }).totalUsd || 0;
    const totalMonthUsd = monthTotal(currentMonth);
    return { sessionTotalUsd, projectMonthUsd, totalMonthUsd };
  });

  process.stdout.write(
    `[${modelName}] session: ${money(sessionTotalUsd)} | project (month): ${money(projectMonthUsd)} | total (month): ${money(totalMonthUsd)} [${label}]`
  );
}

try {
  main();
} catch {
  // A statusLine failure must never break the UI it renders into — fall
  // back to something rather than crashing and leaving a blank line.
  process.stdout.write('[Burnline] unavailable');
}
