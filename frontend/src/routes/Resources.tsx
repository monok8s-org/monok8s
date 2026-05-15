import type { Component } from "solid-js";

import AppShell from "../components/AppShell";

const Resources: Component = () => (
  <AppShell>
    <h1>Resources</h1>
    <p>
      TODO: cloud-resource inventory + drift status (consumes cloud_resources
      table from migration 007 via #91 Phase C's tRPC client).
    </p>
  </AppShell>
);

export default Resources;
