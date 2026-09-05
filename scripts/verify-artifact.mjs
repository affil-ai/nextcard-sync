import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson("package.json");
const source = readJson("manifest.json");
const built = readJson("dist/manifest.json");
if (pkg.version !== source.version || built.version !== source.version) {
  throw new Error("Package, source manifest, and built manifest versions must match. Rebuild this checkout.");
}
if (!existsSync(resolve("dist", built.background.service_worker))) {
  throw new Error("The built service worker is missing.");
}
console.log(JSON.stringify({
  directory: resolve("dist"),
  version: built.version,
  manifestSha256: createHash("sha256").update(readFileSync("dist/manifest.json")).digest("hex"),
}, null, 2));
