import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // CSV imports send parsed rows to a Server Action.
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
