// L1 unit tests for PrincipalAdmin (#238 / sub-task of #95). Same
// pure-presentation pattern as WorkflowTimeline (#92) + AuditLogView
// (#94): synthetic accessors + signal-based parent-callback wiring.

import { describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import PrincipalAdmin, {
  formatCreatedAt,
  formatLiveAge,
  PRINCIPAL_ADMIN_TABS,
  TENANT_ROLES,
  validateChangeRoleForm,
  validateGroupForm,
  validateMemberUserId,
  validateRolesForm,
  type AssignRoleFormInput,
  type ChangeRoleFormInput,
  type CreateGroupFormInput,
  type Group,
  type MemberMutationFormInput,
  type PrincipalAdminTab,
  type PrincipalRef,
  type TenantRole,
  type User,
} from "./PrincipalAdmin";

const TENANT = "00000000-0000-0000-0000-000000000001";
const T = "2026-05-14T12:00:00.000Z";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    tenant_id: TENANT,
    zitadel_id: "zit-aa",
    email: "alice@example.com",
    created_at: new Date(T),
    ...overrides,
  };
}

describe("formatCreatedAt", () => {
  test("formats a Date as ISO 8601", () => {
    expect(formatCreatedAt(new Date(T))).toBe(T);
  });

  test("passes through a string unchanged", () => {
    expect(formatCreatedAt(T)).toBe(T);
  });
});

describe("PRINCIPAL_ADMIN_TABS", () => {
  test("contains the three tabs in stable order", () => {
    expect(PRINCIPAL_ADMIN_TABS).toEqual(["users", "groups", "roles"]);
  });
});

describe("PrincipalAdmin render", () => {
  function mount(initialTab: PrincipalAdminTab, users: User[]) {
    const [activeTab, setActiveTab] = createSignal(initialTab);
    const onTabChange = jest.fn((next: PrincipalAdminTab) =>
      setActiveTab(next),
    );
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={onTabChange}
        users={() => users}
      />
    ));
    return { ui, onTabChange, activeTab };
  }

  test("renders all three tabs in the tab strip", () => {
    const { ui } = mount("users", []);
    const tabs = ui.container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(3);
    const labels = Array.from(tabs).map((t) => t.textContent);
    expect(labels).toEqual(["Users", "Groups", "Roles"]);
  });

  test("marks the active tab via aria-selected", () => {
    const { ui } = mount("groups", []);
    const tabs = Array.from(ui.container.querySelectorAll('[role="tab"]'));
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-tab")).toBe("groups");
  });

  test("clicking a tab fires onTabChange with the right tab id", () => {
    const { ui, onTabChange } = mount("users", []);
    const rolesTab = ui.container.querySelector('[data-tab="roles"]');
    fireEvent.click(rolesTab!);
    expect(onTabChange).toHaveBeenCalledWith("roles");
  });

  test("Users tab renders one row per user from the accessor", () => {
    const { ui } = mount("users", [
      user({ id: "u1", email: "a@x" }),
      user({ id: "u2", email: "b@x" }),
    ]);
    const rows = ui.container.querySelectorAll('[data-row-key]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-row-key")).toBe("u1");
    expect(rows[1]?.getAttribute("data-row-key")).toBe("u2");
  });

  test("Users tab renders empty-state when list is empty", () => {
    const { ui } = mount("users", []);
    expect(ui.container.textContent).toContain("No users in this tenant.");
  });

  test("Users tab renders loading state when loading() is true", () => {
    const [activeTab] = createSignal<PrincipalAdminTab>("users");
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        loading={() => true}
      />
    ));
    expect(ui.container.textContent).toContain("Loading users…");
  });

  test("Users tab renders error state when error() is set", () => {
    const [activeTab] = createSignal<PrincipalAdminTab>("users");
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        error={() => "boom"}
      />
    ));
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("boom");
  });

  test("Groups tab renders its panel (post-#240 — placeholder removed)", () => {
    const { ui } = mount("groups", []);
    expect(ui.container.querySelector('[data-tab-panel="groups"]')).not.toBeNull();
    // Users-tab content should not be rendered.
    expect(ui.container.querySelector('[data-tab-panel="users"]')).toBeNull();
  });

  test("Roles tab renders its panel (post-#242 — placeholder removed)", () => {
    const { ui } = mount("roles", []);
    expect(ui.container.querySelector('[data-tab-panel="roles"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-tab-panel="users"]')).toBeNull();
  });

  test("switching tabs unmounts the prior tab's panel", () => {
    const { ui, onTabChange } = mount("users", [user()]);
    // Users panel present
    expect(ui.container.querySelector('[data-tab-panel="users"]')).not.toBeNull();
    // Click Groups tab
    const groupsTab = ui.container.querySelector('[data-tab="groups"]');
    fireEvent.click(groupsTab!);
    expect(onTabChange).toHaveBeenCalledWith("groups");
    // Note: the signal-driven re-render uses the parent's setActiveTab —
    // mount() wires that synchronously, so after click the active tab
    // is "groups".
    expect(ui.container.querySelector('[data-tab-panel="users"]')).toBeNull();
    expect(ui.container.querySelector('[data-tab-panel="groups"]')).not.toBeNull();
  });
});

// ── Groups tab (#240) ────────────────────────────────────────────────────────

const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

function group(overrides: Partial<Group> = {}): Group {
  return {
    id: VALID_UUID,
    tenant_id: TENANT,
    name: "engineering",
    parent_group_id: null,
    created_at: new Date(T),
    ...overrides,
  };
}

