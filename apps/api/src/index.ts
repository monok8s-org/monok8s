import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { wireProductionAudit } from "./audit_emitter.js";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";
import { handleAuthRoute } from "./routers/auth.js";
import { handleSystemRoute } from "./routers/system.js";

// Register the production audit emitter against packages/auth's audit
// middleware seam (#179 / #88c). Must happen before any auditedMutation
// resolves, which means before the server starts handling requests.
wireProductionAudit();

const server = createHTTPServer({
  router: appRouter,
  createContext,
  // Pre-handler for plain REST routes that must resolve before tRPC processes
  // the request.  Returns true if the request was fully handled.
  middleware(req, res, next) {
    if (handleSystemRoute(req, res)) return;
    if (handleAuthRoute(req, res)) return;
    next();
  },
});

const port = parseInt(process.env.PORT ?? "3000");
server.listen(port);
console.log(`API listening on :${port}`);
