// Type-level contract test — `ts_project` type-checks fail if any of the
// four implementations stop satisfying StorageAdapter. Runtime round-trip
// behavior is asserted in the per-axis follow-up Issues (#102 for storage).

import type { StorageAdapter } from "./interface";
import { baremetal } from "./baremetal";
import { aws } from "./aws";
import { gcp } from "./gcp";
import { azure } from "./azure";

// Each impl must satisfy the interface. The Record forces TS to widen
// the values to StorageAdapter — a missing or off-signature method
// produces a compile error here that fails the ts_project typecheck.
export const registry: Record<"baremetal" | "aws" | "gcp" | "azure", StorageAdapter> = {
  baremetal,
  aws,
  gcp,
  azure,
};
