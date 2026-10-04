/**
 * Ghi lại ảnh chụp của BỘ HỘI THOẠI VÀNG sau một thay đổi CỐ Ý ở engine / công cụ / lời nhắc.
 *
 *   npx tsx tests/sales-agent-golden/update.ts
 *
 * Chạy trên PGlite thử (giống `npm test`), không gọi mạng. Sau khi chạy: `git diff tests/sales-agent-golden/snapshots` — đọc
 * TỪNG thay đổi như đọc mã. Một ảnh chụp đổi mà không ai giải thích được là một hành vi bot đổi mà không ai muốn.
 */
import "../setup-env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureMigrated } from "@/db/migrate";
import { GOLDEN_CASES } from "./cases";
import { GOLDEN_SNAPSHOT_DIR } from "./golden.test";
import { runGoldenCases } from "./harness";

void (async () => {
  await ensureMigrated();
  const got = await runGoldenCases(GOLDEN_CASES);
  mkdirSync(GOLDEN_SNAPSHOT_DIR, { recursive: true });
  for (const [key, t] of got) writeFileSync(path.join(GOLDEN_SNAPSHOT_DIR, `${key}.json`), `${JSON.stringify(t, null, 2)}\n`, { encoding: "utf8" });
  console.log(`Đã ghi ${got.size} ảnh chụp vào ${GOLDEN_SNAPSHOT_DIR} — đọc git diff trước khi commit.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
