#!/usr/bin/env node
/**
 * Proves real handwriting recognition against a deployed NoteSnap.
 *
 * Unit tests use a stubbed provider, which proves the plumbing but says nothing
 * about whether a photo of handwriting is actually read. This script closes that
 * gap: it POSTs a controlled image whose text is known, prints the transcription
 * verbatim, and diffs it line by line so the result can be judged rather than
 * assumed.
 *
 * It talks to a running deployment over HTTP, so it exercises the real route,
 * the real MIME sniffing and the real provider — no credentials are read here.
 *
 * Usage:
 *   node scripts/ocr-fixture.mjs https://notesnap-theta.vercel.app \
 *     --image /tmp/notesnap-e2e-handwriting.png \
 *     --expect "NoteSnap test 12345|buy milk|call mum at 6"
 *
 * Options:
 *   --image <path>   Image to upload. Default: the generated fixture.
 *   --expect <text>  Pipe-separated expected lines, compared in order.
 *   --user-key <key> Sends a caller's own key in the BYOK header. Prefer the
 *                    X_NOTESNAP_USER_KEY environment variable instead, so the
 *                    key never appears in shell history or the process list.
 *
 * Exit codes: 0 matched, 1 mismatch, 2 the request failed.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const args = process.argv.slice(2);
const baseUrl = (args.find((arg) => arg.startsWith("http")) ?? "").replace(/\/$/, "");

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const imagePath = option("image", "/tmp/notesnap-e2e-handwriting.png");
const expectRaw = option("expect", "NoteSnap test 12345|buy milk|call mum at 6");
const expectedLines = expectRaw.split("|").map((line) => line.trim());

// Preferred over a CLI flag so the key stays out of shell history and `ps`.
const userKey = process.env.X_NOTESNAP_USER_KEY || option("user-key", "");

function mimeFor(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tiff":
    case "tif":
      return "image/tiff";
    default:
      return "image/jpeg";
  }
}

/** Collapses whitespace so line-break differences don't count as wrong text. */
function normalize(line) {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

async function main() {
  if (!baseUrl) {
    console.error("Usage: node scripts/ocr-fixture.mjs <base-url> [--image <path>]");
    process.exit(2);
  }

  const bytes = await readFile(imagePath);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mimeFor(imagePath) }), basename(imagePath));

  const headers = userKey ? { "x-notesnap-user-key": userKey } : {};

  console.log(`→ POST ${baseUrl}/api/transcribe`);
  console.log(`  image: ${imagePath} (${mimeFor(imagePath)}, ${bytes.length} bytes)`);
  console.log(`  key:   ${userKey ? "caller-supplied (BYOK header)" : "server-side demo key"}\n`);

  const response = await fetch(`${baseUrl}/api/transcribe`, {
    method: "POST",
    body: form,
    headers,
  });

  const payload = await response.json().catch(() => null);
  const remaining = response.headers.get("x-ratelimit-remaining");

  console.log(`← HTTP ${response.status}`);
  if (remaining !== null) console.log(`  X-RateLimit-Remaining: ${remaining}`);
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) console.log(`  Retry-After: ${retryAfter}s`);

  if (!response.ok) {
    console.error(`\nRequest failed: ${JSON.stringify(payload)}`);
    if (response.status === 429) {
      console.error(
        "\nThis is a quota or budget limit, not a recognition failure. The provider's\n" +
          "free tier is per project and resets at midnight Pacific. Wait for the\n" +
          "reset, add a caller key via X_NOTESNAP_USER_KEY, or self-host.",
      );
    }
    if (response.status === 503) {
      console.error(
        "\nThe shared quota store is unreachable, so the demo fails closed on purpose.",
      );
    }
    process.exit(2);
  }

  const text = payload?.text ?? "";
  console.log("\n── Verbatim transcription ──");
  console.log(text);
  console.log("─────────────────────────────\n");

  const actualLines = text.split("\n").map(normalize).filter(Boolean);

  console.log("── Line-by-line comparison ──");
  let mismatches = 0;
  for (const [index, expected] of expectedLines.entries()) {
    const actual = actualLines[index];
    const ok = actual === normalize(expected);
    if (!ok) mismatches += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"}  expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual ?? "(missing)")}`);
  }

  const extra = actualLines.slice(expectedLines.length);
  if (extra.length > 0) {
    console.log(`  note: ${extra.length} extra line(s) returned: ${JSON.stringify(extra)}`);
  }

  console.log(
    mismatches === 0
      ? `\nAll ${expectedLines.length} expected line(s) matched exactly.`
      : `\n${mismatches} of ${expectedLines.length} line(s) did not match.`,
  );

  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Fixture run failed:", error.message);
  process.exit(2);
});