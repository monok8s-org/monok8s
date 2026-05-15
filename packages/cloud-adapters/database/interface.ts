// Database adapter axis — per-tenant DB provisioning + connection
// handles. Bare-metal is CloudNativePG; cloud impls map to RDS /
// Cloud SQL / Azure DB. DSN-based connection (consumer passes the DSN
// to its pg client of choice — pool/connect surfaces stay in apps/api).

export interface DatabaseHandle {
  readonly id: string;
  readonly dsn: string;
}

export interface DatabaseAdapter {
  provisionInstance(name: string, region: string): Promise<DatabaseHandle>;
  describeInstance(name: string): Promise<DatabaseHandle>;
  deleteInstance(name: string): Promise<void>;
}
