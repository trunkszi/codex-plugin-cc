---
description: Check whether Auggie CLI is installed and authenticated
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(auggie:*), AskUserQuestion
---

Check the Auggie CLI environment and report readiness.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/auggie-companion.mjs" setup
```

Return the command stdout verbatim.

If Auggie is not installed, suggest:
- Installing from the official docs at https://docs.augmentcode.com

If Auggie is installed but not authenticated, suggest:
- Running `!auggie login` to start the authentication flow.
