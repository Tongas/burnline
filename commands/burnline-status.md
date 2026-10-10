---
description: List Burnline's tracked spend for every project, this month and all-time (read-only)
allowed-tools: Bash
---

You are running Burnline's status command. This is purely informational —
read-only, no confirmation needed, and it must never delete or modify
anything.

`statusline/list-projects.js` is the same helper `burnline-reset` uses to
find its target set — it reads the same ledger `statusline/status.js`
writes (respecting `BURNLINE_DATA_DIR` if set) and lists every tracked
project with its slug, spend this month, all-time spend, and real path:

!`node "$CLAUDE_PLUGIN_ROOT/statusline/list-projects.js"`

Present the rows above to the user as a simple table (slug, month USD,
all-time USD, path) followed by the `TOTAL` line. If the output says there
are no tracked projects yet, just report that plainly — nothing else to do.