describe("validateGroupForm", () => {
  test("accepts a non-empty name with no parent", () => {
    const r = validateGroupForm("engineering", "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("engineering");
      expect(r.value.parentGroupId).toBeUndefined();
    }
  });

  test("accepts a non-empty name with a UUID parent", () => {
    const r = validateGroupForm("frontend", VALID_UUID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parentGroupId).toBe(VALID_UUID);
  });

  test("trims whitespace around name + parent", () => {
    const r = validateGroupForm("  engineering  ", `  ${VALID_UUID}  `);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("engineering");
      expect(r.value.parentGroupId).toBe(VALID_UUID);
    }
  });

  test("rejects empty name", () => {
    const r = validateGroupForm("", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/i);
  });

  test("rejects whitespace-only name", () => {
    const r = validateGroupForm("   ", "");
    expect(r.ok).toBe(false);
  });

  test("rejects name longer than 128 chars", () => {
    const r = validateGroupForm("x".repeat(129), "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/128/);
  });

  test("rejects non-UUID parent", () => {
    const r = validateGroupForm("engineering", "not-a-uuid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/UUID/);
  });

  test("accepts empty parent as undefined", () => {
    const r = validateGroupForm("engineering", "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parentGroupId).toBeUndefined();
  });
});

describe("PrincipalAdmin Groups tab render", () => {
  function mountGroupsTab(opts: {
    groups?: Group[];
    loading?: boolean;
    error?: string | null;
    actionPending?: boolean;
    actionError?: string | null;
    onCreate?: jest.Mock<
      (input: CreateGroupFormInput) => Promise<void>
    >;
    onDelete?: jest.Mock<(id: string) => Promise<void>>;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("groups");
    const onCreate = opts.onCreate ?? (jest.fn(async () => {}) as jest.Mock<
      (input: CreateGroupFormInput) => Promise<void>
    >);
    const onDelete = opts.onDelete ?? (jest.fn(async () => {}) as jest.Mock<
      (id: string) => Promise<void>
    >);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        groups={() => opts.groups ?? []}
        groupsLoading={() => opts.loading ?? false}
        groupsError={() => opts.error ?? null}
        onCreateGroup={onCreate as unknown as (input: CreateGroupFormInput) => Promise<void>}
        onDeleteGroup={onDelete as unknown as (id: string) => Promise<void>}
        groupActionPending={() => opts.actionPending ?? false}
        groupActionError={() => opts.actionError ?? null}
      />
    ));
    return { ui, onCreate, onDelete };
  }

  test("renders one row per group with delete buttons", () => {
    const { ui } = mountGroupsTab({
      groups: [
        group({ id: "g1", name: "engineering" }),
        group({ id: "g2", name: "frontend" }),
      ],
    });
    const rows = ui.container.querySelectorAll("[data-row-key]");
    expect(rows).toHaveLength(2);
    const deleteButtons = ui.container.querySelectorAll(
      '[data-action="delete-group"]',
    );
    expect(deleteButtons).toHaveLength(2);
  });

  test("renders empty-state when groups list is empty", () => {
    const { ui } = mountGroupsTab({ groups: [] });
    expect(ui.container.textContent).toContain("No groups in this tenant.");
  });

  test("renders loading state when loading() is true", () => {
    const { ui } = mountGroupsTab({ loading: true });
    expect(ui.container.textContent).toContain("Loading groups…");
  });

  test("renders error state when groupsError() is set", () => {
    const { ui } = mountGroupsTab({ error: "list-failed" });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("list-failed");
  });

  test("submitting create form calls onCreate with parsed input + clears form on success", async () => {
    const onCreate = jest.fn(async () => {}) as jest.Mock<
      (input: CreateGroupFormInput) => Promise<void>
    >;
    const { ui } = mountGroupsTab({ onCreate });
    const nameField = ui.container.querySelector(
      '[data-field="name"]',
    ) as HTMLInputElement;
    const parentField = ui.container.querySelector(
      '[data-field="parentGroupId"]',
    ) as HTMLInputElement;
    fireEvent.input(nameField, { target: { value: "engineering" } });
    fireEvent.input(parentField, { target: { value: VALID_UUID } });
    const submit = ui.container.querySelector('[data-action="create-group"]');
    fireEvent.click(submit!);
    // Async resolution — wait one microtask for the await chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      name: "engineering",
      parentGroupId: VALID_UUID,
    });
    // After successful resolve the form clears.
    expect(nameField.value).toBe("");
    expect(parentField.value).toBe("");
  });

  test("invalid form submission surfaces client-side error + skips onCreate", async () => {
    const onCreate = jest.fn(async () => {}) as jest.Mock<
      (input: CreateGroupFormInput) => Promise<void>
    >;
    const { ui } = mountGroupsTab({ onCreate });
    const submit = ui.container.querySelector('[data-action="create-group"]');
    // Empty name → validation error.
    fireEvent.click(submit!);
    await Promise.resolve();
    expect(onCreate).not.toHaveBeenCalled();
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/required/i);
  });

  test("delete button per row calls onDelete with the row's id", async () => {
    const onDelete = jest.fn(async () => {}) as jest.Mock<
      (id: string) => Promise<void>
    >;
    const { ui } = mountGroupsTab({
      groups: [group({ id: "g1" }), group({ id: "g2" })],
      onDelete,
    });
    const deleteButtons = ui.container.querySelectorAll(
      '[data-action="delete-group"]',
    );
    fireEvent.click(deleteButtons[1]!);
    await Promise.resolve();
    expect(onDelete).toHaveBeenCalledWith("g2");
  });

  test("disables create + delete buttons while actionPending is true", () => {
    const { ui } = mountGroupsTab({
      groups: [group()],
      actionPending: true,
    });
    const create = ui.container.querySelector(
      '[data-action="create-group"]',
    ) as HTMLButtonElement;
    const del = ui.container.querySelector(
      '[data-action="delete-group"]',
    ) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(del.disabled).toBe(true);
  });

  test("surfaces actionError when set", () => {
    const { ui } = mountGroupsTab({
      groups: [],
      actionError: "tenant.create failed: 23505 duplicate slug",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/duplicate slug/);
  });

  test("renders parent_group_id when non-null", () => {
    const PARENT_UUID = "00000000-0000-0000-0000-0000000000bb";
    const { ui } = mountGroupsTab({
      groups: [group({ parent_group_id: PARENT_UUID })],
    });
    expect(ui.container.textContent).toContain(PARENT_UUID);
  });

  test("renders em-dash for top-level groups (parent_group_id null)", () => {
    const { ui } = mountGroupsTab({
      groups: [group({ parent_group_id: null })],
    });
    expect(ui.container.textContent).toContain("—");
  });
});

