import { spawnSync } from "node:child_process";

const task = process.argv[2];
if (!task) {
  console.error("Usage: bun scripts/workspaces.mjs <build|typecheck|test|check>");
  process.exit(2);
}

const matrix = {
  build: ["protocol", "plugin", "app"],
  typecheck: ["protocol", "plugin", "app"],
  test: ["protocol", "plugin", "app"],
  check: ["protocol", "plugin", "app"],
};

const workspaces = matrix[task];
if (!workspaces) {
  console.error(`Unknown task: ${task}`);
  process.exit(2);
}

for (const workspace of workspaces) {
  const result = spawnSync(
    process.execPath,
    ["run", "--cwd", `packages/${workspace}`, task],
    { stdio: "inherit", shell: false },
  );

  // A workspace may intentionally have no test suite yet.
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
