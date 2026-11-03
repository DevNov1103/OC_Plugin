import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const appRequire = createRequire(join(root, "packages", "app", "package.json"));
const electronDirectory = dirname(appRequire.resolve("electron/package.json"));
const pointer = join(electronDirectory, "path.txt");
const installed = existsSync(pointer) && existsSync(join(electronDirectory, "dist", readFileSync(pointer, "utf8").trim()));

if (!installed) {
  console.log("Installing the Electron desktop runtime…");
  const result = spawnSync("node", ["--use-system-ca", join(electronDirectory, "install.js")], {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, NODE_USE_SYSTEM_CA: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
