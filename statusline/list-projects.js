#!/usr/bin/env node
// Shared read-only helper for burnline-status and burnline-reset: lists
// every tracked project (slug, this month's spend, all-time spend, path)
// from the same ledger status.js writes, optionally filtered by a
// case-insensitive substring on the slug or path.
//
// Usage: node list-projects.js [filter]

'use strict';

const path = require('path');
const ledgerStore = require('./ledger');

const filter = (process.argv[2] || '').toLowerCase();
const month = ledgerStore.monthKey(new Date());
// Read-only: loadLedger() also understands the old v1 layout, so this
// works before the first statusLine tick has migrated anything.
const ledger = ledgerStore.loadLedger();

console.log(`month: ${month}`);
console.log(`ledger: ${ledgerStore.LEDGER_FILE}`);
console.log(`reset script: ${path.join(__dirname, 'reset-month.js')}`);

const money = (n) => Math.round(n * 100) / 100;

const rows = Object.keys(ledger.projects)
  .map((slug) => ({
    slug,
    monthUsd: ledgerStore.projectMonth(ledger, slug, month),
    allUsd: ledgerStore.projectAllTime(ledger, slug),
    path: ledger.projects[slug].path,
  }))
  .filter((r) => !filter || r.slug.toLowerCase().includes(filter) || String(r.path || '').toLowerCase().includes(filter))
  .sort((a, b) => b.allUsd - a.allUsd);

if (rows.length === 0) {
  console.log(filter ? `(no tracked project matches "${filter}")` : '(no tracked projects yet)');
  process.exit(0);
}

console.log('');
console.log('slug | month USD | all-time USD | path');
let monthSum = 0;
let allSum = 0;
for (const r of rows) {
  monthSum += r.monthUsd;
  allSum += r.allUsd;
  console.log(`${r.slug} | ${money(r.monthUsd)} | ${money(r.allUsd)} | ${r.path || '(unknown — predates path tracking)'}`);
}
console.log(`TOTAL | ${money(monthSum)} | ${money(allSum)}`);
