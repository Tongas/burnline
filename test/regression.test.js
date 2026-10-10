#!/usr/bin/env node
// Regression tests for the bugs that made "project" read lower than
// "session" and lost history across months. Pure node:assert, runs each
// tick as a real subprocess against a throwaway BURNLINE_DATA_DIR.
//
// Usage: node test/regression.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATUS_JS = path.join(__dirname, '..', 'statusline', 'status.js');
const RESET_JS = path.join(__dirname, '..', 'statusline', 'reset-month.js');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'burnline-test-'));
}

function tick(dataDir, { session = 's1', cost, projectDir = '/p/app', currentDir = projectDir, extra = {}, env = {} }) {
  const payload = {
    session_id: session,
    model: { display_name: 'Test' },
    workspace: { project_dir: projectDir, current_dir: currentDir },
    cost: { total_cost_usd: cost },
    ...extra,
  };
  return execFileSync('node', [STATUS_JS], {
    input: JSON.stringify(payload),
    env: { ...process.env, BURNLINE_DATA_DIR: dataDir, NO_COLOR: '1', ...env },
  }).toString();
}

function ledger(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8'));
}

function onlyProject(dataDir) {
  const projects = Object.values(ledger(dataDir).projects);
  assert.strictEqual(projects.length, 1, `expected 1 project, got ${projects.length}`);
  return projects[0];
}

const month = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

