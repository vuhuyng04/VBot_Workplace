import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Production: a static export (out/) that FastAPI serves next to /api from the same Lambda.
// Dev: `next dev` proxies /api to a local uvicorn (VBOT_API, default http://127.0.0.1:8000).
export default function config(phase: string): NextConfig {
  const base: NextConfig = { turbopack: { root: __dirname } };
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const api = process.env.VBOT_API || "http://127.0.0.1:8000";
    return { ...base, rewrites: async () => [{ source: "/api/:path*", destination: `${api}/api/:path*` }] };
  }
  return { ...base, output: "export", images: { unoptimized: true }, poweredByHeader: false };
}
