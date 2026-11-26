#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function build() {
  const distDir = path.join(ROOT, "dist");
  await fs.mkdir(distDir, { recursive: true });
  const outPath = path.join(distDir, "server.mjs");

  await esbuild.build({
    entryPoints: [path.join(ROOT, "server", "index.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node18"],
    outfile: outPath,
    minify: false,
    sourcemap: false,
    banner: {
      js: 'import { createRequire as __ctCreateRequire } from "node:module"; const require = __ctCreateRequire(import.meta.url);',
    },
  });

  const stat = await fs.stat(outPath);
  console.log(`Built standalone MCP server bundle: ${outPath} (${(stat.size / 1024).toFixed(1)} KiB)`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
