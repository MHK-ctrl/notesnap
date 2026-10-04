import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  formatBytes,
  validateImageFile,
} from "@/lib/validation";

describe("formatBytes", () => {
  it("formats sub-kilobyte sizes in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes and megabytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("survives nonsense input", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("validateImageFile", () => {
  it("accepts a normal JPEG", () => {
    expect(validateImageFile({ name: "notes.jpg", type: "image/jpeg", size: 2_000_000 })).toEqual({
      ok: true,
    });
  });

  it("accepts a file at exactly the size limit", () => {
    expect(
      validateImageFile({ name: "notes.png", type: "image/png", size: MAX_FILE_BYTES }),
    ).toEqual({ ok: true });
  });

  it("rejects a file one byte over the limit with a helpful message", () => {
    const result = validateImageFile({
      name: "huge.jpg",
      type: "image/jpeg",
      size: MAX_FILE_BYTES + 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_large");
    expect(result.message).toContain("10 MB");
  });

  it("rejects empty files", () => {
    const result = validateImageFile({ name: "empty.jpg", type: "image/jpeg", size: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_file");
  });

  it("rejects non-image types", () => {
    const result = validateImageFile({ name: "notes.pdf", type: "application/pdf", size: 1024 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_type");
    expect(result.message).toContain("JPEG");
  });

  it("rejects SVG, which is not a supported Vision input", () => {
    const result = validateImageFile({ name: "diagram.svg", type: "image/svg+xml", size: 1024 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_type");
  });

  it("rejects text files that merely look like images by extension", () => {
    const result = validateImageFile({
      name: "notes.txt",
      type: "text/plain",
      size: 1024,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts HEIC when the browser reports no MIME type", () => {
    // iOS Safari sometimes reports an empty `type` for HEIC files.
    expect(validateImageFile({ name: "IMG_0042.HEIC", type: "", size: 3_000_000 })).toEqual({
      ok: true,
    });
  });

  it("is case-insensitive about MIME types and extensions", () => {
    expect(validateImageFile({ name: "A.JPG", type: "IMAGE/JPEG", size: 1024 })).toEqual({
      ok: true,
    });
  });

  it("rejects NaN sizes", () => {
    const result = validateImageFile({ name: "weird.jpg", type: "image/jpeg", size: Number.NaN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_file");
  });
});
