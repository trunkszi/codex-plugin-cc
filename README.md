# Codex & Gemini plugins for Claude Code

Use Codex and Gemini from inside Claude Code for code reviews or to delegate tasks.

This project provides two Claude Code plugins:

- **Codex plugin** — integrates OpenAI Codex for code review, adversarial review, and task delegation
- **Gemini plugin** — integrates Google Gemini CLI for code review and adversarial review

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

### Codex commands

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work and manage background jobs

### Gemini commands

- `/gemini:review` for a read-only Gemini code review
- `/gemini:adversarial-review` for a steerable adversarial review powered by Gemini
- `/gemini:setup` to check Gemini CLI availability and authentication

## Requirements

- **Node.js 18.18 or later**
- **For Codex commands:** ChatGPT subscription (incl. Free) or OpenAI API key. Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **For Gemini commands:** Google account with Gemini access.

## Install

### Option A: Install from this fork via marketplace (includes both Codex and Gemini)

Add this fork as a marketplace in Claude Code:

```bash
/plugin marketplace add trunkszi/codex-plugin-cc
```

Install the plugins you need:

```bash
/plugin install codex@trunkszi-codex-gemini
/plugin install gemini@trunkszi-codex-gemini
```

Reload plugins:

```bash
/reload-plugins
```

### Option B: Install from local directory

Clone this repository and load plugins directly:

```bash
git clone https://github.com/trunkszi/codex-plugin-cc.git
cd codex-plugin-cc
git checkout gemini/plugin-integration
claude --plugin-dir ./plugins/codex --plugin-dir ./plugins/gemini
```

Or load only the plugin you need:

```bash
claude --plugin-dir ./plugins/codex    # Codex only
claude --plugin-dir ./plugins/gemini   # Gemini only
```

### Option C: Install Codex plugin from official marketplace (Codex only)

If you only need the original Codex plugin, install from the official marketplace:

```bash
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
```

> [!NOTE]
> The official marketplace only includes the Codex plugin. The Gemini plugin is available through this fork (Option A or B).

### Post-install setup

For Codex, run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

For Gemini, run:

```bash
/gemini:setup
```

If Gemini CLI is not installed:

```bash
npm install -g @google/gemini-cli
```

If Gemini CLI is installed but not authenticated, start the login flow:

```bash
!gemini
```

After install, you should see:

- the Codex slash commands (`/codex:*`) and the `codex:codex-rescue` subagent in `/agents`
- the Gemini slash commands (`/gemini:*`)

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "xhigh"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

---

# Gemini plugin for Claude Code

Use Google Gemini CLI from inside Claude Code for code reviews.

This plugin is for Claude Code users who want to use Gemini as an additional review tool alongside or instead of Codex.

See the [Install](#install) section above for setup instructions.

## Usage

### `/gemini:review`

Runs a standard Gemini code review on your current work. The review runs in read-only mode (`--approval-mode plan`) and will not modify any files.

> [!NOTE]
> Code review for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`.

Examples:

```bash
/gemini:review
/gemini:review --base main
/gemini:review --background
/gemini:review --model gemini-2.5-pro --wait
```

This command is read-only and will not perform any changes.

### `/gemini:adversarial-review`

Runs a **steerable** adversarial review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/gemini:review`, including `--base <ref>` for branch review.
It also supports `--wait`, `--background`, and `--model <model>`. Unlike `/gemini:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge whether this was the right caching design
/gemini:adversarial-review --model gemini-2.5-pro --wait look for race conditions
/gemini:adversarial-review --background
```

This command is read-only. It does not fix code.

### `/gemini:setup`

Checks whether Gemini CLI is installed and authenticated.

```bash
/gemini:setup
```

## Typical Gemini Flows

### Quick Review

```bash
/gemini:review --wait
```

### Adversarial Review Before Shipping

```bash
/gemini:adversarial-review --wait
```

### Use A Specific Model

```bash
/gemini:adversarial-review --model gemini-2.5-pro --wait
```

### Background Review

```bash
/gemini:review --background
```

## Gemini Integration

The Gemini plugin invokes the [Gemini CLI](https://github.com/google-gemini/gemini-cli) in headless mode (`gemini -p <prompt> --approval-mode plan`). Each review spawns a single `gemini` process that runs to completion.

Review context (git diff, file contents) is piped via stdin with randomized boundary tags to prevent prompt injection. The instruction prompt is passed via the `-p` flag.

The plugin reuses shared infrastructure from the Codex plugin for git context collection, argument parsing, and workspace resolution.

## Gemini FAQ

### Do I need a Google Cloud account?

No. Gemini CLI authenticates with a standard Google account. Run `gemini` interactively once to complete the login flow.

### What model does it use by default?

Gemini CLI uses its own default model (currently `gemini-2.0-pro-exp-02-05` as of CLI version 0.36.0). You can override it with `--model <model-name>` on any review command.

### Can I use both Codex and Gemini plugins together?

Yes. Load both plugins with:

```bash
claude --plugin-dir ./plugins/codex --plugin-dir ./plugins/gemini
```

The commands use different prefixes (`/codex:*` and `/gemini:*`) so they do not conflict.
