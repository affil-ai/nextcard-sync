import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { crx } from "@crxjs/vite-plugin";
import { z } from "zod";
import manifest from "./manifest.json";
import {
  buildProviderContentScripts,
  getProviderHostPermissions,
  providerIds,
  providerRegistry,
} from "./src/providers/provider-registry";

const NEXTCARD_URL = "https://nextcard.com";
const CONVEX_SITE_URL = "https://laudable-turtle-546.convex.site";

const manifestSchema = z
  .object({
    content_scripts: z
      .array(
        z
          .object({
            world: z.string().optional(),
            matches: z.array(z.string()),
            js: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// MAIN-world document-start code must execute synchronously. CRX's module
// loader uses an asynchronous import, which can miss the issuer's first request.
const issuerLocationScript: Plugin = {
  name: "bofa-document-start-script",
  generateBundle: {
    order: "post",
    async handler(_options, bundle) {
      const manifestAsset = bundle["manifest.json"];
      if (
        !manifestAsset ||
        manifestAsset.type !== "asset" ||
        typeof manifestAsset.source !== "string"
      )
        throw new Error("Missing extension manifest");
      const outputManifest: unknown = JSON.parse(manifestAsset.source);
      const manifest = manifestSchema.parse(outputManifest);
      const sourcePath = "src/content-scripts/bofa-location-context.ts";
      const source = await readFile(
        new URL(sourcePath, import.meta.url),
        "utf8",
      );
      const compiled = await transformWithEsbuild(source, sourcePath, {
        loader: "ts",
        format: "iife",
        target: "chrome120",
        minify: true,
      });
      const fileName = "assets/bofa-location-context.js";
      this.emitFile({ type: "asset", fileName, source: compiled.code });
      for (const script of manifest.content_scripts ?? []) {
        if (
          script.world !== "MAIN" ||
          !script.matches.includes("https://deals.merchant-rewards.com/*")
        )
          continue;
        script.js = [fileName];
      }
      manifestAsset.source = JSON.stringify(manifest, null, 2);
    },
  },
};

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
          name:
            mode === "development" ? `[DEV] ${manifest.name}` : manifest.name,
          host_permissions: hostPermissions,
          content_scripts: [...buildProviderContentScripts(), {
            matches: ["https://www.doordash.com/*", "https://identity.doordash.com/*"],
            js: ["src/content-scripts/doordash-overlay.ts"],
            run_at: "document_idle",
          }],
        },
      }),
      issuerLocationScript,
    ],
    publicDir: "public",
    define: {
      __NEXTCARD_URL__: JSON.stringify(NEXTCARD_URL),
      __CONVEX_SITE_URL__: JSON.stringify(CONVEX_SITE_URL),
      __OFFERS_FIRST_UI_DEV_OVERRIDE__: JSON.stringify(mode === "development"),
      __MOCK_FREE_PLAN__: JSON.stringify(mode === "development"),
      __REWARDS_GUIDE_QA_PREVIEW__: JSON.stringify(
        process.env.REWARDS_GUIDE_QA_PREVIEW === "1",
      ),
    },
    build: {
      outDir: mode === "development" ? "dist-dev" : "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: { welcome: "src/welcome/index.html" },
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
