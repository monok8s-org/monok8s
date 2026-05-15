import {
  createSignal,
  ParentComponent,
  For,
  Show,
  createMemo,
} from "solid-js";
import { useCloud } from "../providers/cloud-theme";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavGroup {
  id:    string;
  label: string;
  items: { id: string; label: string; href: string }[];
}

// ── Navigation structure ──────────────────────────────────────────────────────

const NAV_GROUPS: NavGroup[] = [
  {
    id: "core", label: "Core",
    items: [
      { id: "overview",  label: "Overview",       href: "/" },
      { id: "tenants",   label: "Accounts",        href: "/tenants" },
    ],
  },
  {
    id: "security", label: "Security & Identity",
    items: [
      { id: "iam-roles",   label: "Roles",          href: "/iam/roles" },
      { id: "iam-reviews", label: "Access reviews",  href: "/iam/reviews" },
      { id: "findings",    label: "Security Hub",    href: "/security" },
    ],
  },
  {
    id: "infra", label: "Infrastructure",
    items: [
      { id: "drift",    label: "Drift detection",   href: "/infra/drift" },
      { id: "installs", label: "Installations",     href: "/infra/installs" },
    ],
  },
  {
    id: "billing", label: "Billing & Cost",
    items: [
      { id: "billing", label: "Billing",   href: "/billing" },
    ],
  },
];

const TOP_NAV_SERVICES = ["Accounts", "IAM", "Security", "Infrastructure", "Billing"];

// ── Shell ─────────────────────────────────────────────────────────────────────

/**
 * AWSShell
 *
 * Mimics the AWS Console layout:
 *   - Dark top navigation bar ("AWS Squid Ink" #232f3e) with service menu
 *   - Collapsible left sidebar per active service group (fully collapses — no icon-only)
 *   - White content area, 1280 px max-width, dense information presentation
 *   - AWS Orange (#ec7211) primary; accent link blue (#0972d3) for hyperlinks
 *   - Sharp 2px border radius (CloudScape design system)
 *   - Status indicators shown as colored dot badges
 *
 * The top nav renders a flat list of service-group names mirroring the AWS
 * Console's "Services" mega-menu — clicking one sets the active group and
 * updates the left sidebar to show that group's items.
 */
