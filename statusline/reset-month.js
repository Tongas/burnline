#!/usr/bin/env node
// Zeroes the CURRENT month's spend for every project, or only for projects
// whose slug/path contains the filter. Past months — and therefore the
// all-time history before this month — are never touched. Session peaks
// are kept, so live sessions simply count from zero going forward.
//
// Usage: node reset-month.js [filter]
//
// Destructive: burnline-reset only runs this after explicit confirmation.

'use strict';

const ledgerStore = require('./ledger');

const filter = (process.argv[2] || '').toLowerCase();
const month = ledgerStore.monthKey(new Date());

const result = ledgerStore.withLock(() => {
  const ledger = ledgerStore.loadLedger();
  const cleared = [];
  for (const [slug, project] of Object.entries(ledger.projects)) {
    const matches = !filter || slug.toLowerCase().includes(filter) || String(project.path || '').toLowerCase().includes(filter);
    if (matches && project.months[month]) {
      cleared.push({ slug, usd: project.months[month] });
      delete project.months[month];
    }
  }
  if (cleared.length > 0) ledgerStore.saveLedger(ledger);
  return cleared;
});

console.log(`month: ${month}`);
if (result.length === 0) {
  console.log('(nothing to reset)');
} else {
  let sum = 0;
  for (const r of result) {
    sum += r.usd;
    console.log(`reset ${r.slug} | ${Math.round(r.usd * 100) / 100}`);
  }
  console.log(`TOTAL WIPED | ${Math.round(sum * 100) / 100}`);
}
