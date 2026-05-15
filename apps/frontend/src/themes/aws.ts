import type { ThemeTokens } from "./tokens";

/**
 * AWS Console theme tokens.
 *
 * Inspired by AWS CloudScape design system (open source, Apache 2.0).
 * Key characteristics:
 *   - AWS Orange (#ec7211) primary actions
 *   - Dark top navigation bar (#232f3e — "AWS Squid Ink")
 *   - Clean white content area, dense data tables
 *   - Amazon Ember / Arial typography
 *   - 2px border radius (sharper than GCP/Azure)
 *   - Status shown as colored dot + text badges
 *   - High information density — smaller base font size
 */
export const awsTokens: ThemeTokens = {
  color: {
    primary:        "#ec7211",  // AWS orange
    primaryHover:   "#dd6b0f",
    primaryActive:  "#c85d0d",
    primaryText:    "#ffffff",

    surface:        "#ffffff",
    surfaceRaised:  "#ffffff",
    background:     "#f2f3f3",  // CloudScape grey background

    text:           "#0f1b2d",  // CloudScape charcoal
    textSubtle:     "#5f6b7a",
    textOnDark:     "#ffffff",

    border:         "#c6c6cd",  // CloudScape border
    borderSubtle:   "#e3e3e8",

    accent:         "#0972d3",  // CloudScape link blue (different from orange primary)
    accentSurface:  "#f0f8ff",

    danger:         "#d91515",
    dangerSurface:  "#fff0f0",
    success:        "#1d8102",
    successSurface: "#f2f8f0",
    warning:        "#9e6100",
    warningSurface: "#fff8e7",
    info:           "#0972d3",
    infoSurface:    "#f0f8ff",

    // AWS dark nav bar — the defining visual of the AWS Console
    navBackground:  "#232f3e",  // AWS Squid Ink
    navText:        "#d5dbdb",  // light grey on dark
    navBorder:      "#37475a",
    navActiveItem:  "#ff9900",  // lighter orange for active item
    navActiveText:  "#ffffff",
  },

  font: {
    // Amazon Ember is proprietary; Arial is the standard fallback in CloudScape.
    family:       "'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif",
    familyMono:   "'Amazon Ember Mono', 'Courier New', Courier, monospace",
    sizeXs:       "11px",
    sizeSm:       "12px",
    sizeBase:     "14px",   // CloudScape uses 14px base
    sizeMd:       "16px",
    sizeLg:       "18px",
    sizeXl:       "22px",
    weightNormal: "400",
    weightMedium: "600",    // CloudScape uses 600 for medium
    weightBold:   "700",
    lineHeight:   "1.4",    // slightly tighter than GCP for density
  },

  radius: {
    none: "0",
    sm:   "2px",    // CloudScape is deliberately sharp
    md:   "4px",
    lg:   "8px",
    full: "9999px",
  },

  shadow: {
    none: "none",
    sm:   "0 1px 1px rgba(0,28,36,.3), 1px 1px 1px rgba(0,28,36,.15)",
    md:   "0 1px 8px rgba(0,28,36,.3)",
    lg:   "0 4px 16px rgba(0,28,36,.3)",
  },

  spacing: {
    xs:  "4px",
    sm:  "8px",
    md:  "16px",
    lg:  "20px",   // CloudScape uses slightly tighter spacing
    xl:  "32px",
    xxl: "40px",
  },

  layout: {
    navWidth:          "220px",
    navCollapsedWidth: "0",      // AWS sidebar fully collapses (not icon-only)
    topbarHeight:      "48px",   // AWS top nav is shorter than GCP
    bladeWidth:        "0",
    contentMaxWidth:   "1280px",
  },

  transition: "120ms ease",
};
