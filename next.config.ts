import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "pg-pool", "@electric-sql/pglite", "drizzle-orm"],
  experimental: {
    // Phải lớn hơn MAX_LIST_BASE64 (6 MB) cộng phần bao JSON của Server Action.
    serverActions: { bodySizeLimit: "8mb" },
    // Giữ cache điều hướng phía client 30 giây: bấm qua lại giữa các tab không tải lại toàn bộ trang
    staleTimes: { dynamic: 30, static: 180 },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  logging: { fetches: { fullUrl: false } },
};

export default nextConfig;
