// Shared tRPC context shape. Lifted from apps/api/src/context.ts to break the
// circular package edge (apps/api depends on @monok8s/trpc; @monok8s/trpc must
// not depend on apps/api).
//
// The minimal Context only carries the bearer token. apps/api enriches it via
// middleware (authMiddleware adds `user`; route-specific middleware adds
// `temporal`, `db`, `gcpMarketplaceTokenVerified`, etc.). Those richer shapes
// stay app-local — only the minimum cross-package surface lives here.

export interface Context {
  token: string | undefined;
}
