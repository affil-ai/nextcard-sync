import { defineConfig, loadEnv } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";
import {
  buildProviderContentScripts,
  getProviderHostPermissions,
  providerIds,
  providerRegistry,
} from "./src/providers/provider-registry";

export default defineConfig(({ mode }) => {
  // Load local env files so the extension repo can point at the existing NextCard services.
  const env = loadEnv(mode, process.cwd(), "");
  const convexUrl =
    env.CONVEX_SITE_URL
    ?? process.env.CONVEX_SITE_URL
    ?? "https://laudable-turtle-546.convex.site";
  const hostPermissions = Array.from(
    new Set([
      ...providerIds.flatMap((providerId) => {
        return getProviderHostPermissions(providerRegistry[providerId]);
      }),
      `${convexUrl}/*`,
    ]),
  );

  return {
    plugins: [
      crx({
        manifest: {
          ...manifest,
          name: mode === "development" ? `[DEV] ${manifest.name}` : manifest.name,
          host_permissions: hostPermissions,
          content_scripts: buildProviderContentScripts(),
        },
      }),
    ],
    publicDir: "public",
    define: {
      __NEXTCARD_URL__: JSON.stringify(
        env.NEXTCARD_URL ?? process.env.NEXTCARD_URL ?? "https://nextcard.com",
      ),
      __CONVEX_SITE_URL__: JSON.stringify(
        convexUrl,
      ),
    },
    build: {
      outDir: mode === "development" ? "dist-dev" : "dist",
      emptyOutDir: true,
    },
  };
});
