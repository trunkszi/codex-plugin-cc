/**
 * Gemini CLI wrapper for code review integration.
 *
 * Unlike Codex which uses a persistent App Server (JSON-RPC over stdio/socket),
 * Gemini CLI is a single-shot process invoked via `gemini -p <prompt>`.
 * Review context (git diff etc.) is fed through stdin to avoid OS ARG_MAX
 * limits, while the instruction prompt is passed via the -p flag.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binaryAvailable, runCommand } from "../../../codex/scripts/lib/process.mjs";
import { readJsonFile } from "../../../codex/scripts/lib/fs.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../../../codex/scripts/lib/prompts.mjs";

const GEMINI_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const AUTH_ERROR_PATTERNS = [
  /unauthorized/i,
  /unauthenticated/i,
  /401/,
  /403/,
  /auth/i,
  /login required/i,
  /credential/i,
  /permission denied/i,
  /access denied/i
];

const NETWORK_ERROR_PATTERNS = [
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /network/i,
  /timeout/i,
  /rate limit/i,
  /429/,
  /500/,
  /502/,
  /503/,
  /504/
];

// ---------------------------------------------------------------------------
// Availability & Auth
// ---------------------------------------------------------------------------

export function getGeminiAvailability(cwd) {
  return binaryAvailable("gemini", ["--version"], { cwd });
}

export function getGeminiLoginStatus(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail
    };
  }

  // Gemini CLI does not have a dedicated `login status` subcommand.
  // We run a minimal headless prompt to probe authentication state.
  // To distinguish auth failures from transient network issues, we
  // inspect stderr for known error patterns rather than treating every
  // non-zero exit as "not authenticated".
  const result = runCommand("gemini", ["-p", "reply with ok", "-o", "text"], {
    cwd,
    timeout: 30_000
  });

  if (result.error) {
    const msg = result.error.message ?? "";
    if (NETWORK_ERROR_PATTERNS.some((p) => p.test(msg))) {
      return {
        available: true,
        loggedIn: true,
        detail: `assuming authenticated (network probe failed: ${msg})`
      };
    }
    return {
      available: true,
      loggedIn: false,
      detail: msg
    };
  }

  if (result.status === 0) {
    return {
      available: true,
      loggedIn: true,
      detail: "authenticated"
    };
  }

  // Non-zero exit: inspect stderr to distinguish auth errors from transient
  // network failures.  When in doubt, assume authenticated so users are not
  // trapped in a false login loop during temporary outages.
  const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
  if (AUTH_ERROR_PATTERNS.some((p) => p.test(combinedOutput))) {
    return {
      available: true,
      loggedIn: false,
      detail: combinedOutput || "not authenticated"
    };
  }

  if (NETWORK_ERROR_PATTERNS.some((p) => p.test(combinedOutput))) {
    return {
      available: true,
      loggedIn: true,
      detail: `assuming authenticated (transient error: ${combinedOutput})`
    };
  }

  // Unknown failure — assume not authenticated as a safe default.
  return {
    available: true,
    loggedIn: false,
    detail: combinedOutput || "not authenticated"
  };
}

// ---------------------------------------------------------------------------
// Prompt Building
//
// The review context (git diff, file contents, etc.) is passed via stdin to
// avoid hitting the OS ARG_MAX limit on large diffs.  The -p prompt only
// carries the instruction portion with {{REVIEW_INPUT}} replaced by a
// short marker telling the model to read context from stdin.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

function generateBoundary() {
  return `REVIEW_CONTEXT_${crypto.randomBytes(12).toString("hex")}`;
}

function sanitizeContext(content, closeTag) {
  // Escape any occurrence of the closing boundary tag inside the diff to
  // prevent prompt injection via crafted source files.
  return content.replaceAll(closeTag, closeTag.replace(">", "\\>"));
}

function wrapStdinContext(content) {
  const boundary = generateBoundary();
  const openTag = `<${boundary}>`;
  const closeTag = `</${boundary}>`;
  const sanitized = sanitizeContext(content, closeTag);
  return { wrapped: `${openTag}\n${sanitized}\n${closeTag}`, boundary };
}

function buildStdinMarker(boundary) {
  return `The repository context (git diff, status, file contents) is provided via standard input above this prompt, enclosed in <${boundary}> tags.`;
}

function buildReviewPrompt(context, templateName) {
  const template = loadPromptTemplate(PLUGIN_ROOT, templateName);
  const { wrapped, boundary } = wrapStdinContext(context.content);
  return {
    instruction: interpolateTemplate(template, {
      TARGET_LABEL: context.target.label,
      REVIEW_INPUT: buildStdinMarker(boundary)
    }),
    stdinContext: wrapped
  };
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(PLUGIN_ROOT, "gemini-adversarial-review");
  const { wrapped, boundary } = wrapStdinContext(context.content);
  return {
    instruction: interpolateTemplate(template, {
      TARGET_LABEL: context.target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_INPUT: buildStdinMarker(boundary)
    }),
    stdinContext: wrapped
  };
}

// ---------------------------------------------------------------------------
// Gemini CLI Execution
// ---------------------------------------------------------------------------

/**
 * Run a Gemini CLI review in headless mode.
 *
 * Review context is passed through stdin to avoid the OS ARG_MAX limit.
 * The instruction prompt is passed via the -p flag.  Gemini's -p option
 * appends to stdin, so the model sees: [stdin context] + [instruction].
 *
 * @param {string} prompt  - The instruction prompt (without large context).
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.input]    - Content piped to stdin (review context).
 * @param {number} [options.timeout]
 * @param {((msg: string) => void) | null} [options.onProgress]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runGeminiHeadless(prompt, options = {}) {
  const args = ["--approval-mode", "plan", "-p", prompt];

  if (options.model) {
    args.push("-m", options.model);
  }

  options.onProgress?.("Starting Gemini review.");

  const result = runCommand("gemini", args, {
    cwd: options.cwd,
    input: options.input,
    timeout: options.timeout ?? GEMINI_REVIEW_TIMEOUT_MS
  });

  if (result.error) {
    throw new Error(`Gemini CLI failed: ${result.error.message}`);
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed object matches the expected review output schema.
 * Returns null if valid, or an error string describing the problem.
 */
