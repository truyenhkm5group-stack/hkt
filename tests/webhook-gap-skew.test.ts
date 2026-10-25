/**
 * ═══ LỆCH ĐỒNG HỒ TỆP ↔ WEBHOOK KHÔNG PHẢI RƠI GÓI (lib/constants/webhook-gap.ts, đo production 25/10/2026) ═══
 *
 * Tệp «Danh sách vận đơn» 452 dòng ghi 366 «khoảng hụt» (webhook «rơi 98%»): 357 dòng có mốc tệp CHẬM hơn mốc webhook ERP đang giữ
 * 1–10 giây, 1 dòng 11–120 giây, và 358/358 dòng ấy có đúng sự kiện webhook trong ±120 giây (8 dòng còn lại: ERP chưa có mốc). Khoá: lệch 1 giây ⇒ không phải hụt · lệch 121 giây ⇒ hụt · ERP chưa có
 * mốc ⇒ hụt · bản SQL ≡ bản TS trên cùng dữ liệu · hai chỗ đọc sổ (hàng đợi đối chiếu, sức khoẻ webhook) + trang lượt nhập phân loại
 * lại LÚC ĐỌC bằng cùng hằng số, không sửa dòng sổ · phán quyết từng dòng của lượt nhập (verdictOf) CỐ Ý không dùng dung sai.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { erpKnewWithinSkew, gapWithinSkewSql, measureWebhookGap, WEBHOOK_CLOCK_SKEW_SECONDS, WEBHOOK_GAP_MIN_MINUTES } from "@/lib/constants/webhook-gap";
import { rowsOf } from "@/lib/sql-rows";

export async function testWebhookGapSkew(db: Db) {
  const tep = new Date("2026-10-25T15:24:04Z");
  const nhap = new Date(tep.getTime() + 3 * 3_600_000);
  const lui = (s: number) => new Date(tep.getTime() - s * 1000);
  assert.equal(WEBHOOK_CLOCK_SKEW_SECONDS, 120);
  assert.ok(WEBHOOK_CLOCK_SKEW_SECONDS < WEBHOOK_GAP_MIN_MINUTES * 60, "dung sai lệch đồng hồ nhỏ hơn ngưỡng «quá mới» — không che được một lần rơi thật");

  assert.deepEqual(measureWebhookGap({ carrierEventAt: tep, erpKnewAt: lui(1), importedAt: nhap }).isGap, false, "lệch 1 giây (ca 155281549288: ERP 22:24:02 ↔ tệp 22:24:04) ⇒ ERP đã biết");
  assert.equal((measureWebhookGap({ carrierEventAt: tep, erpKnewAt: lui(1), importedAt: nhap }) as { reason?: string }).reason, "ERP_ALREADY_AHEAD");
  assert.equal(measureWebhookGap({ carrierEventAt: tep, erpKnewAt: lui(120), importedAt: nhap }).isGap, false, "đúng biên 120 giây ⇒ vẫn là đã biết");
  assert.equal(measureWebhookGap({ carrierEventAt: tep, erpKnewAt: lui(121), importedAt: nhap }).isGap, true, "lệch 121 giây ⇒ hụt");
  assert.equal(measureWebhookGap({ carrierEventAt: tep, erpKnewAt: null, importedAt: nhap }).isGap, true, "ERP chưa có mốc ⇒ hụt");
  assert.equal(measureWebhookGap({ carrierEventAt: tep, erpKnewAt: new Date(tep.getTime() + 5000), importedAt: nhap }).isGap, false, "ERP mới hơn ⇒ đã biết (như cũ)");
  assert.throws(() => gapWithinSkewSql("g; drop table x"), /bí danh/);

  // SQL ≡ TS trên cùng dữ liệu.
  const ca = [null, 0, -1, -120, -121, -3600, 5];
  for (const lech of ca) {
    const erp = lech === null ? null : new Date(tep.getTime() + lech * 1000);
    const [r] = rowsOf<{ ok: boolean }>(
      await db.execute(sql`select ${sql.raw(gapWithinSkewSql("g"))} as ok from (select ${erp ? erp.toISOString() : null}::timestamptz as erp_knew_at, ${tep.toISOString()}::timestamptz as carrier_event_at) g`),
    );
    assert.equal(Boolean(r.ok), erpKnewWithinSkew(erp, tep), `SQL ≡ TS khi ERP lệch ${lech} giây`);
  }

  // Chỗ đọc sổ dùng CÙNG hằng số, phân loại lại lúc đọc; phán quyết từng dòng không dùng.
  const q = readFileSync("lib/queries/vtp-reconcile-queue.ts", "utf8");
  assert.match(q, /from vtp_webhook_gaps g\s+where g\.shipment_id = s\.id[\s\S]{0,400}and not \$\{sql\.raw\(gapWithinSkewSql\("g"\)\)\}/, "WEBHOOK_GAP của hàng đợi đối chiếu bỏ dòng lệch đồng hồ");
  const h = readFileSync("lib/queries/vtp-webhook-health.ts", "utf8");
  assert.match(h, /const known = Number\(do30\?\.ok \?\? 0\) \+ lechDongHo;/, "sức khoẻ webhook: dòng lệch đồng hồ cộng vào «ERP đã biết»");
  assert.match(h, /from vtp_webhook_gaps g\s+where g\.detected_at >= now\(\) - interval '30 days' and not \$\{sql\.raw\(gapWithinSkewSql\("g"\)\)\}/, "đếm hụt 30 ngày bỏ dòng lệch đồng hồ");
  const b = readFileSync("lib/queries/vtp-import-batches.ts", "utf8");
  assert.equal(b.match(/skewReclassifiedOf/g)?.length, 3, "danh sách + chi tiết lượt nhập phân loại lại cùng một biểu thức");
  const v = readFileSync("lib/integrations/viettelpost/import-preview.ts", "utf8");
  assert.doesNotMatch(v, /erpKnewWithinSkew|WEBHOOK_CLOCK_SKEW_SECONDS/, "verdictOf CỐ Ý không dùng dung sai (39 bản vá có ích sẽ thành STATUS_CONFLICT)");
  assert.doesNotMatch(readFileSync("lib/integrations/viettelpost/statement-db.ts", "utf8"), /update\(schema\.vtpWebhookGaps\)|delete\(schema\.vtpWebhookGaps\)/, "không sửa / xoá dòng sổ đã ghi");
  console.log("✓ Lệch đồng hồ tệp ↔ webhook (≤ 120 giây) không phải rơi gói: 1 giây ⇒ đã biết · 121 giây ⇒ hụt · chưa có mốc ⇒ hụt · SQL ≡ TS · đọc lại sổ cũ bằng cùng hằng số, không sửa dòng · verdictOf không dùng dung sai");
}
