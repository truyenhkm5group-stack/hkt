import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { costRowsToLines, estimateBlocker, type CostRow } from "@/app/(dashboard)/production/_components/cost-rows";
import { guardSecondApprovalCore, type ApprovalUser } from "@/lib/approvals/service";
import { APPROVAL_ENFORCE_KEY } from "@/lib/constants/approval";
import { computeCostSheet } from "@/lib/constants/production-os";
import { poApprovalPrice, poApprovalSummary, resolvePoApprovalPrice } from "@/lib/production/po-approval-price";
import { productionOrderInputSchema } from "@/lib/validation/production-order";

/**
 * ───────────── LỆNH ĐẶT XƯỞNG CHƯA CÓ GIÁ KHÔNG ĐƯỢC LỌT QUA CỔNG DUYỆT VỚI 0 ₫ ─────────────
 *
 * Bản cũ: `unitCost: z.number().int().min(0).default(0)` ⇒ ô giá trống lưu 0, cổng `PURCHASING_LARGE`
 * nhận `amount = số món × 0 = 0` < ngưỡng ⇒ lệnh chưa ai biết tốn bao nhiêu đi thẳng, không cần người
 * thứ hai. Và bảng giá thành đổi ô trống thành 0 ₫ rồi cho "Dùng làm giá ước tính".
 */

const P = "pua-";
const PROD_NONE = `${P}p-none`; // không giá, không giá dự tính
const PROD_EST = `${P}p-est`; // có giá báo MKT = giá dự tính
const XIN = `${P}xin`;
const DUYET = `${P}duyet`;

const base = { productId: PROD_NONE, productName: "Đầm kiểm giá trống", colors: ["Đen"], sizes: ["M"], cells: { "Đen|M": 100 } };

function testSchema() {
  const trong = productionOrderInputSchema.parse(base);
  assert.equal(trong.unitCost, null, "ô giá trống ⇒ null (CHƯA BIẾT), không phải 0");
  assert.equal(productionOrderInputSchema.parse({ ...base, unitCost: null }).unitCost, null);
  assert.equal(productionOrderInputSchema.parse({ ...base, unitCost: 150_000 }).unitCost, 150_000, "giá đã nhập giữ nguyên");
  const khong = productionOrderInputSchema.safeParse({ ...base, unitCost: 0 });
  assert.equal(khong.success, false, "gõ 0 bị từ chối — cột này mọi nơi đọc coi 0 là chưa nhập");
}

function testPure() {
  assert.deepEqual(resolvePoApprovalPrice({ qty: 100, unitCost: 150_000, estimate: { unitCost: 90_000, source: "MARKETER_PRICE" } }), { basis: "KNOWN", unitPrice: 150_000, amount: 15_000_000, estimateSource: null }, "giá đã nhập thắng giá dự tính");
  assert.deepEqual(resolvePoApprovalPrice({ qty: 100, unitCost: null, estimate: { unitCost: 90_000, source: "MARKETER_PRICE" } }), { basis: "ESTIMATED", unitPrice: 90_000, amount: 9_000_000, estimateSource: "MARKETER_PRICE" }, "chưa có giá ⇒ số món × giá dự tính");
  const ep = resolvePoApprovalPrice({ qty: 100, unitCost: null, estimate: null });
  assert.deepEqual(ep, { basis: "UNPRICED_FORCED", unitPrice: null, amount: null, estimateSource: null }, "không giá nào ⇒ số tiền CHƯA BIẾT, không bao giờ 0");
  assert.equal(resolvePoApprovalPrice({ qty: 100, unitCost: 0, estimate: { unitCost: 0, source: "MANUAL" } }).basis, "UNPRICED_FORCED", "0 ở cả hai nguồn là chưa có giá");
  assert.match(poApprovalSummary({ productName: "Đầm", qty: 100, supplier: "", price: ep }), /chưa có giá — bắt duyệt/);

  // Bảng giá thành: ô trống KHÔNG thành 0.
  const dong = (unitCost: string, unit = "m"): CostRow => ({ kind: "FABRIC", description: "Vải", qty: "2", unit, unitCost });
  const trong = costRowsToLines([dong("50000"), dong("")]);
  assert.ok("error" in trong, "còn dòng chưa có đơn giá ⇒ không ra dòng nào để lưu");
  assert.deepEqual(trong.blankRows, [2]);
  assert.equal(trong.draft[1].unitCost, null, "ô trống là null, không phải 0");
  const go0 = costRowsToLines([dong("0")]);
  assert.ok(!("error" in go0) && go0.lines[0].unitCost === 0, "gõ 0 là lời khẳng định của người — giữ 0");
  const phanTram = costRowsToLines([dong("50000"), { kind: "WASTAGE", description: "Hao hụt", qty: "5", unit: "%", unitCost: "" }]);
  assert.ok(!("error" in phanTram), "dòng % không có đơn giá — ô trống là đúng");
  const tinh = computeCostSheet(phanTram.lines);
  assert.ok(!("error" in tinh) && tinh.total === 105_000);
  // "Dùng làm giá ước tính": dòng tiền 0 ₫ (không phân biệt được với ô trống của bản cũ) ⇒ chặn.
  assert.match(estimateBlocker({ totalUnitCost: 100_000, lines: [{ unit: "m", qty: 2, unitCost: 50_000 }, { unit: "m", qty: 1, unitCost: 0 }] }) ?? "", /Dòng 2 đơn giá 0 ₫/);
  assert.equal(estimateBlocker({ totalUnitCost: 105_000, lines: [{ unit: "m", qty: 2, unitCost: 50_000 }, { unit: "%", qty: 5, unitCost: 0 }] }), null);
  assert.ok(estimateBlocker({ totalUnitCost: 0, lines: [] }), "tổng 0 không dùng làm giá ước tính");
}

