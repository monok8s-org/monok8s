// Type-level contract test — ts_project typecheck fails if any impl
// stops satisfying SecretsAdapter. Runtime round-trip behavior lands
// with the real Vault Transit wiring in #103.

import type { SecretsAdapter } from "./interface";
import { baremetal } from "./baremetal";
import { aws } from "./aws";
import { gcp } from "./gcp";
import { azure } from "./azure";

export const registry: Record<"baremetal" | "aws" | "gcp" | "azure", SecretsAdapter> = {
  baremetal,
  aws,
  gcp,
  azure,
};