const tests = {
  'cd into a subfolder stays in the launch project'() {
    const dir = freshDir();
    tick(dir, { cost: 1.0 });
    tick(dir, { cost: 2.0, currentDir: '/p/app/backend' });
    tick(dir, { cost: 3.0, currentDir: '/p/app/frontend/src' });
    const p = onlyProject(dir);
    assert.strictEqual(p.path, '/p/app');
    assert.strictEqual(p.months[month], 3.0);
  },

  'sub-cent deltas are not lost to rounding'() {
    const dir = freshDir();
    let cost = 1.0;
    tick(dir, { cost });
    for (let i = 0; i < 100; i++) {
      cost += 0.004;
      tick(dir, { cost });
    }
    assert.ok(Math.abs(onlyProject(dir).months[month] - 1.4) < 1e-6, `got ${onlyProject(dir).months[month]}`);
  },

  'a session spanning months never shows more than the all-time total'() {
    const dir = freshDir();
    // Simulate last month: session already had $50, recorded in the past month.
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({
      version: 2,
      sessions: { s1: { lastUsd: 50, updatedAt: new Date().toISOString() } },
      projects: { 'app-x': { path: '/p/app', months: { '2000-01': 50 } } },
    }));
    const out = tick(dir, { cost: 60 });
    assert.match(out, /session \$60\.00/);
    assert.match(out, /total \$10\.00 mo · \$60\.00 all/);
  },

  'a session resumed many months later is not re-added'() {
    const dir = freshDir();
    const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({
      version: 2,
      sessions: { s1: { peakUsd: 80, updatedAt: old } }, // early-v2 field name
      projects: {},
    }));
    tick(dir, { cost: 85 });
    assert.strictEqual(onlyProject(dir).months[month], 5);
  },

  'v1 layout is migrated, history and peaks preserved'() {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '2000-01'));
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, '2000-01', 'old-1234.json'), JSON.stringify({ totalUsd: 12.5, path: '/p/old' }));
    fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), JSON.stringify({ s9: { lastSeenUsd: 12.5, month: '2000-01' } }));
    const out = tick(dir, { session: 's9', cost: 13.5, projectDir: '/p/old2' });
    const l = ledger(dir);
    assert.strictEqual(l.projects['old-1234'].months['2000-01'], 12.5);
    assert.strictEqual(l.sessions.s9.lastUsd, 13.5);
    assert.match(out, /total \$1\.00 mo · \$13\.50 all/);
  },

  'reset wipes only the current month'() {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({
      version: 2,
      sessions: {},
      projects: { 'app-x': { path: '/p/app', months: { '2000-01': 7, [month]: 3 } } },
    }));
    execFileSync('node', [RESET_JS], { env: { ...process.env, BURNLINE_DATA_DIR: dir } });
    assert.deepStrictEqual(ledger(dir).projects['app-x'].months, { '2000-01': 7 });
  },

  'spend is tracked per day and shown as today'() {
    const dir = freshDir();
    tick(dir, { cost: 1 });
    const out = tick(dir, { cost: 3.5 });
    const today = Object.values(ledger(dir).days);
    assert.deepStrictEqual(today, [3.5]);
    assert.match(out, /today \$3\.50/);
  },

  'month bar uses the budget when set, else last month'() {
    const dir = freshDir();
    const d = new Date();
    const prev = `${new Date(d.getFullYear(), d.getMonth() - 1, 1).getFullYear()}-${String(new Date(d.getFullYear(), d.getMonth() - 1, 1).getMonth() + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({
      version: 2, sessions: {}, days: {},
      projects: { 'app-x': { path: '/p/app', months: { [prev]: 40 } } },
    }));
    assert.match(tick(dir, { cost: 10 }), /month \S+ 25% of last month's \$40\.00/);
    execFileSync('node', [path.join(__dirname, '..', 'statusline', 'set-budget.js'), '100'], { env: { ...process.env, BURNLINE_DATA_DIR: dir } });
    assert.match(tick(dir, { cost: 10 }), /month \S+ 10% of \$100 budget/);
  },

  'a cost drop within a session re-baselines instead of swallowing later spend'() {
    const dir = freshDir();
    tick(dir, { cost: 300 });
    tick(dir, { cost: 0.5 }); // e.g. the process restarted and the counter reset
    tick(dir, { cost: 116 });
    assert.strictEqual(onlyProject(dir).months[month], 415.5);
  },

  'worktree sessions count towards the parent repo'() {
    const dir = freshDir();
    tick(dir, { cost: 1 });
    tick(dir, { session: 's2', cost: 2, projectDir: '/p/app/.claude/worktrees/feature-x' });
    tick(dir, { session: 's3', cost: 4, projectDir: '/p/app/.claude/worktrees/agent-123/frontend' });
    const p = onlyProject(dir);
    assert.strictEqual(p.path, '/p/app');
    assert.strictEqual(p.months[month], 7);
  },

  'each CLAUDE_CONFIG_DIR (account) gets its own ledger'() {
    const a = freshDir();
    const b = freshDir();
    const run = (configDir, cost) => execFileSync('node', [STATUS_JS], {
      input: JSON.stringify({ session_id: 'x' + configDir, workspace: { project_dir: '/p/app' }, cost: { total_cost_usd: cost } }),
      env: { ...process.env, BURNLINE_DATA_DIR: '', CLAUDE_CONFIG_DIR: configDir, NO_COLOR: '1' },
    }).toString();
    run(a, 5);
    assert.match(run(b, 2), /total \$2\.00 mo/);
    assert.ok(fs.existsSync(path.join(a, 'burnline', 'ledger.json')));
    assert.ok(fs.existsSync(path.join(b, 'burnline', 'ledger.json')));
  },

  'a stale lock left by a cancelled tick is taken over immediately'() {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.update.lock'), '999999999');
    const t0 = Date.now();
    tick(dir, { cost: 1 });
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    assert.strictEqual(onlyProject(dir).months[month], 1);
  },

  '5-hour window shows reset time and warns when it will run out'() {
    const dir = freshDir();
    const now = Math.floor(Date.now() / 1000);
    // 2h into the window at 60% → full in ~1h20m, before the reset in 3h.
    const hot = tick(dir, { cost: 1, extra: { rate_limits: { five_hour: { used_percentage: 60, resets_at: now + 3 * 3600 } } } });
    assert.match(hot, /5h \S+ 60% resets \d\d:\d\d \(3h00m\) ⚠ full ~\d\d:\d\d/);
    // 4h in at 40% → ~50% by reset, no warning.
    const calm = tick(dir, { cost: 1, extra: { rate_limits: { five_hour: { used_percentage: 40, resets_at: now + 3600 } } } });
    assert.match(calm, /→ ~50% at reset/);
    assert.doesNotMatch(calm, /full/);
  },

  'limits seen earlier show from the first tick of a new session'() {
    const dir = freshDir();
    const now = Math.floor(Date.now() / 1000);
    tick(dir, { cost: 1, extra: { rate_limits: { five_hour: { used_percentage: 30, resets_at: now + 3600 } } } });
    const fresh = tick(dir, { session: 's2', cost: 0 }); // no rate_limits yet
    assert.match(fresh, /5h \S+ 30% resets/);
    assert.match(fresh, /equivalent/);
    // An expired window is not shown.
    const l = ledger(dir);
    l.rateLimits.five_hour.resets_at = now - 10;
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(l));
    const later = tick(dir, { session: 's3', cost: 0 });
    assert.doesNotMatch(later, /5h/);
    assert.match(later, /actual/);
  },

  'prompt cache hit ratio and warmth are shown when reported'() {
    const dir = freshDir();
    const out = tick(dir, { cost: 1, extra: { prompt_cache: { hit_ratio: 0.93, warm: true } } });
    assert.match(out, /cache 93% ● warm/);
  },

  'invalid cost payload leaves the ledger untouched'() {
    const dir = freshDir();
    tick(dir, { cost: 2 });
    const before = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
    tick(dir, { cost: undefined });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'), before);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
