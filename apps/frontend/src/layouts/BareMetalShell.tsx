import {
  createSignal,
  ParentComponent,
  For,
  Show,
} from "solid-js";
import { useCloud } from "../providers/cloud-theme";

// ── Navigation structure ──────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: "overview",    label: "Overview",       icon: "⊞", href: "/" },
  { id: "tenants",     label: "Tenants",        icon: "☁", href: "/tenants" },
  { id: "iam-roles",   label: "Roles",          icon: "🔑", href: "/iam/roles" },
  { id: "iam-reviews", label: "Access reviews", icon: "✓",  href: "/iam/reviews" },
  { id: "drift",       label: "Drift",          icon: "⚡", href: "/infra/drift" },
  { id: "security",    label: "Security",       icon: "🛡",  href: "/security" },
  { id: "billing",     label: "Billing",        icon: "💳", href: "/billing" },
  { id: "installs",    label: "Installations",  icon: "⚙",  href: "/infra/installs" },
];

// ── Shell ─────────────────────────────────────────────────────────────────────

/**
 * BareMetalShell
 *
 * Neutral layout for self-hosted / on-premises installs not running on a
 * major cloud.  No cloud-specific UX metaphors — clean and functional.
 *
 * Layout:
 *   - Dark left sidebar with indigo active item (matches --mk-color-nav-bg)
 *   - Light top bar with platform branding
 *   - Toggleable sidebar collapse (icon-only mode)
 *   - Standard 1280 px max-width content area
 *
 * Typography: Inter via --mk-font-family.
 * Radius: 4 px / 6 px / 8 px — slightly more rounded than Azure/AWS.
 */
const BareMetalShell: ParentComponent = (props) => {
  const { info } = useCloud();

  const [collapsed, setCollapsed] = createSignal(false);
  const [activeId, setActiveId] = createSignal("overview");

  const navWidth = () =>
    collapsed() ? "var(--mk-nav-collapsed-width)" : "var(--mk-nav-width)";

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100vh", "font-family": "var(--mk-font-family)" }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          height:           "var(--mk-topbar-height)",
          background:       "var(--mk-color-surface)",
          "border-bottom":  "1px solid var(--mk-color-border)",
          display:          "flex",
          "align-items":    "center",
          padding:          "0 var(--mk-spacing-md)",
          gap:              "var(--mk-spacing-md)",
          "flex-shrink":    "0",
          "box-shadow":     "var(--mk-shadow-sm)",
          "z-index":        "10",
        }}
      >
        <button
          style={{ background: "none", border: "none", cursor: "pointer", "font-size": "18px", color: "var(--mk-color-text-subtle)" }}
          onClick={() => setCollapsed((c) => !c)}
          aria-label="Toggle sidebar"
        >
          ☰
        </button>

        <span style={{ "font-weight": "var(--mk-font-weight-bold)", "font-size": "var(--mk-font-size-md)", color: "var(--mk-color-primary)" }}>
          monok8s
        </span>

        <span style={{ "font-size": "var(--mk-font-size-sm)", color: "var(--mk-color-text-subtle)", background: "var(--mk-color-border-subtle)", "border-radius": "var(--mk-radius-sm)", padding: "2px 8px" }}>
          {info.environment}
        </span>

        <div style={{ flex: 1 }} />

        <span style={{ "font-size": "var(--mk-font-size-sm)", color: "var(--mk-color-text-subtle)" }}>
          Self-hosted · {info.region}
        </span>
        <button style={{ background: "none", border: "none", cursor: "pointer", "font-size": "16px", color: "var(--mk-color-text-subtle)" }} aria-label="Notifications">🔔</button>
        <button style={{ background: "none", border: "none", cursor: "pointer", "font-size": "16px", color: "var(--mk-color-text-subtle)" }} aria-label="Account">👤</button>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: "1", overflow: "hidden" }}>

        {/* Sidebar */}
        <nav
          style={{
            width:            navWidth(),
            "min-width":      navWidth(),
            background:       "var(--mk-color-nav-bg)",
            "border-right":   "1px solid var(--mk-color-nav-border)",
            display:          "flex",
            "flex-direction": "column",
            overflow:         "hidden auto",
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
                  style={{
                    display:         "flex",
                    "align-items":   "center",
                    gap:             "var(--mk-spacing-sm)",
                    padding:         "9px var(--mk-spacing-sm)",
                    margin:          "1px var(--mk-spacing-xs)",
                    "border-radius": "var(--mk-radius-md)",
                    color:           isActive() ? "var(--mk-color-nav-active-text)" : "var(--mk-color-nav-text)",
                    background:      isActive() ? "var(--mk-color-nav-active-item)" : "transparent",
                    "text-decoration": "none",
                    "font-size":     "var(--mk-font-size-sm)",
                    "font-weight":   isActive() ? "var(--mk-font-weight-medium)" : "var(--mk-font-weight-normal)",
                    transition:      "background var(--mk-transition)",
                    "white-space":   "nowrap",
                    overflow:        "hidden",
                    cursor:          "pointer",
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    setActiveId(item.id);
                  }}
                  title={collapsed() ? item.label : undefined}
                >
                  <span style={{ "flex-shrink": "0", width: "20px", "text-align": "center" }}>{item.icon}</span>
                  <Show when={!collapsed()}>
                    <span>{item.label}</span>
                  </Show>
                </a>
              );
            }}
          </For>
        </nav>

        {/* Main content */}
        <main
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
    </div>
  );
};

export default BareMetalShell;
