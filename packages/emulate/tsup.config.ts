import { defineConfig } from "tsup";
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

const copyFonts = async () => {
  const src = resolve(__dirname, "../@emulators/core/src/fonts");
  const dest = resolve(__dirname, "dist/fonts");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
};

const copyPgliteAssets = async () => {
  const req = createRequire(resolve(__dirname, "../@emulators/postgres/package.json"));
  const pgliteDist = dirname(req.resolve("@electric-sql/pglite"));
  const dest = resolve(__dirname, "dist");
  for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    copyFileSync(resolve(pgliteDist, file), resolve(dest, file));
  }
};

// The Cloudflare emulator's D1/R2 engine is Miniflare, which spawns a workerd
// child process and resolves its own platform binary from node_modules. Unlike
// PGlite there is nothing to copy into dist: workerd is a native executable
// shipped by @cloudflare/workerd-<os>-<arch>, so miniflare (and workerd) stay
// external and are loaded from the installed tree at runtime, exactly as
// redis-memory-server is.
const addShebang = async () => {
  const entry = resolve(__dirname, "dist/index.js");
  const content = readFileSync(entry, "utf-8");
  writeFileSync(entry, `#!/usr/bin/env node\n${content}`);
};

const shared = {
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    splitting: true,
    sourcemap: true,
    noExternal: [/^@emulators\//],
    external: ["redis-memory-server", "miniflare", "workerd"],
    async onSuccess() {
      await copyFonts();
      await copyPgliteAssets();
      await addShebang();
    },
  },
  {
    ...shared,
    entry: ["src/api.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
    noExternal: [/^@emulators\//],
    external: ["redis-memory-server", "miniflare", "workerd"],
    async onSuccess() {
      await copyFonts();
      await copyPgliteAssets();
    },
  },
]);
