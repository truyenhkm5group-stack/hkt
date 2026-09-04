import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "pg-pool", "@electric-sql/pglite", "drizzle-orm"],
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  logging: { fetches: { fullUrl: false } },
};

export default nextConfig;
