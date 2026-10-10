// Turns the figures status.js computed into the two status lines. Kept
// apart from status.js so the formatting can be tested without a ledger.
//
// Line 1 — where the money is: session, project (month / all), total
//          (month / all), billing label.
// Line 2 — how fast it's going: today + 7-day sparkline, a month bar
//          against the budget (or last month when no budget is set), and
//          the end-of-month projection.
// Line 3 — limits (Pro/Max only, or when Claude Code reports a prompt
//          cache): the 5-hour window bar with its reset time and whether
//          the current pace runs out before it, the 7-day window, and the
//          prompt cache hit ratio / warmth.
//
// Colors follow NO_COLOR (https://no-color.org): set it to get plain text.

'use strict';

const useColor = !process.env.NO_COLOR;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(text, ...styles) {
  if (!useColor) return text;
  return styles.map((s) => C[s]).join('') + text + C.reset;
}

function money(n) {
  const v = n || 0;
  // Cents stop being useful once the number is in the thousands.
  const digits = v >= 1000 ? 0 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Same thresholds everywhere a ratio gets a color: comfortable, watch it,
// over.
function levelColor(ratio) {
  if (ratio >= 0.9) return 'red';
  if (ratio >= 0.7) return 'yellow';
  return 'green';
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// Fixed-width bar with eighth-block resolution so small changes still move
// it. Anything past 100% renders full.
function bar(ratio, width = 12) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const part = EIGHTHS[eighths % 8];
  const filled = '█'.repeat(full) + part;
  const empty = '░'.repeat(width - full - (part ? 1 : 0));
  return paint(filled, levelColor(ratio)) + paint(empty, 'dim');
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values) {
  const max = Math.max(...values);
  return values
    .map((v, i) => {
      if (!(max > 0) || !(v > 0)) return paint('▁', 'dim');
      const ch = SPARKS[Math.min(SPARKS.length - 1, Math.floor((v / max) * (SPARKS.length - 1) + 0.5))];
      // Today (last) stands out from the rest of the week.
      return paint(ch, i === values.length - 1 ? 'yellow' : 'cyan');
    })
    .join('');
}

const SEP = () => paint(' │ ', 'dim');

function clock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function duration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

const FIVE_HOURS_MS = 5 * 3600 * 1000;

// The 5-hour window opens with the first message and closes at resets_at,
// so its start is resets_at - 5h and the average burn rate so far is
// used% / elapsed. That's enough to say whether the window runs dry before
// it resets — no history needed.
function fiveHourSegment(w, now) {
  const pct = Number(w.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const ratio = pct / 100;
  let text = paint('5h ', 'dim') + bar(ratio, 10) + ' ' + paint(`${Math.round(pct)}%`, 'bold', levelColor(ratio));
  const resetsMs = Number(w.resets_at) * 1000;
  if (Number.isFinite(resetsMs) && resetsMs > now.getTime()) {
    text += paint(` resets ${clock(new Date(resetsMs))} (${duration(resetsMs - now.getTime())})`, 'dim');
    const elapsed = now.getTime() - (resetsMs - FIVE_HOURS_MS);
    // Too early in the window, the rate is mostly noise.
    if (pct > 0 && elapsed >= 15 * 60000) {
      const msToFull = ((100 - pct) / pct) * elapsed;
      if (now.getTime() + msToFull < resetsMs) {
        text += ' ' + paint(`⚠ full ~${clock(new Date(now.getTime() + msToFull))}`, 'bold', 'red');
      } else {
        const atReset = Math.min(100, pct * (FIVE_HOURS_MS / elapsed));
        text += ' ' + paint(`→ ~${Math.round(atReset)}% at reset`, levelColor(atReset / 100));
      }
    }
  }
  return text;
}

function sevenDaySegment(w, now) {
  const pct = Number(w.used_percentage);
  if (!Number.isFinite(pct)) return null;
  let text = paint('7d ', 'dim') + bar(pct / 100, 6) + ' ' + paint(`${Math.round(pct)}%`, levelColor(pct / 100));
  const resetsMs = Number(w.resets_at) * 1000;
  if (Number.isFinite(resetsMs) && resetsMs > now.getTime()) {
    text += paint(` (${duration(resetsMs - now.getTime())})`, 'dim');
  }
  return text;
}

// A cold cache means the next message re-pays for the whole context, so
// warmth is worth a glance before stepping away for a while.
function cacheSegment(hitRatio, warm) {
  const pct = Math.round(hitRatio * 100);
  const color = hitRatio >= 0.8 ? 'green' : hitRatio >= 0.5 ? 'yellow' : 'red';
  const state = warm ? paint('● warm', 'green') : paint('○ cold', 'dim');
  return paint('cache ', 'dim') + paint(`${pct}%`, color) + ' ' + state;
}

// f: { modelName, label, sessionUsd, projectMonthUsd, projectAllUsd,
//      totalMonthUsd, totalAllUsd, todayUsd, last7Usd[], previousMonthUsd,
//      budgetUsd, monthFraction, now, fiveHour, sevenDay, cacheHitRatio,
//      cacheWarm }
function render(f) {
  const line1 =
    paint(`◆ ${f.modelName}`, 'bold', 'cyan') +
    SEP() +
    paint('session ', 'dim') + paint(money(f.sessionUsd), 'bold', 'yellow') +
    SEP() +
    paint('project ', 'dim') + paint(money(f.projectMonthUsd), 'magenta') + paint(' mo · ', 'dim') + paint(money(f.projectAllUsd), 'magenta') + paint(' all', 'dim') +
    SEP() +
    paint('total ', 'dim') + paint(money(f.totalMonthUsd), 'blue') + paint(' mo · ', 'dim') + paint(money(f.totalAllUsd), 'blue') + paint(' all', 'dim') +
    '  ' + paint(f.label, 'dim');

  const parts = [paint('today ', 'dim') + paint(money(f.todayUsd), 'yellow') + ' ' + sparkline(f.last7Usd) + paint(' 7d', 'dim')];

  // The bar needs something to fill towards: the budget if one is set,
  // otherwise last month's total. With neither, there's nothing honest to
  // draw, so it's left out.
  const reference = f.budgetUsd > 0 ? f.budgetUsd : f.previousMonthUsd;
  if (reference > 0) {
    const ratio = f.totalMonthUsd / reference;
    const what = f.budgetUsd > 0 ? `of ${money(f.budgetUsd).replace(/\.00$/, '')} budget` : `of last month's ${money(f.previousMonthUsd)}`;
    parts.push(paint('month ', 'dim') + bar(ratio) + ' ' + paint(`${Math.round(ratio * 100)}%`, 'bold', levelColor(ratio)) + paint(` ${what}`, 'dim'));
  }

  // A projection off the first day or so is just noise.
  if (f.monthFraction >= 0.05 && f.totalMonthUsd > 0) {
    const pace = f.totalMonthUsd / f.monthFraction;
    const paceColor = reference > 0 ? levelColor(pace / reference) : 'cyan';
    parts.push(paint('pace ', 'dim') + paint(`~${money(pace)}/mo`, paceColor));
  }

  const lines = [line1, parts.join(SEP())];

  const limits = [];
  const now = f.now || new Date();
  if (f.fiveHour) limits.push(fiveHourSegment(f.fiveHour, now));
  if (f.sevenDay) limits.push(sevenDaySegment(f.sevenDay, now));
  if (f.cacheHitRatio !== null && f.cacheHitRatio !== undefined) limits.push(cacheSegment(f.cacheHitRatio, f.cacheWarm));
  const shown = limits.filter(Boolean);
  if (shown.length > 0) lines.push(shown.join(SEP()));

  return lines.join('\n');
}

module.exports = { render, money, bar, sparkline };
