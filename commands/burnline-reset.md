---
description: Reset Burnline's accumulated spend for the current month (all projects, or one matching project)
argument-hint: "[project-slug-or-partial-name]"
allowed-tools: Bash, Read
---

You are running Burnline's reset command. This command wipes accumulated
spend data on disk — it must never change anything without the user
explicitly confirming first, and it must never touch any month other than
the current one.

The argument the user passed, if any, is: `$ARGUMENTS`

## Step 1 — Find what would be affected (read-only, do this now)

`statusline/list-projects.js` is the same helper `burnline-status` uses —
it reads the same ledger `statusline/status.js` writes (respecting
`BURNLINE_DATA_DIR` if set), and when given an argument, filters to
projects whose slug or path contains it as a case-insensitive substring:

!`node "$CLAUDE_PLUGIN_ROOT/statusline/list-projects.js" "$ARGUMENTS"`

This output already **is** the target set — no argument means every row
listed (full month reset); an argument means only the matched row(s).
Only the "month USD" column is affected; all-time history from previous
months is never touched.

## Step 2 — Show the plan and stop for confirmation

- If the output above said there are no tracked projects / no match, or
  every matched row has 0 for this month: say so plainly and stop —
  there's nothing to reset.
- Otherwise, present the listed row(s) (slug, month USD, path) and the
  month total to the user. Make clear this only affects the current month
  shown in the output. If more than one row matched a given argument, say
  explicitly that confirming will reset **all** of them, and offer the
  option to re-run with a more specific argument if the user only meant one.

Then explicitly ask the user to confirm before doing anything else, e.g.:
"Reset this month's spend for these N project(s) in <month>, wiping $X.XX?
Reply to confirm."

**Do not change anything in this turn.** End your turn here and wait for
the user's next message. Only proceed to Step 3 once they've clearly said
yes in a follow-up message — a request to run this command is not itself
confirmation.

## Step 3 — Reset only after explicit confirmation

Once the user confirms in a later message, run the `reset script` path
printed in Step 1's output with the exact same argument (or none):

`node "<reset script path>" "$ARGUMENTS"`

It removes only the current month's figure for the matching projects,
under the same lock the status line uses. Session peaks are kept, so live
sessions simply count from zero going forward. Never edit `ledger.json`
by hand.

Report the script's summary: which project(s) were reset, the total
wiped, and the month it applied to.
