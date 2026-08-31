import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";
import {
  CONVEX_SITE_URL,
  getExtensionDefines,
} from "./extension-build-config";
import {
  buildProviderContentScripts,
  getProviderHostPermissions,
  providerIds,
  providerRegistry,
} from "./src/providers/provider-registry";

export default defineConfig(({ mode }) => {
  const isSafari = mode === "safari";
  const hostPermissions = Array.from(
    new Set([
      ...(isSafari ? [] : ["http://*/*"]),
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
          permissions: isSafari
            ? manifest.permissions.filter((permission) => permission !== "sidePanel")
            : manifest.permissions,
          action: isSafari
            ? {
                ...manifest.action,
                default_popup: "src/popup/popup.html",
              }
            : manifest.action,
          host_permissions: hostPermissions,
          content_scripts: buildProviderContentScripts(),
        },
      }),
    ],
    publicDir: "public",
    define: getExtensionDefines(mode),
    build: {
      outDir: mode === "development" ? "dist-dev" : isSafari ? "dist-safari" : "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Unpacked extensions keep the current manifest in memory until the user
          // reloads them. Stable JS paths let already-registered content scripts
          // survive a local rebuild instead of importing a deleted hashed chunk.
          entryFileNames: "assets/[name].js",
          chunkFileNames: "assets/[name].js",
        },
      },
    },
  };
});
