// Role-based default-route redirect (#91 Phase A AC).
//
// Mounted at "/". Resolves the user's role via useAuth() and
// redirects to the role's default landing route. Pure function logic
// (defaultRouteForRole) lives in lib/auth so the redirect is testable
// without mounting the router.

import { Navigate } from "@solidjs/router";
import { Show, type Component } from "solid-js";

import { defaultRouteForRole, useAuth } from "../lib/auth";

const RoleDefault: Component = () => {
  const auth = useAuth();
  return (
    <Show when={!auth.loading()} fallback={<div role="status">Loading…</div>}>
      <Show when={auth.user()}>
        {(user) => <Navigate href={defaultRouteForRole(user().role)} />}
      </Show>
    </Show>
  );
};

export default RoleDefault;
