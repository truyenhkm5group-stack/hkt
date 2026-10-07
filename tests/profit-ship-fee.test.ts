import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  DEFAULT_PROFIT_ASSUMPTIONS,
  FALLBACK_SHIP_FEE_DELIVERED,
  manualShipFee,
  PROFIT_ASSUMPTIONS_KEY,
  resolveShipFees,
} from "@/lib/constants/profit";
import { resolveAssumptions } from "@/lib/queries/profit-nominal";
import { setSettingJson } from "@/lib/settings";

/**
 * Ô cước của khung Giả định: gõ 0 phải là 0 ₫ (HSLC báo 06/10/2026 — gõ 0 mà màn hình vẫn in
 * 17.000 ₫ / 34.000 ₫ "mặc định"), để trống mới là tự tính, và dòng lưu trước bản này giữ nguyên
 * nghĩa cũ (0 = tự tính).
 */
export async function testProfitShipFee() {
  // ── Hàm thuần ──
  assert.equal(manualShipFee({ shipFeeDelivered: 0, shipFeeReturned: 0, shipFeeExplicitZero: true }, "shipFeeDelivered"), 0, "bản mới: 0 là 0 ₫ đặt tay");
  assert.equal(manualShipFee({ shipFeeDelivered: 0, shipFeeReturned: 0 }, "shipFeeDelivered"), null, "dòng cũ không có cờ: 0 vẫn là tự tính");
  assert.equal(manualShipFee({ shipFeeDelivered: null, shipFeeReturned: null, shipFeeExplicitZero: true }, "shipFeeReturned"), null, "ô trống = tự tính");
  assert.equal(manualShipFee({ shipFeeDelivered: 22_400.4, shipFeeReturned: null }, "shipFeeDelivered"), 22_400, "số khác 0 luôn là đặt tay, làm tròn VND");
  assert.equal(DEFAULT_PROFIT_ASSUMPTIONS.shipFeeExplicitZero, undefined, "cờ KHÔNG được nằm trong mặc định — getSettingJson trộn mặc định vào dòng cũ");

  assert.deepEqual(resolveShipFees({ delivered: 0, returned: 0 }, { delivered: 25_000, returnFee: 0 }), { delivered: 0, returned: 0, source: "setting" }, "đặt tay 0/0 thắng dữ liệu");
  assert.deepEqual(resolveShipFees({ delivered: 0, returned: null }, { delivered: 25_000, returnFee: 0 }), { delivered: 0, returned: 0, source: "fallback" }, "cước gửi 0 ⇒ đơn hoàn tự tính = 0 + 0");
  assert.deepEqual(resolveShipFees({ delivered: null, returned: null }, { delivered: 0, returnFee: 0 }), { delivered: FALLBACK_SHIP_FEE_DELIVERED, returned: 2 * FALLBACK_SHIP_FEE_DELIVERED, source: "fallback" });
  assert.deepEqual(resolveShipFees({ delivered: null, returned: 50_000 }, { delivered: 21_000, returnFee: 9_000 }), { delivered: 21_000, returned: 50_000, source: "data" });
  assert.deepEqual(resolveShipFees({ delivered: 20_000, returned: null }, { delivered: 21_000, returnFee: 9_000 }), { delivered: 20_000, returned: 29_000, source: "data" });

  // ── Qua đường đọc thật, trên CSDL thử ──
  const db = await getDb();
  const truoc = await db.query.settings.findFirst({ where: eq(schema.settings.key, PROFIT_ASSUMPTIONS_KEY) });
  try {
    await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...DEFAULT_PROFIT_ASSUMPTIONS, shipFeeDelivered: 0, shipFeeReturned: 0, shipFeeExplicitZero: true });
    clearMemo();
    const moi = await resolveAssumptions();
    assert.equal(moi.shipFeeDeliveredUsed, 0, "gõ 0 ở cước gửi ⇒ phép tính dùng 0 ₫");
    assert.equal(moi.shipFeeReturnedUsed, 0, "gõ 0 ở cước hoàn ⇒ phép tính dùng 0 ₫");
    assert.equal(moi.shipFeeSource, "setting");

    await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...DEFAULT_PROFIT_ASSUMPTIONS, shipFeeDelivered: 0, shipFeeReturned: 0 });
    clearMemo();
    const cu = await resolveAssumptions();
    assert.ok(cu.shipFeeDeliveredUsed > 0, "dòng cũ (không cờ) 0 = tự tính: không được đổi nghĩa thành 0 ₫");
    assert.ok(cu.shipFeeReturnedUsed >= cu.shipFeeDeliveredUsed);
  } finally {
    if (truoc) await db.update(schema.settings).set({ value: truoc.value }).where(eq(schema.settings.key, PROFIT_ASSUMPTIONS_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, PROFIT_ASSUMPTIONS_KEY));
    clearMemo();
  }

  // ── Mã nguồn: lưu giả định phải xoá đệm báo cáo, nếu không trang dựng lại đúng số cũ ──
  const action = readFileSync(path.join(process.cwd(), "lib/actions/report-settings.ts"), "utf8");
  assert.ok(/clearMemo\(\);\s*revalidatePath\("\/reports"\)/.test(action), "saveProfitAssumptions phải clearMemo() trước revalidatePath — báo cáo nhớ đệm 120 giây theo kỳ, không theo giả định");
  assert.ok(action.includes("shipFeeExplicitZero: true"), "lưu từ biểu mẫu mới phải bật cờ 0 là 0 thật");
  const form = readFileSync(path.join(process.cwd(), "app/(dashboard)/reports/assumptions-form.tsx"), "utf8");
  assert.ok(!/shipFeeDelivered \|\| ""/.test(form), "biểu mẫu không được đổi 0 thành ô trống");
  assert.ok(!/num\(form\.\w+, \d/.test(form), "ô trống không được lặng lẽ thay bằng số mặc định");
}
