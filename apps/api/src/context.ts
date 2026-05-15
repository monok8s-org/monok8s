import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import type { Context as BaseContext } from "@monok8s/trpc";

import { getConfig, type AppConfig } from "./config.js";

// AppContext extends the minimal BaseContext (defined in
// @monok8s/trpc to avoid the circular package edge) with the
// app-local config object resolved at module-load time via
// loadConfig() (#195 — Locality).
//
// The Temporal WorkflowClient is NOT a field on AppContext — tRPC's
// procedure-builder type chain wouldn't see it through middleware
// inference. It's added per-procedure via the `withTemporal`
// middleware from ./middleware/temporal.js (#222 + #224 wiring).
//
// Direct re-export of BaseContext is kept for back-compat with code
// imported under the old `Context` name. New code should reach for
// `AppContext` to get the config-aware type.
export type Context = BaseContext;
export interface AppContext extends BaseContext {
  config: AppConfig;
}

export async function createContext({
  req,
}: CreateHTTPContextOptions): Promise<AppContext> {
  // Extract verified JWT from Zitadel, resolve SpiceDB subject
  const token = req.headers.authorization?.replace("Bearer ", "");
  return { token, config: getConfig() };
}
