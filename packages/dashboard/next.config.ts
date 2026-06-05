import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const dashboardDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Dev is served via portless on custom domains (dashboard.polpo.localhost,
  // not localhost). Next dev blocks cross-origin requests to its internal
  // dev assets — including the HMR WebSocket (`/_next/*-hmr`) — unless the
  // origin is allowlisted here. Without this, HMR fails in a reconnect loop
  // and the page never hot-reloads. Tightened by the Next upgrade, which is
  // why it broke. Include the exact hosts + a wildcard for any subdomain.
  allowedDevOrigins: [
    "dashboard.polpo.localhost",
    "api.polpo.localhost",
    "*.polpo.localhost",
    "polpo.localhost",
  ],
  turbopack: {
    root: join(dashboardDir, "../.."),
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  // @lumea-labs/chat ships .ts source (no dist); Next must transpile it.
  // chat-polpo ships built dist and doesn't need to be listed.
  transpilePackages: ["@lumea-labs/chat"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // Keep visited route segments in the client Router Cache so switching
    // between agent tabs (each is its own segment) is instant instead of
    // re-rendering + refetching on the server every time. First visit per
    // tab still loads lazily; re-visits within the window are cached.
    staleTimes: {
      dynamic: 180,
      static: 300,
    },
  },
  async rewrites() {
    return [
      {
        source: "/blog/:slug.md",
        destination: "/api/blog/:slug/md",
      },
    ];
  },
};

export default nextConfig;
