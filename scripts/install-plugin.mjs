import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "packages", "plugin", "dist", "opencode-pet.js");
const target = join(homedir(), ".config", "opencode", "plugins", "opencode-pet.js");
const tuiSource = join(root, "packages", "plugin", "dist", "opencode-pet-tui.js");
const tuiTarget = join(homedir(), ".config", "opencode", "opencode-pet", "opencode-pet-tui.js");

const build = spawnSync(
  process.execPath,
  ["run", "--cwd", join(root, "packages", "plugin"), "build"],
  { stdio: "inherit", shell: false },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

async function installFile(sourcePath, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    const existing = await readFile(targetPath);
    const incoming = await readFile(sourcePath);
    if (existing.equals(incoming)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(targetPath, `${targetPath}.${stamp}.bak`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await copyFile(sourcePath, targetPath);
}

await installFile(source, target);
await installFile(tuiSource, tuiTarget);
console.log(`Installed opencode pet plugin to ${target}`);
console.log(`Optional TUI plugin: ${tuiTarget}`);
console.log("Restart opencode to load the updated plugin.");
