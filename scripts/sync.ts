/**
 * Chạy job đồng bộ từ dòng lệnh (không cần server).
 *   npm run sync -- pancake-all --backfill
 *   npm run sync -- pancake-orders
 *   npm run sync -- vtp-tracking --all --limit=500
 *   npm run sync -- pancake-backfill --days=90 --restart
 */
import "dotenv/config";
import { ensureMigrated } from "@/db/migrate";
import { JOB_DEFINITIONS, runJob } from "@/lib/sync/jobs";

async function main() {
  const [job, ...rest] = process.argv.slice(2);
  if (!job || !JOB_DEFINITIONS[job]) {
    console.log("Cách dùng: npm run sync -- <job> [--key=value ...]\n");
    for (const [name, def] of Object.entries(JOB_DEFINITIONS)) console.log(`  ${name.padEnd(20)} ${def.label} — ${def.description}`);
    process.exit(job ? 1 : 0);
  }
  const params: Record<string, string> = {};
  for (const arg of rest) {
    const m = arg.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) params[m[1]] = m[2] ?? "1";
  }
  await ensureMigrated();
  console.log(`▶ ${JOB_DEFINITIONS[job].label} (${job})`, Object.keys(params).length ? params : "");
  const started = Date.now();
  const result = await runJob(job, { trigger: "MANUAL", actor: "cli", params });
  console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`Xong sau ${Math.round((Date.now() - started) / 1000)} giây.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
