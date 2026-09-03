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
since the last tick. A naive implementation that persists the latest value
every tick would double-count nothing — but it would also lose everything
the moment a session resets, because on older Claude Code versions
`/clear` zeroed `total_cost_usd` back to `0` while (as far as the
statusLine payload was concerned) reusing the same `session_id`.

So Burnline keeps its own memory of "the highest cost value ever seen for
this session" (`lastSeenUsd`, tracked as a running peak, not just the most
recent reading) and diffs against it on every invocation:

- `new_total > peak` → normal case, `delta = new_total - peak`, and `peak`
  advances to `new_total`.
- `new_total <= peak` → nothing new happened from this tick's perspective;
  `delta = 0` and `peak` is left unchanged.

This per-session peak tracking is what makes accumulation correct across
long sessions and across the statusLine script being invoked many times
per minute — including when invocations for the *same* session overlap in
time (see the concurrency note below), where peak-tracking's
order-independence is what keeps the total correct regardless of which
overlapping invocation happens to finish first.

### Concurrency: why this needed a lock, and why "peak" instead of "last seen"

statusLine ticks fire frequently, and nothing guarantees two invocations
for the same session never overlap in wall-clock time (a burst of tool
activity can trigger rapid refreshes faster than one invocation's disk I/O
completes). Without protection, concurrent invocations race on the shared
JSON files (`state/sessions.json` and each project's total file): each
reads the same pre-update state, computes its own "correct" delta, and
whichever writes last wins — silently discarding the other's update. The
project total, being an *accumulation*, has no way to self-correct from a
lost write; it stays wrong forever. (Session state, being an *overwrite*,
tends to self-correct over many ticks, which is why real corrupted data
showed a project total far below the session's own reported cost — that
asymmetry was the actual symptom that led to this fix.)

The fix has two parts:

1. **A lockfile-based mutex** (`withLock` in `status.js`) serializes the
   entire read-decide-write transaction, so concurrent invocations can
   never interleave their reads and writes.
2. **Peak-tracking instead of "last seen."** Serialization alone isn't
   enough: it guarantees invocations run one at a time, but not in the
   order Claude Code logically fired them — two overlapping ticks can be
   processed in either order depending on which one wins the lock first.
   The original "any drop below last-seen is a reset, add the whole new
   value" heuristic breaks under that reordering: an out-of-order *lower*
   reading looks identical to a genuine reset and gets double-added.
   Tracking the historical *maximum* instead of the *most recent* value
   makes the algorithm commutative — applying the same set of readings in
   any order converges to the same final peak and the same total delta —
   so serialization plus peak-tracking together are what make concurrent
   invocations safe.

### Known limitation: peak-tracking assumes `total_cost_usd` never genuinely drops within one `session_id`

Because a drop is now always treated as "nothing new" (`delta = 0`) rather
than "the session reset, add the new value," this design depends on
`total_cost_usd` never legitimately decreasing while `session_id` stays
the same. That holds on Claude Code v2.1.211+, where official docs
(`statusline.md`, on the `cost.total_cost_usd` field) state: *"Resets to
$0 when `/clear` starts a new session. Before v2.1.211, the total carried
over after `/clear`."* — i.e. `/clear` now starts a new session rather
than resetting cost in place within the same one.

That statement is about "a new session," not verbatim about `session_id`
— the inference that `session_id` itself changes is reasonable and
consistent with the `SessionStart` hook's `"clear"` startup-reason filter,
but it is not confirmed with that literal term anywhere in Anthropic's
documentation. If this assumption is ever wrong on some future version —
`total_cost_usd` drops while `session_id` stays the same — the failure
mode is a silent undercount for that one drop event (`delta = 0`), not
data corruption or double-counting. That's a deliberate tradeoff: it
avoids regressing into the concurrency bug peak-tracking was built to fix,
in exchange for potentially missing one narrow, currently-unobserved edge
case.

## 3. Why spend is persisted to disk, grouped by month and by project

The status line has to answer three questions every tick: session cost,
*this project's* cost this month, and *total* cost this month. None of
those are available from the payload alone — the payload only ever tells
you about the current session. Cross-session and cross-project aggregation
requires a durable store that survives session restarts, so Burnline
persists accumulated spend under:

```
~/.claude/burnline/<YYYY-MM>/<project-slug>.json
```

Grouping by calendar month makes "this month" a matter of picking the
right file rather than filtering timestamps, and keeps old months
naturally out of the way (and easy to prune or archive). Grouping by
project (derived by slugifying `workspace.current_dir`/`cwd`) is what
makes the per-project figure possible at all — without it, "project cost"
would just be "total cost" with a different label.

The total for a given month is the sum across every project-slug file in
that month's directory, computed on read — there's no separate rollup file
to keep in sync, which removes an entire class of "the summary disagrees
with the detail" bugs.

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
is pure Node.js core modules only (`fs`, `path`, `os`) — no `package.json`
dependencies, no build step, no telemetry, no network calls of any kind.
