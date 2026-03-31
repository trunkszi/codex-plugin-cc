/**
 * Auggie CLI wrapper for code review integration.
 *
 * Auggie is invoked in one-shot mode: `auggie -p -i <prompt> -a --quiet`.
 * Review context is fed through stdin, the instruction prompt via -i flag.
 * -a (ask mode) ensures read-only execution.
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binaryAvailable, runCommand } from "../../../codex/scripts/lib/process.mjs";
import { readJsonFile } from "../../../codex/scripts/lib/fs.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../../../codex/scripts/lib/prompts.mjs";

const AUGGIE_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const AUTH_ERROR_PATTERNS = [
  /unauthorized/i,
  /unauthenticated/i,
  /401/,
  /403/,
  /auth/i,
  /login required/i,
  /credential/i,
  /not logged in/i
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

export function getAuggieAvailability(cwd) {
  return binaryAvailable("auggie", ["--version"], { cwd });
}

export function getAuggieLoginStatus(cwd) {
  const availability = getAuggieAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail
    };
  }

  const result = runCommand("auggie", ["-p", "-i", "reply with ok", "--quiet"], {
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

  return {
    available: true,
    loggedIn: false,
    detail: combinedOutput || "not authenticated"
  };
}

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

function generateBoundary() {
  return `REVIEW_CONTEXT_${crypto.randomBytes(12).toString("hex")}`;
}

function sanitizeContext(content, closeTag) {
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
  return `The repository context (git diff, status, file contents) is provided via standard input above this instruction, enclosed in <${boundary}> tags.`;
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
  const template = loadPromptTemplate(PLUGIN_ROOT, "auggie-adversarial-review");
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
// Auggie CLI Execution
// ---------------------------------------------------------------------------

/**
 * Run Auggie in one-shot ask (read-only) mode.
 *
 * Context is piped via stdin. The instruction prompt is passed via -i.
 * -a enables ask mode (read-only), -p enables print (one-shot) mode,
 * --quiet suppresses progress output.
 *
 * @param {string} instruction - The review instruction prompt.
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.input]    - Content piped to stdin.
 * @param {number} [options.timeout]
 * @param {((msg: string) => void) | null} [options.onProgress]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runAuggieHeadless(instruction, options = {}) {
  const args = ["-p", "-a", "--quiet", "-i", instruction];

  if (options.model) {
    args.push("-m", options.model);
  }

  options.onProgress?.("Starting Auggie review.");

  const result = runCommand("auggie", args, {
    cwd: options.cwd,
    input: options.input,
    timeout: options.timeout ?? AUGGIE_REVIEW_TIMEOUT_MS
  });

  if (result.error) {
    throw new Error(`Auggie CLI failed: ${result.error.message}`);
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
    if (typeof f.body !== "string") {
      return `findings[${i}] missing string "body".`;
    }
    if (typeof f.file !== "string") {
      return `findings[${i}] missing string "file".`;
    }
    if (!Number.isInteger(f.line_start) || f.line_start < 1) {
      return `findings[${i}] missing or invalid "line_start".`;
    }
    if (!Number.isInteger(f.line_end) || f.line_end < 1) {
      return `findings[${i}] missing or invalid "line_end".`;
    }
    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
      return `findings[${i}] missing or invalid "confidence" (must be 0-1).`;
    }
    if (typeof f.recommendation !== "string") {
      return `findings[${i}] missing string "recommendation".`;
    }
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  for (let i = 0; i < data.next_steps.length; i++) {
    if (typeof data.next_steps[i] !== "string") {
      return `next_steps[${i}] is not a string.`;
    }
  }
  return null;
}

export function parseAuggieReviewOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Auggie did not return a final message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const text = rawOutput.trim();
  let lastValidationError = null;

  function looksLikeReviewAttempt(obj) {
    return obj && typeof obj === "object" &&
      ("verdict" in obj || "findings" in obj || "summary" in obj);
  }

  function tryValidate(obj) {
    if (!obj) return null;
    const error = validateReviewSchema(obj);
    if (!error) return obj;
    if (looksLikeReviewAttempt(obj)) {
      lastValidationError = error;
    }
    return null;
  }

  const validCandidates = [];

  // Strategy 1: entire output is valid JSON
  try {
    const result = tryValidate(JSON.parse(text));
    if (result) validCandidates.push(result);
  } catch {
    // continue
  }

  // Strategy 2: JSON in markdown code fences
  {
    const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
    for (const match of text.matchAll(fenceRegex)) {
      try {
        const result = tryValidate(JSON.parse(match[1].trim()));
        if (result) validCandidates.push(result);
      } catch {
        // continue
      }
    }
  }

  // Strategy 3: balanced brace matching
  {
    let searchFrom = 0;
    while (true) {
      const start = text.indexOf("{", searchFrom);
      if (start === -1) break;

      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }

      if (end === -1) {
        // Unbalanced brace — skip past it. The inner loop scanned forward
        // but didn't find a match, so advance past this opening brace.
        // Using start + 1 allows finding valid JSON objects that appear
        // after preamble text containing stray braces.
        searchFrom = start + 1;
        continue;
      }

      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        const result = tryValidate(obj);
        if (result) validCandidates.push(result);
      } catch {
        // JSON.parse failed
      }
      searchFrom = end + 1;
    }
  }

  if (validCandidates.length > 0) {
    return {
      parsed: validCandidates[validCandidates.length - 1],
      parseError: null,
      rawOutput: text,
      ...fallback
    };
  }

  const parseError = lastValidationError
    ? `Auggie returned JSON but it failed review schema validation: ${lastValidationError}`
    : "Could not extract valid review JSON from Auggie output.";

  return { parsed: null, parseError, rawOutput: text, ...fallback };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// ---------------------------------------------------------------------------
// High-Level Review API
// ---------------------------------------------------------------------------

export function runAuggieReview(cwd, context, options = {}) {
  const availability = getAuggieAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Auggie CLI is not installed. Install it following the official docs at https://docs.augmentcode.com, then rerun `/auggie:setup`."
    );
  }

  const { instruction, stdinContext } = buildReviewPrompt(context, "auggie-review");

  options.onProgress?.("Auggie review started.");

  const result = runAuggieHeadless(instruction, {
    cwd: context.repoRoot,
    model: options.model,
    input: stdinContext,
    timeout: options.timeout,
    onProgress: options.onProgress
  });

  options.onProgress?.("Auggie review completed.");

  const parsed = parseAuggieReviewOutput(result.stdout, {
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

export function runAuggieAdversarialReview(cwd, context, focusText, options = {}) {
  const availability = getAuggieAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Auggie CLI is not installed. Install it following the official docs at https://docs.augmentcode.com, then rerun `/auggie:setup`."
    );
  }

  const { instruction, stdinContext } = buildAdversarialReviewPrompt(context, focusText);

  options.onProgress?.("Auggie adversarial review started.");

  const result = runAuggieHeadless(instruction, {
    cwd: context.repoRoot,
    model: options.model,
    input: stdinContext,
    timeout: options.timeout,
    onProgress: options.onProgress
  });

  options.onProgress?.("Auggie adversarial review completed.");

  const parsed = parseAuggieReviewOutput(result.stdout, {
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
