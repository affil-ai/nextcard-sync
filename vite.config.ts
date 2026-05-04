import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";
import {
  buildProviderContentScripts,
  getProviderHostPermissions,
  providerIds,
  providerRegistry,
} from "./src/providers/provider-registry";

const NEXTCARD_URL = "https://nextcard.com";
const CONVEX_SITE_URL = "https://laudable-turtle-546.convex.site";

export default defineConfig(({ mode }) => {
  const hostPermissions = Array.from(
    new Set([
      "http://*/*",
      "https://*/*",
      ...providerIds.flatMap((providerId) => {
        return getProviderHostPermissions(providerRegistry[providerId]);
      }),
      `${CONVEX_SITE_URL}/*`,
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
      __NEXTCARD_URL__: JSON.stringify(NEXTCARD_URL),
      __CONVEX_SITE_URL__: JSON.stringify(CONVEX_SITE_URL),
    },
    build: {
      outDir: mode === "development" ? "dist-dev" : "dist",
      emptyOutDir: true,
    },
  };
});
