import express, { type Express } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Clerk proxy — must be BEFORE body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({ credentials: true, origin: true }));

// ---------------------------------------------------------------------------
// Single-origin static serving: the built trails SPA lives on the SAME domain
// as the API, so Clerk's same-origin proxy (/api/__clerk) and credentialed
// cookies keep working. Mounted BEFORE the body parsers and Clerk session
// middleware so static assets and client-side routes don't pay for auth
// resolution (auth is enforced client-side and on /api). In dev the frontend
// runs on its own Vite server and this block is skipped (the build dir won't
// exist). Override the location with STATIC_DIR if the layout differs.
// ---------------------------------------------------------------------------
const clientDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../trails/dist/public");

if (fs.existsSync(path.join(clientDir, "index.html"))) {
  const indexHtml = path.join(clientDir, "index.html");
  app.use(express.static(clientDir));
  // SPA fallback: any GET that isn't an /api route and doesn't map to a real
  // file returns index.html so client-side routes (/compare, …) resolve.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(indexHtml);
  });
  logger.info({ clientDir }, "Serving trails SPA (single-origin)");
} else {
  logger.warn({ clientDir }, "No client build found — serving API only");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Clerk session middleware — resolves publishable key from hostname so the same
// server works in dev and prod without NODE_ENV gates.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
