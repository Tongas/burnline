#!/usr/bin/env node
// Shared read-only helper for burnline-status and burnline-reset: lists
// the current month's tracked projects (slug, totalUsd, path) from the
// exact same data status.js writes, optionally filtered by a
// case-insensitive substring on the slug. Kept as one script so both
// commands read the same `path` field the same way instead of each
// re-implementing the lookup.
//
// Usage: node list-projects.js [filter]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = process.env.BURNLINE_DATA_DIR || path.join(os.homedir(), '.claude', 'burnline');
const filter = (process.argv[2] || '').toLowerCase();

const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const dir = path.join(DATA_ROOT, month);

console.log(`month: ${month}`);
console.log(`dir: ${dir}`);

let files;
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
} catch {
  console.log('(no data directory for this month yet)');
  process.exit(0);
}

const rows = files
  .map((f) => {
    const slug = f.replace(/\.json$/, '');
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      data = {};
    }
    return { slug, totalUsd: data.totalUsd, path: data.path };
  })
  .filter((r) => !filter || r.slug.toLowerCase().includes(filter))
  .sort((a, b) => a.slug.localeCompare(b.slug));

if (rows.length === 0) {
  console.log(filter ? `(no tracked project matches "${filter}")` : '(no tracked projects this month)');
  process.exit(0);
}

console.log('');
console.log('slug | totalUsd | path');
let sum = 0;
for (const r of rows) {
  const totalUsd = typeof r.totalUsd === 'number' ? r.totalUsd : 0;
  sum += totalUsd;
  console.log(`${r.slug} | ${totalUsd} | ${r.path || '(unknown — predates path tracking)'}`);
}
console.log(`TOTAL | ${Math.round(sum * 100) / 100}`);
