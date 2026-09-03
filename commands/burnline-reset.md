---
description: Reset Burnline's accumulated spend for the current month (all projects, or one matching project)
argument-hint: "[project-slug-or-partial-name]"
allowed-tools: Bash, Read
---

You are running Burnline's reset command. This command wipes accumulated
spend data on disk — it must never delete anything without the user
explicitly confirming first, and it must never touch any month other than
the current one.

The argument the user passed, if any, is: `$ARGUMENTS`

## Step 1 — Find what would be affected (read-only, do this now)

`statusline/list-projects.js` is the same helper `burnline-status` uses —
it computes the current month's data folder exactly the way
`statusline/status.js` does (respecting `BURNLINE_DATA_DIR` if set, never a
past month), and when given an argument, filters to slugs containing it as
a case-insensitive substring:

!`node "$CLAUDE_PLUGIN_ROOT/statusline/list-projects.js" "$ARGUMENTS"`

This output already **is** the target set — no argument means every row
listed (full month reset); an argument means only the matched row(s).

## Step 2 — Show the plan and stop for confirmation

- If the output above said no data directory / no tracked projects / no
  match: say so plainly and stop — there's nothing to reset.
- Otherwise, present the listed row(s) (slug, totalUsd, path) and the
  `TOTAL` line to the user. Make clear this only affects the current month
  shown in the output, and does not touch any other month's data. If more
  than one row matched a given argument, say explicitly that confirming
  will reset **all** of them, and offer the option to re-run with a more
  specific argument if the user only meant one.

Then explicitly ask the user to confirm before doing anything else, e.g.:
"Reset these N file(s) for <month>, wiping $X.XX total? Reply to confirm."

**Do not delete anything in this turn.** End your turn here and wait for
the user's next message. Only proceed to Step 3 once they've clearly said
yes in a follow-up message — a request to run this command is not itself
confirmation.

## Step 3 — Delete only after explicit confirmation

Once the user confirms in a later message: delete only the specific
`<slug>.json` files identified in Step 1 (never the whole month directory,
never any file that didn't match, never anything outside the current
month's folder). Leave `state/sessions.json` untouched — the next
statusLine tick for any session will simply treat its stored `lastSeenUsd`
as the new baseline and start accumulating into a fresh file again, which
is exactly "start counting from zero going forward."

After deleting, report a short summary: which file(s) were removed, the
total `totalUsd` that was wiped, and the month it applied to.
