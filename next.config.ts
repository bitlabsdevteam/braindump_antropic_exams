import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typedRoutes: true,
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: {
    "/api/tutor": ["./SOUL.MD", "./prompts/personal-ai-tutor.system.md"],
  },
};

export default nextConfig;
