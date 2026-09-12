import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Defense in depth for a site with no sessions or auth: nothing here may be framed, sniffed,
  // or handed a referrer, and the API only ever answers same-origin JSON.
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
      ],
    }];
  },
  // Both route groups read repository files at runtime: search loads the committed index
  // artifacts and the guide loads the project documentation. Tracing them explicitly means a
  // Vercel deployment cannot ship a function bundle that is missing its own corpus.
  outputFileTracingIncludes: {
    "/api/search": ["./data/search/**"],
    "/api/summarize": ["./data/search/**", "./docs/**"],
    "/api/health": ["./data/search/index_manifest.json"],
    "/api/chat": ["./docs/**"],
  },
};

export default nextConfig;
