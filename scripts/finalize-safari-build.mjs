import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "dist-safari");
const manifestPath = resolve(outputDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

delete manifest.incognito;
delete manifest.side_panel;
manifest.permissions = manifest.permissions.filter((permission) => permission !== "sidePanel");
manifest.action = {
  ...manifest.action,
  default_popup: "src/popup/popup.html",
};
manifest.background = {
  service_worker: "safari-service-worker.js",
};

for (const resourceGroup of manifest.web_accessible_resources ?? []) {
  delete resourceGroup.use_dynamic_url;
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await Promise.all([
  rm(resolve(outputDirectory, "service-worker-loader.js"), { force: true }),
  rm(resolve(outputDirectory, "assets/service-worker.ts.js"), { force: true }),
]);
