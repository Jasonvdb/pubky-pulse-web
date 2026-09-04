import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "browser",
  target: "es2020",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  minify: false,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
