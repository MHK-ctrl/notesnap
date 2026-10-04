import { describe, expect, it } from "vitest";

import { MAX_EDGE_PX, fitWithin, toJpegName } from "@/lib/image";

describe("fitWithin", () => {
  it("caps the longest edge of a landscape photo", () => {
    expect(fitWithin(4000, 3000, 2200)).toEqual({ width: 2200, height: 1650 });
  });

  it("caps the longest edge of a portrait photo", () => {
    expect(fitWithin(3024, 4032, 2200)).toEqual({ width: 1650, height: 2200 });
  });

  it("leaves images that are already small enough alone", () => {
    expect(fitWithin(1200, 900, 2200)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(2200, 2200, 2200)).toEqual({ width: 2200, height: 2200 });
  });

  it("keeps the aspect ratio within a pixel", () => {
    const scaled = fitWithin(4032, 3024, 2200);
    expect(scaled.width / scaled.height).toBeCloseTo(4032 / 3024, 2);
  });

  it("never returns a zero dimension for a very thin image", () => {
    expect(fitWithin(10_000, 3, 2200)).toEqual({ width: 2200, height: 1 });
  });

  it("returns zeros for invalid dimensions", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
  });

  it("uses 2200px as the default cap", () => {
    expect(MAX_EDGE_PX).toBe(2200);
    expect(fitWithin(4400, 2200)).toEqual({ width: 2200, height: 1100 });
  });
});

describe("toJpegName", () => {
  it("swaps the extension for .jpg", () => {
    expect(toJpegName("IMG_0042.HEIC")).toBe("IMG_0042.jpg");
    expect(toJpegName("scan.png")).toBe("scan.jpg");
  });

  it("keeps multi-dot names readable", () => {
    expect(toJpegName("notes.final.v2.jpeg")).toBe("notes.final.v2.jpg");
  });

  it("handles names without an extension", () => {
    expect(toJpegName("notes")).toBe("notes.jpg");
  });
});
