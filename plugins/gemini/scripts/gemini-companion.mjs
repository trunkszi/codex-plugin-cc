#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "../../codex/scripts/lib/args.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../../codex/scripts/lib/git.mjs";
import { binaryAvailable } from "../../codex/scripts/lib/process.mjs";
import { resolveWorkspaceRoot } from "../../codex/scripts/lib/workspace.mjs";
import {
  getGeminiAvailability,
  getGeminiLoginStatus,
  parseGeminiReviewOutput,
  runGeminiReview,
  runGeminiAdversarialReview
} from "./lib/gemini.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function severityRank(severity) {
  switch (severity) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    default: return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) return `:${finding.line_start}`;
  return `:${finding.line_start}-${finding.line_end}`;
}

function renderReviewResult(parsed, meta) {
  if (!parsed.parsed) {
    const lines = [
      `# Gemini ${meta.reviewLabel}`,
      "",
      "Gemini did not return valid structured JSON.",
      "",
      `- Parse error: ${parsed.parseError}`
    ];
    if (parsed.rawOutput) {
      lines.push("", "Raw output:", "", "```text", parsed.rawOutput, "```");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = parsed.parsed;
  const findings = [...(data.findings ?? [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );

  const lines = [
    `# Gemini ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps?.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSetupReport(report) {
  const lines = [
    "# Gemini Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- gemini: ${report.gemini.detail}`,
    `- auth: ${report.auth.detail}`,
    ""
  ];

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);

  // Only check auth when gemini is available, to avoid wasting time
  let authStatus;
  if (geminiStatus.available) {
    authStatus = getGeminiLoginStatus(cwd);
  } else {
    authStatus = { available: false, loggedIn: false, detail: "skipped (gemini not installed)" };
  }

  const nextSteps = [];
  if (!geminiStatus.available) {
    nextSteps.push("Install Gemini CLI: npm install -g @google/gemini-cli or follow the official instructions.");
  }
  if (geminiStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate Gemini CLI by running `!gemini` and completing the login flow.");
  }

  return {
    ready: nodeStatus.available && geminiStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    gemini: geminiStatus,
    auth: authStatus,
    nextSteps
  };
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const report = buildSetupReport(cwd);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

function ensureGeminiReady(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed. Install it following the official docs, then rerun `/gemini:setup`."
    );
  }
}

function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  ensureGeminiReady(cwd);
  ensureGitRepository(cwd);

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const context = collectReviewContext(cwd, target);
  const stderrProgress = (msg) => process.stderr.write(`${msg}\n`);

  const result = runGeminiReview(cwd, context, {
    model: options.model,
    onProgress: options.json ? null : stderrProgress
  });

  const payload = {
    review: "Review",
    target,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    gemini: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout
    },
    result: result.parsed.parsed,
    rawOutput: result.parsed.rawOutput,
    parseError: result.parsed.parseError
  };

  const rendered = renderReviewResult(result.parsed, {
    reviewLabel: "Review",
    targetLabel: context.target.label
  });

  outputResult(options.json ? payload : rendered, options.json);

  if (result.status !== 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// adversarial-review
// ---------------------------------------------------------------------------

function handleAdversarialReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  ensureGeminiReady(cwd);
  ensureGitRepository(cwd);

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const focusText = positionals.join(" ").trim();
  const context = collectReviewContext(cwd, target);
  const stderrProgress = (msg) => process.stderr.write(`${msg}\n`);

  const result = runGeminiAdversarialReview(cwd, context, focusText, {
    model: options.model,
    onProgress: options.json ? null : stderrProgress
  });

  const payload = {
    review: "Adversarial Review",
    target,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    gemini: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout
    },
    result: result.parsed.parsed,
    rawOutput: result.parsed.rawOutput,
    parseError: result.parsed.parseError
  };

  const rendered = renderReviewResult(result.parsed, {
    reviewLabel: "Adversarial Review",
    targetLabel: context.target.label
  });

  outputResult(options.json ? payload : rendered, options.json);

  if (result.status !== 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [focus text]"
    ].join("\n")
  );
}

function readArgsFromStdin() {
  try {
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  let rawArgs = process.argv.slice(2);

  // When invoked with --args-stdin, read the argument string from stdin
  // instead of the command line to avoid shell injection risks.
  if (rawArgs[0] === "--args-stdin") {
    const stdinArgs = readArgsFromStdin();
    if (stdinArgs) {
      rawArgs = splitRawArgumentString(stdinArgs);
    } else {
      rawArgs = [];
    }
  }

  const [subcommand, ...argv] = rawArgs;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      handleReview(argv);
      break;
    case "adversarial-review":
      handleAdversarialReview(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
