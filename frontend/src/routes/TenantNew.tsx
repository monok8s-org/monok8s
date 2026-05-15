// Tenant create route (#32) — `/tenants/new`. Form with slug + plan +
// ownerEmail; submits to `tenants.create` which enqueues
// OnboardTenantWorkflow. On success the route navigates to the new
// tenant's detail page so the operator can watch the onboarding state.
//
// Note: only system admins (members of `system:monok8s#create_tenants`)
// can actually submit this — non-admins get FORBIDDEN from the backend
// `canOnSystem` check. The UI doesn't pre-hide the form; the server is
// the source of truth.

import { Show, createSignal, type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";

import AppShell from "../components/AppShell";
import { monok8sClient } from "../lib/trpc";

// Slug validation mirrors the server-side `CreateTenantInputSchema`:
// 3-64 chars, lowercase alphanumeric + hyphens.
const SLUG_RE = /^[a-z0-9-]+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateTenantNewForm(opts: {
  slug: string;
  plan: string;
  ownerEmail: string;
}):
  | { ok: true; value: { slug: string; plan: "starter" | "pro" | "enterprise"; ownerEmail: string } }
  | { ok: false; error: string } {
  const slug = opts.slug.trim();
  if (slug.length < 3 || slug.length > 64) {
    return { ok: false, error: "Slug must be 3–64 characters" };
  }
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: "Slug must be lowercase alphanumeric or hyphen" };
  }
  if (opts.plan !== "starter" && opts.plan !== "pro" && opts.plan !== "enterprise") {
    return { ok: false, error: "Plan must be starter, pro, or enterprise" };
  }
  const email = opts.ownerEmail.trim();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Owner email must be a valid email address" };
  }
  return {
    ok: true,
    value: { slug, plan: opts.plan, ownerEmail: email },
  };
}

const TenantNew: Component = () => {
  const navigate = useNavigate();
  const [slug, setSlug] = createSignal("");
  const [plan, setPlan] = createSignal<"starter" | "pro" | "enterprise">(
    "starter",
  );
  const [ownerEmail, setOwnerEmail] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);

    const result = validateTenantNewForm({
      slug: slug(),
      plan: plan(),
      ownerEmail: ownerEmail(),
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setPending(true);
    try {
      const response = (await monok8sClient.principals.tenants.create.mutate(
        result.value,
      )) as unknown as { tenantId: string; workflowId: string };
      navigate(`/tenants/${response.tenantId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <AppShell>
      <h1>Create tenant</h1>
      <form aria-label="Create tenant" onSubmit={handleSubmit} data-form="tenant-new">
        <label>
          Slug
          <input
            type="text"
            name="slug"
            value={slug()}
            onInput={(e) => setSlug(e.currentTarget.value)}
            disabled={pending()}
            data-field="slug"
            required
          />
        </label>
        <label>
          Plan
          <select
            name="plan"
            value={plan()}
            onChange={(e) =>
              setPlan(e.currentTarget.value as "starter" | "pro" | "enterprise")
            }
            disabled={pending()}
            data-field="plan"
          >
            <option value="starter">starter</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        </label>
        <label>
          Owner email
          <input
            type="email"
            name="ownerEmail"
            value={ownerEmail()}
            onInput={(e) => setOwnerEmail(e.currentTarget.value)}
            disabled={pending()}
            data-field="owner-email"
            required
          />
        </label>
        <button
          type="submit"
          data-action="submit-tenant-new"
          disabled={pending()}
        >
          {pending() ? "Creating…" : "Create tenant"}
        </button>
      </form>
      <Show when={error()}>
        {(err) => <p role="alert">{err()}</p>}
      </Show>
    </AppShell>
  );
};

export default TenantNew;
