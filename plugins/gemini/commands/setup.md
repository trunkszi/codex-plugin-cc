---
description: Check whether Gemini CLI is installed and authenticated
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(gemini:*), AskUserQuestion
---

Check the Gemini CLI environment and report readiness.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "$ARGUMENTS"
```

Return the command stdout verbatim.

If Gemini is not installed, suggest:
- `npm install -g @google/gemini-cli` or following the official installation guide.

If Gemini is installed but not authenticated, suggest:
- Running `!gemini` to start the interactive login flow.
