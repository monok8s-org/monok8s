// AppShell — navigation chrome wrapping every authed route (#91 Phase A).
//
// Top bar: project name + tenant switcher dropdown + user menu.
// Left sidebar: nav items (Dashboards / Principals / Workflows / Audit /
// Resources). Active route highlighted via @solidjs/router's
// useCurrentMatches hook.
//
// Phase A renders against the stub AuthProvider — every UI surface
// here works with the hardcoded user. Phase B replaces the auth source
// with real OIDC; this component doesn't change.
//
// Cloud-neutral per #91's AC ("no 'Hosted on AWS' branding — cloud is
// implicit via apex URL"). The top bar shows the project name and the
// active tenant; nothing about the underlying cloud provider.

import { useLocation, A } from "@solidjs/router";
import { For, Show, type Component, type JSX } from "solid-js";

import { useAuth } from "../lib/auth";

interface NavItem {
  to: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/principals", label: "Principals" },
  { to: "/workflows", label: "Workflows" },
  { to: "/audit", label: "Audit log" },
  { to: "/resources", label: "Resources" },
];

const AppShell: Component<{ children: JSX.Element }> = (props) => {
  const auth = useAuth();
  const location = useLocation();

  return (
    <Show
      when={!auth.loading()}
      fallback={<div role="status">Loading…</div>}
    >
      <div class="app-shell">
        {/* Top bar */}
        <header class="app-shell__top">
          <div class="app-shell__brand">
            <strong>monok8s</strong>
          </div>
          <Show when={auth.user()}>
            {(user) => (
              <div class="app-shell__top-right">
                {/* Tenant switcher */}
                <label class="app-shell__tenant" for="tenant-switcher">
                  Tenant
                  <select
                    id="tenant-switcher"
                    value={user().tenantId}
                    onChange={(e) =>
                      auth.switchTenant((e.target as HTMLSelectElement).value)
                    }
                  >
                    <For each={user().tenants}>
                      {(tenant) => (
                        <option value={tenant.id}>{tenant.name}</option>
                      )}
                    </For>
                  </select>
                </label>
                {/* User menu */}
                <span class="app-shell__user" aria-label="signed-in user">
                  {user().name}
                </span>
              </div>
            )}
          </Show>
        </header>

        {/* Sidebar + main */}
        <div class="app-shell__body">
          <nav class="app-shell__sidebar" aria-label="primary">
            <ul>
              <For each={NAV_ITEMS}>
                {(item) => (
                  <li>
                    <A
                      href={item.to}
                      activeClass="app-shell__nav--active"
                      // `end` matches /dashboard exactly so /dashboard/foo
                      // doesn't keep the Dashboard item highlighted.
                      end={item.to === "/dashboard"}
                      data-active={location.pathname.startsWith(item.to)}
                    >
                      {item.label}
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </nav>

          <main class="app-shell__main">{props.children}</main>
        </div>
      </div>
    </Show>
  );
};

export default AppShell;
