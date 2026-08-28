import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
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
