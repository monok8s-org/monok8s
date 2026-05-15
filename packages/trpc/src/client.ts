// tRPC v11 client factory for the SolidJS shell (#192 / #91 Phase C).
//
// Composes splitLink over two transports so a single client handles
// both queries/mutations (httpBatchLink) and subscriptions (httpSub-
// scriptionLink over SSE) with one URL. The cookie session minted by
// apps/api's BFF (#191 Phase B) rides along because the default
// fetcher passes `credentials: "include"`.
//
// Generic over `TRouter` so packages/trpc doesn't take a dep on apps/api;
// the consuming module (frontend/src/lib/trpc.ts) supplies the
// `AppRouter` type at the call site.
//
// Per code-design.md Rule 2 effect_then_interceptor: the link
// fetcher + EventSource ctor are injected (defaults to global
// fetch + globalThis.EventSource) so L1 tests inject fakes without
// monkey-patching globals.

import type { AnyRouter } from "@trpc/server";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
  type CreateTRPCClient,
  type Operation,
  type TRPCLink,
} from "@trpc/client";

export interface CreateMonok8sClientOptions {
  url: string;
  // Optional fetch override — L1 tests inject a stub. Defaults to
  // globalThis.fetch wrapped to thread `credentials: "include"` so
  // the BFF session cookie travels.
  fetch?: typeof fetch;
  // Optional EventSource ctor override — L1 tests inject a stub.
  // Defaults to globalThis.EventSource. SSR contexts that lack
  // EventSource should pass a ponyfill explicitly.
  EventSource?: typeof EventSource;
}

// Pure predicate: which link handles a given op. Exported for L1
// tests — splitLink consumes it internally but the contract that
// "every subscription routes through SSE, everything else through
// the batch link" is the testable invariant.
export function isSubscription(op: Operation): boolean {
  return op.type === "subscription";
}

// credentialsFetch — wraps fetch so the cookie session from
// apps/api's BFF rides every request. Exposed so callers can compose
// further (e.g. tracing headers) without re-implementing the
// credentials-include wiring.
export function credentialsFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) =>
    fetcher(input, { ...init, credentials: "include" });
}

export function createMonok8sClient<TRouter extends AnyRouter>(
  opts: CreateMonok8sClientOptions,
): CreateTRPCClient<TRouter> {
  const fetcher = credentialsFetch(opts.fetch);
  const eventSourceCtor = opts.EventSource ?? globalThis.EventSource;

  // Link option types in tRPC v11 carry a conditional `TransformerOptions`
  // over the router's transformer flag. With an unconstrained
  // `TRouter extends AnyRouter`, TypeScript can't narrow the conditional,
  // so the literal options object isn't assignable in the generic
  // position. The cast-through-unknown is safe — monok8s never
  // configures a server-side transformer (jose JSON only), and concrete
  // callers (frontend/src/lib/trpc.ts uses createMonok8sClient<AppRouter>)
  // get the narrowed conditional path checked at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscriptionLink = (httpSubscriptionLink as any)({
    url: opts.url,
    EventSource: eventSourceCtor,
  }) as TRPCLink<TRouter>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batchLink = (httpBatchLink as any)({
    url: opts.url,
    fetch: fetcher,
  }) as TRPCLink<TRouter>;

  return createTRPCClient<TRouter>({
    links: [
      splitLink({
        condition: isSubscription,
        true: subscriptionLink,
        false: batchLink,
      }),
    ],
  });
}
