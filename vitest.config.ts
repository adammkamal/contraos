import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "edge-runtime", include: ["tests/**/*.test.ts", "convex/**/*.test.ts"], testTimeout: 15000 } });