// ── Roles tab (#242) ─────────────────────────────────────────────────────────

describe("TENANT_ROLES", () => {
  test("matches the five-role canonical set", () => {
    expect(TENANT_ROLES).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
      "billing_manager",
    ]);
  });
});

describe("validateRolesForm", () => {
  test("accepts a UUID + user type", () => {
    const r = validateRolesForm(VALID_UUID, "user");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(VALID_UUID);
      expect(r.value.type).toBe("user");
    }
  });

  test("accepts a UUID + service_account type", () => {
    const r = validateRolesForm(VALID_UUID, "service_account");
    expect(r.ok).toBe(true);
  });

  test("rejects empty id", () => {
    const r = validateRolesForm("", "user");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/i);
  });

  test("rejects non-UUID id", () => {
    const r = validateRolesForm("not-a-uuid", "user");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/UUID/);
  });

  test("rejects unknown principal type", () => {
    const r = validateRolesForm(VALID_UUID, "group");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/user|service_account/i);
  });
});

describe("PrincipalAdmin Roles tab render", () => {
  function mountRolesTab(opts: {
    selected?: PrincipalRef | null;
    roles?: TenantRole[];
    loading?: boolean;
    error?: string | null;
    actionPending?: boolean;
    actionError?: string | null;
    onSelect?: jest.Mock<(p: PrincipalRef | null) => void>;
    onAssign?: jest.Mock<(input: AssignRoleFormInput) => Promise<void>>;
    onUnassign?: jest.Mock<(input: AssignRoleFormInput) => Promise<void>>;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("roles");
    const [selectedPrincipal, setSelectedPrincipal] =
      createSignal<PrincipalRef | null>(opts.selected ?? null);
    const onSelect =
      opts.onSelect ??
      (jest.fn((p: PrincipalRef | null) => setSelectedPrincipal(p)) as jest.Mock<
        (p: PrincipalRef | null) => void
      >);
    const onAssign =
      opts.onAssign ??
      (jest.fn(async () => {}) as jest.Mock<
        (input: AssignRoleFormInput) => Promise<void>
      >);
    const onUnassign =
      opts.onUnassign ??
      (jest.fn(async () => {}) as jest.Mock<
        (input: AssignRoleFormInput) => Promise<void>
      >);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        selectedPrincipal={selectedPrincipal}
        onSelectPrincipal={(p) => {
          onSelect(p);
          setSelectedPrincipal(p);
        }}
        principalRoles={() => opts.roles ?? []}
        principalRolesLoading={() => opts.loading ?? false}
        principalRolesError={() => opts.error ?? null}
        onAssignRole={onAssign as unknown as (input: AssignRoleFormInput) => Promise<void>}
        onUnassignRole={onUnassign as unknown as (input: AssignRoleFormInput) => Promise<void>}
        roleActionPending={() => opts.actionPending ?? false}
        roleActionError={() => opts.actionError ?? null}
      />
    ));
    return { ui, onSelect, onAssign, onUnassign };
  }

  test("renders 'select a principal' message when none selected", () => {
    const { ui } = mountRolesTab({});
    expect(ui.container.textContent).toMatch(/Select a principal/i);
    // No principal-roles section rendered.
    expect(ui.container.querySelector('[data-section="principal-roles"]')).toBeNull();
  });

  test("lookup button calls onSelectPrincipal with parsed input", async () => {
    const { ui, onSelect } = mountRolesTab({});
    const idField = ui.container.querySelector(
      '[data-field="principal-id"]',
    ) as HTMLInputElement;
    const typeField = ui.container.querySelector(
      '[data-field="principal-type"]',
    ) as HTMLSelectElement;
    fireEvent.input(idField, { target: { value: VALID_UUID } });
    fireEvent.change(typeField, { target: { value: "service_account" } });
    const submit = ui.container.querySelector('[data-action="lookup-principal"]');
    fireEvent.click(submit!);
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith({
      id: VALID_UUID,
      type: "service_account",
    });
  });

  test("lookup with invalid UUID surfaces client error + skips selection", async () => {
    const { ui, onSelect } = mountRolesTab({});
    const idField = ui.container.querySelector(
      '[data-field="principal-id"]',
    ) as HTMLInputElement;
    fireEvent.input(idField, { target: { value: "not-a-uuid" } });
    const submit = ui.container.querySelector('[data-action="lookup-principal"]');
    fireEvent.click(submit!);
    await Promise.resolve();
    // onSelect called with null (the validation-failure clear path).
    expect(onSelect).toHaveBeenCalledWith(null);
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/UUID/);
  });

  test("renders current roles as chip-list when selected + roles non-empty", () => {
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      roles: ["admin", "viewer"],
    });
    const items = ui.container.querySelectorAll("[data-role-key]");
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("data-role-key")).toBe("admin");
    expect(items[1]?.getAttribute("data-role-key")).toBe("viewer");
  });

  test("renders empty-state when selected principal holds no roles", () => {
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      roles: [],
    });
    expect(ui.container.textContent).toMatch(/no tenant roles/i);
  });

  test("renders loading state for selected principal", () => {
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      loading: true,
    });
    expect(ui.container.textContent).toMatch(/Loading roles/i);
  });

  test("renders error state for selected principal", () => {
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      error: "boom",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("boom");
  });

  test("unassign-role button calls onUnassign with the role", async () => {
    const onUnassign = jest.fn(async () => {}) as jest.Mock<
      (input: AssignRoleFormInput) => Promise<void>
    >;
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      roles: ["admin", "viewer"],
      onUnassign,
    });
    const buttons = ui.container.querySelectorAll(
      '[data-action="unassign-role"]',
    );
    fireEvent.click(buttons[1]!);
    await Promise.resolve();
    expect(onUnassign).toHaveBeenCalledWith({
      principal: { id: VALID_UUID, type: "user" },
      role: "viewer",
    });
  });

  test("assign form submission calls onAssign with selected principal + role", async () => {
    const onAssign = jest.fn(async () => {}) as jest.Mock<
      (input: AssignRoleFormInput) => Promise<void>
    >;
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      roles: [],
      onAssign,
    });
    const roleField = ui.container.querySelector(
      '[data-field="assign-role"]',
    ) as HTMLSelectElement;
    fireEvent.change(roleField, { target: { value: "admin" } });
    const submit = ui.container.querySelector('[data-action="assign-role"]');
    fireEvent.click(submit!);
    await Promise.resolve();
    expect(onAssign).toHaveBeenCalledWith({
      principal: { id: VALID_UUID, type: "user" },
      role: "admin",
    });
  });

  test("assign-without-selection surfaces client error + skips onAssign", async () => {
    const onAssign = jest.fn(async () => {}) as jest.Mock<
      (input: AssignRoleFormInput) => Promise<void>
    >;
    // No selected principal — assign should refuse.
    const { ui } = mountRolesTab({ selected: null, onAssign });
    // Without a selection the assign form isn't rendered (it lives
    // inside the Show-when-selected block) — so no submit button.
    // Verify defense: even if the form WERE rendered, the handler
    // guards against null. Here we just assert no assign button.
    expect(ui.container.querySelector('[data-action="assign-role"]')).toBeNull();
    expect(onAssign).not.toHaveBeenCalled();
  });

  test("disables all role-action buttons while actionPending is true", () => {
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      roles: ["admin"],
      actionPending: true,
    });
    const unassign = ui.container.querySelector(
      '[data-action="unassign-role"]',
    ) as HTMLButtonElement;
    const assign = ui.container.querySelector(
      '[data-action="assign-role"]',
    ) as HTMLButtonElement;
    expect(unassign.disabled).toBe(true);
    expect(assign.disabled).toBe(true);
  });

  test("surfaces actionError when set", () => {
    const { ui } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
      actionError: "spicedb: NamespaceNotFound",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/NamespaceNotFound/);
  });

  test("clear button resets form + clears selection", async () => {
    const { ui, onSelect } = mountRolesTab({
      selected: { id: VALID_UUID, type: "user" },
    });
    const clearButton = ui.container.querySelector(
      '[data-action="clear-principal"]',
    );
    fireEvent.click(clearButton!);
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("validateChangeRoleForm (#261)", () => {
  test("accepts a pair of distinct roles", () => {
    const r = validateChangeRoleForm("viewer", "member");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.oldRole).toBe("viewer");
      expect(r.value.newRole).toBe("member");
    }
  });

  test("rejects identical old + new roles", () => {
    const r = validateChangeRoleForm("admin", "admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must differ/i);
  });
});

describe("PrincipalAdmin Roles change-form render (#261)", () => {
  function mountChangeForm(opts: {
    selected?: PrincipalRef | null;
    actionPending?: boolean;
    actionError?: string | null;
    onChange?: jest.Mock<(input: ChangeRoleFormInput) => Promise<void>>;
    omitOnChange?: boolean;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("roles");
    const [selectedPrincipal] = createSignal<PrincipalRef | null>(
      opts.selected ?? null,
    );
    const onChange =
      opts.onChange ??
      (jest.fn(async () => {}) as jest.Mock<
        (input: ChangeRoleFormInput) => Promise<void>
      >);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        selectedPrincipal={selectedPrincipal}
        onSelectPrincipal={jest.fn()}
        principalRoles={() => ["viewer"]}
        onAssignRole={jest.fn(async () => {})}
        onUnassignRole={jest.fn(async () => {})}
        onChangeRole={
          opts.omitOnChange
            ? undefined
            : (onChange as unknown as (
                input: ChangeRoleFormInput,
              ) => Promise<void>)
        }
        roleActionPending={() => opts.actionPending ?? false}
        roleActionError={() => opts.actionError ?? null}
      />
    ));
    return { ui, onChange };
  }

  const PRINCIPAL: PrincipalRef = {
    id: "00000000-0000-0000-0000-000000000099",
    type: "user",
  };

  test("does NOT render the change-role form when onChangeRole is not wired (backward compat)", () => {
    const { ui } = mountChangeForm({
      selected: PRINCIPAL,
      omitOnChange: true,
    });
    expect(
      ui.container.querySelector('[data-form="change-role"]'),
    ).toBeNull();
  });

  test("renders the change-role form when onChangeRole is wired + principal is selected", () => {
    const { ui } = mountChangeForm({ selected: PRINCIPAL });
    expect(
      ui.container.querySelector('[data-form="change-role"]'),
    ).not.toBeNull();
    expect(
      ui.container.querySelector('[data-field="change-old-role"]'),
    ).not.toBeNull();
    expect(
      ui.container.querySelector('[data-field="change-new-role"]'),
    ).not.toBeNull();
  });

  test("submitting with default values (viewer→member) dispatches onChangeRole with the principal + selected roles", async () => {
    const onChange = jest.fn(async () => {}) as jest.Mock<
      (input: ChangeRoleFormInput) => Promise<void>
    >;
    const { ui } = mountChangeForm({ selected: PRINCIPAL, onChange });
    const button = ui.container.querySelector(
      '[data-action="change-role"]',
    );
    fireEvent.click(button!);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      oldRole: "viewer",
      newRole: "member",
    });
  });

  test("changing the From + To selects updates the dispatched roles", async () => {
    const onChange = jest.fn(async () => {}) as jest.Mock<
      (input: ChangeRoleFormInput) => Promise<void>
    >;
    const { ui } = mountChangeForm({ selected: PRINCIPAL, onChange });
    const oldSelect = ui.container.querySelector(
      '[data-field="change-old-role"]',
    ) as HTMLSelectElement;
    const newSelect = ui.container.querySelector(
      '[data-field="change-new-role"]',
    ) as HTMLSelectElement;
    fireEvent.change(oldSelect, { target: { value: "admin" } });
    fireEvent.change(newSelect, { target: { value: "billing_manager" } });
    fireEvent.click(
      ui.container.querySelector('[data-action="change-role"]')!,
    );
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      oldRole: "admin",
      newRole: "billing_manager",
    });
  });

  test("setting old=new surfaces client error + skips onChangeRole", async () => {
    const onChange = jest.fn(async () => {}) as jest.Mock<
      (input: ChangeRoleFormInput) => Promise<void>
    >;
    const { ui } = mountChangeForm({ selected: PRINCIPAL, onChange });
    const newSelect = ui.container.querySelector(
      '[data-field="change-new-role"]',
    ) as HTMLSelectElement;
    // Default oldRole is "viewer" — set newRole to "viewer" too.
    fireEvent.change(newSelect, { target: { value: "viewer" } });
    fireEvent.click(
      ui.container.querySelector('[data-action="change-role"]')!,
    );
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/must differ/i);
  });

  test("roleActionPending disables the change-role button", () => {
    const { ui } = mountChangeForm({
      selected: PRINCIPAL,
      actionPending: true,
    });
    const button = ui.container.querySelector(
      '[data-action="change-role"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("PrincipalAdmin Roles expand-for-role render (#266)", () => {
  function mountExpandForRole(opts: {
    expandedRole?: TenantRole | null;
    expanded?: { users: string[]; serviceAccounts: string[] } | null;
    loading?: boolean;
    error?: string | null;
    onSelect?: jest.Mock<(r: TenantRole | null) => void>;
    omitOnSelect?: boolean;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("roles");
    const [expandedRole, setExpandedRole] = createSignal<TenantRole | null>(
      opts.expandedRole ?? null,
    );
    const onSelect =
      opts.onSelect ??
      (jest.fn((r: TenantRole | null) => setExpandedRole(r)) as jest.Mock<
        (r: TenantRole | null) => void
      >);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        expandedRole={expandedRole}
        onSelectExpandedRole={
          opts.omitOnSelect
            ? undefined
            : (r) => {
                onSelect(r);
                setExpandedRole(r);
              }
        }
        expandedRolePrincipals={() => opts.expanded ?? null}
        expandedRoleLoading={() => opts.loading ?? false}
        expandedRoleError={() => opts.error ?? null}
      />
    ));
    return { ui, onSelect };
  }

  test("section absent when onSelectExpandedRole not wired (backward compat)", () => {
    const { ui } = mountExpandForRole({ omitOnSelect: true });
    expect(
      ui.container.querySelector('[data-section="expand-for-role"]'),
    ).toBeNull();
  });

  test("section rendered with form when onSelectExpandedRole is wired", () => {
    const { ui } = mountExpandForRole({});
    expect(
      ui.container.querySelector('[data-section="expand-for-role"]'),
    ).not.toBeNull();
    expect(
      ui.container.querySelector('[data-field="expand-role"]'),
    ).not.toBeNull();
    expect(
      ui.container.querySelector('[data-action="expand-role-lookup"]'),
    ).not.toBeNull();
  });

  test("submitting the form dispatches onSelectExpandedRole with the picked role", () => {
    const onSelect = jest.fn() as jest.Mock<(r: TenantRole | null) => void>;
    const { ui } = mountExpandForRole({ onSelect });
    const select = ui.container.querySelector(
      '[data-field="expand-role"]',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "admin" } });
    fireEvent.click(
      ui.container.querySelector('[data-action="expand-role-lookup"]')!,
    );
    expect(onSelect).toHaveBeenCalledWith("admin");
  });

  test("Clear button dispatches onSelectExpandedRole(null) when a role is active", () => {
    const onSelect = jest.fn() as jest.Mock<(r: TenantRole | null) => void>;
    const { ui } = mountExpandForRole({
      expandedRole: "admin",
      expanded: { users: [], serviceAccounts: [] },
      onSelect,
    });
    const clearBtn = ui.container.querySelector(
      '[data-action="expand-role-clear"]',
    );
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn!);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("loading state surfaces while expansion resolves", () => {
    const { ui } = mountExpandForRole({
      expandedRole: "admin",
      expanded: null,
      loading: true,
    });
    const results = ui.container.querySelector(
      '[data-section="expand-for-role-results"]',
    );
    expect(results?.textContent).toMatch(/Loading principals/);
  });

  test("error state surfaces when the expansion fails", () => {
    const { ui } = mountExpandForRole({
      expandedRole: "admin",
      expanded: null,
      error: "spicedb: NamespaceNotFound",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Failed to load principals/);
    expect(alert?.textContent).toMatch(/NamespaceNotFound/);
  });

  test("populated expansion renders user + service-account lists with counts", () => {
    const USERS = [
      "00000000-0000-0000-0000-000000000aa1",
      "00000000-0000-0000-0000-000000000aa2",
    ];
    const SAS = ["00000000-0000-0000-0000-000000000bb1"];
    const { ui } = mountExpandForRole({
      expandedRole: "member",
      expanded: { users: USERS, serviceAccounts: SAS },
    });
    const userLis = ui.container.querySelectorAll("[data-expanded-user-id]");
    const saLis = ui.container.querySelectorAll("[data-expanded-sa-id]");
    expect(userLis).toHaveLength(2);
    expect(saLis).toHaveLength(1);
    expect(userLis[0]?.getAttribute("data-expanded-user-id")).toBe(USERS[0]);
    expect(saLis[0]?.getAttribute("data-expanded-sa-id")).toBe(SAS[0]);
  });

  test("empty expansion renders the no-principals messages with zero counts", () => {
    const { ui } = mountExpandForRole({
      expandedRole: "billing_manager",
      expanded: { users: [], serviceAccounts: [] },
    });
    expect(ui.container.textContent).toMatch(/No users hold this role/);
    expect(ui.container.textContent).toMatch(
      /No service accounts hold this role/,
    );
  });
});

