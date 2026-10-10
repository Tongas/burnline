# Architecture

Burnline is deliberately small: one script, one JSON store, zero dependencies.
This document explains the reasoning behind each constraint, because the
constraints — not the code — are the interesting part.

## 1. Why everything lives in the statusLine script, not a hook

Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, etc.)
fire on lifecycle events, but the JSON payload they receive does **not**
include cost data. Cost information — `cost.total_cost_usd` — is only ever
sent to the `statusLine` command, because the status line is the one surface
Claude Code refreshes continuously and treats as "cheap to recompute."

That means Burnline cannot be a hook that watches for `Stop` events and logs
spend, no matter how tempting that architecture looks on paper (hooks feel
like the "correct" place for side-effecting bookkeeping). The only process
that ever sees `cost.total_cost_usd` is the statusLine command. So read,
persist, and render all had to collapse into that single script — there is
no separate observer to delegate to.

### `${CLAUDE_PLUGIN_ROOT}` only resolves through a plugin install, not by hand

The plugin's own `settings.json` registers its statusLine command as
`node "${CLAUDE_PLUGIN_ROOT}/statusline/status.js"`, which works correctly
once Claude Code merges that file into a user's settings during a real
plugin install. It does **not** work if that same literal string is
hand-typed directly into a user's own top-level `~/.claude/settings.json`
— confirmed empirically (Sep 3, 2026): applying it to a manually-maintained
settings file caused the statusLine to silently freeze (no crash, no
visible error — the underlying spend file simply stopped updating)
rather than fail loudly. Reverting to an absolute path resumed ticking
within seconds, with clean before/after timestamps ruling out coincidence.

The variable is resolved by Claude Code's plugin subsystem at
install/merge time, not as a general environment variable available to
any arbitrary `statusLine.command`. Anyone wiring Burnline's statusLine
manually — e.g. for local dev/testing before a proper plugin install — must
use an absolute path, not the plugin-relative syntax.

## 2. Why the script tracks a delta instead of trusting a running total

`cost.total_cost_usd` is cumulative *for the current session*, not a delta
since the last tick. So Burnline remembers the last value it saw for each
`session_id` (`lastUsd`) and, on every tick, adds only the positive
difference:

- `current > lastUsd` → add `current - lastUsd`.
- `current <= lastUsd` → add nothing; `lastUsd` moves down to `current`,
  so whatever the session spends after the drop is still counted.

### History: from "last seen" to "peak" and back

The first version used last-seen tracking but treated any drop as a reset
and re-added the whole new value. Concurrent ticks for the same session
could be processed out of order, and an out-of-order *lower* reading then
got double-added. The fix at the time was a lock plus tracking the
session's *peak* instead, which is order-independent.

Peak-tracking had its own failure mode, though: if `total_cost_usd`
genuinely dropped within one `session_id`, everything spent afterwards was
ignored until the old peak was exceeded. Cross-checking the ledger against
Claude Code's own saved per-project `lastCost` (in `~/.claude.json`)
turned up one session where the two disagreed by $218, with the transcript
holding far more token usage than either figure accounted for. The cause
couldn't be pinned down, but losing hundreds of dollars silently is the
worst possible outcome for a spend tracker.

What made switching back safe is documented Claude Code behavior: *"If a
new update triggers while your script is still running, Claude Code
cancels the in-flight script."* So two ticks of one session essentially
never run at once, and out-of-order readings are rare. The worst case
of last-seen tracking is now a small overcount by the size of one
reordering; the worst case of peak-tracking was an unbounded undercount.

### Concurrency: the lock, and cancelled ticks

Ticks from *different* sessions (several Claude Code windows) still run
concurrently, and they share one ledger. The whole read-decide-write
transaction is therefore serialized behind a lockfile (`withLock` in
`ledger.js`) and ends in a single atomic write (see §3).

