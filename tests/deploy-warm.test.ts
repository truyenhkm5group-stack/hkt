/**
 * Làm ấm trang nặng sau deploy (lib/constants/deploy-warm.ts, scripts/warm-pages.ts, scripts/install-vps.sh). Khoá:
 *  · danh sách khai MỘT chỗ, mọi tuyến trong đó có trang thật; script không gõ lại tuyến nào;
 *  · bước làm ấm chạy NGAY sau vòng chờ health và TRƯỚC smoke (và trước các bước dài như sao lưu);
 *  · không bao giờ chặn deploy (`|| warn`, script luôn thoát 0); chỉ đọc do Postgres ép (cờ trước @/db).
 * Script tự chạy khi được nạp, nên bài này chỉ ĐỌC mã nguồn.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DEPLOY_WARM_CONCURRENCY, DEPLOY_WARM_ROUTES, DEPLOY_WARM_TIMEOUT_MS } from "@/lib/constants/deploy-warm";

export function testDeployWarm() {
  assert.equal(new Set(DEPLOY_WARM_ROUTES).size, DEPLOY_WARM_ROUTES.length, "không trùng tuyến");
  for (const r of DEPLOY_WARM_ROUTES) {
    const tep = r === "/" ? "app/(dashboard)/page.tsx" : `app/(dashboard)${r}/page.tsx`;
    assert.ok(existsSync(tep), `tuyến làm ấm ${r} phải có trang thật (${tep})`);
  }
  assert.ok(DEPLOY_WARM_CONCURRENCY >= 1 && DEPLOY_WARM_CONCURRENCY <= 3, "trần song song nhỏ — VPS 2 nhân");
  assert.ok(DEPLOY_WARM_TIMEOUT_MS > 0);

  const sc = readFileSync("scripts/warm-pages.ts", "utf8");
  assert.ok(sc.indexOf('process.env.ERP_READ_ONLY = "1"') > 0 && sc.indexOf('process.env.ERP_READ_ONLY = "1"') < sc.indexOf('await import("@/db")'), "ép chỉ đọc trước lần nạp @/db");
  assert.doesNotMatch(sc, /from "@\/db"/, "không import tĩnh @/db (cờ chỉ đọc phải đặt trước)");
  assert.match(sc, /DEPLOY_WARM_ROUTES/, "đọc danh sách từ hằng số");
  for (const r of DEPLOY_WARM_ROUTES.filter((x) => x !== "/")) assert.ok(!sc.includes(`"${r}"`), `script không gõ lại tuyến ${r}`);
  assert.match(sc, /process\.exit\(0\)/, "luôn thoát 0 — làm ấm không phải cổng");
  assert.doesNotMatch(sc, /process\.exit\([1-9]/);

  const sh = readFileSync("scripts/install-vps.sh", "utf8");
  const health = sh.indexOf('say "ERP đã chạy"');
  const warm = sh.indexOf("scripts/warm-pages.ts");
  const smoke = sh.indexOf("scripts/smoke.ts");
  const saoLuu = sh.indexOf("erp-backup.sh configure-offsite");
  assert.ok(health > 0 && warm > health, "làm ấm chạy SAU vòng chờ health");
  assert.ok(smoke > warm, "làm ấm chạy TRƯỚC smoke");
  assert.ok(saoLuu > warm, "làm ấm chạy TRƯỚC các bước dài (sao lưu) — cửa sổ người dùng là lượt đầu phải ngắn nhất");
  assert.match(sh.slice(warm, sh.indexOf("\n", warm)), /\|\| warn /, "lỗi làm ấm chỉ cảnh báo, không chặn deploy");
  console.log(`✓ Làm ấm sau deploy: ${DEPLOY_WARM_ROUTES.length} trang nặng khai một chỗ (đều có trang thật) · song song ${DEPLOY_WARM_CONCURRENCY} · sau health, trước sao lưu và smoke · không bao giờ chặn deploy · chỉ đọc`);
}
