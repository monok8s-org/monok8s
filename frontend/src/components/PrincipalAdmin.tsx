// PrincipalAdmin — #238 / sub-task of #95.
//
// Tabbed shell over the principal-admin surface. First tab (Users)
// is wired; Groups + Roles ship in follow-up sub-PRs.
//
// Same pure-presentation pattern as WorkflowTimeline (#92 / PR #207)
// and AuditLogView (#94 / PR #210): parent route owns the resource +
// active-tab signal, this component renders. Synthetic tests pass
// fixture rows; no network in L1.

import { For, Show, createSignal, type Component } from "solid-js";

import type { Group, User } from "@monok8s/db";

export type { Group, User };

// Form input for groups.create — matches the apps/api wire shape
// (parentGroupId is camelCase per the TS-side schema; the DB-helper
// translates to snake_case parent_group_id at the boundary).
export interface CreateGroupFormInput {
  name: string;
  parentGroupId?: string | null;
}

// Form input for groups.add_member / groups.remove_member (#250).
// userId only — groupId comes from the parent's selectedGroup signal.
export interface MemberMutationFormInput {
  userId: string;
}

// Tenant role enum mirroring TENANT_ROLES from
// apps/api/src/handlers/principals.ts. Hardcoded locally to avoid a
// cross-package dep on apps/api from frontend; if a third consumer
// emerges this lifts to packages/db (or packages/auth as the
// schema-zed authority).
export const TENANT_ROLES = [
  "owner",
  "admin",
  "member",
  "viewer",
  "billing_manager",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export type PrincipalType = "user" | "service_account";

export interface PrincipalRef {
  id: string;
  type: PrincipalType;
}

// Form input for role-assignment mutations — caller's intent.
export interface AssignRoleFormInput {
  principal: PrincipalRef;
  role: TenantRole;
}

// Form input for role-change (atomic swap) mutation (#261). Mirrors
// the server-side ChangeRoleSchema in apps/api/src/routers/principals.ts:
// principal + oldRole + newRole, with oldRole !== newRole enforced
// at validation time.
export interface ChangeRoleFormInput {
  principal: PrincipalRef;
  oldRole: TenantRole;
  newRole: TenantRole;
}

export type PrincipalAdminTab = "users" | "groups" | "roles";

export const PRINCIPAL_ADMIN_TABS: readonly PrincipalAdminTab[] = [
  "users",
  "groups",
  "roles",
] as const;

const TAB_LABELS: Record<PrincipalAdminTab, string> = {
  users: "Users",
  groups: "Groups",
  roles: "Roles",
};

export interface PrincipalAdminProps {
  activeTab: () => PrincipalAdminTab;
  onTabChange: (next: PrincipalAdminTab) => void;
  // Users data accessors (only consumed when activeTab === "users").
  users: () => User[];
  loading?: () => boolean;
  error?: () => string | null;

  // Groups data + mutation callbacks (only consumed when
  // activeTab === "groups"). Parent route owns the tRPC mutations +
  // refetches; component stays pure-presentation.
  groups?: () => Group[];
  groupsLoading?: () => boolean;
  groupsError?: () => string | null;
  onCreateGroup?: (input: CreateGroupFormInput) => Promise<void> | void;
  onDeleteGroup?: (id: string) => Promise<void> | void;
  // True while a create/delete mutation is in flight — disables
  // action buttons to prevent double-submit / racing concurrent
  // mutations against a stale view.
  groupActionPending?: () => boolean;
  // Surfaces validation OR server-side mutation errors back to the
  // user. Empty / null when no error to display.
  groupActionError?: () => string | null;

  // Groups member-management (#250). Parent owns the selectedGroup
  // signal + the mutation callbacks; the component renders a "Manage
  // members" button per row + a member-mutation form when selected.
  // v1 doesn't show a current-members list (no groups.list_members
  // API procedure yet); operator types userId + clicks Add or Remove.
  selectedGroup?: () => Group | null;
  onSelectGroup?: (next: Group | null) => void;
  onAddGroupMember?: (
    groupId: string,
    input: MemberMutationFormInput,
  ) => Promise<void> | void;
  onRemoveGroupMember?: (
    groupId: string,
    input: MemberMutationFormInput,
  ) => Promise<void> | void;
  memberActionPending?: () => boolean;
  memberActionError?: () => string | null;

  // groups.list_members consumer (#258). Parent route owns the
  // resource keyed on selectedGroup; the component renders the
  // current-members list in the MemberManagementSection. Accessors
  // are optional — old mounts that don't wire list_members keep
  // working (the section renders without the members list).
  groupMembers?: () => string[];
  groupMembersLoading?: () => boolean;
  groupMembersError?: () => string | null;

  // Roles tab (#242 — sub-PR of #95). Parent owns the
  // selectedPrincipal signal + `principalRoles` resource keyed on
  // it; the component is pure-presentation over those accessors.
  selectedPrincipal?: () => PrincipalRef | null;
  onSelectPrincipal?: (next: PrincipalRef | null) => void;
  principalRoles?: () => TenantRole[];
  principalRolesLoading?: () => boolean;
  principalRolesError?: () => string | null;
  onAssignRole?: (input: AssignRoleFormInput) => Promise<void> | void;
  onUnassignRole?: (input: AssignRoleFormInput) => Promise<void> | void;
  // Roles atomic-swap mutation (#261). Mirrors assign/unassign DI;
  // backend procedure (principals.roles.change) already ships.
  onChangeRole?: (input: ChangeRoleFormInput) => Promise<void> | void;
  // Shared across assign + unassign + change — disables every role-
  // mutation button while one is in flight (same posture as
  // groupActionPending).
  roleActionPending?: () => boolean;
  roleActionError?: () => string | null;

  // Roles "Expand for role" view (#266 / closes the Roles tab's
  // dual-direction lookup gap). Backend procedure
  // `principals.roles.expand_for_role` returns `{users: string[],
  // serviceAccounts: string[]}` for a given tenant role. The parent
  // owns the expandedRole signal + the expansion resource keyed on
  // it; the component is pure-presentation. Accessors optional —
  // old mounts without expand-for-role keep working.
  expandedRole?: () => TenantRole | null;
  onSelectExpandedRole?: (next: TenantRole | null) => void;
  expandedRolePrincipals?: () => {
    users: string[];
    serviceAccounts: string[];
  } | null;
  expandedRoleLoading?: () => boolean;
  expandedRoleError?: () => string | null;

  // Users tab suspend/reinstate (#254 / Issue #105). Parent owns the
  // selectedUser signal + the mutation callbacks; the component renders
  // a "Manage" button per row + a UserManageSection when selected. V1
  // doesn't surface the user's current suspended state in the row (User
  // shape from @monok8s/db carries no `suspended_at` field today) — both
  // Suspend and Reinstate buttons render side-by-side; backend SpiceDB
  // writes are idempotent (TOUCH/DELETE no-op on existing/missing
  // relations) so wrong-click is safe.
  selectedUser?: () => User | null;
  onSelectUser?: (next: User | null) => void;
  onSuspendUser?: (userId: string) => Promise<void> | void;
  onReinstateUser?: (userId: string) => Promise<void> | void;
  userActionPending?: () => boolean;
  userActionError?: () => string | null;

  // Live-updates indicator (#246 / final sub-PR of #95). Parent
  // route subscribes to events.tenant + updates this signal on each
  // envelope; the component renders a "Live · Xs ago" badge in the
  // tab-strip header. When the accessor returns null (subscription
  // not yet connected OR no events seen), the indicator shows
  // "Connecting…" instead.
  lastTenantEventAt?: () => Date | null;
  // Optional time-source override for tests so "Xs ago" rendering
  // is deterministic. Production uses () => new Date().
  now?: () => Date;
}

// formatCreatedAt — keeps the render layer's date formatting in one
// place so tests can pin the expected output. Returns ISO string for
// determinism; the upstream type is a Date OR string (pg.driver
// difference depending on jsdom vs. real psql).
export function formatCreatedAt(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return value;
}

// formatLiveAge — pure helper exported for L1 tests. Renders the
// elapsed wall-clock distance between `lastEventAt` and `now` as a
// short human string ("3s ago", "2m ago", "1h ago"). Returns
// "Connecting…" when lastEventAt is null.
export function formatLiveAge(
  lastEventAt: Date | null,
  now: Date,
): string {
  if (lastEventAt === null) return "Connecting…";
  const deltaMs = Math.max(0, now.getTime() - lastEventAt.getTime());
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const PrincipalAdmin: Component<PrincipalAdminProps> = (props) => {
  // Default time source: real wall clock. Test runs override.
  const nowFn = () => (props.now ? props.now() : new Date());
  // Live indicator visible only when the parent has wired the
  // lastTenantEventAt accessor (i.e. when subscription is set up).
  // Renders "Connecting…" when no event seen yet (accessor returns
  // null) so the operator sees the indicator's intent immediately.
  const showLiveIndicator = () => props.lastTenantEventAt !== undefined;

  return (
    <section aria-label="Principal admin">
      <nav aria-label="Principal admin tabs" role="tablist">
        <For each={PRINCIPAL_ADMIN_TABS}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              data-tab={tab}
              aria-selected={props.activeTab() === tab}
              onClick={() => props.onTabChange(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          )}
        </For>
        <Show when={showLiveIndicator()}>
          <span data-live-indicator="" aria-live="polite">
            Live · {formatLiveAge(props.lastTenantEventAt?.() ?? null, nowFn())}
          </span>
        </Show>
      </nav>

      <Show when={props.activeTab() === "users"}>
        <UsersTab
          users={props.users}
          loading={props.loading}
          error={props.error}
          selectedUser={props.selectedUser}
          onSelectUser={props.onSelectUser}
          onSuspendUser={props.onSuspendUser}
          onReinstateUser={props.onReinstateUser}
          actionPending={props.userActionPending}
          actionError={props.userActionError}
        />
      </Show>

      <Show when={props.activeTab() === "groups"}>
        <GroupsTab
          groups={props.groups}
          loading={props.groupsLoading}
          error={props.groupsError}
          onCreate={props.onCreateGroup}
          onDelete={props.onDeleteGroup}
          actionPending={props.groupActionPending}
          actionError={props.groupActionError}
          selectedGroup={props.selectedGroup}
          onSelectGroup={props.onSelectGroup}
          onAddMember={props.onAddGroupMember}
          onRemoveMember={props.onRemoveGroupMember}
          memberActionPending={props.memberActionPending}
          memberActionError={props.memberActionError}
          members={props.groupMembers}
          membersLoading={props.groupMembersLoading}
          membersError={props.groupMembersError}
        />
      </Show>

      <Show when={props.activeTab() === "roles"}>
        <RolesTab
          selectedPrincipal={props.selectedPrincipal}
          onSelectPrincipal={props.onSelectPrincipal}
          expandedRole={props.expandedRole}
          onSelectExpandedRole={props.onSelectExpandedRole}
          expandedRolePrincipals={props.expandedRolePrincipals}
          expandedRoleLoading={props.expandedRoleLoading}
          expandedRoleError={props.expandedRoleError}
          principalRoles={props.principalRoles}
          loading={props.principalRolesLoading}
          error={props.principalRolesError}
          onAssign={props.onAssignRole}
          onUnassign={props.onUnassignRole}
          onChange={props.onChangeRole}
          actionPending={props.roleActionPending}
          actionError={props.roleActionError}
        />
      </Show>
    </section>
  );
};

interface UsersTabProps {
  users: () => User[];
  loading?: () => boolean;
  error?: () => string | null;

  // Suspend/reinstate (#254 / Issue #105) — same Manage→section
  // pattern as the Groups tab's member-management surface.
  selectedUser?: () => User | null;
  onSelectUser?: (next: User | null) => void;
  onSuspendUser?: (userId: string) => Promise<void> | void;
  onReinstateUser?: (userId: string) => Promise<void> | void;
  actionPending?: () => boolean;
  actionError?: () => string | null;
}

const UsersTab: Component<UsersTabProps> = (props) => {
  const manageEnabled = () =>
    props.onSelectUser !== undefined &&
    (props.onSuspendUser !== undefined || props.onReinstateUser !== undefined);
  return (
    <div data-tab-panel="users" role="tabpanel">
      <Show when={props.loading?.()}>
        <p>Loading users…</p>
      </Show>
      <Show when={props.error?.()}>
        {(err) => <p role="alert">Failed to load users: {err()}</p>}
      </Show>
      <Show
        when={!props.loading?.() && !props.error?.() && props.users().length === 0}
      >
        <p>No users in this tenant.</p>
      </Show>
      <Show when={!props.loading?.() && !props.error?.() && props.users().length > 0}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>User ID</th>
              <th>Created</th>
              <Show when={manageEnabled()}>
                <th>Actions</th>
              </Show>
            </tr>
          </thead>
          <tbody>
            <For each={props.users()}>
              {(user) => (
                <tr data-row-key={user.id}>
                  <td>{user.email}</td>
                  <td>
                    <code>{user.id}</code>
                  </td>
                  <td>{formatCreatedAt(user.created_at)}</td>
                  <Show when={manageEnabled()}>
                    <td>
                      <button
                        type="button"
                        data-action="manage-user"
                        data-user-id={user.id}
                        disabled={props.actionPending?.()}
                        onClick={() => props.onSelectUser?.(user)}
                      >
                        Manage
                      </button>
                    </td>
                  </Show>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={props.selectedUser?.()}>
        {(user) => (
          <UserManageSection
            user={user()}
            onClose={() => props.onSelectUser?.(null)}
            onSuspend={props.onSuspendUser}
            onReinstate={props.onReinstateUser}
            actionPending={props.actionPending}
            actionError={props.actionError}
          />
        )}
      </Show>
    </div>
  );
};

interface UserManageSectionProps {
  user: User;
  onClose: () => void;
  onSuspend?: (userId: string) => Promise<void> | void;
  onReinstate?: (userId: string) => Promise<void> | void;
  actionPending?: () => boolean;
  actionError?: () => string | null;
}

// UserManageSection — appears below the Users table when a row's
// Manage button is clicked. Two action buttons (Suspend + Reinstate)
// + Close. Backend SpiceDB writes are idempotent, so wrong-click is
// safe — UI doesn't try to gate Suspend vs Reinstate visibility on
// current state (User shape from @monok8s/db doesn't surface it yet).
const UserManageSection: Component<UserManageSectionProps> = (props) => (
  <section
    data-section="user-manage"
    data-user-id={props.user.id}
    aria-label="User management"
  >
    <header>
      Manage user <code>{props.user.email}</code>
      <button
        type="button"
        data-action="close-user-manage"
        onClick={() => props.onClose()}
      >
        Close
      </button>
    </header>
    <div data-user-actions="">
      <button
        type="button"
        data-action="suspend-user"
        disabled={props.actionPending?.()}
        onClick={() => props.onSuspend?.(props.user.id)}
      >
        Suspend
      </button>
      <button
        type="button"
        data-action="reinstate-user"
        disabled={props.actionPending?.()}
        onClick={() => props.onReinstate?.(props.user.id)}
      >
        Reinstate
      </button>
    </div>
    <Show when={props.actionError?.()}>
      {(err) => <p role="alert">{err()}</p>}
    </Show>
  </section>
);

// ── Groups tab (#240 — sub-PR of #95) ────────────────────────────────────────
//
// Pure-presentation: parent route owns the tRPC mutation calls + the
// refetch-on-success bookkeeping. The component just reads the
// `groups()` accessor and fires the `onCreate` / `onDelete` callbacks.

const NAME_MIN = 1;
const NAME_MAX = 128;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// validateGroupForm — exported for L1 tests. Returns the parsed input
// on success or an error string on failure. Mirrors the server-side
// zod constraints (CreateGroupSchema in apps/api/src/routers/principals.ts).
export function validateGroupForm(
  rawName: string,
  rawParent: string,
): { ok: true; value: CreateGroupFormInput } | { ok: false; error: string } {
  const name = rawName.trim();
  if (name.length < NAME_MIN) {
    return { ok: false, error: "Name is required" };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, error: `Name must be ≤${NAME_MAX} characters` };
  }
  const parent = rawParent.trim();
  if (parent.length > 0 && !UUID_RE.test(parent)) {
    return { ok: false, error: "Parent group ID must be a UUID (or empty)" };
  }
  return {
    ok: true,
    value: {
      name,
      parentGroupId: parent.length > 0 ? parent : undefined,
    },
  };
}

// validateMemberUserId — pure UUID validator for the member-mutation
// form (#250). Exported for L1 tests. Returns the trimmed userId on
// success or an error string on failure.
export function validateMemberUserId(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const id = raw.trim();
  if (id.length === 0) return { ok: false, error: "User ID is required" };
  if (!UUID_RE.test(id)) return { ok: false, error: "User ID must be a UUID" };
  return { ok: true, value: id };
}

interface GroupsTabProps {
  groups?: () => Group[];
  loading?: () => boolean;
  error?: () => string | null;
  onCreate?: (input: CreateGroupFormInput) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  actionPending?: () => boolean;
  actionError?: () => string | null;
  // Member-management (#250).
  selectedGroup?: () => Group | null;
  onSelectGroup?: (next: Group | null) => void;
  onAddMember?: (
    groupId: string,
    input: MemberMutationFormInput,
  ) => Promise<void> | void;
  onRemoveMember?: (
    groupId: string,
    input: MemberMutationFormInput,
  ) => Promise<void> | void;
  memberActionPending?: () => boolean;
  memberActionError?: () => string | null;
  // groups.list_members consumer (#258). Members of the selectedGroup.
  members?: () => string[];
  membersLoading?: () => boolean;
  membersError?: () => string | null;
}

const GroupsTab: Component<GroupsTabProps> = (props) => {
  const [nameInput, setNameInput] = createSignal("");
  const [parentInput, setParentInput] = createSignal("");
  const [clientError, setClientError] = createSignal<string | null>(null);

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    setClientError(null);
    const result = validateGroupForm(nameInput(), parentInput());
    if (!result.ok) {
      setClientError(result.error);
      return;
    }
    await props.onCreate?.(result.value);
    // Parent refetches; clear form on success path. Errors surface
    // via props.actionError so the form keeps its inputs for retry.
    setNameInput("");
    setParentInput("");
  };

  const handleDelete = async (id: string) => {
    setClientError(null);
    await props.onDelete?.(id);
  };

  const displayError = () => clientError() ?? props.actionError?.() ?? null;
  const groupsList = () => props.groups?.() ?? [];

  return (
    <div data-tab-panel="groups" role="tabpanel">
      <form aria-label="Create group" onSubmit={handleCreate}>
        <label>
          Name
          <input
            name="group-name"
            type="text"
            value={nameInput()}
            onInput={(e) => setNameInput(e.currentTarget.value)}
            disabled={props.actionPending?.()}
            data-field="name"
          />
        </label>
        <label>
          Parent group ID (optional)
          <input
            name="group-parent"
            type="text"
            value={parentInput()}
            onInput={(e) => setParentInput(e.currentTarget.value)}
            disabled={props.actionPending?.()}
            data-field="parentGroupId"
          />
        </label>
        <button
          type="submit"
          data-action="create-group"
          disabled={props.actionPending?.()}
        >
          Create group
        </button>
      </form>

      <Show when={displayError()}>
        {(err) => <p role="alert">{err()}</p>}
      </Show>

      <Show when={props.loading?.()}>
        <p>Loading groups…</p>
      </Show>

      <Show
        when={
          !props.loading?.() && !props.error?.() && groupsList().length === 0
        }
      >
        <p>No groups in this tenant.</p>
      </Show>

      <Show when={props.error?.()}>
        {(err) => <p role="alert">Failed to load groups: {err()}</p>}
      </Show>

      <Show
        when={!props.loading?.() && !props.error?.() && groupsList().length > 0}
      >
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Group ID</th>
              <th>Parent</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={groupsList()}>
              {(group) => (
                <tr data-row-key={group.id}>
                  <td>{group.name}</td>
                  <td>
                    <code>{group.id}</code>
                  </td>
                  <td>
                    {group.parent_group_id ? (
                      <code>{group.parent_group_id}</code>
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                  <td>{formatCreatedAt(group.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      data-action="manage-members"
                      data-row-action-key={group.id}
                      disabled={
                        props.actionPending?.() ||
                        props.memberActionPending?.()
                      }
                      onClick={() => props.onSelectGroup?.(group)}
                    >
                      Manage members
                    </button>
                    <button
                      type="button"
                      data-action="delete-group"
                      data-row-action-key={group.id}
                      disabled={props.actionPending?.()}
                      onClick={() => handleDelete(group.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={props.selectedGroup?.()}>
        {(selected) => (
          <MemberManagementSection
            group={selected()}
            onClose={() => props.onSelectGroup?.(null)}
            onAddMember={(input) =>
              props.onAddMember?.(selected().id, input)
            }
            onRemoveMember={(input) =>
              props.onRemoveMember?.(selected().id, input)
            }
            actionPending={props.memberActionPending}
            actionError={props.memberActionError}
            members={props.members}
            membersLoading={props.membersLoading}
            membersError={props.membersError}
          />
        )}
      </Show>
    </div>
  );
};

interface MemberManagementSectionProps {
  group: Group;
  onClose: () => void;
  onAddMember?: (input: MemberMutationFormInput) => Promise<void> | void;
  onRemoveMember?: (input: MemberMutationFormInput) => Promise<void> | void;
  actionPending?: () => boolean;
  actionError?: () => string | null;
  // Current-members list (#258). Optional — old mounts that don't
  // wire list_members keep working without rendering the list.
  members?: () => string[];
  membersLoading?: () => boolean;
  membersError?: () => string | null;
}

const MemberManagementSection: Component<MemberManagementSectionProps> = (
  props,
) => {
  const [userIdInput, setUserIdInput] = createSignal("");
  const [clientError, setClientError] = createSignal<string | null>(null);

  const dispatch = async (
    fn: ((input: MemberMutationFormInput) => Promise<void> | void) | undefined,
  ) => {
    setClientError(null);
    const result = validateMemberUserId(userIdInput());
    if (!result.ok) {
      setClientError(result.error);
      return;
    }
    await fn?.({ userId: result.value });
    setUserIdInput("");
  };

  const displayError = () => clientError() ?? props.actionError?.() ?? null;

  return (
    <section
      data-section="member-management"
      aria-label={`Members of ${props.group.name}`}
    >
      <h3>
        Members of <code>{props.group.name}</code>
      </h3>
      <button
        type="button"
        data-action="close-member-management"
        onClick={props.onClose}
        disabled={props.actionPending?.()}
      >
        Close
      </button>

      <form
        aria-label="Add or remove group member"
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          User ID
          <input
            name="member-user-id"
            type="text"
            value={userIdInput()}
            onInput={(e) => setUserIdInput(e.currentTarget.value)}
            disabled={props.actionPending?.()}
            data-field="member-user-id"
          />
        </label>
        <button
          type="button"
          data-action="add-member"
          disabled={props.actionPending?.()}
          onClick={() => dispatch(props.onAddMember)}
        >
          Add
        </button>
        <button
          type="button"
          data-action="remove-member"
          disabled={props.actionPending?.()}
          onClick={() => dispatch(props.onRemoveMember)}
        >
          Remove
        </button>
      </form>

      <Show when={displayError()}>
        {(err) => <p role="alert">{err()}</p>}
      </Show>

      <Show when={props.members !== undefined}>
        <div data-section="member-list" aria-label="Current group members">
          <h4>Current members</h4>
          <Show when={props.membersLoading?.()}>
            <p>Loading members…</p>
          </Show>
          <Show when={props.membersError?.()}>
            {(err) => <p role="alert">Failed to load members: {err()}</p>}
          </Show>
          <Show
            when={
              !props.membersLoading?.() &&
              !props.membersError?.() &&
              (props.members?.()?.length ?? 0) === 0
            }
          >
            <p>No members in this group.</p>
          </Show>
          <Show
            when={
              !props.membersLoading?.() &&
              !props.membersError?.() &&
              (props.members?.()?.length ?? 0) > 0
            }
          >
            <ul>
              <For each={props.members?.() ?? []}>
                {(userId) => (
                  <li data-member-user-id={userId}>
                    <code>{userId}</code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </section>
  );
};

// ── Roles tab (#242 — sub-PR of #95) ─────────────────────────────────────────
//
// Per-principal view: pick a principal (UUID + type), see their
// current tenant roles, assign or unassign individual roles. Atomic
// role-change (roles.change mutation) deferred to a follow-up sub-PR.
//
// Pure-presentation: parent route owns the selectedPrincipal signal +
// the principalRoles resource keyed on it (refetches when selection
// changes). The component reads accessors + fires callbacks.

// validateRolesForm — exported for L1 tests. Parses the principal-
// picker form (UUID id + type enum) into a PrincipalRef. Mirrors
// the server-side PrincipalSchema (apps/api/src/routers/principals.ts).
export function validateRolesForm(
  rawId: string,
  rawType: string,
):
  | { ok: true; value: PrincipalRef }
  | { ok: false; error: string } {
  const id = rawId.trim();
  if (id.length === 0) {
    return { ok: false, error: "Principal ID is required" };
  }
  if (!UUID_RE.test(id)) {
    return { ok: false, error: "Principal ID must be a UUID" };
  }
  if (rawType !== "user" && rawType !== "service_account") {
    return {
      ok: false,
      error: 'Principal type must be "user" or "service_account"',
    };
  }
  return { ok: true, value: { id, type: rawType } };
}

interface RolesTabProps {
  selectedPrincipal?: () => PrincipalRef | null;
  onSelectPrincipal?: (next: PrincipalRef | null) => void;
  principalRoles?: () => TenantRole[];
  loading?: () => boolean;
  error?: () => string | null;
  onAssign?: (input: AssignRoleFormInput) => Promise<void> | void;
  onUnassign?: (input: AssignRoleFormInput) => Promise<void> | void;
  onChange?: (input: ChangeRoleFormInput) => Promise<void> | void;
  actionPending?: () => boolean;
  actionError?: () => string | null;
  // Expand-for-role (#266) — dual to list_for_principal. Parent
  // owns the expandedRole signal + the expansion resource keyed on it.
  expandedRole?: () => TenantRole | null;
  onSelectExpandedRole?: (next: TenantRole | null) => void;
  expandedRolePrincipals?: () => {
    users: string[];
    serviceAccounts: string[];
  } | null;
  expandedRoleLoading?: () => boolean;
  expandedRoleError?: () => string | null;
}

// validateChangeRoleForm — exported for L1 tests. Mirrors the server-
// side ChangeRoleSchema's `.refine(d => d.oldRole !== d.newRole)`.
// Caller passes the parsed roles already (RolesTab's select values
// are bound to TenantRole), so this validator's sole job is the
// oldRole !== newRole check.
export function validateChangeRoleForm(
  oldRole: TenantRole,
  newRole: TenantRole,
):
  | { ok: true; value: { oldRole: TenantRole; newRole: TenantRole } }
  | { ok: false; error: string } {
  if (oldRole === newRole) {
    return { ok: false, error: "oldRole and newRole must differ" };
  }
  return { ok: true, value: { oldRole, newRole } };
}

const RolesTab: Component<RolesTabProps> = (props) => {
  const [idInput, setIdInput] = createSignal("");
  const [typeInput, setTypeInput] = createSignal<PrincipalType>("user");
  const [assignRoleInput, setAssignRoleInput] = createSignal<TenantRole>(
    "viewer",
  );
  // Change-form state (#261). Defaults: oldRole=viewer / newRole=member
  // so the initial values differ (passes the oldRole !== newRole rule
  // without any user input).
  const [changeOldRoleInput, setChangeOldRoleInput] =
    createSignal<TenantRole>("viewer");
  const [changeNewRoleInput, setChangeNewRoleInput] =
    createSignal<TenantRole>("member");
  // Expand-for-role form state (#266). Picks the role the form will
  // submit; parent's `expandedRole` signal tracks the actively-shown
  // expansion.
  const [expandRoleInput, setExpandRoleInput] =
    createSignal<TenantRole>("admin");
  const [clientError, setClientError] = createSignal<string | null>(null);

  const handleLookup = (e: Event) => {
    e.preventDefault();
    setClientError(null);
    const result = validateRolesForm(idInput(), typeInput());
    if (!result.ok) {
      setClientError(result.error);
      props.onSelectPrincipal?.(null);
      return;
    }
    props.onSelectPrincipal?.(result.value);
  };

  const handleClear = () => {
    setClientError(null);
    setIdInput("");
    setTypeInput("user");
    props.onSelectPrincipal?.(null);
  };

  const handleAssign = async (e: Event) => {
    e.preventDefault();
    setClientError(null);
    const principal = props.selectedPrincipal?.();
    if (!principal) {
      setClientError("Select a principal first");
      return;
    }
    await props.onAssign?.({ principal, role: assignRoleInput() });
  };

  const handleUnassign = async (role: TenantRole) => {
    setClientError(null);
    const principal = props.selectedPrincipal?.();
    if (!principal) return;
    await props.onUnassign?.({ principal, role });
  };

  const handleChange = async (e: Event) => {
    e.preventDefault();
    setClientError(null);
    const principal = props.selectedPrincipal?.();
    if (!principal) {
      setClientError("Select a principal first");
      return;
    }
    const result = validateChangeRoleForm(
      changeOldRoleInput(),
      changeNewRoleInput(),
    );
    if (!result.ok) {
      setClientError(result.error);
      return;
    }
    await props.onChange?.({
      principal,
      oldRole: result.value.oldRole,
      newRole: result.value.newRole,
    });
  };

  const handleExpandLookup = (e: Event) => {
    e.preventDefault();
    props.onSelectExpandedRole?.(expandRoleInput());
  };

  const handleExpandClear = () => {
    props.onSelectExpandedRole?.(null);
  };

  const displayError = () => clientError() ?? props.actionError?.() ?? null;
  const currentRoles = () => props.principalRoles?.() ?? [];
  const expandedUsers = () => props.expandedRolePrincipals?.()?.users ?? [];
  const expandedServiceAccounts = () =>
    props.expandedRolePrincipals?.()?.serviceAccounts ?? [];

  return (
    <div data-tab-panel="roles" role="tabpanel">
      <form aria-label="Principal picker" onSubmit={handleLookup}>
        <label>
          Principal ID
          <input
            name="principal-id"
            type="text"
            value={idInput()}
            onInput={(e) => setIdInput(e.currentTarget.value)}
            disabled={props.actionPending?.()}
            data-field="principal-id"
          />
        </label>
        <label>
          Type
          <select
            name="principal-type"
            value={typeInput()}
            onChange={(e) =>
              setTypeInput(e.currentTarget.value as PrincipalType)
            }
            disabled={props.actionPending?.()}
            data-field="principal-type"
          >
            <option value="user">user</option>
            <option value="service_account">service_account</option>
          </select>
        </label>
        <button
          type="submit"
          data-action="lookup-principal"
          disabled={props.actionPending?.()}
        >
          Look up roles
        </button>
        <button
          type="button"
          data-action="clear-principal"
          onClick={handleClear}
          disabled={props.actionPending?.()}
        >
          Clear
        </button>
      </form>

      <Show when={displayError()}>
        {(err) => <p role="alert">{err()}</p>}
      </Show>

      <Show when={!props.selectedPrincipal?.()}>
        <p>Select a principal above to view + edit their tenant roles.</p>
      </Show>

      <Show when={props.selectedPrincipal?.()}>
        {(principal) => (
          <section data-section="principal-roles">
            <h2>
              Roles for {principal().type}:{" "}
              <code>{principal().id}</code>
            </h2>

            <Show when={props.loading?.()}>
              <p>Loading roles…</p>
            </Show>

            <Show when={props.error?.()}>
              {(err) => (
                <p role="alert">Failed to load roles: {err()}</p>
              )}
            </Show>

            <Show
              when={
                !props.loading?.() &&
                !props.error?.() &&
                currentRoles().length === 0
              }
            >
              <p>This principal holds no tenant roles.</p>
            </Show>

            <Show
              when={
                !props.loading?.() &&
                !props.error?.() &&
                currentRoles().length > 0
              }
            >
              <ul data-list="current-roles">
                <For each={currentRoles()}>
                  {(role) => (
                    <li data-role-key={role}>
                      <span class="role-chip">{role}</span>
                      <button
                        type="button"
                        data-action="unassign-role"
                        data-role-action-key={role}
                        disabled={props.actionPending?.()}
                        onClick={() => handleUnassign(role)}
                        aria-label={`Unassign ${role}`}
                      >
                        ×
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <form aria-label="Assign role" onSubmit={handleAssign}>
              <label>
                Role
                <select
                  name="assign-role"
                  value={assignRoleInput()}
                  onChange={(e) =>
                    setAssignRoleInput(
                      e.currentTarget.value as TenantRole,
                    )
                  }
                  disabled={props.actionPending?.()}
                  data-field="assign-role"
                >
                  <For each={TENANT_ROLES}>
                    {(role) => <option value={role}>{role}</option>}
                  </For>
                </select>
              </label>
              <button
                type="submit"
                data-action="assign-role"
                disabled={props.actionPending?.()}
              >
                Assign
              </button>
            </form>

            <Show when={props.onChange !== undefined}>
              <form
                aria-label="Change role"
                onSubmit={handleChange}
                data-form="change-role"
              >
                <label>
                  From
                  <select
                    name="change-old-role"
                    value={changeOldRoleInput()}
                    onChange={(e) =>
                      setChangeOldRoleInput(
                        e.currentTarget.value as TenantRole,
                      )
                    }
                    disabled={props.actionPending?.()}
                    data-field="change-old-role"
                  >
                    <For each={TENANT_ROLES}>
                      {(role) => <option value={role}>{role}</option>}
                    </For>
                  </select>
                </label>
                <label>
                  To
                  <select
                    name="change-new-role"
                    value={changeNewRoleInput()}
                    onChange={(e) =>
                      setChangeNewRoleInput(
                        e.currentTarget.value as TenantRole,
                      )
                    }
                    disabled={props.actionPending?.()}
                    data-field="change-new-role"
                  >
                    <For each={TENANT_ROLES}>
                      {(role) => <option value={role}>{role}</option>}
                    </For>
                  </select>
                </label>
                <button
                  type="submit"
                  data-action="change-role"
                  disabled={props.actionPending?.()}
                >
                  Change role
                </button>
              </form>
            </Show>
          </section>
        )}
      </Show>

      <Show when={props.onSelectExpandedRole !== undefined}>
        <section data-section="expand-for-role" aria-label="Expand for role">
          <h2>Expand for role</h2>
          <p>
            Look up every principal (users + service accounts) holding a
            given tenant role.
          </p>
          <form
            aria-label="Expand-for-role picker"
            onSubmit={handleExpandLookup}
            data-form="expand-for-role"
          >
            <label>
              Role
              <select
                name="expand-role"
                value={expandRoleInput()}
                onChange={(e) =>
                  setExpandRoleInput(e.currentTarget.value as TenantRole)
                }
                data-field="expand-role"
              >
                <For each={TENANT_ROLES}>
                  {(role) => <option value={role}>{role}</option>}
                </For>
              </select>
            </label>
            <button type="submit" data-action="expand-role-lookup">
              Look up principals
            </button>
            <Show when={props.expandedRole?.() !== null && props.expandedRole?.() !== undefined}>
              <button
                type="button"
                data-action="expand-role-clear"
                onClick={handleExpandClear}
              >
                Clear
              </button>
            </Show>
          </form>

          <Show when={props.expandedRole?.()}>
            {(role) => (
              <div data-section="expand-for-role-results">
                <h3>
                  Principals holding role <code>{role()}</code>
                </h3>

                <Show when={props.expandedRoleLoading?.()}>
                  <p>Loading principals…</p>
                </Show>

                <Show when={props.expandedRoleError?.()}>
                  {(err) => (
                    <p role="alert">
                      Failed to load principals: {err()}
                    </p>
                  )}
                </Show>

                <Show
                  when={
                    !props.expandedRoleLoading?.() &&
                    !props.expandedRoleError?.()
                  }
                >
                  <h4>Users ({expandedUsers().length})</h4>
                  <Show when={expandedUsers().length === 0}>
                    <p>No users hold this role.</p>
                  </Show>
                  <Show when={expandedUsers().length > 0}>
                    <ul data-list="expanded-users">
                      <For each={expandedUsers()}>
                        {(userId) => (
                          <li data-expanded-user-id={userId}>
                            <code>{userId}</code>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <h4>
                    Service accounts ({expandedServiceAccounts().length})
                  </h4>
                  <Show when={expandedServiceAccounts().length === 0}>
                    <p>No service accounts hold this role.</p>
                  </Show>
                  <Show when={expandedServiceAccounts().length > 0}>
                    <ul data-list="expanded-service-accounts">
                      <For each={expandedServiceAccounts()}>
                        {(saId) => (
                          <li data-expanded-sa-id={saId}>
                            <code>{saId}</code>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </Show>
    </div>
  );
};

export default PrincipalAdmin;