// ── Live updates indicator (#246 — final sub-PR of #95) ──────────────────────

describe("formatLiveAge", () => {
  const NOW = new Date("2026-05-14T19:30:00Z");

  test("returns 'Connecting…' when lastEventAt is null", () => {
    expect(formatLiveAge(null, NOW)).toBe("Connecting…");
  });

  test("returns '0s ago' when event was just now", () => {
    expect(formatLiveAge(NOW, NOW)).toBe("0s ago");
  });

  test("returns 'Ns ago' for events within the last minute", () => {
    const fiveSec = new Date(NOW.getTime() - 5 * 1000);
    expect(formatLiveAge(fiveSec, NOW)).toBe("5s ago");
  });

  test("returns 'Nm ago' for events between 1m and 1h", () => {
    const tenMin = new Date(NOW.getTime() - 10 * 60 * 1000);
    expect(formatLiveAge(tenMin, NOW)).toBe("10m ago");
  });

  test("returns 'Nh ago' for events ≥1h old", () => {
    const twoHours = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    expect(formatLiveAge(twoHours, NOW)).toBe("2h ago");
  });

  test("clamps negative deltas (clock skew) to 0s", () => {
    const future = new Date(NOW.getTime() + 5000);
    expect(formatLiveAge(future, NOW)).toBe("0s ago");
  });
});