export async function testProductionUnpricedApproval(db: Db) {
  testSchema();
  testPure();

  await db.insert(schema.users).values([
    { id: XIN, email: "pua-xin@test.local", name: "Người lập lệnh", passwordHash: "x", role: "LEADER" },
    { id: DUYET, email: "pua-duyet@test.local", name: "Người duyệt", passwordHash: "x", role: "MANAGER" },
  ]).onConflictDoNothing();
  await db.insert(schema.products).values([
    { id: PROD_NONE, name: "Đầm kiểm giá trống", customId: "PUA-NONE" },
    { id: PROD_EST, name: "Đầm kiểm giá dự tính", customId: "PUA-EST" },
  ]).onConflictDoNothing();
  await db.insert(schema.marketerPrices).values({ productId: PROD_EST, productCode: "PUA-EST", price: 90_000, effectiveFrom: new Date("2026-09-01T00:00:00+07:00"), reason: "kiểm", setBy: "test" });
  const [cauHinhCu] = await db.select().from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  const batCuongChe = JSON.stringify({ v: 2, groups: { PURCHASING_LARGE: true } });
  await db.insert(schema.settings).values({ key: APPROVAL_ENFORCE_KEY, value: batCuongChe }).onConflictDoUpdate({ target: schema.settings.key, set: { value: batCuongChe } });
  const xin: ApprovalUser = { id: XIN, email: "pua-xin@test.local" };
  // Đúng hình dạng lời gọi cổng của `saveProductionOrder` (action không chạy được ngoài phiên đăng nhập).
  const cong = async (productId: string, qty: number, unitCost: number | null) => {
    const gia = await poApprovalPrice({ productId, qty, unitCost });
    const kq = await guardSecondApprovalCore(db, xin, { group: "PURCHASING_LARGE", action: "production.save", entity: "PRODUCTION_ORDER", entityId: "", summary: poApprovalSummary({ productName: productId, qty, supplier: "", price: gia }), amount: gia.amount, payload: { productId, qty, unitCost, priceBasis: gia.basis } });
    return { gia, kq };
  };
  try {
    // 1. Chưa có giá, không có giá dự tính ⇒ BẮT DUYỆT, dù chỉ 10 món.
    const a = await cong(PROD_NONE, 10, productionOrderInputSchema.parse(base).unitCost);
    assert.equal(a.gia.basis, "UNPRICED_FORCED");
    assert.equal(a.gia.amount, null, "số tiền đưa vào cổng là CHƯA BIẾT, không phải 0");
    assert.equal(a.kq.mode, "NEEDS_APPROVAL", "lệnh chưa có giá phải xin người thứ hai duyệt — không bao giờ đi qua với 0 ₫");
    const [yc] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, a.kq.requestId ?? ""));
    assert.ok(yc && yc.amount === null && /chưa có giá — bắt duyệt/.test(yc.summary), "yêu cầu duyệt ghi số tiền CHƯA BIẾT và nói lý do");

    // 2. Có giá dự tính (giá báo MKT) ⇒ số tiền = số món × giá dự tính; dưới ngưỡng thì đi qua như mọi lệnh nhỏ.
    const b = await cong(PROD_EST, 100, null);
    assert.equal(b.gia.basis, "ESTIMATED");
    assert.equal(b.gia.estimateSource, "MARKETER_PRICE");
    assert.equal(b.gia.amount, 100 * 90_000);
    assert.equal(b.kq.mode, "PROCEED", "9 triệu theo giá dự tính < ngưỡng 20 triệu");
    const c = await cong(PROD_EST, 300, null);
    assert.equal(c.gia.amount, 300 * 90_000);
    assert.equal(c.kq.mode, "NEEDS_APPROVAL", "27 triệu theo giá dự tính ⇒ vượt ngưỡng ⇒ duyệt");

    // 3. Giá đã nhập ⇒ hành vi cũ nguyên vẹn (giá thật thắng giá dự tính).
    const d = await cong(PROD_EST, 100, 150_000);
    assert.deepEqual({ basis: d.gia.basis, amount: d.gia.amount }, { basis: "KNOWN", amount: 15_000_000 });
    assert.equal(d.kq.mode, "PROCEED");
    const e = await cong(PROD_NONE, 200, 150_000);
    assert.equal(e.gia.amount, 30_000_000);
    assert.equal(e.kq.mode, "NEEDS_APPROVAL");
  } finally {
    if (cauHinhCu) await db.update(schema.settings).set({ value: cauHinhCu.value }).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
    await db.delete(schema.approvalRequests).where(inArray(schema.approvalRequests.requestedBy, [XIN]));
    await db.delete(schema.marketerPrices).where(like(schema.marketerPrices.productId, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  }
  console.log("✓ Lệnh đặt xưởng chưa có giá: lưu NULL (không 0) · cổng duyệt dùng giá đã nhập → giá dự tính (giá báo MKT) → CHƯA BIẾT ⇒ bắt duyệt · bảng giá thành ô trống không thành 0 ₫, không dùng làm giá ước tính");
}
