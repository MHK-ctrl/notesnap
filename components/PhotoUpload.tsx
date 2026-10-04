"use client";

import { useId, useState } from "react";

export type UploadStatus = "idle" | "preparing" | "ready" | "transcribing" | "done";

export interface PhotoPreview {
  url: string;
  name: string;
  sizeLabel: string;
  dimensionsLabel: string | null;
  recompressed: boolean;
}

export interface PhotoUploadProps {
  preview: PhotoPreview | null;
  status: UploadStatus;
  onSelect: (file: File) => void;
  onClear: () => void;
}

const busyStatuses: UploadStatus[] = ["preparing", "transcribing"];

/**
 * Photo picker.
 *
 * Two inputs on purpose: `capture="environment"` sends phones straight to the
 * rear camera (the main use case), while the second input lets anyone pick an
 * existing photo from their library.
 */
export default function PhotoUpload({ preview, status, onSelect, onClear }: PhotoUploadProps) {
  const cameraInputId = useId();
  const libraryInputId = useId();
  const [isDragging, setIsDragging] = useState(false);

  const busy = busyStatuses.includes(status);

  function handleFiles(files: readonly File[]) {
    const candidate = files[0];
    if (!candidate) {
      // A cleared or cancelled picker fires with nothing selected. Do nothing:
      // an error message here would just be noise on top of a working flow.
      return;
    }
    onSelect(candidate);
  }

  /**
   * Reads the selection into a plain array *before* the input is cleared.
   * `input.files` is live: resetting `input.value` empties it in place, so
   * holding onto the FileList itself would lose the file.
   */
  function takeSelectedFiles(input: HTMLInputElement): File[] {
    const selected = Array.from(input.files ?? []);
    // Reset so picking the same photo again still fires onChange.
    input.value = "";
    return selected;
  }

  return (
    <div className="space-y-4">
      <input
        id={cameraInputId}
        className="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={busy}
        onChange={(event) => handleFiles(takeSelectedFiles(event.target))}
      />
      <input
        id={libraryInputId}
        className="sr-only"
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={(event) => handleFiles(takeSelectedFiles(event.target))}
      />

      {preview ? (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob URL, next/image adds nothing here */}
          <img
            src={preview.url}
            alt="Preview of the photo you selected"
            className="mx-auto max-h-72 w-auto rounded-xl border border-slate-200 bg-white object-contain"
          />
          <dl className="text-center text-xs text-slate-600">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              <dt className="sr-only">Selected file</dt>
              <dd className="font-medium text-slate-700">{preview.name}</dd>
              <dt className="sr-only">File size</dt>
              <dd>· {preview.sizeLabel}</dd>
              {preview.dimensionsLabel ? (
                <>
                  <dt className="sr-only">Image dimensions</dt>
                  <dd>· {preview.dimensionsLabel}</dd>
                </>
              ) : null}
              {preview.recompressed ? (
                <dd className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                  resized before upload
                </dd>
              ) : null}
            </div>
          </dl>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <label
              htmlFor={cameraInputId}
              className={secondaryButtonClass(busy)}
              aria-disabled={busy}
            >
              Take another photo
            </label>
            <label
              htmlFor={libraryInputId}
              className={secondaryButtonClass(busy)}
              aria-disabled={busy}
            >
              Choose from library
            </label>
            <button type="button" onClick={onClear} className={ghostButtonClass} disabled={busy}>
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            if (busy) return;
            handleFiles(Array.from(event.dataTransfer?.files ?? []));
          }}
          className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
            isDragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-white"
          }`}
        >
          <CameraIcon />
          <label htmlFor={cameraInputId} className={primaryButtonClass(busy)} aria-disabled={busy}>
            Take a photo
          </label>
          <label htmlFor={libraryInputId} className={secondaryButtonClass(busy)} aria-disabled={busy}>
            Upload from device
          </label>
          <p className="text-xs text-slate-500">
            JPEG, PNG, WebP, HEIC, GIF, BMP or TIFF · up to 10&nbsp;MB · photos are resized
            in your browser before upload
          </p>
        </div>
      )}

    </div>
  );
}

function CameraIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      className="h-10 w-10 text-slate-400"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2a1 1 0 0 0 .84-.46l.72-1.1A1.5 1.5 0 0 1 9.48 4h5.04a1.5 1.5 0 0 1 1.25.44l.72 1.1a1 1 0 0 0 .84.46h1.17A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-8Z"
      />
      <circle cx="12" cy="12.25" r="3.25" />
    </svg>
  );
}

const baseButton =
  "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors";

function primaryButtonClass(disabled: boolean): string {
  return `${baseButton} ${
    disabled
      ? "cursor-not-allowed bg-indigo-300 text-white"
      : "cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700"
  }`;
}

function secondaryButtonClass(disabled: boolean): string {
  return `${baseButton} border border-slate-300 bg-white text-slate-800 ${
    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-slate-100"
  }`;
}

const ghostButtonClass = `${baseButton} text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900`;
