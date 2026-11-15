import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Builds a self-contained server in .next/standalone, which the Dockerfile runs.
  output: "standalone",
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
