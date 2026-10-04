"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import PhotoUpload, { type PhotoPreview, type UploadStatus } from "@/components/PhotoUpload";
import TranscriptEditor from "@/components/TranscriptEditor";
import { prepareImageForUpload, releasePreviewUrl, type PreparedImage } from "@/lib/image";
import { formatBytes, validateImageFile } from "@/lib/validation";

/** Update this if you fork the project under a different account. */
const REPO_URL = "https://github.com/MHK-ctrl/notesnap";

interface TranscribeResponse {
  text?: string;
  error?: { code?: string; message?: string };
}

export default function HomePage() {
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const previewUrlRef = useRef<string | null>(null);

  // Never leak blob URLs when the tab unmounts.
  useEffect(() => {
    return () => releasePreviewUrl(previewUrlRef.current);
  }, []);

  const runTranscription = useCallback(async (file: File) => {
    setError(null);
    setStatus("transcribing");

    const body = new FormData();
    body.append("image", file, file.name);

    try {
      const response = await fetch("/api/transcribe", { method: "POST", body });
      const payload = (await response.json().catch(() => null)) as TranscribeResponse | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? messageForStatus(response.status));
        setStatus("ready");
        return;
      }

      const text = payload?.text?.trim() ?? "";
      if (text === "") {
        setError("That page came back empty. Try a sharper photo with more light.");
        setStatus("ready");
        return;
      }

      setTranscript(text);
      setStatus("done");
    } catch {
      setError("We couldn't reach the transcription service. Check your connection and try again.");
      setStatus("ready");
    }
  }, []);

  const handleSelect = useCallback(
    async (candidate: File) => {
      setError(null);

      // Same checks the server runs — this one is just for instant feedback.
      const validation = validateImageFile(candidate);
      if (!validation.ok) {
        setStatus("idle");
        setError(validation.message);
        return;
      }

      setStatus("preparing");

      let next: PreparedImage;
      try {
        next = await prepareImageForUpload(candidate);
      } catch {
        setStatus("idle");
        setError(
          "We couldn't open that photo in your browser. Try a JPEG or PNG version of it.",
        );
        return;
      }

      releasePreviewUrl(previewUrlRef.current);
      previewUrlRef.current = next.previewUrl;
      setPrepared(next);
      setTranscript("");
      setStatus("ready");

      // Transcribe straight away: one tap on the phone, no second button.
      await runTranscription(next.file);
    },
    [runTranscription],
  );

  const handleRetry = useCallback(() => {
    if (!prepared) return;
    void runTranscription(prepared.file);
  }, [prepared, runTranscription]);

  const handleStartOver = useCallback(() => {
    releasePreviewUrl(previewUrlRef.current);
    previewUrlRef.current = null;
    setPrepared(null);
    setTranscript("");
    setError(null);
    setStatus("idle");
  }, []);

  const preview: PhotoPreview | null = prepared
    ? {
        url: prepared.previewUrl,
        name: prepared.file.name,
        sizeLabel: formatBytes(prepared.file.size),
        dimensionsLabel:
          prepared.width > 0 && prepared.height > 0
            ? `${prepared.width}×${prepared.height}`
            : null,
        recompressed: prepared.recompressed,
      }
    : null;

  const statusMessage = describeStatus(status);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          NoteSnap
        </h1>
        <p className="text-base text-slate-600 sm:text-lg">
          Snap a photo of handwritten notes — notebook, whiteboard, sticky note — and get clean,
          paste-ready text in seconds.
        </p>
      </header>

      <section
        aria-labelledby="upload-heading"
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <h2 id="upload-heading" className="text-lg font-semibold text-slate-900">
          {prepared ? "Your photo" : "Add a photo"}
        </h2>
        <PhotoUpload
          preview={preview}
          status={status}
          onSelect={(file) => void handleSelect(file)}
          onClear={handleStartOver}
        />
      </section>

      <p role="status" aria-live="polite" className="min-h-6 text-sm text-slate-600">
        {statusMessage}
      </p>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900">That didn&rsquo;t work</p>
          <p className="mt-1 text-sm text-red-800">{error}</p>
          {prepared ? (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-800"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {status === "transcribing" ? (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600"
          />
          Reading your handwriting…
        </p>
      ) : null}

      {/* Kept mounted while re-transcribing so the previous text stays visible. */}
      {transcript !== "" ? (
        <TranscriptEditor
          value={transcript}
          onChange={setTranscript}
          onRetry={handleRetry}
          onStartOver={handleStartOver}
          busy={status === "transcribing"}
        />
      ) : null}

      <footer className="mt-auto space-y-2 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>
          Privacy: your photo is sent to our OCR provider (Google) for processing and is never
          stored by this app — no database, no bucket, no logs of your images.
        </p>
        <p>
          Open source (MIT) ·{" "}
          <a
            href={REPO_URL}
            className="font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-900"
          >
            Fork it on GitHub
          </a>{" "}
          — each deployer brings their own OCR API key.
        </p>
      </footer>
    </main>
  );
}

function describeStatus(status: UploadStatus): string {
  switch (status) {
    case "preparing":
      return "Preparing your photo (resizing it in your browser)…";
    case "ready":
      return "Photo ready.";
    case "transcribing":
      return "Transcribing your notes…";
    case "done":
      return "Transcription ready — review it below.";
    case "idle":
      return "";
    default:
      return "";
  }
}

function messageForStatus(status: number): string {
  if (status === 413) {
    return "That photo is larger than the 10 MB limit. Try a smaller one.";
  }
  if (status === 429) {
    return "Too many transcriptions in a row. Wait a minute and try again.";
  }
  if (status === 422) {
    return "No handwriting found in that photo. Get closer, add light, and try again.";
  }
  return "The transcription service had a problem. Please try again in a moment.";
}
