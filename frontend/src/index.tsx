import { render } from "solid-js/web";

import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element on page");

render(() => <App />, root);
