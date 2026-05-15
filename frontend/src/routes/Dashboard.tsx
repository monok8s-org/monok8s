// Dashboard route — #91 Phase C wires the first tRPC query: the
// active tenant's record fetched via principals.tenants.get(id). Real
// tile/widget UI lands with #93 / #94 / #97; Phase C just demonstrates
// the typed query path works end-to-end against apps/api.

import { Show, type Component } from "solid-js";
import { createResource } from "solid-js";

import AppShell from "../components/AppShell";
import { useAuth } from "../lib/auth";
import { monok8sClient } from "../lib/trpc";

const Dashboard: Component = () => {
  const { user } = useAuth();

  const [tenant] = createResource(
    () => user()?.tenantId,
    async (id: string) => monok8sClient.principals.tenants.get.query({ id }),
  );

  return (
    <AppShell>
      <h1>Dashboard</h1>
      <Show when={tenant.loading}>
        <p>Loading tenant…</p>
      </Show>
      <Show when={tenant.error}>
        <p>Failed to load tenant: {String(tenant.error)}</p>
      </Show>
      <Show when={tenant()}>
        {(t) => (
          <dl>
            <dt>slug</dt>
            <dd>{t().slug}</dd>
            <dt>plan</dt>
            <dd>{t().plan ?? "—"}</dd>
          </dl>
        )}
      </Show>
      <p>TODO: tenant overview tiles (#93, #94, #97 wire here).</p>
    </AppShell>
  );
};

export default Dashboard;
