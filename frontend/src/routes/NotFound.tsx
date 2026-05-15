import type { Component } from "solid-js";

import AppShell from "../components/AppShell";

const NotFound: Component = () => (
  <AppShell>
    <h1>Not found</h1>
    <p>The page you requested does not exist.</p>
  </AppShell>
);

export default NotFound;
