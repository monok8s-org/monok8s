import type { ThemeTokens } from "./tokens";

/**
 * Azure Portal theme tokens.
 *
 * Inspired by Microsoft Fluent UI and the Azure Portal design language.
 * Key characteristics:
 *   - Azure Blue (#0078d4) primary
 *   - Warm off-white background (#faf9f8)
 *   - Segoe UI typography (Windows system font)
 *   - 2px border radius (Fluent is deliberately less rounded than Material)
 *   - Collapsible icon sidebar with breadcrumb nav
 *   - Blade navigation: resources open in stacked side panels
 *   - Flat surfaces: no card shadows, borders instead of elevation
 *   - Status shown as colored circle (●) + text
 */
export const azureTokens: ThemeTokens = {
  color: {
    primary:        "#0078d4",  // Fluent communication blue
    primaryHover:   "#106ebe",
    primaryActive:  "#005a9e",
    primaryText:    "#ffffff",

    surface:        "#ffffff",
    surfaceRaised:  "#ffffff",
    background:     "#faf9f8",  // Fluent neutral background — warm white

    text:           "#201f1e",  // Fluent neutral primary
    textSubtle:     "#605e5c",  // Fluent neutral secondary
    textOnDark:     "#ffffff",

    border:         "#edebe9",  // Fluent neutral stroke
    borderSubtle:   "#f3f2f1",

    accent:         "#0078d4",
    accentSurface:  "#eff6fc",  // Fluent theme lighter

    danger:         "#a4262c",  // Fluent shared error
    dangerSurface:  "#fde7e9",
    success:        "#107c10",  // Fluent shared success
    successSurface: "#dff6dd",
    warning:        "#797673",  // Fluent uses grey-tone warnings (subtle)
    warningSurface: "#fff4ce",
    info:           "#0078d4",
    infoSurface:    "#eff6fc",

    // Azure sidebar is white/light, not dark
    navBackground:  "#ffffff",
    navText:        "#201f1e",
    navBorder:      "#edebe9",
    navActiveItem:  "#eff6fc",
    navActiveText:  "#0078d4",
  },

  font: {
    // Segoe UI is the Windows system font; loaded via font-face for non-Windows.
    family:       "'Segoe UI', 'Segoe UI Variable', system-ui, -apple-system, sans-serif",
    familyMono:   "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
    sizeXs:       "11px",
    sizeSm:       "12px",
    sizeBase:     "14px",
    sizeMd:       "16px",
    sizeLg:       "20px",
    sizeXl:       "28px",
    weightNormal: "400",
    weightMedium: "600",
    weightBold:   "700",
    lineHeight:   "1.45",
  },

  radius: {
    none: "0",
    sm:   "2px",    // Fluent uses 2px — deliberately more squared than Material
    md:   "4px",
    lg:   "6px",
    full: "9999px",
  },

  shadow: {
    none: "none",
    // Fluent UI uses flat design — elevation is expressed through border, not shadow.
    // These shadows are very subtle; borders carry more visual weight.
    sm:   "0 1.6px 3.6px rgba(0,0,0,.132), 0 .3px .9px rgba(0,0,0,.108)",
    md:   "0 3.2px 7.2px rgba(0,0,0,.132), 0 .6px 1.8px rgba(0,0,0,.108)",
    lg:   "0 6.4px 14.4px rgba(0,0,0,.132), 0 1.2px 3.6px rgba(0,0,0,.108)",
  },

  spacing: {
    xs:  "4px",
    sm:  "8px",
    md:  "16px",
    lg:  "24px",
    xl:  "32px",
    xxl: "48px",
  },

  layout: {
    navWidth:          "200px",   // icon + label sidebar when expanded
    navCollapsedWidth: "48px",    // icon-only sidebar (Azure default start state)
    topbarHeight:      "50px",    // Azure portal top bar height
    bladeWidth:        "780px",   // Azure blade default — can be resized by user
    contentMaxWidth:   "none",    // Azure blades fill available space
  },

  transition: "200ms ease",
};
