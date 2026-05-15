import {
  createSignal,
  ParentComponent,
  For,
  Show,
  createMemo,
} from "solid-js";
import { useCloud } from "../providers/cloud-theme";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavItem {
  id:    string;
  label: string;
  icon:  string;    // Unicode / emoji placeholder — swap for SVG icons in prod
  href:  string;
  children?: NavItem[];
}

// ── Navigation structure ──────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  {
    id: "overview", label: "Overview", icon: "⊞", href: "/",
  },
  {
    id: "tenants", label: "Tenants", icon: "☁", href: "/tenants",
    children: [
      { id: "tenants-list",      label: "All tenants",   icon: "•", href: "/tenants" },
      { id: "tenants-onboard",   label: "Onboard",       icon: "•", href: "/tenants/onboard" },
    ],
  },
  {
    id: "iam", label: "IAM & Access", icon: "🔑", href: "/iam",
    children: [
      { id: "iam-roles",   label: "Roles",          icon: "•", href: "/iam/roles" },
      { id: "iam-review",  label: "Access reviews",  icon: "•", href: "/iam/reviews" },
    ],
  },
  {
    id: "infra", label: "Infrastructure", icon: "⚙", href: "/infra",
    children: [
      { id: "infra-drift",    label: "Drift",       icon: "•", href: "/infra/drift" },
      { id: "infra-installs", label: "Installs",    icon: "•", href: "/infra/installs" },
    ],
  },
  {
    id: "security", label: "Security", icon: "🛡", href: "/security",
  },
  {
    id: "billing", label: "Billing", icon: "💳", href: "/billing",
  },
];

// ── Shell ─────────────────────────────────────────────────────────────────────

/**
 * GCPShell
 *
 * Mimics the Google Cloud Console layout:
 *   - Fixed left sidebar (256 px expanded / 56 px icon-only)
 *   - Top bar with project selector (placeholder) and right-side utility icons
 *   - Main content area with 1440 px max-width, scrollable independently
 *   - Material Design-inspired nav: active item highlighted with accent surface
 *     pill, hover transitions via --mk-transition
 *
 * Typography: Google Sans / Roboto via --mk-font-family.
 * Radius: 4 px / 8 px / 12 px via --mk-radius-*.
 * Shadows: Material elevation 1/2/3 via --mk-shadow-*.
 */
