import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

// Pin the tracing root to this directory: without it, Next.js walks up looking
// for lockfiles and can pick an unrelated parent directory as the project root.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: projectRoot,
  // The OCR route is the only server code in the app. Keep the runtime explicit
  // so the Vision API key can never be bundled into client JavaScript.
  serverExternalPackages: [],
};

export default nextConfig;
