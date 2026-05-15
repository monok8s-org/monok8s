// Tenant detail route (#32) — `/tenants/:id`. Loads the tenant via
// `tenants.ping` (V1 read-only platform-DB lookup) and renders the
// shape. The original AC named this a "ping" button — V1 ships an
// inline auto-load so the detail view loads as soon as the page
// mounts. Follow-up adds the workflow-status panel for monitoring
// the OnboardTenantWorkflow lifecycle.

import { Show, type Component } from "solid-js";
import { createResource } from "solid-js";
import { useParams } from "@solidjs/router";

import AppShell from "../components/AppShell";
import { monok8sClient } from "../lib/trpc";

interface TenantShape {
  id: string;
  slug: string;
  plan: string;
  created_at: Date | string;
}

const TenantDetail: Component = () => {
  const params = useParams<{ id: string }>();

  const [tenant] = createResource(
    () => params.id,
    async (id: string) => {
      const result = (await monok8sClient.principals.tenants.ping.query({
        id,
      })) as unknown as TenantShape | null;
      return result;
    },
  );

  return (
    <AppShell>
      <h1>
        Tenant <code>{params.id}</code>
      </h1>
      <p>
        <a href="/tenants">← back to tenants</a>
      </p>
      <Show when={tenant.loading}>
        <p>Loading tenant…</p>
      </Show>
      <Show when={tenant.error}>
        {(err) => <p role="alert">Failed to load tenant: {String(err())}</p>}
      </Show>
      <Show
        when={!tenant.loading && !tenant.error && tenant() === null}
      >
        <p>Tenant not found.</p>
      </Show>
      <Show when={tenant()}>
        {(t) => (
          <dl data-section="tenant-detail">
            <dt>id</dt>
            <dd>
              <code>{t().id}</code>
            </dd>
            <dt>slug</dt>
            <dd>{t().slug}</dd>
            <dt>plan</dt>
            <dd>{t().plan ?? "—"}</dd>
            <dt>created</dt>
            <dd>
              {t().created_at instanceof Date
                ? t().created_at.toISOString()
                : String(t().created_at)}
            </dd>
          </dl>
        )}
      </Show>
      <p>
        TODO: workflow-status panel (OnboardTenantWorkflow lifecycle for
        recent tenants).
      </p>
    </AppShell>
  );
};

export default TenantDetail;
