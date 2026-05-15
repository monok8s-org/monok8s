// packages/flagd — OpenFeature feature-flag client (#35 / 0.1.0).
//
// 0.1.0 ships a NO-OP provider stub. Every flag evaluation returns the
// caller-supplied default; no flagd server is contacted. The 0.2.0
// upgrade swaps in `@openfeature/server-sdk` + a real flagd binding;
// callers' code shape stays the same since the surface mirrors
// OpenFeature's standard getClient() shape.
//
// Why a stub rather than pulling in the real `@openfeature/server-sdk`
// dependency today: the SDK + a flagd server + a flag-store backing
// service are infrastructure the 0.1.0 release isn't deploying yet
// (flagd is queued for the 0.2.0 platform-install layer). Shipping
// the stub lets call sites adopt the interface now; the upgrade is
// then a single-package internal swap.

export interface FlagdClient {
  getBooleanValue(flagKey: string, defaultValue: boolean): boolean;
  getStringValue(flagKey: string, defaultValue: string): string;
  getNumberValue(flagKey: string, defaultValue: number): number;
}

const noopClient: FlagdClient = {
  getBooleanValue: (_flagKey: string, defaultValue: boolean) => defaultValue,
  getStringValue: (_flagKey: string, defaultValue: string) => defaultValue,
  getNumberValue: (_flagKey: string, defaultValue: number) => defaultValue,
};

// getClient — singleton accessor mirroring OpenFeature's standard
// pattern. 0.1.0 returns the no-op client; 0.2.0 wires the real
// flagd provider here.
export function getClient(): FlagdClient {
  return noopClient;
}
