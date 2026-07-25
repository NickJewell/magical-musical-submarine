import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Set before any module loads. Several modules capture these at import
    // time: @workspace/db throws if DATABASE_URL is unset, and musicbrainz.ts
    // captures LASTFM_KEY at load (its Last.fm search path is gated on it).
    // A dummy DATABASE_URL never actually connects — pg.Pool is lazy.
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      LASTFM_API_KEY: "test-key-for-unit-tests",
    },
  },
  resolve: {
    alias: {
      "@workspace/db": resolve(__dirname, "../../lib/db/src/index.ts"),
    },
  },
});
