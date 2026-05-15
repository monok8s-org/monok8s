import { lazy, ParentComponent, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useCloud } from "../providers/cloud-theme";
import type { Cloud } from "../providers/cloud-theme";

// Lazy-load each shell so only the active one is bundled in the initial chunk.
const shells: Record<Cloud, ReturnType<typeof lazy>> = {
  gcp:          lazy(() => import("./GCPShell")),
  aws:          lazy(() => import("./AWSShell")),
  azure:        lazy(() => import("./AzureShell")),
  "bare-metal": lazy(() => import("./BareMetalShell")),
};

/**
 * CloudShell
 *
 * Top-level layout router.  Reads the active cloud from CloudThemeContext and
 * renders the matching navigation shell (GCP left sidebar, AWS dark top nav,
 * Azure icon sidebar + blades, or a neutral bare-metal shell).
 *
 * Must be a descendant of <CloudThemeProvider>.
 *
 * Usage:
 *   <CloudThemeProvider>
 *     <CloudShell>
 *       <Router> … </Router>
 *     </CloudShell>
 *   </CloudThemeProvider>
 */
const CloudShell: ParentComponent = (props) => {
  const { info } = useCloud();
  const Shell = shells[info.cloud];

  return (
    <Suspense fallback={<div class="mk-loading-splash" />}>
      <Dynamic component={Shell}>{props.children}</Dynamic>
    </Suspense>
  );
};

export default CloudShell;
