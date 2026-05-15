// Frontend tRPC client singleton (#192 / #91 Phase C).
//
// Per frontend/CLAUDE.md: "The tRPC client is configured once in
// src/lib/trpc.ts and imported everywhere." Routes import
// `monok8sClient` directly and never construct their own.
//
// AppRouter is the type-only export from apps/api/src/router.ts —
// type-only because the frontend cannot pull the apps/api runtime
// code into the SPA bundle (no server deps + no @trpc/server in
// the browser). esbuild strips the type import; the runtime
// continues to call apps/api over HTTP via the BFF.

import { createMonok8sClient } from "@monok8s/trpc";

import type { AppRouter } from "../../../apps/api/src/router";

// `/api/trpc` is served by apps/api's standalone tRPC HTTP server.
// Dev: Vite's proxy in vite.config.ts forwards /api/* to localhost:3000.
// Prod: same path under the nginx-served SPA, terminated by the
// Cilium Gateway → apps/api Service routing.
export const monok8sClient = createMonok8sClient<AppRouter>({
  url: "/api/trpc",
});
