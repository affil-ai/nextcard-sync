import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("Safari packaging requires macOS and Xcode.");
}

const root = resolve(import.meta.dirname, "..");
const packageDirectory = resolve(root, ".safari-build");
const projectDirectory = resolve(packageDirectory, "nextcard");
await rm(projectDirectory, { force: true, recursive: true });

const argumentsList = [
  "safari-web-extension-packager",
  resolve(root, "dist-safari"),
  "--project-location",
  packageDirectory,
  "--app-name",
  "nextcard",
  "--bundle-identifier",
  "ai.affil.nextcard.sync",
  "--swift",
  "--copy-resources",
  "--no-open",
  "--no-prompt",
  "--force",
];

await new Promise((resolvePromise, reject) => {
  const child = spawn("xcrun", argumentsList, { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`Safari packager exited with code ${code ?? "unknown"}.`));
  });
});

console.log(`Safari Xcode project created at ${projectDirectory}`);
