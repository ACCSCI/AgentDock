/**
 * 构建时将 daemon 预编译为 JS。
 *
 * 打包的 Electron 应用中无法使用 bun，因此需要在构建时将
 * plugins/daemon.ts 预编译为 out/daemon/daemon.cjs。
 * 打包应用通过 Electron 的 Node 模式（ELECTRON_RUN_AS_NODE=1）
 * 运行编译后的 daemon。
 */
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

async function main() {
  await build({
    entryPoints: [resolve(root, "plugins/daemon.ts")],
    bundle: true,
    outfile: resolve(root, "out/daemon/daemon.cjs"),
    platform: "node",
    target: "node24",
    format: "cjs",
    external: [
      "node-pty",       // 原生模块，不可打包
      "electron",        // daemon 不需要 electron
      "better-sqlite3",  // 原生模块
    ],
    sourcemap: false,
    minify: false,
    banner: {
      js: "// AgentDock daemon — 构建时编译，请勿手动编辑。",
    },
  });
  console.log("[build-daemon] daemon compiled to out/daemon/daemon.cjs");
}

main().catch((err) => {
  console.error("[build-daemon] failed:", err);
  process.exit(1);
});