const AWSShell: ParentComponent = (props) => {
  const { info } = useCloud();

  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [activeGroup, setActiveGroup] = createSignal<string>("core");
  const [activeItem, setActiveItem] = createSignal("overview");

  const currentGroup = createMemo(() =>
    NAV_GROUPS.find((g) => g.id === activeGroup()) ?? NAV_GROUPS[0],
  );

  const sidebarWidth = createMemo(() =>
    sidebarOpen() ? "var(--mk-nav-width)" : "var(--mk-nav-collapsed-width, 0px)",
  );

  return (
    <div class="mk-aws-shell" style={{ display: "flex", "flex-direction": "column", height: "100vh", "font-size": "var(--mk-font-size-base)" }}>

      {/* ── Top navigation bar ─────────────────────────────────────────────── */}
      <header
        class="mk-aws-topbar"
        style={{
          height:           "var(--mk-topbar-height)",
          background:       "var(--mk-color-nav-bg)",
          "border-bottom":  "2px solid #ff9900",
          display:          "flex",
          "align-items":    "center",
          padding:          "0 var(--mk-spacing-md)",
          gap:              "var(--mk-spacing-md)",
          "flex-shrink":    "0",
          "z-index":        "10",
        }}
      >
        {/* Logo */}
        <span style={{ color: "#ff9900", "font-weight": "var(--mk-font-weight-bold)", "font-size": "var(--mk-font-size-md)", "white-space": "nowrap" }}>
          ☁ monok8s
        </span>

        {/* Services menu bar */}
        <nav style={{ display: "flex", gap: "2px", "overflow-x": "auto" }}>
          <For each={NAV_GROUPS}>
            {(group) => (
              <button
                class="mk-aws-topnav-btn"
                classList={{ "mk-aws-topnav-btn--active": activeGroup() === group.id }}
                onClick={() => {
                  setActiveGroup(group.id);
                  setSidebarOpen(true);
                }}
              >
                {group.label}
              </button>
            )}
          </For>
        </nav>

        <div style={{ flex: 1 }} />

        {/* Right-side controls */}
        <span style={{ color: "var(--mk-color-nav-text)", "font-size": "var(--mk-font-size-sm)" }}>
          {info.region}
        </span>
        <button class="mk-aws-topnav-btn" aria-label="Account">👤 {info.environment}</button>
        <button class="mk-aws-icon-btn" aria-label="Notifications">🔔</button>
      </header>

      {/* ── Breadcrumb sub-bar ─────────────────────────────────────────────── */}
      <div
        style={{
          background:      "var(--mk-color-surface)",
          "border-bottom": "1px solid var(--mk-color-border)",
          padding:         "6px var(--mk-spacing-md)",
          "font-size":     "var(--mk-font-size-sm)",
          color:           "var(--mk-color-text-subtle)",
          display:         "flex",
          gap:             "var(--mk-spacing-xs)",
          "align-items":   "center",
        }}
      >
        <span style={{ color: "var(--mk-color-accent)", cursor: "pointer" }}>monok8s</span>
        <span>›</span>
        <span>{currentGroup().label}</span>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: "1", overflow: "hidden" }}>

        {/* Left sidebar */}
        <nav
          class="mk-aws-sidebar"
          style={{
            width:           sidebarWidth(),
            "min-width":     sidebarWidth(),
            background:      "var(--mk-color-surface)",
            "border-right":  "1px solid var(--mk-color-border)",
            overflow:        "hidden auto",
            transition:      "width var(--mk-transition)",
            "flex-shrink":   "0",
          }}
        >
          <Show when={sidebarOpen()}>
            <div style={{ "padding": "var(--mk-spacing-sm) 0" }}>
              {/* Sidebar toggle */}
              <div style={{ padding: "0 var(--mk-spacing-sm) var(--mk-spacing-sm)", "text-align": "right" }}>
                <button
                  class="mk-aws-icon-btn"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Collapse sidebar"
                  style={{ "font-size": "16px" }}
                >
                  ◂
                </button>
              </div>

              <div style={{ "font-size": "var(--mk-font-size-xs)", "font-weight": "var(--mk-font-weight-bold)", color: "var(--mk-color-text-subtle)", padding: "var(--mk-spacing-xs) var(--mk-spacing-md)", "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
                {currentGroup().label}
              </div>

              <For each={currentGroup().items}>
                {(item) => (
                  <a
                    href={item.href}
                    class="mk-aws-nav-item"
                    classList={{ "mk-aws-nav-item--active": activeItem() === item.id }}
                    onClick={(e) => {
                      e.preventDefault();
                      setActiveItem(item.id);
                    }}
                  >
                    {item.label}
                  </a>
                )}
              </For>
            </div>
          </Show>
          <Show when={!sidebarOpen()}>
            <div style={{ padding: "var(--mk-spacing-sm)", "text-align": "center" }}>
              <button
                class="mk-aws-icon-btn"
                onClick={() => setSidebarOpen(true)}
                aria-label="Expand sidebar"
                style={{ "font-size": "16px" }}
              >
                ▸
              </button>
            </div>
          </Show>
        </nav>

        {/* Main content */}
        <main
          class="mk-aws-content"
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
        .mk-aws-topnav-btn {
          background: none;
          border: none;
          color: var(--mk-color-nav-text);
          font-size: var(--mk-font-size-sm);
          padding: 6px var(--mk-spacing-sm);
          cursor: pointer;
          border-radius: var(--mk-radius-sm);
          white-space: nowrap;
          transition: background var(--mk-transition);
        }
        .mk-aws-topnav-btn:hover {
          background: rgba(255,255,255,0.1);
        }
        .mk-aws-topnav-btn--active {
          color: #ffffff;
          background: rgba(255,255,255,0.15);
          border-bottom: 2px solid #ff9900;
        }
        .mk-aws-icon-btn {
          background: none;
          border: none;
          color: var(--mk-color-nav-text);
          cursor: pointer;
          padding: 4px 6px;
          border-radius: var(--mk-radius-sm);
          transition: background var(--mk-transition);
        }
        .mk-aws-icon-btn:hover { background: rgba(255,255,255,0.1); }
        .mk-aws-nav-item {
          display: block;
          padding: 7px var(--mk-spacing-md);
          color: var(--mk-color-accent);
          font-size: var(--mk-font-size-sm);
          text-decoration: none;
          transition: background var(--mk-transition);
        }
        .mk-aws-nav-item:hover {
          background: var(--mk-color-border-subtle);
          color: var(--mk-color-text);
        }
        .mk-aws-nav-item--active {
          background: var(--mk-color-accent-surface);
          color: var(--mk-color-text);
          font-weight: var(--mk-font-weight-medium);
          border-left: 3px solid var(--mk-color-primary);
          padding-left: calc(var(--mk-spacing-md) - 3px);
        }
      `}</style>
    </div>
  );
};

export default AWSShell;
