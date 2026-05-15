import { lazy } from "solid-js";
import type { RouteDefinition } from "@solidjs/router";

// Route table (#91 Phase A). Every authed route mounts AppShell
// internally (so the navigation chrome is present); RoleDefault at "/"
// redirects by role per defaultRouteForRole().
//
// Phase B (OIDC) adds an unauthed /login route + an auth-guard wrapper
// before the AppShell components mount. Phase C (tRPC client) wires
// real data into each stub.
export const routes: RouteDefinition[] = [
  {
    path: "/",
    component: lazy(() => import("./RoleDefault")),
  },
  {
    path: "/dashboard",
    component: lazy(() => import("./Dashboard")),
  },
  {
    path: "/principals",
    component: lazy(() => import("./Principals")),
  },
  {
    path: "/tenants",
    component: lazy(() => import("./Tenants")),
  },
  {
    path: "/tenants/new",
    component: lazy(() => import("./TenantNew")),
  },
  {
    path: "/tenants/:id",
    component: lazy(() => import("./TenantDetail")),
  },
  {
    path: "/workflows",
    component: lazy(() => import("./Workflows")),
  },
  {
    path: "/audit",
    component: lazy(() => import("./Audit")),
  },
  {
    path: "/resources",
    component: lazy(() => import("./Resources")),
  },
  {
    path: "**",
    component: lazy(() => import("./NotFound")),
  },
];
