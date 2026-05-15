import {
  createContext,
  createResource,
  useContext,
  ParentComponent,
  Show,
} from "solid-js";
import { applyThemeTokens, type ThemeTokens } from "../themes/tokens";
import { gcpTokens } from "../themes/gcp";
import { awsTokens } from "../themes/aws";
import { azureTokens } from "../themes/azure";
import { bareMetalTokens } from "../themes/bare-metal";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Cloud = "gcp" | "aws" | "azure" | "bare-metal";

export interface CloudInfo {
  cloud: Cloud;
  region: string;
  /** Display name of the cloud, e.g. "Google Cloud" */
  cloudName: string;
  /** The monok8s platform environment name */
  environment: string;
}

export interface CloudTheme {
  info: CloudInfo;
  tokens: ThemeTokens;
}

// ── Context ────────────────────────────────────────────────────────────────────

const CloudThemeContext = createContext<CloudTheme>();

/**
 * useCloud() — access the active cloud info and theme tokens anywhere in the tree.
 *
 * @example
 * const { info, tokens } = useCloud();
 * // info.cloud === "aws"
 * // tokens.color.primary === "#ec7211"
 */
export function useCloud(): CloudTheme {
  const ctx = useContext(CloudThemeContext);
  if (!ctx) throw new Error("useCloud must be used inside <CloudThemeProvider>");
  return ctx;
}

// ── Provider ───────────────────────────────────────────────────────────────────

/**
 * CloudThemeProvider
 *
 * Fetches the active cloud from /api/v1/system/cloud, selects the matching
 * theme token set, injects CSS custom properties onto :root, and provides
 * the result via context.
 *
 * Place this at the top of the app, wrapping CloudShell and all routes.
 *
 * CSS custom properties injected (all prefixed --mk-):
 *   --mk-color-primary        primary action color
 *   --mk-color-primary-hover
 *   --mk-color-surface        card/panel background
 *   --mk-color-background     page background
 *   --mk-color-text           body text
 *   --mk-color-text-subtle    secondary text
 *   --mk-color-border         default border
 *   --mk-color-accent         accent for highlights/chips
 *   --mk-color-danger         destructive action color
 *   --mk-color-success        positive status color
 *   --mk-color-warning        warning status color
 *   --mk-font-family          body font stack
 *   --mk-font-family-mono     monospace font stack
 *   --mk-font-size-base
 *   --mk-radius-sm            e.g. 2px (Azure) or 4px (GCP)
 *   --mk-radius-md
 *   --mk-radius-lg
 *   --mk-shadow-sm            card shadow (none for Azure, subtle for GCP)
 *   --mk-shadow-md
 *   --mk-nav-width            sidebar width when expanded
 *   --mk-nav-collapsed-width  sidebar width when collapsed (icon-only)
 *   --mk-topbar-height        top navigation bar height
 */
export const CloudThemeProvider: ParentComponent = (props) => {
  const [theme] = createResource<CloudTheme>(async () => {
    const resp = await fetch("/api/v1/system/cloud");
    const info: CloudInfo = await resp.json();
    const tokens = tokensForCloud(info.cloud);
    applyThemeTokens(tokens);
    return { info, tokens };
  });

  return (
    <Show when={theme()} fallback={<div class="mk-loading-splash" />}>
      <CloudThemeContext.Provider value={theme()!}>
        {props.children}
      </CloudThemeContext.Provider>
    </Show>
  );
};

// ── Token selection ────────────────────────────────────────────────────────────

function tokensForCloud(cloud: Cloud): ThemeTokens {
  switch (cloud) {
    case "gcp":        return gcpTokens;
    case "aws":        return awsTokens;
    case "azure":      return azureTokens;
    case "bare-metal": return bareMetalTokens;
  }
}
