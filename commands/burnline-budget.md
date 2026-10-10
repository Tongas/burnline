---
description: Set, show, or clear Burnline's monthly budget (the target the status line's month bar fills towards)
argument-hint: "[usd | off]"
allowed-tools: Bash
---

You are running Burnline's budget command. The argument the user passed,
if any, is: `$ARGUMENTS`

!`node "$CLAUDE_PLUGIN_ROOT/statusline/set-budget.js" "$ARGUMENTS"`

Report the result above in one short line. With no argument it only shows
the current budget. Mention that the status line picks the change up on
its next refresh, and that without a budget the month bar compares
against last month's total instead.
