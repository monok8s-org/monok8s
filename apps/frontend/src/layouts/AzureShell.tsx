import {
  createSignal,
  ParentComponent,
  For,
  Show,
} from "solid-js";
import { useCloud } from "../providers/cloud-theme";
import BladeStack from "./BladeStack";

// ── Navigation structure ──────────────────────────────────────────────────────

interface NavItem {
  id:     string;
  label:  string;
  icon:   string;
  href:   string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "overview",    label: "Overview",        icon: "⊞", href: "/" },
  { id: "tenants",     label: "Subscriptions",   icon: "☁", href: "/tenants" },
  { id: "iam-roles",   label: "Roles",           icon: "🔑", href: "/iam/roles" },
  { id: "iam-reviews", label: "Access reviews",  icon: "✓",  href: "/iam/reviews" },
  { id: "drift",       label: "Drift",           icon: "⚡", href: "/infra/drift" },
  { id: "security",    label: "Defender",        icon: "🛡",  href: "/security" },
  { id: "billing",     label: "Cost Management", icon: "💳", href: "/billing" },
  { id: "installs",    label: "Installations",   icon: "⚙",  href: "/infra/installs" },
];

// ── Shell ─────────────────────────────────────────────────────────────────────

/**
 * AzureShell
 *
 * Mimics the Azure Portal layout:
 *   - Collapsible icon sidebar (48px collapsed icon-only / 240px expanded with labels)
 *   - Light top bar matching the content surface (Fluent UI — not a dark bar)
 *   - Blade navigation: resources open as stacked side panels via BladeStack
 *   - Warm off-white background (#faf9f8), Segoe UI typography
 *   - Flat design — borders carry visual weight, shadows minimal
 *   - 2px border radius (Fluent UI "deliberately less rounded than Material")
 *   - Status badges use ● (filled circle) + text — the Azure Portal convention
 *
 * Azure's icon sidebar defaults to collapsed (icon-only) — the user expands it
 * by clicking the hamburger.  This is the opposite of GCP which defaults open.
 *
 * The BladeStack wraps the content area so any child can call useBladeStack()
 * to open a resource detail blade without changing the URL or the sidebar state.
 */