const GCPShell: ParentComponent = (props) => {
  const { info } = useCloud();

  const [collapsed, setCollapsed] = createSignal(false);
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());
  const [activeId, setActiveId] = createSignal("overview");

  const navWidth = createMemo(() => collapsed() ? "var(--mk-nav-collapsed-width)" : "var(--mk-nav-width)");

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function navItemEl(item: NavItem, depth = 0) {
    const isActive = () => activeId() === item.id;
    const isExpanded = () => expandedGroups().has(item.id);
    const hasChildren = !!item.children?.length;

    return (
      <div>
        <a
          href={item.href}
          class="mk-gcp-nav-item"
          classList={{
            "mk-gcp-nav-item--active": isActive(),
            "mk-gcp-nav-item--child":  depth > 0,
          }}
          style={{ "padding-left": depth > 0 ? "var(--mk-spacing-xl)" : undefined }}
          onClick={(e) => {
            e.preventDefault();
            setActiveId(item.id);
            if (hasChildren) toggleGroup(item.id);
          }}
          title={collapsed() ? item.label : undefined}
        >
          <span class="mk-gcp-nav-item__icon">{item.icon}</span>
          <Show when={!collapsed()}>
            <span class="mk-gcp-nav-item__label">{item.label}</span>
            <Show when={hasChildren}>
              <span class="mk-gcp-nav-item__chevron">
                {isExpanded() ? "▾" : "▸"}
              </span>
            </Show>
          </Show>
        </a>
        <Show when={!collapsed() && hasChildren && isExpanded()}>
          <For each={item.children}>
            {(child) => navItemEl(child, depth + 1)}
          </For>
        </Show>
      </div>
    );
  }

  return (
    <div class="mk-gcp-shell" style={{ display: "flex", "flex-direction": "column", height: "100vh" }}>

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <header
        class="mk-gcp-topbar"
        style={{
          height:           "var(--mk-topbar-height)",
          background:       "var(--mk-color-surface)",
          "border-bottom":  "1px solid var(--mk-color-border)",
          display:          "flex",
          "align-items":    "center",
          padding:          "0 var(--mk-spacing-md)",
          gap:              "var(--mk-spacing-md)",
          "flex-shrink":    "0",
          "z-index":        "10",
        }}
      >
        {/* Hamburger */}
        <button
          class="mk-icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label="Toggle sidebar"
        >
          ☰
        </button>

        {/* Logo wordmark */}
        <span style={{ "font-weight": "var(--mk-font-weight-bold)", "font-size": "var(--mk-font-size-md)" }}>
          monok8s
        </span>

        {/* Project selector (GCP-style) */}
        <button
          class="mk-gcp-project-selector"
          style={{
            display:       "flex",
            "align-items": "center",
            gap:           "var(--mk-spacing-xs)",
            padding:       "4px var(--mk-spacing-sm)",
            border:        "1px solid var(--mk-color-border)",
            "border-radius": "var(--mk-radius-sm)",
            background:    "transparent",
            cursor:        "pointer",
            "font-size":   "var(--mk-font-size-sm)",
            color:         "var(--mk-color-text)",
          }}
        >
          <span>{info.environment}</span>
          <span style={{ "font-size": "10px", color: "var(--mk-color-text-subtle)" }}>▾</span>
        </button>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Right utility icons */}
        <span class="mk-icon-btn" title={`Region: ${info.region}`} style={{ "font-size": "var(--mk-font-size-sm)", color: "var(--mk-color-text-subtle)" }}>
          {info.region}
        </span>
        <button class="mk-icon-btn" aria-label="Notifications">🔔</button>
        <button class="mk-icon-btn" aria-label="Help">?</button>
        <button class="mk-icon-btn" aria-label="Account">👤</button>
      </header>

      {/* ── Body (sidebar + content) ──────────────────────────────────────── */}
      <div style={{ display: "flex", flex: "1", overflow: "hidden" }}>

        {/* Sidebar */}
        <nav
          class="mk-gcp-sidebar"
          style={{
            width:            navWidth(),
            "min-width":      navWidth(),
            background:       "var(--mk-color-nav-bg)",
            "border-right":   "1px solid var(--mk-color-nav-border)",
            overflow:         "hidden auto",
            transition:       "width var(--mk-transition)",
            display:          "flex",
            "flex-direction": "column",
            "padding-top":    "var(--mk-spacing-sm)",
          }}
        >
          <For each={NAV_ITEMS}>
            {(item) => navItemEl(item)}
          </For>
        </nav>

        {/* Main content */}
        <main
          class="mk-gcp-content"
          style={{
            flex:       "1",
            overflow:   "auto",
            background: "var(--mk-color-background)",
            padding:    "var(--mk-spacing-lg)",
          }}
        >
          <div style={{ "max-width": "var(--mk-content-max-width)", margin: "0 auto" }}>
            {props.children}
          </div>
        </main>
      </div>

      <style>{`
        .mk-gcp-nav-item {
          display: flex;
          align-items: center;
          gap: var(--mk-spacing-sm);
          padding: 6px var(--mk-spacing-sm);
          margin: 1px var(--mk-spacing-xs);
          border-radius: var(--mk-radius-full);
          color: var(--mk-color-nav-text);
          text-decoration: none;
          font-size: var(--mk-font-size-sm);
          transition: background var(--mk-transition);
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
        }
        .mk-gcp-nav-item:hover {
          background: color-mix(in srgb, var(--mk-color-nav-text) 10%, transparent);
        }
        .mk-gcp-nav-item--active {
          background: var(--mk-color-accent-surface);
          color: var(--mk-color-nav-active-text);
          font-weight: var(--mk-font-weight-medium);
        }
        .mk-gcp-nav-item__icon { flex-shrink: 0; width: 20px; text-align: center; }
        .mk-gcp-nav-item__label { flex: 1; }
        .mk-gcp-nav-item__chevron { font-size: 10px; }
        .mk-icon-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px 6px;
          border-radius: var(--mk-radius-sm);
          color: var(--mk-color-text);
          transition: background var(--mk-transition);
        }
        .mk-icon-btn:hover { background: var(--mk-color-border-subtle); }
      `}</style>
    </div>
  );
};

export default GCPShell;
