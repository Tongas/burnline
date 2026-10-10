<p align="center">
  <img src="./docs/banner.jpeg" alt="Burnline — real-time spend tracking in your Claude Code status line" width="100%">
</p>

# Burnline

🇪🇸 [Leer en español](README.es.md)

**Real spend, right in your status line.**

Burnline is a [Claude Code](https://claude.com/claude-code) plugin that
shows your spend directly in the status line: how much this session has
cost, how much this project has cost this month and since you started
tracking, and how much you've spent in total this month and all-time —
all computed from Claude Code's own `cost.total_cost_usd` field, with zero
external pricing recalculation.

```
◆ Sonnet 5 │ session $4.20 │ project $61.30 mo · $1,152 all │ total $240.00 mo · $2,942 all  actual
today $18.40 ▅▇▂▁█▆▄ 7d │ month █████████▋░░ 80% of $300 budget │ pace ~$774.19/mo
5h ████▊░░░░░ 47% resets 14:43 (2h10m) → ~83% at reset │ 7d █▍░░░░ 22% (3d11h) │ cache 94% ● warm
```

## The problem

Claude Code shows you a running cost for the *current session*, but nothing
that survives a `/clear`, nothing per-project, and nothing that answers
"how much have I actually spent this month?" — the question that actually
matters when you're paying an API bill or deciding whether a subscription
plan is worth it. Burnline answers that question, live, without you having
to run a separate command or open a dashboard.

## Why it doesn't reuse ccusage (or reprice anything)

Tools like [ccusage](https://github.com/ryoppippi/ccusage) recompute cost
from raw token counts against a maintained table of per-model pricing.
That's the right approach for deep historical analytics, but it's also a
moving target: pricing changes, new models ship, and a stale table
produces confidently wrong numbers with no visible warning sign.

Burnline takes the opposite bet: it never reprices anything. Every figure
it shows is built from `cost.total_cost_usd`, the number Claude Code itself
computes from the actual request accounting it already has. There's no
pricing table to keep in sync and no way for it to drift out of date — the
number is exactly as correct as Claude Code's own cost tracking, always.
The tradeoff is that Burnline can only ever show what Claude Code chooses
to expose, but for "what am I spending," that's the number that matters.

## How this differs from ccburn

[ccburn](https://github.com/JuanjoFuchs/ccburn) is a great tool, but it
tracks something else entirely: **rate-limit burn-up** — how much of your
Pro/Max 5-hour or 7-day rate-limit window you've used. That's useful for
pacing yourself against a limit. Burnline tracks **dollars**, broken down
by project and by month. Different metric, different question, no overlap
— run both if you want the full picture.

## How it works, in short

- Claude Code hooks never receive cost data — only the `statusLine`
  command does, via stdin, on every refresh. So Burnline is a single
  script (`statusline/status.js`), not a hook.
- `cost.total_cost_usd` is cumulative per session. Burnline remembers the
  last value it saw per session and adds only the positive difference
  each tick. If the value ever drops, that becomes the new baseline, so
  later spend is never swallowed.
- Spend is persisted locally in a single ledger, per project and per
  calendar month, and the full history is kept — so a new month never
  erases the past, and "all-time" figures are always available.
- Amounts are frozen in dollars at the moment they're spent. If prices
  change later, past months are never recalculated: all-time is simply
  past spend at the prices of the time plus new spend at the new prices.
- A project is the directory you launched Claude Code in
  (`workspace.project_dir`); a `cd` into a subfolder during the session
  still counts toward that same project, and so does a Claude Code
  worktree (`<repo>/.claude/worktrees/<name>`).
- Each Claude account is tracked separately: data lives under
  `$CLAUDE_CONFIG_DIR/burnline/` (default `~/.claude/burnline/`), and one
  config dir per account is the documented way to run several accounts.
  Accounts switched with `/login` inside the same config dir are combined.
- Subscription (Pro/Max) vs. pay-per-token API billing is auto-detected
  from whether the status line payload includes `rate_limits` — no config
  needed. Same number either way; the label changes to say whether it's
  actual spend or an estimated API-equivalent.

Full design rationale, including why each of these choices was made, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reading the status line

Line 1 is where the money is: this session, this project (this month and
all-time), and everything (this month and all-time). The label at the end
is `equivalent` on Pro/Max (what the same usage would cost on the API;
you're not billed it) or `actual` on pay-per-token API billing.

Line 2 is how fast it's going, in color:

- **today** — spend across all projects today, plus a 7-day sparkline
  (today highlighted). Daily tracking starts the day you upgrade, so the
  sparkline fills up over the first week.
- **month** — a bar for this month's total that turns green → yellow →
  red at 70% / 90%. It fills towards your monthly budget if you set one
  (`80% of $300 budget`), otherwise towards last month's total
  (`8% of last month's $2,743`: this month's spend so far is 8% of what
  you spent in all of last month).
- **pace** — projected end-of-month total at the current rate, colored
  against the same budget/last-month reference (shown after the first
  ~1.5 days of the month).

Line 3 shows your limits, when Claude Code reports them (Pro/Max):

- **5h** — the 5-hour window: a bar, when it resets (clock time and
  countdown), and whether you'll run out first at the current pace
  (`⚠ full ~16:40`) or where you'll land (`→ ~83% at reset`).
- **7d** — the weekly window and time until it resets.
- The 5h/7d windows are remembered between sessions, so they show as
  soon as a session starts, before its first message.
- **cache** — the session's prompt cache hit ratio, and whether it's
  still warm. A cold cache makes the next message re-pay for the whole
  context.

Set `NO_COLOR=1` in the statusLine command's environment for plain text.

### How `pace` and `full` are calculated

Both are straight-line projections: they assume you keep going at the
average rate you've had so far.

**`pace`** = spend so far this month ÷ fraction of the month elapsed.

> On Oct 10 in the evening (~34% of October gone) with $205 spent:
> $205 ÷ 0.34 ≈ **`pace ~$650/mo`**. Against a $300 budget that's red;
> against last month's $2,743 it's green (~24%).

**`full`** uses the 5-hour window. The window ends at `resets_at`, so it
started 5 hours before that; your rate is `used% ÷ time elapsed`.

> It's 14:00, the window resets at 17:00 (so it opened at 12:00), and
> you've used 60%: that's 30%/hour. The remaining 40% lasts ~80 minutes,
> so you'd hit 100% at 15:20 — before the reset, hence
> **`⚠ full ~15:20`** in red. With 40% used at 16:00 instead, the rate is
> 10%/hour and you'd end near 50%: **`→ ~50% at reset`**.

Limitations:

- Both use the average since the start (of the month, or of the 5-hour
  window), not your last few minutes. An idle stretch makes them read
  low; a burst after a quiet start makes them read high.
- `pace` is hidden for the first ~1.5 days of a month and the 5-hour
  projection for the first 15 minutes of a window: with that little data
  the numbers swing wildly.
- The 7-day window shows usage and time to reset, with no projection.

## Setting a monthly budget

`/burnline:burnline-budget 300` sets a $300/month budget for the month
bar; `/burnline:burnline-budget off` clears it, and with no argument it
shows the current one. It's stored in `~/.claude/burnline/config.json`
(`{"monthlyBudgetUsd": 300}`), or under `$CLAUDE_CONFIG_DIR/burnline/`
for an account with its own config dir — each account has its own budget.

## Checking tracked spend

`/burnline:burnline-status` lists every project Burnline has tracked for
the current calendar month and all-time — slug, month spend, all-time
spend, and the project's real path (when known; data written before path
tracking was added shows as unknown) — plus the totals at the bottom. It's read-only: no
confirmation prompt, nothing is ever deleted or modified.

## Resetting tracked spend

Burnline ships a slash command, `/burnline:burnline-reset` (shown to
Claude Code as `/burnline-reset`), for starting the count over.

- With no argument, it targets **every** project for the **current
  calendar month only** — a full "start fresh from zero this month."
- With an argument (a project slug or partial name, e.g. `ads`), it targets
  only the matching project(s) for the current month, leaving everything
  else untouched.
- It never touches any month other than the current one — this is a
  "reset going forward," not a way to erase historical data.
- Before changing anything, it lists exactly which project(s) would be
  affected and their current month spend, and waits for you to explicitly
  confirm in a follow-up message. It will not change anything in the same
  turn it shows you the plan.

## Install

```
/plugin marketplace add Tongas/burnline
/plugin install burnline@burnline
```

The marketplace name shown by `/plugin marketplace list` after adding it
is the authoritative one to use — if it differs from `burnline`
on your machine, use that instead.

Restart Claude Code (or start a new session) and the status line will pick
up Burnline's format automatically.

## Data and privacy

Burnline is entirely local. It makes no network calls, sends no telemetry,
and depends on no external process — it's a single Node.js script using
only core modules (`fs`, `path`, `os`, `crypto`). Accumulated spend is
written to `~/.claude/burnline/ledger.json` on your own machine and
nowhere else. Delete that folder at any time to reset. (Older versions
wrote `<YYYY-MM>/<project-slug>.json` files; they're imported into the
ledger automatically on first run and then left untouched.)

## Requirements

- Claude Code with statusLine support.
- Node.js available on your `PATH` (no npm install, no dependencies).

## Known behavior

Each Claude Code session's status line refreshes independently. If you
reset spend (or anything else changes on disk) from one session, other
open sessions won't reflect it until their own next statusLine tick. This
isn't a bug — there's no shared process to push updates between sessions,
each one just reads the ledger on disk whenever it next refreshes.

A session that started last month keeps showing its full cost in
`session`, while `month` figures only count what was spent this month —
so early in a month `session` can exceed `project … month`. The `all`
figures always include it.

## Author

Built by [Gastón Parravicini](https://github.com/Tongas).

## License

MIT — see [LICENSE](LICENSE).
