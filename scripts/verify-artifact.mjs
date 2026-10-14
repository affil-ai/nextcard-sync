import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson("package.json");
const source = readJson("manifest.json");
const built = readJson("dist/manifest.json");
if (pkg.version !== source.version || built.version !== source.version) {
  throw new Error(
    "Package, source manifest, and built manifest versions must match. Rebuild this checkout.",
  );
}
if (!existsSync(resolve("dist", built.background.service_worker))) {
  throw new Error("The built service worker is missing.");
}
if (!existsSync(resolve("dist/src/welcome/index.html"))) {
  throw new Error(
    "The installation welcome page is missing from the release artifact.",
  );
}
const locationScript = built.content_scripts.find(
  (script) =>
    script.world === "MAIN" &&
    script.matches.includes("https://deals.merchant-rewards.com/*"),
);
if (
  !locationScript ||
  locationScript.run_at !== "document_start" ||
  locationScript.js.length !== 1
) {
  throw new Error(
    "BofA location capture must run at document start in the issuer MAIN world.",
  );
}
// Execute the actual built script as a classic content script. A module loader
// would fail here or install its observer too late for the first issuer request.
const requests = [];
class IssuerXHR {
  open(...args) {
    requests.push(args);
  }
  send(body) {
    requests.push(body);
  }
}
const realm = {
  window: { fetch: async () => {} },
  XMLHttpRequest: IssuerXHR,
  URL,
  URLSearchParams,
  TextEncoder,
  crypto: webcrypto,
  location: { href: "https://deals.merchant-rewards.com/search", search: "" },
  localStorage: { getItem: () => "artifact-test-session" },
};
runInNewContext(
  readFileSync(resolve("dist", locationScript.js[0]), "utf8"),
  realm,
);
const xhr = new IssuerXHR();
xhr.open("POST", "/api/offers-search", true);
xhr.send(JSON.stringify({ proximity_target: { latitude: 1, longitude: 2 } }));
await new Promise((resolve) => setTimeout(resolve, 20));
if (
  realm.window.__nextcardBofaLocation?.latitude !== 1 ||
  requests.length !== 2
) {
  throw new Error(
    "The built BofA observer did not synchronously capture the first issuer read.",
  );
}
console.log(
  JSON.stringify(
    {
      directory: resolve("dist"),
      version: built.version,
      manifestSha256: createHash("sha256")
        .update(readFileSync("dist/manifest.json"))
        .digest("hex"),
    },
    null,
    2,
  ),
);