describe("PrincipalAdmin live indicator render", () => {
  const FIXED_NOW = new Date("2026-05-14T19:30:00Z");

  function mountIndicator(opts: {
    lastTenantEventAt?: Date | null;
    withWiring?: boolean;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("users");
    const props: Parameters<typeof PrincipalAdmin>[0] = {
      activeTab,
      onTabChange: jest.fn(),
      users: () => [],
      now: () => FIXED_NOW,
    };
    if (opts.withWiring !== false) {
      props.lastTenantEventAt = () => opts.lastTenantEventAt ?? null;
    }
    return render(() => <PrincipalAdmin {...props} />);
  }

  test("does NOT render the indicator when lastTenantEventAt prop is absent", () => {
    const ui = mountIndicator({ withWiring: false });
    expect(ui.container.querySelector("[data-live-indicator]")).toBeNull();
  });

  test("renders 'Connecting…' when wired but no event seen yet (null)", () => {
    const ui = mountIndicator({ lastTenantEventAt: null });
    const indicator = ui.container.querySelector("[data-live-indicator]");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toMatch(/Connecting/);
  });

  test("renders 'Live · Ns ago' when a recent event is set", () => {
    const tenSecAgo = new Date(FIXED_NOW.getTime() - 10 * 1000);
    const ui = mountIndicator({ lastTenantEventAt: tenSecAgo });
    const indicator = ui.container.querySelector("[data-live-indicator]");
    expect(indicator?.textContent).toMatch(/Live · 10s ago/);
  });

  test("renders 'Live · Nm ago' for events between 1m and 1h", () => {
    const fiveMinAgo = new Date(FIXED_NOW.getTime() - 5 * 60 * 1000);
    const ui = mountIndicator({ lastTenantEventAt: fiveMinAgo });
    const indicator = ui.container.querySelector("[data-live-indicator]");
    expect(indicator?.textContent).toMatch(/Live · 5m ago/);
  });

  test("indicator uses aria-live=polite for screen-reader courtesy", () => {
    const ui = mountIndicator({ lastTenantEventAt: null });
    const indicator = ui.container.querySelector("[data-live-indicator]");
    expect(indicator?.getAttribute("aria-live")).toBe("polite");
  });
});

// ── Groups member-management (#250) ──────────────────────────────────────────

describe("validateMemberUserId", () => {
  test("accepts a UUID", () => {
    const r = validateMemberUserId(VALID_UUID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_UUID);
  });

  test("trims whitespace", () => {
    const r = validateMemberUserId(`  ${VALID_UUID}  `);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_UUID);
  });

  test("rejects empty string", () => {
    const r = validateMemberUserId("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/i);
  });

  test("rejects whitespace-only", () => {
    const r = validateMemberUserId("   ");
    expect(r.ok).toBe(false);
  });

  test("rejects non-UUID", () => {
    const r = validateMemberUserId("not-a-uuid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/UUID/);
  });
});

describe("PrincipalAdmin Groups member-management render", () => {
  function mountGroupsMember(opts: {
    groups?: Group[];
    selected?: Group | null;
    actionPending?: boolean;
    actionError?: string | null;
    onSelect?: jest.Mock<(g: Group | null) => void>;
    onAdd?: jest.Mock<(groupId: string, input: MemberMutationFormInput) => Promise<void>>;
    onRemove?: jest.Mock<(groupId: string, input: MemberMutationFormInput) => Promise<void>>;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("groups");
    const [selectedGroup, setSelectedGroup] = createSignal<Group | null>(
      opts.selected ?? null,
    );
    const onSelect =
      opts.onSelect ??
      (jest.fn((g: Group | null) => setSelectedGroup(g)) as jest.Mock<
        (g: Group | null) => void
      >);
    const onAdd =
      opts.onAdd ??
      (jest.fn(async () => {}) as jest.Mock<
        (groupId: string, input: MemberMutationFormInput) => Promise<void>
      >);
    const onRemove =
      opts.onRemove ??
      (jest.fn(async () => {}) as jest.Mock<
        (groupId: string, input: MemberMutationFormInput) => Promise<void>
      >);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        groups={() => opts.groups ?? []}
        selectedGroup={selectedGroup}
        onSelectGroup={(g) => {
          onSelect(g);
          setSelectedGroup(g);
        }}
        onAddGroupMember={onAdd as unknown as (
          groupId: string,
          input: MemberMutationFormInput,
        ) => Promise<void>}
        onRemoveGroupMember={onRemove as unknown as (
          groupId: string,
          input: MemberMutationFormInput,
        ) => Promise<void>}
        memberActionPending={() => opts.actionPending ?? false}
        memberActionError={() => opts.actionError ?? null}
      />
    ));
    return { ui, onSelect, onAdd, onRemove };
  }

  test("renders a Manage button per group row", () => {
    const { ui } = mountGroupsMember({
      groups: [group({ id: "g1" }), group({ id: "g2", name: "frontend" })],
    });
    const buttons = ui.container.querySelectorAll(
      '[data-action="manage-members"]',
    );
    expect(buttons).toHaveLength(2);
  });

  test("clicking Manage selects the group + opens member-management section", async () => {
    const { ui, onSelect } = mountGroupsMember({
      groups: [group({ id: "g1", name: "engineering" })],
    });
    expect(ui.container.querySelector('[data-section="member-management"]')).toBeNull();
    const manage = ui.container.querySelector('[data-action="manage-members"]');
    fireEvent.click(manage!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]?.id).toBe("g1");
    expect(ui.container.querySelector('[data-section="member-management"]')).not.toBeNull();
  });

  test("Close button clears the selection", async () => {
    const { ui, onSelect } = mountGroupsMember({
      groups: [group()],
      selected: group(),
    });
    const close = ui.container.querySelector('[data-action="close-member-management"]');
    fireEvent.click(close!);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("Add calls onAddGroupMember with selected group id + parsed userId", async () => {
    const SELECTED = group({ id: "g-target" });
    const USER_ID = "00000000-0000-0000-0000-000000000099";
    const onAdd = jest.fn(async () => {}) as jest.Mock<
      (groupId: string, input: MemberMutationFormInput) => Promise<void>
    >;
    const { ui } = mountGroupsMember({
      groups: [SELECTED],
      selected: SELECTED,
      onAdd,
    });
    const userField = ui.container.querySelector(
      '[data-field="member-user-id"]',
    ) as HTMLInputElement;
    fireEvent.input(userField, { target: { value: USER_ID } });
    const addBtn = ui.container.querySelector('[data-action="add-member"]');
    fireEvent.click(addBtn!);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAdd).toHaveBeenCalledWith("g-target", { userId: USER_ID });
  });

  test("Remove calls onRemoveGroupMember + clears userId field on success", async () => {
    const SELECTED = group({ id: "g-target" });
    const USER_ID = "00000000-0000-0000-0000-000000000099";
    const onRemove = jest.fn(async () => {}) as jest.Mock<
      (groupId: string, input: MemberMutationFormInput) => Promise<void>
    >;
    const { ui } = mountGroupsMember({
      groups: [SELECTED],
      selected: SELECTED,
      onRemove,
    });
    const userField = ui.container.querySelector(
      '[data-field="member-user-id"]',
    ) as HTMLInputElement;
    fireEvent.input(userField, { target: { value: USER_ID } });
    fireEvent.click(ui.container.querySelector('[data-action="remove-member"]')!);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRemove).toHaveBeenCalledWith("g-target", { userId: USER_ID });
    expect(userField.value).toBe("");
  });

  test("Add with invalid userId surfaces client error + skips onAddGroupMember", async () => {
    const SELECTED = group();
    const onAdd = jest.fn(async () => {}) as jest.Mock<
      (groupId: string, input: MemberMutationFormInput) => Promise<void>
    >;
    const { ui } = mountGroupsMember({
      groups: [SELECTED],
      selected: SELECTED,
      onAdd,
    });
    fireEvent.click(ui.container.querySelector('[data-action="add-member"]')!);
    await Promise.resolve();
    expect(onAdd).not.toHaveBeenCalled();
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/required/i);
  });

  test("memberActionPending disables Add + Remove + Manage buttons", () => {
    const SELECTED = group();
    const { ui } = mountGroupsMember({
      groups: [SELECTED],
      selected: SELECTED,
      actionPending: true,
    });
    const add = ui.container.querySelector(
      '[data-action="add-member"]',
    ) as HTMLButtonElement;
    const rem = ui.container.querySelector(
      '[data-action="remove-member"]',
    ) as HTMLButtonElement;
    const manage = ui.container.querySelector(
      '[data-action="manage-members"]',
    ) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(rem.disabled).toBe(true);
    expect(manage.disabled).toBe(true);
  });

  test("surfaces memberActionError when set", () => {
    const SELECTED = group();
    const { ui } = mountGroupsMember({
      groups: [SELECTED],
      selected: SELECTED,
      actionError: "spicedb: NotFound",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/NotFound/);
  });
});

