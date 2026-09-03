---
description: List Burnline's tracked spend for every project this month (read-only)
allowed-tools: Bash
---

You are running Burnline's status command. This is purely informational —
read-only, no confirmation needed, and it must never delete or modify
anything.

`statusline/list-projects.js` is the same helper `burnline-reset` uses to
find its target set — it computes the current month's data folder exactly
the way `statusline/status.js` does (respecting `BURNLINE_DATA_DIR` if
set), and lists every tracked project for that month with its slug,
`totalUsd`, and real path (when known — files written before path
tracking was added will show as unknown):

!`node "$CLAUDE_PLUGIN_ROOT/statusline/list-projects.js"`

Present the rows above to the user as a simple table (slug, totalUsd,
path) followed by the `TOTAL` line as the sum for the month. If the output
says there's no data directory or no tracked projects yet, just report
that plainly — nothing else to do.
