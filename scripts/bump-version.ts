/**
 * 更新 package.json 中的版本号。
 * 用法：
 *   bun run scripts/bump-version.ts patch      # 0.1.0 → 0.1.1
 *   bun run scripts/bump-version.ts minor      # 0.1.0 → 0.2.0
 *   bun run scripts/bump-version.ts major      # 0.1.0 → 1.0.0
 *   bun run scripts/bump-version.ts 0.2.0      # 精确指定版本号
 *
 * 版本号更新后按以下步骤发布：
 *   git add package.json
 *   git commit -m "chore: bump to v0.1.1"
 *   git tag v0.1.1
 *   git push --follow-tags
 *
 * 推送 v* tag 后 Release workflow 自动触发。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname ?? ".", "..");
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const arg = process.argv[2];
if (!arg) {
  console.error("用法: bun run scripts/bump-version.ts <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

// 安全提取 semver 主.次.修订号，忽略末尾的预发布标签（如 0.1.0-rc.1）
const match = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!match) {
  console.error(`当前 package.json 中的版本号格式无法解析: "${pkg.version}"`);
  process.exit(1);
}
const major = Number(match[1]);
const minor = Number(match[2]);
const patch = Number(match[3]);

let newVersion: string;
switch (arg) {
  case "major":
    newVersion = `${major + 1}.0.0`;
    break;
  case "minor":
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case "patch":
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
  default:
    // 精确版本号 — 简单校验 semver 格式
    if (!/^\d+\.\d+\.\d+$/.test(arg)) {
      console.error(`无效版本号: "${arg}"。请使用 patch, minor, major 或 X.Y.Z 格式`);
      process.exit(1);
    }
    newVersion = arg;
}

pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`版本已更新: ${pkg.version} → ${newVersion}`);
console.log();
console.log("后续步骤:");
console.log(`  git add package.json`);
console.log(`  git commit -m "chore: bump to v${newVersion}"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push --follow-tags`);
