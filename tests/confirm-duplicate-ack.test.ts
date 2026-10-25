/**
 * ═══ XÁC NHẬN TAY ĐƠN CÓ THỂ TRÙNG — HAI BƯỚC (P0 HSLC 25/10/2026: #E0663E84 mang cờ «có thể cùng khách» vẫn bị xác nhận tay) ═══
 *
 * Tổ chức thật `dup-ack` (tự cấp, tự dọn), đơn đi ĐÚNG form hộp thư (`createOrderFromChatCore`, trạng thái «Mới»):
 *  1. nút nhanh «Xác nhận đơn» trên đơn nghi trùng (cùng SĐT + cùng món) ⇒ lượt 1 CONFLICT `duplicateAck:dup:<đơn kia>`, đơn giữ «Mới»;
 *     lượt 2 gửi đúng khoá ⇒ «Đã xác nhận» + một dòng nhật ký ORDER_CONFIRM_DUPLICATE_ACK;
 *  2. form sửa đơn đổi sang «Đã xác nhận» ⇒ cùng rào hai bước;
 *  3. cờ POSSIBLE_SAME_CUSTOMER đang mở ⇒ khoá `flag:<mốc>`;
 *  4. đơn không có tín hiệu trùng ⇒ xác nhận một bước như cũ, không nhật ký;
 *  5. khoá CŨ không thay được khoá MỚI (tín hiệu mới chưa thấy ⇒ từ chối lại);
 *  6. hai đường UI dùng chung hộp cảnh báo và gửi lại khoá.
 * Phần thuần: đọc cảnh báo từ lỗi máy chủ. Mốc theo ĐỒNG HỒ THẬT (AGENTS.md mục 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { DUPLICATE_ACK_FIELD, duplicateAckWarnings } from "@/lib/constants/order-duplicate";
import { reviewSeenOf, withReviewEntry, orderReviewOf } from "@/lib/constants/order-review";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createOrderFromChatCore } from "@/lib/records/chat-order";
import { confirmOrderReviewCore, manualOrderFormValues, updateManualOrderCore } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { conversationFor } from "@/lib/sales-chatbot/fanpage";

const ORG = "dup-ack";
const ADMIN_EMAIL = "chu@dup-ack.local";
const PAGE = "5550004445";

function testPure() {
  const w = duplicateAckWarnings([
    { field: `${DUPLICATE_ACK_FIELD}:dup:erp-abc`, message: "Nghi trùng với đơn #ABC" },
    { field: `${DUPLICATE_ACK_FIELD}:flag:2026-10-25T01:00:00.000Z`, message: "SĐT trùng đơn bot đang mở" },
    { field: "customerId", message: "Chọn khách" },
  ]);
  assert.deepEqual(w, [
    { key: "dup:erp-abc", otherId: "erp-abc", label: "Nghi trùng với đơn #ABC" },
    { key: "flag:2026-10-25T01:00:00.000Z", otherId: null, label: "SĐT trùng đơn bot đang mở" },
  ]);
  assert.deepEqual(duplicateAckWarnings(undefined), []);
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
  assert.ok(u);
  const org = await findOrganization(ORG);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: org?.name ?? ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const o = schema.orders;
    const admin = await adminOf();
    const p = await createProductCore(admin, { name: "Chả cá thu", code: "CA-THU", unit: "kg", retailPrice: 280_000, cost: null, variants: [{ sku: "CA-THU", size: "", color: "", retailPrice: 280_000, cost: null, selling: true }] });
    assert.ok(p.ok, JSON.stringify(p));
    const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
    assert.ok(v);
    const p2 = await createProductCore(admin, { name: "Nước mắm", code: "NM", unit: "chai", retailPrice: 150_000, cost: null, variants: [{ sku: "NM", size: "", color: "", retailPrice: 150_000, cost: null, selling: true }] });
    assert.ok(p2.ok, JSON.stringify(p2));
    const v2 = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p2.id) });
    assert.ok(v2);
    let req = 0;
    const order = async (thread: string, phone: string, variantId: string) => {
      const conv = await conversationFor(PAGE, `${PAGE}_${thread}`);
      assert.ok(conv);
      req += 1;
      const r = await createOrderFromChatCore(admin, conv.id, { requestKey: `dupack-req-${req}`, name: "Chị Nga", phone, address: "Số 7 ngõ Thử Nghiệm", province: "Hà Nội", ward: "Phường Hoàn Kiếm", stage: "NEW", lines: [{ variantId, quantity: 1, unitPrice: variantId === v.id ? 280_000 : 150_000 }] });
      assert.ok(r.ok, JSON.stringify(r));
      return r.orderId;
    };
    const stageOf = async (id: string) => (await db.select({ s: o.stage }).from(o).where(eq(o.id, id)).limit(1))[0]?.s;
    const acks = async (id: string) => (await db.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORDER_CONFIRM_DUPLICATE_ACK"), eq(schema.auditLogs.entityId, id)))).length;
    const fields = (r: unknown) => (r && typeof r === "object" && "errors" in r ? ((r as { errors: { field: string }[] }).errors ?? []).map((e) => e.field) : []);

    // ── 1 · Nút nhanh trên đơn nghi trùng: lượt 1 CONFLICT, lượt 2 với đúng khoá ⇒ xác nhận + nhật ký ──
    const a = await order("a", "0919000808", v.id);
    const b = await order("b", "0919000808", v.id);
    const r1 = await confirmOrderReviewCore(admin, b, { count: 0, latestAt: null });
    assert.ok(!r1.ok && r1.code === "CONFLICT" && fields(r1).includes(`${DUPLICATE_ACK_FIELD}:dup:${a}`), `lượt 1 ⇒ cảnh báo trùng: ${JSON.stringify(r1)}`);
    assert.equal(await stageOf(b), "NEW", "lượt 1 không ghi gì");
    const r2 = await confirmOrderReviewCore(admin, b, { count: 0, latestAt: null, duplicates: [`dup:${a}`] });
    assert.ok(r2.ok, `lượt 2 với đúng khoá ⇒ xác nhận: ${JSON.stringify(r2)}`);
    assert.equal(await stageOf(b), "CONFIRMED");
    assert.equal(await acks(b), 1, "một dòng nhật ký người đã thấy cảnh báo");

    // ── 5 · Khoá cũ không thay được khoá mới: đơn thứ ba cùng món ⇒ cảnh báo có cả cặp mới ──
    const c = await order("c", "0919000808", v.id);
    const r3 = await confirmOrderReviewCore(admin, a, { count: 0, latestAt: null, duplicates: [`dup:${b}`] });
    assert.ok(!r3.ok && fields(r3).includes(`${DUPLICATE_ACK_FIELD}:dup:${c}`) && !fields(r3).includes(`${DUPLICATE_ACK_FIELD}:dup:${b}`), `chỉ nêu tín hiệu CHƯA thấy: ${JSON.stringify(r3)}`);

    // ── 2 · Form sửa đơn đổi «Mới» ⇒ «Đã xác nhận»: cùng rào hai bước ──
    const values = await manualOrderFormValues(c);
    assert.ok(values);
    const e1 = await updateManualOrderCore(admin, c, { ...values, stage: "CONFIRMED" });
    assert.ok(!e1.ok && e1.code === "CONFLICT" && fields(e1).some((f) => f.startsWith(`${DUPLICATE_ACK_FIELD}:dup:`)), `form lượt 1 ⇒ cảnh báo: ${JSON.stringify(e1)}`);
    assert.equal(await stageOf(c), "NEW");
    const keys = fields(e1).filter((f) => f.startsWith(`${DUPLICATE_ACK_FIELD}:`)).map((f) => f.slice(DUPLICATE_ACK_FIELD.length + 1));
    const e2 = await updateManualOrderCore(admin, c, { ...values, stage: "CONFIRMED" }, { duplicateAck: keys });
    assert.ok(e2.ok, JSON.stringify(e2));
    assert.equal(await stageOf(c), "CONFIRMED");
    assert.equal(await acks(c), 1);
    // Sửa đơn KHÔNG đổi sang «Đã xác nhận» ⇒ không rào (chỉ lượt xác nhận mới cần nhìn).
    const d = await order("d", "0919000808", v.id);
    const dv = await manualOrderFormValues(d);
    assert.ok(dv);
    const e3 = await updateManualOrderCore(admin, d, { ...dv, stage: "NEW", note: "khách hẹn chiều" });
    assert.ok(e3.ok, `sửa giữ «Mới» ⇒ không hỏi: ${JSON.stringify(e3)}`);

    // ── 3 · Cờ POSSIBLE_SAME_CUSTOMER đang mở ⇒ khoá flag:<mốc> (đơn khác SĐT, khác món — không cặp nghi trùng) ──
    const f = await order("f", "0909111222", v2.id);
    const [fr] = await db.select({ raw: o.raw }).from(o).where(eq(o.id, f));
    const flagged = withReviewEntry(fr!.raw as Record<string, unknown>, { code: "POSSIBLE_SAME_CUSTOMER", note: "SĐT khách gõ trùng đơn bot đang mở #ABCD1234 ở hội thoại khác", quote: null, at: new Date().toISOString(), by: "Bot" });
    await db.update(o).set({ raw: flagged.raw }).where(eq(o.id, f));
    const entries = orderReviewOf(flagged.raw)?.entries ?? [];
    const seen = reviewSeenOf(entries);
    const g1 = await confirmOrderReviewCore(admin, f, seen);
    const flagKey = `flag:${entries[0].at}`;
    assert.ok(!g1.ok && fields(g1).includes(`${DUPLICATE_ACK_FIELD}:${flagKey}`), `cờ «có thể cùng khách» ⇒ cảnh báo: ${JSON.stringify(g1)}`);
    const g2 = await confirmOrderReviewCore(admin, f, { ...seen, duplicates: [flagKey] });
    assert.ok(g2.ok, JSON.stringify(g2));
    assert.equal(await stageOf(f), "CONFIRMED");

    // ── 4 · Không tín hiệu trùng ⇒ một bước như cũ, không nhật ký ──
    const h = await order("h", "0909333444", v.id);
    const k1 = await confirmOrderReviewCore(admin, h, { count: 0, latestAt: null });
    assert.ok(k1.ok, JSON.stringify(k1));
    assert.equal(await acks(h), 0);
  });
}

function testUiFences() {
  const quick = readFileSync("components/orders/order-review-quick.tsx", "utf8");
  const form = readFileSync("app/(dashboard)/orders/manual-order-form.tsx", "utf8");
  for (const [name, src] of [["nút nhanh", quick], ["form sửa đơn", form]] as const) {
    assert.ok(src.includes("<DuplicateAckBox") && src.includes("duplicateAckWarnings("), `${name}: hiện hộp cảnh báo từ lỗi máy chủ`);
    assert.ok(/dupWarnings\.map\(\(w\) => w\.key\)/.test(src), `${name}: lượt hai gửi lại ĐÚNG các khoá đã thấy`);
  }
  assert.ok(quick.includes("duplicates: [...ack]"), "nút nhanh gửi khoá trong dấu vết đã xem");
  assert.ok(form.includes("updateManualOrderAction(orderId ?? \"\", payload(), ack"), "form gửi khoá qua action sửa đơn");
}

export async function testConfirmDuplicateAck() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop xác nhận trùng", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "XacNhanTrung@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
  testUiFences();
  console.log("  ✓ xác nhận tay đơn có thể trùng: nút nhanh + form sửa đơn hai bước (lượt 1 cảnh báo, không ghi · lượt 2 đúng khoá ⇒ xác nhận + nhật ký) · khoá cũ không thay khoá mới · cờ «có thể cùng khách» · đơn không trùng một bước · sửa giữ «Mới» không hỏi");
}