Because Claude Code routinely cancels in-flight statusLine scripts, a
lock holder being killed is normal. The lockfile stores its holder's pid,
and a lock whose holder no longer exists is taken over immediately. The
2-second timeout is only a backstop. Otherwise the next tick would wait
out the timeout and likely be cancelled itself while waiting.

## 3. Why spend is persisted to one ledger, by project and by month

The status line has to answer five money questions every tick: session cost,
*this project's* cost this month and all-time, and *total* cost this month
and all-time. Only the first is in the payload — everything else needs a
durable store that survives session restarts. Burnline keeps a single
file:

```
~/.claude/burnline/ledger.json
{
  "version": 2,
  "sessions": { "<session_id>": { "lastUsd": 12.34, "updatedAt": "…" } },
  "projects": { "<slug>": { "path": "/abs/dir", "months": { "2026-10": 98.7 } } },
  "days": { "2026-10-10": 18.4 }
}
```

Every figure is derived on read (month = one key, all-time = sum of every
month) — there's no rollup to keep in sync. `days` is the one exception
to "per project": it's a global per-day total that only feeds the
"today" figure and the 7-day sparkline, so it doesn't need a project
breakdown. Formatting lives in `statusline/render.js`, separate from the
bookkeeping, so it can change without touching the ledger logic. History is never pruned, so a
new month never erases the past.

### Why one file instead of one file per project per month (v1)

The v1 layout wrote `state/sessions.json` and `<YYYY-MM>/<slug>.json`
separately on every tick. Claude Code does kill statusLine processes
mid-run — dozens of orphaned `*.tmp` files in real data were the
evidence. A kill landing between those two writes left the project total
updated but the session baseline stale, so the next tick re-added the same
delta. With one file and one atomic rename, a tick either fully lands or
doesn't happen. v1 data is imported into the ledger on first run and the
old files are left untouched.

### Why a project is `workspace.project_dir`, not `current_dir`

`current_dir` follows every `cd` Claude makes during a session;
`project_dir` is where Claude Code was launched and stays fixed. v1 keyed
projects on `current_dir`, which split one project's spend across every
subfolder a session wandered into (`app/`, `app/backend/`,
`app/backend/services/`, …) — the visible symptom was "project" reading
lower than "session". v1 history keeps those per-subfolder entries as
they were recorded.

### Why amounts are stored at micro-dollar precision, not cents

v1 rounded the running total to the cent on every addition, which
silently dropped every delta under half a cent — forever, since the
session baseline had already advanced. Only display rounds to cents now.

### Why session baselines are kept ~400 days, not "two months"

`--resume` restores a session's previous `total_cost_usd`. If its
baseline has been forgotten, the whole restored history looks like a fresh delta
and gets counted twice. v1 pruned them after about two months; the ledger
keeps them for 400 days.

### Why worktrees count towards their parent repo

Claude Code puts worktrees at `<repo>/.claude/worktrees/<name>`, and a
session running in one reports that path as its `project_dir`. That's a
throwaway checkout of the same project, so Burnline strips the
`/.claude/worktrees/<name>` suffix and books the spend to the repo.

### One ledger per account

The documented way to use several Claude accounts on one machine is one
config directory per account (`CLAUDE_CONFIG_DIR=~/.claude-work claude`).
Burnline stores its data under `$CLAUDE_CONFIG_DIR/burnline/` (default
`~/.claude/burnline/`), so each account's spend stays separate, which is
what you want when one account is personal and another is paid by work.
Switching accounts with `/login` inside the *same* config directory can't
be told apart from the statusLine payload, so that spend is combined.

### Price changes never rewrite the past

Each delta is frozen in dollars, at whatever price Claude Code applied
when it was observed. If prices change, past months stay as they were;
all-time is past spend at past prices plus new spend at new prices.

### Session vs. month figures across a month boundary

A session that started last month keeps reporting its full cumulative
cost, while `month` only counts what was added this month. So early in a
month `session` can legitimately exceed `project … month` or `total …
month`; the `all` figures always include it.

## 3b. Limits line: 5-hour window, 7-day window, prompt cache

