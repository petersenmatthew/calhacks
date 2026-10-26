import path from "node:path";
import type { NextConfig } from "next";

/*
 * The landing page on its own, as static files for Vercel. It reuses the app's landing
 * components from ../src, so the repo root is the Turbopack root. Build: npm run build:site.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  devIndicators: false,
  turbopack: {
    root: path.join(__dirname, ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
