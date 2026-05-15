import type { ThemeTokens } from "./tokens";

/**
 * Bare-metal / self-hosted theme tokens.
 *
 * A neutral, professional theme for installs not running on a major cloud.
 * Uses Inter as the typeface — clean, readable, no cloud affiliation.
 * Slightly more rounded than Azure/AWS; slightly flatter than GCP.
 */
export const bareMetalTokens: ThemeTokens = {
  color: {
    primary:        "#6366f1",  // indigo — neutral but distinct
    primaryHover:   "#4f46e5",
    primaryActive:  "#4338ca",
    primaryText:    "#ffffff",

    surface:        "#ffffff",
    surfaceRaised:  "#ffffff",
    background:     "#f9fafb",

    text:           "#111827",
    textSubtle:     "#6b7280",
    textOnDark:     "#ffffff",

    border:         "#e5e7eb",
    borderSubtle:   "#f3f4f6",

    accent:         "#6366f1",
    accentSurface:  "#eef2ff",

    danger:         "#dc2626",
    dangerSurface:  "#fef2f2",
    success:        "#16a34a",
    successSurface: "#f0fdf4",
    warning:        "#d97706",
    warningSurface: "#fffbeb",
    info:           "#2563eb",
    infoSurface:    "#eff6ff",

    navBackground:  "#1e293b",
    navText:        "#cbd5e1",
    navBorder:      "#334155",
    navActiveItem:  "#6366f1",
    navActiveText:  "#ffffff",
  },

  font: {
    family:       "Inter, 'Helvetica Neue', Arial, sans-serif",
    familyMono:   "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    sizeXs:       "11px",
    sizeSm:       "12px",
    sizeBase:     "14px",
    sizeMd:       "16px",
    sizeLg:       "20px",
    sizeXl:       "24px",
    weightNormal: "400",
    weightMedium: "500",
    weightBold:   "600",
    lineHeight:   "1.5",
  },

  radius: {
    none: "0",
    sm:   "4px",
    md:   "6px",
    lg:   "8px",
    full: "9999px",
  },

  shadow: {
    none: "none",
    sm:   "0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06)",
    md:   "0 4px 6px rgba(0,0,0,.07), 0 2px 4px rgba(0,0,0,.06)",
    lg:   "0 10px 15px rgba(0,0,0,.1), 0 4px 6px rgba(0,0,0,.05)",
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
    navWidth:          "240px",
    navCollapsedWidth: "56px",
    topbarHeight:      "56px",
    bladeWidth:        "0",
    contentMaxWidth:   "1280px",
  },

  transition: "150ms ease",
};
