// 對 public/ 下所有前端 ES module 執行 node --check（跨平台，Windows PowerShell 也能用 npm run check:js）。
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const files = readdirSync(publicDir).filter((name) => name.endsWith(".js")).sort();
let failed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, ["--check", join(publicDir, name)], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`FAIL public/${name}\n${result.stderr}\n`);
  }
}
console.log(`node --check: ${files.length - failed}/${files.length} files ok`);
process.exit(failed ? 1 : 0);
