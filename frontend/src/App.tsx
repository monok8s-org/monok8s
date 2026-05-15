// Top-level App component (#91 Phase A).
//
// Composes the SolidJS Router with the AuthProvider stub. Phase B
// (follow-up Issue) replaces AuthProvider's body with real Zitadel
// OIDC; the App tree shape doesn't change.

import type { Component } from "solid-js";
import { Router } from "@solidjs/router";

import { AuthProvider } from "./lib/auth";
import { routes } from "./routes";

const App: Component = () => (
  <AuthProvider>
    <Router>{routes}</Router>
  </AuthProvider>
);

export default App;
