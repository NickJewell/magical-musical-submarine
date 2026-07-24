import app from "./app";
import { logger } from "./lib/logger";
import { purgeExpiredHttpCache } from "./lib/http";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// How often to sweep expired http_cache rows (default: every 6 hours)
const CACHE_PURGE_INTERVAL_MS =
  Number(process.env["CACHE_PURGE_INTERVAL_MS"] ?? "") ||
  6 * 60 * 60 * 1000;

async function runCachePurge() {
  const deleted = await purgeExpiredHttpCache();
  logger.info({ deleted }, "http_cache sweep complete");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Run once at startup, then on a fixed interval
  runCachePurge();
  setInterval(runCachePurge, CACHE_PURGE_INTERVAL_MS);
  logger.info(
    { intervalMs: CACHE_PURGE_INTERVAL_MS },
    "http_cache purge scheduled",
  );
});
