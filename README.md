<p align="center">
  <img src="./docs/banner.jpeg" alt="Burnline — real-time spend tracking in your Claude Code status line" width="100%">
</p>

# Burnline

🇪🇸 [Leer en español](README.es.md)

**Real spend, right in your status line.**

Burnline is a [Claude Code](https://claude.com/claude-code) plugin that
shows your monthly spend directly in the status line: how much this
session has cost, how much this project has cost this month, and how much
you've spent in total this month — all computed from Claude Code's own
`cost.total_cost_usd` field, with zero external pricing recalculation.

```
[Sonnet 5] session: $0.34 | project (month): $12.87 | total (month): $45.21 [actual]
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
- `cost.total_cost_usd` is cumulative per session. Burnline tracks the
  highest value seen per session (a running peak) and adds only the
  positive difference each tick — an approach that stays correct even
  when statusLine ticks for the same session overlap in time, which a
  simple "last seen" comparison doesn't.
- Spend is persisted locally, grouped by calendar month and by project, so
  "this project, this month" and "everything, this month" are both cheap
  lookups.
- Subscription (Pro/Max) vs. pay-per-token API billing is auto-detected
  from whether the status line payload includes `rate_limits` — no config
  needed. Same number either way; the label changes to say whether it's
  actual spend or an estimated API-equivalent.

Full design rationale, including why each of these choices was made, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Checking tracked spend

`/burnline:burnline-status` lists every project Burnline has tracked for
the current calendar month — slug, `totalUsd`, and the project's real path
(when known; data written before path tracking was added shows as
unknown) — plus the sum total at the bottom. It's read-only: no
confirmation prompt, nothing is ever deleted or modified.

## Resetting tracked spend

Burnline ships a slash command, `/burnline:burnline-reset` (shown to
Claude Code as `/burnline-reset`), for starting the count over.

- With no argument, it targets **every** project file for the **current
  calendar month only** — a full "start fresh from zero this month."
- With an argument (a project slug or partial name, e.g. `ads`), it targets
  only the matching project's file(s) for the current month, leaving
  everything else untouched.
- It never touches any month other than the current one — this is a
  "reset going forward," not a way to erase historical data.
- Before deleting anything, it lists exactly which file(s) would be
  affected and their current `totalUsd`, and waits for you to explicitly
  confirm in a follow-up message. It will not delete anything in the same
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
written to `~/.claude/burnline/<YYYY-MM>/<project-slug>.json` on your own
machine and nowhere else. Delete that folder at any time to reset.

## Requirements

- Claude Code with statusLine support.
- Node.js available on your `PATH` (no npm install, no dependencies).

## Known behavior

Each Claude Code session's status line refreshes independently. If you
reset spend (or anything else changes on disk) from one session, other
open sessions won't reflect it until their own next statusLine tick. This
isn't a bug — there's no shared process to push updates between sessions,
each one just reads the files on disk whenever it next refreshes.

## Author

Built by [Gastón Parravicini](https://github.com/Tongas).

## License

MIT — see [LICENSE](LICENSE).
