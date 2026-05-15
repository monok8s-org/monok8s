import {
  createSignal,
  createContext,
  useContext,
  ParentComponent,
  For,
  Show,
  JSX,
} from "solid-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Blade {
  id:       string;
  title:    string;
  content:  JSX.Element;
  /** Width override — defaults to --mk-blade-width (780px) */
  width?:   string;
}

interface BladeStackContextValue {
  push: (blade: Blade) => void;
  pop:  ()            => void;
  /** Close all blades from index (inclusive) to the end */
  trimTo: (index: number) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const BladeStackContext = createContext<BladeStackContextValue>();

/**
 * useBladeStack — push/pop blades from any descendant component.
 *
 * @example
 * const { push } = useBladeStack();
 * push({ id: "tenant-detail", title: "tenant-abc", content: <TenantDetail id="abc" /> });
 */
export function useBladeStack(): BladeStackContextValue {
  const ctx = useContext(BladeStackContext);
  if (!ctx) throw new Error("useBladeStack must be used inside <BladeStack>");
  return ctx;
}

// ── BladeStack ────────────────────────────────────────────────────────────────

/**
 * BladeStack
 *
 * Azure Portal's defining navigation pattern: resources open in stacked side
 * panels that slide in from the right.  Each blade overlaps the previous one,
 * scrolls independently, and can be individually closed.  Clicking on a blade's
 * breadcrumb trims the stack back to that position.
 *
 * The initial children are rendered as the "base" content (no blade chrome).
 * Blades are pushed programmatically via useBladeStack().push().
 *
 * Visual behaviour:
 *   - Blades slide in from the right over 200 ms (--mk-transition)
 *   - Each blade has a title bar with a close (×) button and an optional back (‹) button
 *   - Breadcrumb row above the stack shows the full path; clicking any crumb trims to it
 *   - A backdrop covers the base content when any blade is open (portal darkens at ~20%)
 *
 * Width: blades default to var(--mk-blade-width, 780px).  Pass `width` to override.
 */
const BladeStack: ParentComponent = (props) => {
  const [blades, setBlades] = createSignal<Blade[]>([]);

  const push = (blade: Blade) => {
    setBlades((prev) => {
      // Replace if same id already on stack
      const idx = prev.findIndex((b) => b.id === blade.id);
      if (idx !== -1) return [...prev.slice(0, idx), blade];
      return [...prev, blade];
    });
  };

  const pop = () => setBlades((prev) => prev.slice(0, -1));

  const trimTo = (index: number) =>
    setBlades((prev) => prev.slice(0, index));

  const ctx: BladeStackContextValue = { push, pop, trimTo };

  return (
    <BladeStackContext.Provider value={ctx}>
      <div
        class="mk-blade-stack"
        style={{
          display:         "flex",
          height:          "100%",
          overflow:        "hidden",
          position:        "relative",
        }}
      >
        {/* Base content */}
        <div
          class="mk-blade-base"
          style={{
            flex:       "1",
            overflow:   "auto",
            transition: `opacity var(--mk-transition)`,
            opacity:    blades().length > 0 ? "0.5" : "1",
            "min-width": "400px",
          }}
        >
          {props.children}
        </div>

        {/* Blade breadcrumb (shown above the blade strip when blades are open) */}
        <Show when={blades().length > 0}>
          <div
            class="mk-blade-crumbs"
            style={{
              position:        "absolute",
              top:             "0",
              left:            "0",
              right:           "0",
              background:      "var(--mk-color-surface)",
              "border-bottom": "1px solid var(--mk-color-border)",
              padding:         "6px var(--mk-spacing-md)",
              display:         "flex",
              gap:             "var(--mk-spacing-xs)",
              "align-items":   "center",
              "font-size":     "var(--mk-font-size-sm)",
              "z-index":       "5",
            }}
          >
            <span
              style={{ color: "var(--mk-color-accent)", cursor: "pointer" }}
              onClick={() => trimTo(0)}
            >
              Home
            </span>
            <For each={blades()}>
              {(blade, i) => (
                <>
                  <span style={{ color: "var(--mk-color-text-subtle)" }}>›</span>
                  <span
                    style={{
                      color:  i() === blades().length - 1 ? "var(--mk-color-text)" : "var(--mk-color-accent)",
                      cursor: i() === blades().length - 1 ? "default" : "pointer",
                      "font-weight": i() === blades().length - 1 ? "var(--mk-font-weight-medium)" : undefined,
                    }}
                    onClick={() => { if (i() < blades().length - 1) trimTo(i() + 1); }}
                  >
                    {blade.title}
                  </span>
                </>
              )}
            </For>
          </div>
        </Show>

        {/* Blade panels */}
        <For each={blades()}>
          {(blade, i) => (
            <div
              class="mk-blade"
              style={{
                width:           blade.width ?? "var(--mk-blade-width, 780px)",
                "min-width":     blade.width ?? "var(--mk-blade-width, 780px)",
                height:          "100%",
                background:      "var(--mk-color-surface)",
                "border-left":   "1px solid var(--mk-color-border)",
                display:         "flex",
                "flex-direction":"column",
                "overflow":      "hidden",
                "flex-shrink":   "0",
                animation:       "mk-blade-slide-in 200ms ease",
                "box-shadow":    "var(--mk-shadow-lg)",
                "z-index":       String(10 + i()),
              }}
            >
              {/* Blade title bar */}
              <div
                class="mk-blade__titlebar"
                style={{
                  display:         "flex",
                  "align-items":   "center",
                  gap:             "var(--mk-spacing-sm)",
                  padding:         "0 var(--mk-spacing-md)",
                  height:          "48px",
                  "flex-shrink":   "0",
                  "border-bottom": "1px solid var(--mk-color-border)",
                  background:      "var(--mk-color-surface)",
                }}
              >
                <Show when={i() > 0}>
                  <button
                    class="mk-blade__back"
                    onClick={() => trimTo(i())}
                    aria-label="Close blade"
                  >
                    ‹
                  </button>
                </Show>
                <h2
                  style={{
                    flex:        "1",
                    margin:      "0",
                    "font-size": "var(--mk-font-size-md)",
                    "font-weight": "var(--mk-font-weight-medium)",
                    overflow:    "hidden",
                    "text-overflow": "ellipsis",
                    "white-space":   "nowrap",
                  }}
                >
                  {blade.title}
                </h2>
                <button
                  class="mk-blade__close"
                  onClick={() => trimTo(i())}
                  aria-label="Close blade"
                >
                  ×
                </button>
              </div>

              {/* Blade body */}
              <div style={{ flex: "1", overflow: "auto", padding: "var(--mk-spacing-lg)" }}>
                {blade.content}
              </div>
            </div>
          )}
        </For>
      </div>

      <style>{`
        @keyframes mk-blade-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        .mk-blade__back, .mk-blade__close {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: var(--mk-color-text-subtle);
          padding: 4px 8px;
          border-radius: var(--mk-radius-sm);
          transition: background var(--mk-transition), color var(--mk-transition);
          line-height: 1;
        }
        .mk-blade__back:hover, .mk-blade__close:hover {
          background: var(--mk-color-border-subtle);
          color: var(--mk-color-text);
        }
      `}</style>
    </BladeStackContext.Provider>
  );
};

export default BladeStack;
