/**
 * Browser-side image preparation: decode → resize → re-encode as JPEG.
 *
 * A 12 MP phone photo is several megabytes and takes seconds to upload. Capping
 * the longest edge at 2200px keeps handwriting legible for OCR while cutting
 * upload size (and Vision's payload) dramatically.
 *
 * Everything here runs in the browser; `lib/image.ts` is never imported by the
 * API route.
 */

/** Longest edge of the re-encoded image, in pixels. */
export const MAX_EDGE_PX = 2200;

/** JPEG quality for the re-encoded image. High enough for OCR. */
export const JPEG_QUALITY = 0.9;

/** Below this, re-encoding usually costs more bytes than it saves. */
const ORIGINAL_IS_SMALL_BYTES = 300 * 1024;

export interface PreparedImage {
  /** The file to upload: the compressed one when compression helped. */
  file: File;
  /** Object URL for the preview. Call `releasePreviewUrl` when done with it. */
  previewUrl: string;
  /** Natural dimensions after resizing, or 0 when the image couldn't decode. */
  width: number;
  height: number;
  /** Size of `file`, in bytes. */
  bytes: number;
  /** True when the file was resized/re-encoded before upload. */
  recompressed: boolean;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Scales `width x height` down so the longest edge is at most `maxEdge`.
 * Images already within the limit are returned unchanged. Pure, so it is
 * unit-tested directly.
 */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_EDGE_PX): Size {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  if (maxEdge <= 0) return { width: Math.round(width), height: Math.round(height) };

  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Renames a file to a .jpg name, for the re-encoded output. */
export function toJpegName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, "") || "notes";
  return `${base}.jpg`;
}

/**
 * Decodes, resizes and re-encodes an image for upload.
 *
 * If the browser can't decode the file (e.g. HEIC on some Android browsers), the
 * original file is returned untouched so the request can still be attempted.
 */
export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("prepareImageForUpload() runs in the browser only.");
  }

  const original: PreparedImage = {
    file,
    previewUrl: URL.createObjectURL(file),
    width: 0,
    height: 0,
    bytes: file.size,
    recompressed: false,
  };

  let decoded: ImageBitmap | HTMLImageElement;
  try {
    decoded = await decodeImage(file);
  } catch {
    // Undecodable here — let the server and Vision have a go at it.
    return original;
  }

  const sourceWidth = "naturalWidth" in decoded ? decoded.naturalWidth : decoded.width;
  const sourceHeight = "naturalHeight" in decoded ? decoded.naturalHeight : decoded.height;
  const target = fitWithin(sourceWidth, sourceHeight);

  if (target.width === 0 || target.height === 0) {
    closeDecoded(decoded);
    return original;
  }

  const needsResize = target.width !== sourceWidth || target.height !== sourceHeight;
  if (!needsResize && file.size <= ORIGINAL_IS_SMALL_BYTES) {
    closeDecoded(decoded);
    return { ...original, width: sourceWidth, height: sourceHeight };
  }

  let blob: Blob | null = null;
  try {
    blob = await renderToJpeg(decoded, target);
  } catch {
    blob = null;
  } finally {
    closeDecoded(decoded);
  }

  // Keep the original when re-encoding made things worse.
  if (!blob || blob.size === 0 || (blob.size >= file.size && !needsResize)) {
    return { ...original, width: sourceWidth, height: sourceHeight };
  }

  const compressed = new File([blob], toJpegName(file.name), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });

  URL.revokeObjectURL(original.previewUrl);

  return {
    file: compressed,
    previewUrl: URL.createObjectURL(compressed),
    width: target.width,
    height: target.height,
    bytes: compressed.size,
    recompressed: true,
  };
}

/** Frees an object URL created by `prepareImageForUpload`. */
export function releasePreviewUrl(url: string | null | undefined): void {
  if (url) URL.revokeObjectURL(url);
}

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image failed to load"));
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderToJpeg(source: ImageBitmap | HTMLImageElement, target: Size): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // Flatten transparency onto white: JPEG has no alpha channel and recorded
  // handwriting reads better on a light background.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0, target.width, target.height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", JPEG_QUALITY);
  });
}

function closeDecoded(decoded: ImageBitmap | HTMLImageElement): void {
  if (typeof ImageBitmap !== "undefined" && decoded instanceof ImageBitmap) {
    decoded.close();
  }
}
