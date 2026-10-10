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
const ledgerStore = require('./ledger');
const { render } = require('./render');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
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
  const currentMonth = ledgerStore.monthKey(now);
  const previousMonth = ledgerStore.monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  const sessionId = payload.session_id || 'unknown-session';
  const modelName = (payload.model && payload.model.display_name) || 'Claude';
  // project_dir is where Claude Code was launched and stays fixed for the
  // session; current_dir follows every `cd` Claude makes. Keying on
  // current_dir (as the old code did) split one project's spend across
  // every subfolder the session wandered into, so "project" read lower
  // than "session".
  const ws = payload.workspace || {};
  const cwd = ledgerStore.projectRoot(ws.project_dir || ws.current_dir || payload.cwd || 'unknown');
  const slug = ledgerStore.projectSlug(cwd);

  const rawCost = payload.cost && payload.cost.total_cost_usd;
  const costIsValid = typeof rawCost === 'number' && Number.isFinite(rawCost);

  // rate_limits is only ever present for Pro/Max subscription plans (which
  // are rate-limited, not metered); its absence means pay-per-token API
  // billing. Same number either way, different label.
  const isSubscription = Object.prototype.hasOwnProperty.call(payload, 'rate_limits');
  const label = isSubscription ? 'equivalent' : 'actual';

  // Everything from reading the ledger through writing it back is one
  // transaction under the lock, and it ends in a single atomic write — so
  // overlapping or killed ticks can neither lose nor double-count a delta.
  const figures = ledgerStore.withLock(() => {
    const ledger = ledgerStore.loadLedger();
    const prevEntry = ledger.sessions[sessionId];

    // A missing/malformed cost field is a bad payload, not a genuine "$0"
    // reading — fall back to the last known value and leave the ledger
    // untouched.
    const sessionTotalUsd = costIsValid ? rawCost : (prevEntry ? prevEntry.lastUsd : 0);

    if (costIsValid) {
      // Last-seen tracking: add whatever the session climbed since the
      // previous tick. A drop just moves the baseline down, so spend after
      // the drop is still counted. Peak-tracking (the earlier design) lost
      // everything until the old peak was exceeded again — real data showed
      // a session where Claude Code's own saved cost disagreed with the
      // statusLine peak by $218. Out-of-order ticks, the reason peak-
      // tracking existed, are now rare: Claude Code cancels an in-flight
      // statusLine script before starting the next. See ARCHITECTURE.md §2.
      const lastUsd = prevEntry ? prevEntry.lastUsd : 0;
      const delta = sessionTotalUsd > lastUsd ? sessionTotalUsd - lastUsd : 0;

      if (delta > 0) {
        ledgerStore.addSpend(ledger, slug, cwd, now, delta);
      }

      ledger.sessions[sessionId] = {
        lastUsd: sessionTotalUsd,
        updatedAt: now.toISOString(),
      };
      ledgerStore.saveLedger(ledger, now);
    }

    const last7Usd = ledgerStore.lastDays(ledger, now, 7);
    return {
      sessionUsd: sessionTotalUsd,
      projectMonthUsd: ledgerStore.projectMonth(ledger, slug, currentMonth),
      projectAllUsd: ledgerStore.projectAllTime(ledger, slug),
      totalMonthUsd: ledgerStore.totalMonth(ledger, currentMonth),
      totalAllUsd: ledgerStore.totalAllTime(ledger),
      todayUsd: last7Usd[last7Usd.length - 1],
      last7Usd,
      previousMonthUsd: ledgerStore.totalMonth(ledger, previousMonth),
    };
  });

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const budget = Number(ledgerStore.loadConfig().monthlyBudgetUsd);
  const rl = payload.rate_limits || {};
  const cache = payload.prompt_cache || null;

  process.stdout.write(
    render({
      ...figures,
      modelName,
      label,
      previousMonth,
      budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
      monthFraction: (now.getTime() - monthStart) / (monthEnd - monthStart),
      now,
      fiveHour: rl.five_hour || null,
      sevenDay: rl.seven_day || null,
      cacheHitRatio: cache && typeof cache.hit_ratio === 'number' ? cache.hit_ratio : null,
      cacheWarm: cache ? cache.warm === true : null,
    })
  );
}

try {
  main();
} catch {
  // A statusLine failure must never break the UI it renders into — fall
  // back to something rather than crashing and leaving a blank line.
  process.stdout.write('[Burnline] unavailable');
}