On Pro/Max, the payload carries `rate_limits.five_hour` /
`rate_limits.seven_day` (`used_percentage`, `resets_at`), and on recent
versions a `prompt_cache` summary. These are already in the payload, so
the third line needs nothing persisted:

- The 5-hour window opens with the first message and closes at
  `resets_at`, so its start is `resets_at − 5h` and the average rate so
  far is `used% / elapsed`. Projected forward, that says whether the
  window runs out before it resets (`⚠ full ~HH:MM`) or where it lands
  (`→ ~N% at reset`). Projections are skipped in the first 15 minutes,
  when the rate is mostly noise.
- Claude Code re-runs the statusLine on its own when a `resets_at` or the
  prompt cache's `expires_at` passes, so the line doesn't go stale at
  those moments.
- `rate_limits` only arrives with an API response, so a new session has
  none until its first message. The windows belong to the account, not
  the session, so the ledger keeps the last ones seen (`rateLimits`) and
  shows them, and the `equivalent` label, while their `resets_at` is
  still in the future.
- `prompt_cache.hit_ratio` and `warm` matter for cost: a cold cache means
  the next message pays to re-process the whole context.

## 4. Why subscription vs. API billing is auto-detected, not configured

The statusLine payload includes a `rate_limits` field precisely when the
user is on a Pro/Max subscription plan, because those plans are rate-limited
rather than metered per token. Pay-as-you-go API key billing has no rate
limit concept in the same sense, so the field is simply absent for those
users.

That absence/presence is a reliable, zero-config signal for which billing
model applies — so Burnline uses it directly instead of asking the user to
declare their plan type in a settings file (which would drift out of sync
the moment they change plans, and which is one more thing to get wrong on
install). The dollar figure computed is *identical* either way — Burnline
never recomputes pricing from token counts, it only ever reads
`cost.total_cost_usd` as Claude Code reports it — but the label changes to
be honest about what the number means:

- `rate_limits` present → "estimated equivalent API cost" (you're not
  actually being billed this amount; this is what the same usage would
  have cost on metered billing).
- `rate_limits` absent → "actual spend" (this is a real dollar figure being
  charged to your API key).

## 5. Why no external pricing tables, and no ccusage dependency

Tools like [ccusage](https://github.com/ryoppippi/ccusage) recompute cost
from token counts and a maintained table of per-model, per-token pricing.
That's necessary work for tools that want historical analytics across every
model Anthropic has shipped — but it's also a moving target: pricing
changes, models are added, and a stale table silently produces wrong
numbers with no indication anything is wrong.

Burnline sidesteps that entire failure mode by never repricing anything.
`cost.total_cost_usd` is computed by Claude Code itself, from the actual
request/response accounting it already has — it is definitionally correct
for whatever model and pricing was in effect at the time, with no table to
maintain and no way for it to drift out of date. The tradeoff is that
Burnline can only ever be as capable as what Claude Code chooses to expose
in that field — which is a tradeoff in favor of correctness over
completeness.

## 6. Why this isn't ccburn

[ccburn](https://github.com/JuanjoFuchs/ccburn) tracks a genuinely different
metric: rate-limit percentage burn-up (how much of your Pro/Max rate-limit
window you've consumed). That's valuable for people who hit rate limits and
want to pace themselves, but it says nothing about dollars, and nothing
about which project is expensive. Burnline tracks dollars, per project,
per month — the two tools answer different questions and can be run
side by side.

## 7. Why no npm dependency, no external process

The statusLine command runs on every refresh — effectively a hot path.
Spawning a subprocess, hitting the network, or loading a dependency tree
would make every refresh slower and would add failure modes (a missing
`node_modules`, a network hiccup, a version mismatch) to something that is
supposed to be a glanceable, always-on UI element. `statusline/status.js`
is pure Node.js core modules only (`fs`, `path`, `os`, `crypto`) — no `package.json`
dependencies, no build step, no telemetry, no network calls of any kind.
