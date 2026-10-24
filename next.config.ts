import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module, and the mail libraries load optional modules at runtime; keep them out of the server bundle.
  serverExternalPackages: ["better-sqlite3", "nodemailer", "imapflow", "mailparser"],
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
