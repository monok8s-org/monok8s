// Principals route — thin subscription-shell consuming
// <PrincipalAdmin> (#238 + #240 + #242 + #246 / sub-tasks of #95).
// Owns the tRPC resources + mutation calls + the active-tab signal +
// per-tab state (group action signals, selected-principal signal) +
// the events.tenant SSE subscription that drives live refetches.
// The component is pure presentation.

import { type Component } from "solid-js";
import { createResource, createSignal, onCleanup, onMount } from "solid-js";

import AppShell from "../components/AppShell";
import PrincipalAdmin, {
  type AssignRoleFormInput,
  type ChangeRoleFormInput,
  type CreateGroupFormInput,
  type Group,
  type MemberMutationFormInput,
  type PrincipalAdminTab,
  type PrincipalRef,
  type TenantRole,
  type User,
} from "../components/PrincipalAdmin";
// User type stays as the @monok8s/db shape; the alias above is the
// public re-export the test surface consumes.
import { monok8sClient } from "../lib/trpc";

const Principals: Component = () => {
  const [activeTab, setActiveTab] = createSignal<PrincipalAdminTab>("users");

  // Users resource (#238). Destructured with `refetch` (#263) so the
  // events.tenant subscription handler can pull a fresh users-list
  // alongside the groups + principalRoles refetches — same posture as
  // every other volatile resource in this route.
  const [users, { refetch: refetchUsers }] = createResource(async () =>
    (await monok8sClient.principals.users.list.query()) as unknown as User[],
  );

  // Groups resource (#240).
  const [groups, { refetch: refetchGroups }] = createResource(async () =>
    (await monok8sClient.principals.groups.list.query()) as unknown as Group[],
  );

  const [groupActionPending, setGroupActionPending] = createSignal(false);
  const [groupActionError, setGroupActionError] = createSignal<string | null>(
    null,
  );

  const handleCreateGroup = async (input: CreateGroupFormInput) => {
    setGroupActionError(null);
    setGroupActionPending(true);
    try {
      await monok8sClient.principals.groups.create.mutate(input);
      await refetchGroups();
    } catch (e) {
      setGroupActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setGroupActionPending(false);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    setGroupActionError(null);
    setGroupActionPending(true);
    try {
      await monok8sClient.principals.groups.delete.mutate({ id });
      await refetchGroups();
    } catch (e) {
      setGroupActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setGroupActionPending(false);
    }
  };

  // Roles tab (#242). Selected principal + the roles resource keyed
  // on it (re-resolves when selection changes).
  const [selectedPrincipal, setSelectedPrincipal] =
    createSignal<PrincipalRef | null>(null);
  const [principalRoles, { refetch: refetchPrincipalRoles }] = createResource(
    selectedPrincipal,
    async (principal) => {
      if (!principal) return [];
      const result = (await monok8sClient.principals.roles.list_for_principal.query(
        principal,
      )) as unknown as { roles: TenantRole[] };
      return result.roles;
    },
  );

  const [roleActionPending, setRoleActionPending] = createSignal(false);
  const [roleActionError, setRoleActionError] = createSignal<string | null>(
    null,
  );

  const handleAssignRole = async (input: AssignRoleFormInput) => {
    setRoleActionError(null);
    setRoleActionPending(true);
    try {
      await monok8sClient.principals.roles.assign.mutate(input);
      await refetchPrincipalRoles();
    } catch (e) {
      setRoleActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleActionPending(false);
    }
  };

  const handleUnassignRole = async (input: AssignRoleFormInput) => {
    setRoleActionError(null);
    setRoleActionPending(true);
    try {
      await monok8sClient.principals.roles.unassign.mutate(input);
      await refetchPrincipalRoles();
    } catch (e) {
      setRoleActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleActionPending(false);
    }
  };

  // Roles atomic-swap mutation (#261). Same handler shape as assign/
  // unassign — shared roleActionPending / roleActionError signals so
  // a single in-flight swap disables every role-mutation button.
  const handleChangeRole = async (input: ChangeRoleFormInput) => {
    setRoleActionError(null);
    setRoleActionPending(true);
    try {
      await monok8sClient.principals.roles.change.mutate(input);
      await refetchPrincipalRoles();
    } catch (e) {
      setRoleActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleActionPending(false);
    }
  };

  // Expand-for-role (#266 / closes the Roles tab dual-direction
  // lookup). Resource keyed on selectedExpandedRole; re-resolves
  // whenever a new role is picked.
  const [selectedExpandedRole, setSelectedExpandedRole] =
    createSignal<TenantRole | null>(null);
  const [expandedRolePrincipals] = createResource(
    selectedExpandedRole,
    async (role) => {
      if (!role) return null;
      const result = (await monok8sClient.principals.roles.expand_for_role.query({
        role,
      })) as unknown as { users: string[]; serviceAccounts: string[] };
      return result;
    },
  );

  // Groups member-management (#250). Selected group + shared
  // memberActionPending / memberActionError signals across the
  // add_member / remove_member mutations.
  const [selectedGroup, setSelectedGroup] = createSignal<Group | null>(null);
  const [memberActionPending, setMemberActionPending] = createSignal(false);
  const [memberActionError, setMemberActionError] = createSignal<string | null>(
    null,
  );

  // groups.list_members consumer (#258). Resource keyed on selectedGroup;
  // re-fetches whenever a new group is picked. Returns [] for the null-
  // selection case so the UI renders nothing when no group is selected.
  const [groupMembers, { refetch: refetchGroupMembers }] = createResource(
    selectedGroup,
    async (group) => {
      if (!group) return [];
      const result = (await monok8sClient.principals.groups.list_members.query({
        id: group.id,
      })) as unknown as { users: string[] };
      return result.users;
    },
  );

  const handleAddGroupMember = async (
    groupId: string,
    input: MemberMutationFormInput,
  ) => {
    setMemberActionError(null);
    setMemberActionPending(true);
    try {
      await monok8sClient.principals.groups.add_member.mutate({
        groupId,
        userId: input.userId,
      });
      // Refetch members so the just-added user shows up. The mutation
      // is async (Temporal workflow) so this read can race ahead of
      // the SpiceDB write — V1 accepts the race since the
      // live-updates indicator (#246) reflects the tenant.event when
      // the workflow completes; operators can re-Manage the group to
      // hard-refetch if the optimistic refetch missed.
      await refetchGroupMembers();
    } catch (e) {
      setMemberActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMemberActionPending(false);
    }
  };

  const handleRemoveGroupMember = async (
    groupId: string,
    input: MemberMutationFormInput,
  ) => {
    setMemberActionError(null);
    setMemberActionPending(true);
    try {
      await monok8sClient.principals.groups.remove_member.mutate({
        groupId,
        userId: input.userId,
      });
      await refetchGroupMembers();
    } catch (e) {
      setMemberActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMemberActionPending(false);
    }
  };

  // Users tab suspend/reinstate (#254 / Issue #105). Mirrors the
  // Groups member-management shape: selectedUser signal + shared
  // actionPending / actionError signals across both mutations.
  const [selectedUser, setSelectedUser] = createSignal<User | null>(null);
  const [userActionPending, setUserActionPending] = createSignal(false);
  const [userActionError, setUserActionError] = createSignal<string | null>(
    null,
  );

  const handleSuspendUser = async (userId: string) => {
    setUserActionError(null);
    setUserActionPending(true);
    try {
      await monok8sClient.principals.users.suspend.mutate({ userId });
      // No users.list refetch — User shape doesn't surface
      // suspended state today. Live-updates indicator (#246) reflects
      // the tenant.event when the workflow completes.
    } catch (e) {
      setUserActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setUserActionPending(false);
    }
  };

  const handleReinstateUser = async (userId: string) => {
    setUserActionError(null);
    setUserActionPending(true);
    try {
      await monok8sClient.principals.users.reinstate.mutate({ userId });
    } catch (e) {
      setUserActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setUserActionPending(false);
    }
  };

  // Live updates (#246 — final sub-PR of #95). Subscribe to
  // events.tenant on mount; on each envelope, bump the
  // lastTenantEventAt signal + refetch all three resources. Same
  // subscription pattern as Audit.tsx (#94 / PR #210) and
  // Workflows.tsx (#92 / PR #207). Coarse-grained refetch (every
  // event triggers full refetch) for v1; fine-grained dispatch by
  // event type is a follow-up if traffic gets noisy.
  const [lastTenantEventAt, setLastTenantEventAt] =
    createSignal<Date | null>(null);

  onMount(() => {
    const sub = monok8sClient.events.tenant.subscribe(undefined, {
      onData: () => {
        setLastTenantEventAt(new Date());
        void refetchGroups();
        void refetchPrincipalRoles();
        // Users-list refetch (#263). User suspension state isn't on
        // the @monok8s/db User shape today (per #105's V1 trade-off),
        // but tenant.events also fire for user invitations + erasures
        // which DO change the users-list. Cheap pull keeps the row
        // set fresh alongside the other volatile resources.
        void refetchUsers();
      },
      onError: () => {
        // Swallow — tRPC client handles its own reconnect semantics;
        // the indicator just stops advancing if disconnected.
      },
    });
    onCleanup(() => sub.unsubscribe());
  });

  return (
    <AppShell>
      <h1>Principals</h1>
      <PrincipalAdmin
        activeTab={activeTab}
        onTabChange={setActiveTab}
        users={() => users() ?? []}
        loading={() => users.loading}
        error={() => (users.error ? String(users.error) : null)}
        groups={() => groups() ?? []}
        groupsLoading={() => groups.loading}
        groupsError={() => (groups.error ? String(groups.error) : null)}
        onCreateGroup={handleCreateGroup}
        onDeleteGroup={handleDeleteGroup}
        groupActionPending={groupActionPending}
        groupActionError={groupActionError}
        selectedPrincipal={selectedPrincipal}
        onSelectPrincipal={setSelectedPrincipal}
        principalRoles={() => principalRoles() ?? []}
        principalRolesLoading={() => principalRoles.loading}
        principalRolesError={() =>
          principalRoles.error ? String(principalRoles.error) : null
        }
        onAssignRole={handleAssignRole}
        onUnassignRole={handleUnassignRole}
        onChangeRole={handleChangeRole}
        roleActionPending={roleActionPending}
        roleActionError={roleActionError}
        expandedRole={selectedExpandedRole}
        onSelectExpandedRole={setSelectedExpandedRole}
        expandedRolePrincipals={() => expandedRolePrincipals() ?? null}
        expandedRoleLoading={() => expandedRolePrincipals.loading}
        expandedRoleError={() =>
          expandedRolePrincipals.error
            ? String(expandedRolePrincipals.error)
            : null
        }
        lastTenantEventAt={lastTenantEventAt}
        selectedGroup={selectedGroup}
        onSelectGroup={setSelectedGroup}
        onAddGroupMember={handleAddGroupMember}
        onRemoveGroupMember={handleRemoveGroupMember}
        memberActionPending={memberActionPending}
        memberActionError={memberActionError}
        groupMembers={() => groupMembers() ?? []}
        groupMembersLoading={() => groupMembers.loading}
        groupMembersError={() =>
          groupMembers.error ? String(groupMembers.error) : null
        }
        selectedUser={selectedUser}
        onSelectUser={setSelectedUser}
        onSuspendUser={handleSuspendUser}
        onReinstateUser={handleReinstateUser}
        userActionPending={userActionPending}
        userActionError={userActionError}
      />
    </AppShell>
  );
};

export default Principals;
