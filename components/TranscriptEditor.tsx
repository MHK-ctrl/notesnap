"use client";

import { useEffect, useRef, useState } from "react";

export interface TranscriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRetry: () => void;
  onStartOver: () => void;
  busy: boolean;
}

type CopyState = "idle" | "copied" | "manual";

/**
 * Editable transcription result.
 *
 * The textarea is deliberately plain: what Vision read is what you see, so OCR
 * mistakes stay visible and fixable instead of being silently "corrected".
 */
export default function TranscriptEditor({
  value,
  onChange,
  onRetry,
  onStartOver,
  busy,
}: TranscriptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  const wordCount = value.trim() === "" ? 0 : value.trim().split(/\s+/).length;

  async function handleCopy() {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    try {
      if (clipboard?.writeText) {
        await clipboard.writeText(value);
      } else if (!legacyCopy(textareaRef.current)) {
        throw new Error("Clipboard unavailable");
      }
      setCopyState("copied");
    } catch {
      setCopyState(legacyCopy(textareaRef.current) ? "copied" : "manual");
    }
  }

  return (
    <section aria-labelledby="transcript-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="transcript-heading" className="text-lg font-semibold text-slate-900">
            Your text
          </h2>
          <p className="text-xs text-slate-600">
            Exactly as read — no autocorrect. Fix anything that looks off, then copy.
          </p>
        </div>
        <p className="text-xs text-slate-500">
          {wordCount} {wordCount === 1 ? "word" : "words"} · {value.length} characters
        </p>
      </div>

      <label htmlFor="transcript" className="sr-only">
        Transcription text (editable)
      </label>
      <textarea
        id="transcript"
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        spellCheck
        aria-describedby="transcript-hint"
        className="w-full resize-y rounded-xl border border-slate-300 bg-white p-4 font-mono text-sm leading-relaxed text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none sm:text-base"
      />
      <p id="transcript-hint" className="text-xs text-slate-500">
        Nothing you type or paste here is saved — this page lives only in your browser tab.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
        >
          {copyState === "copied" ? "Copied!" : "Copy text"}
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition-colors ${
            busy ? "cursor-not-allowed opacity-60" : "hover:bg-slate-100"
          }`}
        >
          {busy ? "Re-transcribing…" : "Re-transcribe"}
        </button>
        <button
          type="button"
          onClick={onStartOver}
          disabled={busy}
          className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 underline decoration-slate-300 underline-offset-4 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Start over
        </button>
        <span role="status" aria-live="polite" className="text-sm font-medium text-emerald-700">
          {copyState === "copied" ? "Copied to clipboard" : null}
          {copyState === "manual" ? "Press Ctrl/Cmd + C to copy the selected text" : null}
        </span>
      </div>
    </section>
  );
}

/** Fallback for browsers without the async clipboard API (or non-secure origins). */
function legacyCopy(element: HTMLTextAreaElement | null): boolean {
  if (!element || typeof document === "undefined") return false;
  try {
    element.focus();
    element.select();
    return document.execCommand("copy");
  } catch {
    return false;
  }
}