const AzureShell: ParentComponent = (props) => {
  const { info } = useCloud();

  // Azure defaults to icon-only (collapsed)
  const [expanded, setExpanded] = createSignal(false);
  const [activeId, setActiveId] = createSignal("overview");

  const navWidth = () =>
    expanded() ? "var(--mk-nav-width)" : "var(--mk-nav-collapsed-width)";

  return (
    <div
      class="mk-azure-shell"
      style={{ display: "flex", "flex-direction": "column", height: "100vh", "font-family": "var(--mk-font-family)" }}
    >

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          height:           "var(--mk-topbar-height)",
          background:       "var(--mk-color-primary)",
          display:          "flex",
          "align-items":    "center",
          padding:          "0 var(--mk-spacing-md)",
          gap:              "var(--mk-spacing-md)",
          "flex-shrink":    "0",
          "z-index":        "20",
        }}
      >
        {/* Hamburger toggle */}
        <button
          class="mk-azure-topbar-btn"
          onClick={() => setExpanded((e) => !e)}
          aria-label="Toggle sidebar"
        >
          ☰
        </button>

        {/* Portal wordmark */}
        <span style={{ color: "#ffffff", "font-size": "var(--mk-font-size-md)", "font-weight": "var(--mk-font-weight-medium)" }}>
          monok8s
        </span>

        {/* Search (Fluent-style) */}
        <div
          style={{
            flex:            "1",
            "max-width":     "400px",
            display:         "flex",
            "align-items":   "center",
            background:      "rgba(255,255,255,0.15)",
            "border-radius": "var(--mk-radius-sm)",
            padding:         "4px var(--mk-spacing-sm)",
            gap:             "var(--mk-spacing-xs)",
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.7)", "font-size": "14px" }}>⌕</span>
          <span style={{ color: "rgba(255,255,255,0.6)", "font-size": "var(--mk-font-size-sm)" }}>
            Search resources, services…
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Right-side controls */}
        <span style={{ color: "rgba(255,255,255,0.85)", "font-size": "var(--mk-font-size-sm)" }}>
          {info.region}
        </span>
        <button class="mk-azure-topbar-btn" aria-label="Notifications">🔔</button>
        <button class="mk-azure-topbar-btn" aria-label="Settings">⚙</button>
        <button class="mk-azure-topbar-btn" aria-label="Account">
          <span style={{ background: "rgba(255,255,255,0.2)", "border-radius": "50%", padding: "2px 6px" }}>
            👤
          </span>
        </button>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: "1", overflow: "hidden" }}>

        {/* Icon / label sidebar */}
        <nav
          class="mk-azure-sidebar"
          style={{
            width:            navWidth(),
            "min-width":      navWidth(),
            background:       "var(--mk-color-nav-bg)",
            "border-right":   "1px solid var(--mk-color-nav-border)",
            display:          "flex",
            "flex-direction": "column",
            overflow:         "hidden",
            transition:       "width var(--mk-transition)",
            "flex-shrink":    "0",
            "padding-top":    "var(--mk-spacing-sm)",
          }}
        >
          <For each={NAV_ITEMS}>
            {(item) => {
              const isActive = () => activeId() === item.id;
              return (
                <a
                  href={item.href}
                  class="mk-azure-nav-item"
                  classList={{ "mk-azure-nav-item--active": isActive() }}
                  onClick={(e) => {
                    e.preventDefault();
                    setActiveId(item.id);
                  }}
                  title={!expanded() ? item.label : undefined}
                >
                  <span class="mk-azure-nav-item__icon">{item.icon}</span>
                  <Show when={expanded()}>
                    <span class="mk-azure-nav-item__label">{item.label}</span>
                  </Show>
                </a>
              );
            }}
          </For>

          {/* Expand toggle at bottom */}
          <div style={{ "margin-top": "auto", "border-top": "1px solid var(--mk-color-nav-border)" }}>
            <button
              class="mk-azure-nav-item"
              style={{ width: "100%", border: "none", background: "none", cursor: "pointer", "text-align": "left" }}
              onClick={() => setExpanded((e) => !e)}
              aria-label={expanded() ? "Collapse sidebar" : "Expand sidebar"}
            >
              <span class="mk-azure-nav-item__icon">{expanded() ? "◂" : "▸"}</span>
              <Show when={expanded()}>
                <span class="mk-azure-nav-item__label">Collapse</span>
              </Show>
            </button>
          </div>
        </nav>

        {/* Main content — wrapped in BladeStack for Azure blade navigation */}
        <main
          style={{
            flex:       "1",
            overflow:   "hidden",
            background: "var(--mk-color-background)",
            display:    "flex",
            "flex-direction": "column",
          }}
        >
          <BladeStack>
            <div
              style={{
                padding:    "var(--mk-spacing-lg)",
                overflow:   "auto",
                height:     "100%",
              }}
            >
              {props.children}
            </div>
          </BladeStack>
        </main>
      </div>

      <style>{`
        .mk-azure-topbar-btn {
          background: none;
          border: none;
          color: #ffffff;
          font-size: 18px;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: var(--mk-radius-sm);
          transition: background var(--mk-transition);
        }
        .mk-azure-topbar-btn:hover { background: rgba(255,255,255,0.15); }

        .mk-azure-nav-item {
          display: flex;
          align-items: center;
          gap: var(--mk-spacing-sm);
          padding: 10px var(--mk-spacing-sm);
          color: var(--mk-color-nav-text);
          text-decoration: none;
          font-size: var(--mk-font-size-sm);
          transition: background var(--mk-transition);
          white-space: nowrap;
          overflow: hidden;
        }
        .mk-azure-nav-item:hover {
          background: color-mix(in srgb, var(--mk-color-primary) 8%, transparent);
        }
        .mk-azure-nav-item--active {
          color: var(--mk-color-nav-active-text);
          border-left: 3px solid var(--mk-color-primary);
        }
        .mk-azure-nav-item--active .mk-azure-nav-item__icon {
          color: var(--mk-color-primary);
        }
        .mk-azure-nav-item__icon {
          flex-shrink: 0;
          width: 24px;
          text-align: center;
          font-size: 16px;
        }
        .mk-azure-nav-item__label { flex: 1; }
      `}</style>
    </div>
  );
};

export default AzureShell;