describe("PrincipalAdmin Users tab suspend/reinstate render (#254 / Issue #105)", () => {
  function mountUsers(opts: {
    users?: User[];
    selected?: User | null;
    actionPending?: boolean;
    actionError?: string | null;
    onSelect?: jest.Mock<(u: User | null) => void>;
    onSuspend?: jest.Mock<(userId: string) => Promise<void>>;
    onReinstate?: jest.Mock<(userId: string) => Promise<void>>;
    wireMutations?: boolean;
  }) {
    const wired = opts.wireMutations !== false;
    const [activeTab] = createSignal<PrincipalAdminTab>("users");
    const [selectedUser, setSelectedUser] = createSignal<User | null>(
      opts.selected ?? null,
    );
    const onSelect =
      opts.onSelect ??
      (jest.fn((u: User | null) => setSelectedUser(u)) as jest.Mock<
        (u: User | null) => void
      >);
    const onSuspend =
      opts.onSuspend ??
      (jest.fn(async () => {}) as jest.Mock<
        (userId: string) => Promise<void>
      >);
    const onReinstate =
      opts.onReinstate ??
      (jest.fn(async () => {}) as jest.Mock<
        (userId: string) => Promise<void>
      >);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => opts.users ?? []}
        selectedUser={wired ? selectedUser : undefined}
        onSelectUser={
          wired
            ? (u) => {
                onSelect(u);
                setSelectedUser(u);
              }
            : undefined
        }
        onSuspendUser={
          wired
            ? (onSuspend as unknown as (userId: string) => Promise<void>)
            : undefined
        }
        onReinstateUser={
          wired
            ? (onReinstate as unknown as (userId: string) => Promise<void>)
            : undefined
        }
        userActionPending={wired ? () => opts.actionPending ?? false : undefined}
        userActionError={wired ? () => opts.actionError ?? null : undefined}
      />
    ));
    return { ui, onSelect, onSuspend, onReinstate };
  }

  test("renders a Manage button per user row when callbacks are wired", () => {
    const { ui } = mountUsers({
      users: [
        user({ id: "u1" }),
        user({ id: "u2", email: "bob@example.com" }),
      ],
    });
    const buttons = ui.container.querySelectorAll(
      '[data-action="manage-user"]',
    );
    expect(buttons).toHaveLength(2);
  });

  test("does NOT render Manage button when mutation callbacks are not wired", () => {
    const { ui } = mountUsers({
      users: [user()],
      wireMutations: false,
    });
    expect(
      ui.container.querySelector('[data-action="manage-user"]'),
    ).toBeNull();
    // Actions column header also gone.
    const headers = Array.from(
      ui.container.querySelectorAll("thead th"),
    ).map((h) => h.textContent);
    expect(headers).not.toContain("Actions");
  });

  test("clicking Manage selects user + opens UserManageSection", () => {
    const { ui, onSelect } = mountUsers({
      users: [user({ id: "u-alpha", email: "alpha@example.com" })],
    });
    expect(ui.container.querySelector('[data-section="user-manage"]')).toBeNull();
    const manage = ui.container.querySelector(
      '[data-action="manage-user"]',
    );
    fireEvent.click(manage!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]?.id).toBe("u-alpha");
    expect(
      ui.container.querySelector('[data-section="user-manage"]'),
    ).not.toBeNull();
  });

  test("Close button clears the selection", () => {
    const { ui, onSelect } = mountUsers({
      users: [user()],
      selected: user(),
    });
    const close = ui.container.querySelector(
      '[data-action="close-user-manage"]',
    );
    fireEvent.click(close!);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("Suspend button dispatches onSuspendUser with the selected user id", () => {
    const SELECTED = user({ id: "u-suspend-target" });
    const onSuspend = jest.fn(async () => {}) as jest.Mock<
      (userId: string) => Promise<void>
    >;
    const { ui } = mountUsers({
      users: [SELECTED],
      selected: SELECTED,
      onSuspend,
    });
    fireEvent.click(
      ui.container.querySelector('[data-action="suspend-user"]')!,
    );
    expect(onSuspend).toHaveBeenCalledWith("u-suspend-target");
  });

  test("Reinstate button dispatches onReinstateUser with the selected user id", () => {
    const SELECTED = user({ id: "u-reinstate-target" });
    const onReinstate = jest.fn(async () => {}) as jest.Mock<
      (userId: string) => Promise<void>
    >;
    const { ui } = mountUsers({
      users: [SELECTED],
      selected: SELECTED,
      onReinstate,
    });
    fireEvent.click(
      ui.container.querySelector('[data-action="reinstate-user"]')!,
    );
    expect(onReinstate).toHaveBeenCalledWith("u-reinstate-target");
  });

  test("userActionPending disables Manage + Suspend + Reinstate buttons", () => {
    const SELECTED = user();
    const { ui } = mountUsers({
      users: [SELECTED],
      selected: SELECTED,
      actionPending: true,
    });
    const manage = ui.container.querySelector(
      '[data-action="manage-user"]',
    ) as HTMLButtonElement;
    const susp = ui.container.querySelector(
      '[data-action="suspend-user"]',
    ) as HTMLButtonElement;
    const reins = ui.container.querySelector(
      '[data-action="reinstate-user"]',
    ) as HTMLButtonElement;
    expect(manage.disabled).toBe(true);
    expect(susp.disabled).toBe(true);
    expect(reins.disabled).toBe(true);
  });

  test("surfaces userActionError when set", () => {
    const SELECTED = user();
    const { ui } = mountUsers({
      users: [SELECTED],
      selected: SELECTED,
      actionError: "FORBIDDEN: Only an owner can suspend another owner",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/FORBIDDEN/);
  });
});

describe("PrincipalAdmin Groups member-list render (#258)", () => {
  function mountWithMembers(opts: {
    selected?: Group | null;
    members?: string[];
    membersLoading?: boolean;
    membersError?: string | null;
  }) {
    const [activeTab] = createSignal<PrincipalAdminTab>("groups");
    const [selectedGroup] = createSignal<Group | null>(opts.selected ?? null);
    const ui = render(() => (
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={jest.fn()}
        users={() => []}
        groups={() => (opts.selected ? [opts.selected] : [])}
        selectedGroup={selectedGroup}
        onSelectGroup={jest.fn()}
        onAddGroupMember={jest.fn(async () => {})}
        onRemoveGroupMember={jest.fn(async () => {})}
        memberActionPending={() => false}
        memberActionError={() => null}
        groupMembers={
          opts.members !== undefined ? () => opts.members ?? [] : undefined
        }
        groupMembersLoading={
          opts.membersLoading !== undefined
            ? () => opts.membersLoading ?? false
            : undefined
        }
        groupMembersError={
          opts.membersError !== undefined
            ? () => opts.membersError ?? null
            : undefined
        }
      />
    ));
    return { ui };
  }

  test("renders nothing for member-list when members prop is not wired (backward compat)", () => {
    const SELECTED = group();
    const { ui } = mountWithMembers({ selected: SELECTED });
    expect(
      ui.container.querySelector('[data-section="member-list"]'),
    ).toBeNull();
  });

  test("renders empty-state when group has no members", () => {
    const SELECTED = group();
    const { ui } = mountWithMembers({
      selected: SELECTED,
      members: [],
    });
    const section = ui.container.querySelector(
      '[data-section="member-list"]',
    );
    expect(section).not.toBeNull();
    expect(section?.textContent).toMatch(/No members/);
  });

  test("renders one <li> per member with the user id", () => {
    const SELECTED = group();
    const MEMBERS = [
      "00000000-0000-0000-0000-0000000000aa",
      "00000000-0000-0000-0000-0000000000bb",
    ];
    const { ui } = mountWithMembers({
      selected: SELECTED,
      members: MEMBERS,
    });
    const rows = ui.container.querySelectorAll("[data-member-user-id]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-member-user-id")).toBe(MEMBERS[0]);
    expect(rows[1]?.getAttribute("data-member-user-id")).toBe(MEMBERS[1]);
  });

  test("renders loading indicator when membersLoading is true", () => {
    const SELECTED = group();
    const { ui } = mountWithMembers({
      selected: SELECTED,
      members: [],
      membersLoading: true,
    });
    const section = ui.container.querySelector(
      '[data-section="member-list"]',
    );
    expect(section?.textContent).toMatch(/Loading members/);
  });

  test("surfaces membersError when set", () => {
    const SELECTED = group();
    const { ui } = mountWithMembers({
      selected: SELECTED,
      members: [],
      membersError: "lookupSubjects failed: timeout",
    });
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Failed to load members/);
    expect(alert?.textContent).toMatch(/timeout/);
  });
});
