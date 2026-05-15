// Type-level contract test — ts_project typecheck fails if any impl
// stops satisfying ObservabilityAdapter. Runtime round-trip behavior
// lands with the real Loki+Mimir+Tempo wiring in #105.

import type { ObservabilityAdapter } from "./interface";
import { baremetal } from "./baremetal";
import { aws } from "./aws";
import { gcp } from "./gcp";
import { azure } from "./azure";

export const registry: Record<"baremetal" | "aws" | "gcp" | "azure", ObservabilityAdapter> = {
  baremetal,
  aws,
  gcp,
  azure,
};
