// Tenants list route (#32) — `/tenants`. Loads the caller's accessible
// tenants via `principals.tenants.list` (RLS scopes the rows per the
// platform DB convention) and renders a table with a "New tenant" link.
//
// V1 omits filtering / sorting / pagination — those land as follow-ups
// once the list grows beyond demo scale.

import { For, Show, type Component } from "solid-js";
import { createResource } from "solid-js";

import AppShell from "../components/AppShell";
import { monok8sClient } from "../lib/trpc";

interface TenantRow {
  id: string;
  slug: string;
  plan: string;
  created_at: Date | string;
}

const Tenants: Component = () => {
  const [tenants] = createResource(async () => {
    const result = (await monok8sClient.principals.tenants.list.query()) as unknown as TenantRow[];
    return result;
  });

  return (
    <AppShell>
      <h1>Tenants</h1>
      <p>
        <a href="/tenants/new" data-action="tenant-new">
          + New tenant
        </a>
      </p>
      <Show when={tenants.loading}>
        <p>Loading tenants…</p>
      </Show>
      <Show when={tenants.error}>
        {(err) => <p role="alert">Failed to load: {String(err())}</p>}
      </Show>
      <Show
        when={
          !tenants.loading && !tenants.error && (tenants()?.length ?? 0) === 0
        }
      >
        <p>No tenants visible. Try creating one above.</p>
      </Show>
      <Show
        when={!tenants.loading && !tenants.error && (tenants()?.length ?? 0) > 0}
      >
        <table data-list="tenants">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Plan</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={tenants() ?? []}>
              {(t) => (
                <tr data-row-key={t.id}>
                  <td>
                    <a href={`/tenants/${t.id}`} data-action="tenant-detail">
                      {t.slug}
                    </a>
                  </td>
                  <td>{t.plan ?? "—"}</td>
                  <td>
                    {t.created_at instanceof Date
                      ? t.created_at.toISOString()
                      : String(t.created_at)}
                  </td>
                  <td>
                    <a href={`/tenants/${t.id}`}>view</a>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </AppShell>
  );
};

export default Tenants;