function validateReviewSchema(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing or empty string `verdict`.";
  }
  if (data.verdict !== "approve" && data.verdict !== "needs-attention") {
    return `Invalid verdict "${data.verdict}". Expected "approve" or "needs-attention".`;
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing or empty string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  for (let i = 0; i < data.findings.length; i++) {
    const f = data.findings[i];
    if (!f || typeof f !== "object") {
      return `findings[${i}] is not an object.`;
    }
    if (typeof f.severity !== "string") {
      return `findings[${i}] missing string "severity".`;
    }
    if (typeof f.title !== "string") {
      return `findings[${i}] missing string "title".`;
    }
    if (typeof f.file !== "string") {
      return `findings[${i}] missing string "file".`;
    }
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

/**
 * Extract and parse the JSON review payload from Gemini's raw text output.
 *
 * Gemini may wrap the JSON in markdown code fences or include preamble text.
 * This function tries several strategies to extract valid JSON, then validates
 * the result against the expected review output schema.
 */
export function parseGeminiReviewOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const text = rawOutput.trim();
  let candidate = null;

  // Strategy 1: the entire output is valid JSON
  try {
    candidate = JSON.parse(text);
  } catch {
    // continue
  }

  // Strategy 2: JSON is wrapped in markdown code fences
  if (!candidate) {
    const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenceMatch) {
      try {
        candidate = JSON.parse(fenceMatch[1].trim());
      } catch {
        // continue
      }
    }
  }

  // Strategy 3: find the first balanced { ... } JSON object using brace
  // depth tracking.  If the first candidate fails to parse, continue
  // searching from the next "{" so that conversational preamble containing
  // braces (e.g. "Analyzing {module}...") does not block extraction.
  if (!candidate) {
    let searchFrom = 0;
    while (!candidate) {
      const start = text.indexOf("{", searchFrom);
      if (start === -1) break;

      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }

      if (end !== -1) {
        try {
          candidate = JSON.parse(text.slice(start, end + 1));
        } catch {
          // Parse failed for this block — advance past it and try next "{"
          searchFrom = start + 1;
          continue;
        }
      } else {
        break;
      }
    }
  }

  if (!candidate) {
    return {
      parsed: null,
      parseError: "Could not extract valid JSON from Gemini output.",
      rawOutput: text,
      ...fallback
    };
  }

  // Validate against expected schema
  const validationError = validateReviewSchema(candidate);
  if (validationError) {
    return {
      parsed: null,
      parseError: `Gemini returned JSON with invalid review schema: ${validationError}`,
      rawOutput: text,
      ...fallback
    };
  }

  return { parsed: candidate, parseError: null, rawOutput: text, ...fallback };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// ---------------------------------------------------------------------------
// High-Level Review API
// ---------------------------------------------------------------------------

/**
 * Run a standard Gemini code review.
 *
 * @param {string} cwd
 * @param {{ target: object, content: string, repoRoot: string, branch: string, summary: string }} context
 * @param {object} options
 */
export function runGeminiReview(cwd, context, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed. Install it following the official docs, then rerun `/gemini:setup`."
    );
  }

  const { instruction, stdinContext } = buildReviewPrompt(context, "gemini-review");

  options.onProgress?.("Gemini review started.");

  const result = runGeminiHeadless(instruction, {
    cwd: context.repoRoot,
    model: options.model,
    input: stdinContext,
    timeout: options.timeout,
    onProgress: options.onProgress
  });

  options.onProgress?.("Gemini review completed.");

  const parsed = parseGeminiReviewOutput(result.stdout, {
    status: result.status,
    failureMessage: result.stderr?.trim() || null
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed
  };
}

/**
 * Run an adversarial Gemini review.
 *
 * @param {string} cwd
 * @param {{ target: object, content: string, repoRoot: string, branch: string, summary: string }} context
 * @param {string} focusText
 * @param {object} options
 */
export function runGeminiAdversarialReview(cwd, context, focusText, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed. Install it following the official docs, then rerun `/gemini:setup`."
    );
  }

  const { instruction, stdinContext } = buildAdversarialReviewPrompt(context, focusText);

  options.onProgress?.("Gemini adversarial review started.");

  const result = runGeminiHeadless(instruction, {
    cwd: context.repoRoot,
    model: options.model,
    input: stdinContext,
    timeout: options.timeout,
    onProgress: options.onProgress
  });

  options.onProgress?.("Gemini adversarial review completed.");

  const parsed = parseGeminiReviewOutput(result.stdout, {
    status: result.status,
    failureMessage: result.stderr?.trim() || null
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed
  };
}
