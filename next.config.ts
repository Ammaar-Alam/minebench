import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Avoid stale client/server bundle divergence when watch limits are hit locally.
      config.cache = false;
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/.git/**",
          "**/.next/**",
          "**/node_modules/**",
          "**/uploads/**",
          "**/assets/texture-pack/**",
        ],
      };
    }

    return config;
  },
};

export default withWorkflow(nextConfig);
