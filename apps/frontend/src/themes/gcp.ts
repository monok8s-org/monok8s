import type { ThemeTokens } from "./tokens";

/**
 * GCP Console theme tokens.
 *
 * Inspired by Google Cloud Console and Material Design 3.
 * Key characteristics:
 *   - Google Blue (#1a73e8) primary
 *   - Clean white surfaces with subtle card shadows
 *   - Google Sans / Roboto typography
 *   - 4px base border radius
 *   - Light left sidebar matching the content background
 *   - Status displayed with colored filled circles
 */
export const gcpTokens: ThemeTokens = {
  color: {
    primary:        "#1a73e8",
    primaryHover:   "#1557b0",
    primaryActive:  "#0d47a1",
    primaryText:    "#ffffff",

    surface:        "#ffffff",
    surfaceRaised:  "#ffffff",
    background:     "#f8f9fa",

    text:           "#202124",
    textSubtle:     "#5f6368",
    textOnDark:     "#ffffff",

    border:         "#dadce0",
    borderSubtle:   "#e8eaed",

    accent:         "#1a73e8",
    accentSurface:  "#e8f0fe",

    danger:         "#d93025",
    dangerSurface:  "#fce8e6",
    success:        "#137333",
    successSurface: "#e6f4ea",
    warning:        "#e37400",
    warningSurface: "#fef7e0",
    info:           "#1967d2",
    infoSurface:    "#e8f0fe",

    // GCP uses a light sidebar (not dark like AWS)
    navBackground:  "#ffffff",
    navText:        "#202124",
    navBorder:      "#e8eaed",
    navActiveItem:  "#e8f0fe",
    navActiveText:  "#1a73e8",
  },

  font: {
    // Google Sans is loaded from Google Fonts; Roboto as fallback.
    family:       "'Google Sans', Roboto, 'Helvetica Neue', Arial, sans-serif",
    familyMono:   "'Google Sans Mono', 'Roboto Mono', 'Courier New', monospace",
    sizeXs:       "11px",
    sizeSm:       "12px",
    sizeBase:     "14px",
    sizeMd:       "16px",
    sizeLg:       "20px",
    sizeXl:       "24px",
    weightNormal: "400",
    weightMedium: "500",
    weightBold:   "700",
    lineHeight:   "1.5",
  },

  radius: {
    none: "0",
    sm:   "4px",
    md:   "8px",
    lg:   "12px",
    full: "9999px",
  },

  shadow: {
    none: "none",
    sm:   "0 1px 2px rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15)",
    md:   "0 1px 3px rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15)",
    lg:   "0 2px 6px rgba(60,64,67,.3), 0 6px 12px 4px rgba(60,64,67,.15)",
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
    navWidth:          "256px",
    navCollapsedWidth: "56px",
    topbarHeight:      "64px",
    bladeWidth:        "0",          // GCP doesn't use blades
    contentMaxWidth:   "1440px",
  },

  transition: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
};
