import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

const configDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@opencode-pet/protocol"] })],
    resolve: {
      alias: {
        "@opencode-pet/protocol": resolve(configDirectory, "../protocol/src/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: configDirectory,
    resolve: {
      alias: {
        "@app": resolve(configDirectory, "src"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(configDirectory, "index.html"),
      },
    },
  },
})
