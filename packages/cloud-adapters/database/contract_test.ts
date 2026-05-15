// Type-level contract test — ts_project typecheck fails if any impl
// stops satisfying DatabaseAdapter. Runtime round-trip behavior lands
// with the real CNPG wiring in #104.

import type { DatabaseAdapter } from "./interface";
import { baremetal } from "./baremetal";
import { aws } from "./aws";
import { gcp } from "./gcp";
import { azure } from "./azure";

export const registry: Record<"baremetal" | "aws" | "gcp" | "azure", DatabaseAdapter> = {
  baremetal,
  aws,
  gcp,
  azure,
};
