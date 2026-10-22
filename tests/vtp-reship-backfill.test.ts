/**
 * ops `vtp-reship-backfill` (P0 22/10/2026) — bản CHỈ ĐO: tham số, kỳ đo khớp URL của /reports/returns, --apply chưa mở,
 * kênh tóm tắt không in mã đơn / mã vận đơn, và script không có câu ghi nào.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measureWindows, parseBackfillArgs, RESHIP_FROM_DAY, vnToday } from "../scripts/vtp-reship-backfill";

export function testVtpReshipBackfill() {
  assert.deepEqual(parseBackfillArgs([]), { ok: true, apply: false });
  assert.deepEqual(parseBackfillArgs(["--measure"]), { ok: true, apply: false });
  assert.deepEqual(parseBackfillArgs(["--apply"]), { ok: true, apply: true }, "--apply đọc được — main() từ chối nó");
  assert.equal(parseBackfillArgs(["--all"]).ok, false, "cờ lạ ⇒ lỗi, không đoán");
  const now = new Date("2026-10-22T18:00:00Z");
  assert.equal(vnToday(now), "2026-10-23", "ngày giờ Việt Nam");
  assert.deepEqual(measureWindows(now).map((w) => w.raw), [{ period: "7d" }, { period: "custom", from: RESHIP_FROM_DAY, to: "2026-10-23" }], "đúng tham số URL người dùng mở");
  const src = readFileSync("scripts/vtp-reship-backfill.ts", "utf8");
  assert.ok(src.includes('process.env.ERP_READ_ONLY = "1"') && src.includes("show transaction_read_only"), "chỉ đọc do Postgres ép + hỏi lại phiên");
  assert.ok(src.includes("--apply CHƯA MỞ"), "--apply bị từ chối tới khi có hàm ghép của vtp-reship-relink");
  for (const cam of [".insert(", ".update(", ".delete(", "insert into", "update shipments", "update orders"]) assert.ok(!src.toLowerCase().includes(cam.toLowerCase()), `không câu ghi: ${cam}`);
  assert.ok(src.includes("loadReturnsPage(") && src.includes("returnsPageParams("), "GTC qua đúng hàm của /reports/returns");
  assert.ok(src.includes("SHIPMENT_LEFT_WAREHOUSE"), "rời kho theo đúng vị ngữ của sổ kho");
  const tom = [...src.matchAll(/tomTat\(`([^`]*)`\)/g)].map((m) => m[1]);
  assert.ok(tom.length >= 4 && tom.every((t) => !/\$\{[^}]*\b(id|orderId|origId|newId|vtp_order_number|order_reference)\b/.test(t)), "kênh tóm tắt chỉ có số đếm");
  console.log("  ✓ vtp-reship-backfill (chỉ đo): kỳ 7 ngày + từ 15/10 qua hàm của /reports/returns · rời kho theo SHIPMENT_LEFT_WAREHOUSE · chỉ đọc do Postgres ép · --apply chưa mở · tóm tắt chỉ số đếm");
}
