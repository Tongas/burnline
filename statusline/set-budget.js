#!/usr/bin/env node
// Sets (or clears) the monthly budget the status line's month bar fills
// towards. Without a budget, the bar compares against last month instead.
//
// Usage: node set-budget.js <usd>    e.g. 300
//        node set-budget.js off

'use strict';

const ledgerStore = require('./ledger');

const arg = String(process.argv[2] || '').trim().replace(/^\$/, '');
const config = ledgerStore.loadConfig();

if (!arg) {
  console.log(config.monthlyBudgetUsd ? `budget: $${config.monthlyBudgetUsd}/month` : 'budget: not set (month bar compares against last month)');
} else if (/^(off|none|clear|0)$/i.test(arg)) {
  delete config.monthlyBudgetUsd;
  ledgerStore.saveConfig(config);
  console.log('budget cleared (month bar now compares against last month)');
} else {
  const usd = Number(arg);
  if (!Number.isFinite(usd) || usd <= 0) {
    console.log(`invalid budget "${process.argv[2]}" — pass a dollar amount like 300, or "off"`);
    process.exit(1);
  }
  config.monthlyBudgetUsd = usd;
  ledgerStore.saveConfig(config);
  console.log(`budget set: $${usd}/month`);
}
