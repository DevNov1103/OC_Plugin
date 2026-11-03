import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const appDirectory = join(root, "packages", "app");
const appRequire = createRequire(join(appDirectory, "package.json"));
const builderDirectory = dirname(appRequire.resolve("electron-builder/package.json"));
const electronDirectory = dirname(appRequire.resolve("electron/package.json"));

const result = spawnSync("node", [
  "--use-system-ca",
  join(builderDirectory, "cli.js"),
  "--win", "nsis",
  `--config.electronDist=${join(electronDirectory, "dist")}`,
  ...process.argv.slice(2),
], {
  cwd: appDirectory,
  stdio: "inherit",
  shell: false,
  env: { ...process.env, NODE_USE_SYSTEM_CA: "1" },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
