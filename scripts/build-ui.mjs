#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function build() {
  const [template, css, bundled] = await Promise.all([
    fs.readFile(path.join(ROOT, "ui", "index.html"), "utf8"),
    fs.readFile(path.join(ROOT, "ui", "styles.css"), "utf8"),
    esbuild.build({
      entryPoints: [path.join(ROOT, "ui", "app.js")],
      bundle: true,
      format: "iife",
      target: ["es2022"],
      minify: true,
      write: false,
      sourcemap: false,
    }),
  ]);

  const jsCode = bundled.outputFiles[0].text;

  // Escape closing script/style tags just in case
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  const safeJs = jsCode.replace(/<\/script/gi, "<\\/script");

  const html = template
    .replace("/* __INLINE_CSS__ */", () => safeCss)
    .replace("/* __INLINE_JS__ */", () => safeJs);

  const distDir = path.join(ROOT, "dist");
  await fs.mkdir(distDir, { recursive: true });
  const outPath = path.join(distDir, "app.html");
  await fs.writeFile(outPath, html, "utf8");

  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`Built self-contained MCP App HTML: ${outPath} (${kb} KiB)`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
