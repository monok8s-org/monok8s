/**
 * ThemeTokens — the complete set of design tokens for a cloud theme.
 *
 * All tokens map 1:1 to CSS custom properties (--mk-<category>-<name>).
 * applyThemeTokens() injects them onto :root.
 *
 * Components use var(--mk-color-primary) etc — never hard-coded colors.
 */
export interface ThemeTokens {
  color: {
    primary:       string;
    primaryHover:  string;
    primaryActive: string;
    primaryText:   string; // text on primary background (always white or near-white)
    surface:       string; // card / panel background
    surfaceRaised: string; // elevated card (dropdown, modal)
    background:    string; // page background
    text:          string; // body text
    textSubtle:    string; // secondary / placeholder text
    textOnDark:    string; // text on dark nav backgrounds
    border:        string; // default border
    borderSubtle:  string; // lighter separator
    accent:        string; // highlight chips, active nav item
    accentSurface: string; // background for accent chips
    danger:        string;
    dangerSurface: string;
    success:       string;
    successSurface:string;
    warning:       string;
    warningSurface:string;
    info:          string;
    infoSurface:   string;
    /** Top nav / sidebar background (dark for AWS, light for GCP/Azure) */
    navBackground: string;
    navText:       string;
    navBorder:     string;
    navActiveItem: string;
    navActiveText: string;
  };
  font: {
    family:      string; // body font stack
    familyMono:  string;
    sizeXs:      string;
    sizeSm:      string;
    sizeBase:    string;
    sizeMd:      string;
    sizeLg:      string;
    sizeXl:      string;
    weightNormal:string;
    weightMedium:string;
    weightBold:  string;
    lineHeight:  string;
  };
  radius: {
    none: string;
    sm:   string; // e.g. 2px (Azure/Fluent) or 4px (GCP/Material)
    md:   string;
    lg:   string;
    full: string; // pill / circle
  };
  shadow: {
    none: string;
    sm:   string; // card elevation
    md:   string; // dropdown / modal
    lg:   string; // overlay
  };
  spacing: {
    xs:  string;
    sm:  string;
    md:  string;
    lg:  string;
    xl:  string;
    xxl: string;
  };
  layout: {
    navWidth:          string; // expanded sidebar width
    navCollapsedWidth: string; // icon-only sidebar width
    topbarHeight:      string; // top nav bar height
    bladeWidth:        string; // Azure blade default width
    contentMaxWidth:   string;
  };
  /** CSS transition for interactive elements */
  transition: string;
}

/**
 * applyThemeTokens — injects all tokens as CSS custom properties on :root.
 * Called once by CloudThemeProvider when the cloud is resolved.
 */
export function applyThemeTokens(tokens: ThemeTokens): void {
  const root = document.documentElement;
  const vars: Record<string, string> = {
    "--mk-color-primary":         tokens.color.primary,
    "--mk-color-primary-hover":   tokens.color.primaryHover,
    "--mk-color-primary-active":  tokens.color.primaryActive,
    "--mk-color-primary-text":    tokens.color.primaryText,
    "--mk-color-surface":         tokens.color.surface,
    "--mk-color-surface-raised":  tokens.color.surfaceRaised,
    "--mk-color-background":      tokens.color.background,
    "--mk-color-text":            tokens.color.text,
    "--mk-color-text-subtle":     tokens.color.textSubtle,
    "--mk-color-text-on-dark":    tokens.color.textOnDark,
    "--mk-color-border":          tokens.color.border,
    "--mk-color-border-subtle":   tokens.color.borderSubtle,
    "--mk-color-accent":          tokens.color.accent,
    "--mk-color-accent-surface":  tokens.color.accentSurface,
    "--mk-color-danger":          tokens.color.danger,
    "--mk-color-danger-surface":  tokens.color.dangerSurface,
    "--mk-color-success":         tokens.color.success,
    "--mk-color-success-surface": tokens.color.successSurface,
    "--mk-color-warning":         tokens.color.warning,
    "--mk-color-warning-surface": tokens.color.warningSurface,
    "--mk-color-info":            tokens.color.info,
    "--mk-color-info-surface":    tokens.color.infoSurface,
    "--mk-color-nav-bg":          tokens.color.navBackground,
    "--mk-color-nav-text":        tokens.color.navText,
    "--mk-color-nav-border":      tokens.color.navBorder,
    "--mk-color-nav-active-item": tokens.color.navActiveItem,
    "--mk-color-nav-active-text": tokens.color.navActiveText,

    "--mk-font-family":       tokens.font.family,
    "--mk-font-family-mono":  tokens.font.familyMono,
    "--mk-font-size-xs":      tokens.font.sizeXs,
    "--mk-font-size-sm":      tokens.font.sizeSm,
    "--mk-font-size-base":    tokens.font.sizeBase,
    "--mk-font-size-md":      tokens.font.sizeMd,
    "--mk-font-size-lg":      tokens.font.sizeLg,
    "--mk-font-size-xl":      tokens.font.sizeXl,
    "--mk-font-weight-normal":tokens.font.weightNormal,
    "--mk-font-weight-medium":tokens.font.weightMedium,
    "--mk-font-weight-bold":  tokens.font.weightBold,
    "--mk-line-height":       tokens.font.lineHeight,

    "--mk-radius-none": tokens.radius.none,
    "--mk-radius-sm":   tokens.radius.sm,
    "--mk-radius-md":   tokens.radius.md,
    "--mk-radius-lg":   tokens.radius.lg,
    "--mk-radius-full": tokens.radius.full,

    "--mk-shadow-none": tokens.shadow.none,
    "--mk-shadow-sm":   tokens.shadow.sm,
    "--mk-shadow-md":   tokens.shadow.md,
    "--mk-shadow-lg":   tokens.shadow.lg,

    "--mk-spacing-xs":  tokens.spacing.xs,
    "--mk-spacing-sm":  tokens.spacing.sm,
    "--mk-spacing-md":  tokens.spacing.md,
    "--mk-spacing-lg":  tokens.spacing.lg,
    "--mk-spacing-xl":  tokens.spacing.xl,
    "--mk-spacing-xxl": tokens.spacing.xxl,

    "--mk-nav-width":           tokens.layout.navWidth,
    "--mk-nav-collapsed-width": tokens.layout.navCollapsedWidth,
    "--mk-topbar-height":       tokens.layout.topbarHeight,
    "--mk-blade-width":         tokens.layout.bladeWidth,
    "--mk-content-max-width":   tokens.layout.contentMaxWidth,

    "--mk-transition": tokens.transition,
  };

  for (const [prop, value] of Object.entries(vars)) {
    root.style.setProperty(prop, value);
  }

  // Apply font-face preloads by setting a data attribute that CSS can key on.
  root.setAttribute("data-mk-cloud",
    tokens.color.navBackground === tokens.color.background ? "light-nav" : "dark-nav");
}
