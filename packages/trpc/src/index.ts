import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

// observable is the canonical return type for tRPC v11 subscription
// procedures — the SSE adapter unrolls it into a stream. Re-exported
// from @monok8s/trpc so subscription authors don't reach into the
// upstream module directly.
export { observable };

export type { Context } from "./context";

// Client-side factory (#192 / #91 Phase C). Re-exported here so the
// single-segment `@monok8s/trpc` specifier covers both server-side
// router primitives and the SolidJS client. Avoids the
// nested-specifier `@monok8s/trpc/client` path that the project's
// runtime resolvers (tools/bazel/monok8s-esm-resolver.mjs) don't
// support today.
export {
  createMonok8sClient,
  credentialsFetch,
  isSubscription,
  type CreateMonok8sClientOptions,
} from "./client.js";
