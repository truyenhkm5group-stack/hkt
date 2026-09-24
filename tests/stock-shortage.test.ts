import assert from "node:assert/strict";
import { inArray, like, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { suggestedNetOfOpenPo } from "@/lib/constants/inventory-decision";
import {
  EMPTY_DIGEST_LEDGER,
  SHORTAGE_DECISIONS_KEY,
  SHORTAGE_LINKS,
  allocateStock,
  applyShortageDecisions,
  decisionLink,
  isShortageMuted,
  pruneShortageDecisions,
  type ShortageDecision,
  buildShortageLarkCard,
  decideShortageDigest,
  shortageAsPostLines,
  waitLabel,
  waitingOrderDetail,
  type ReservedLine,
  type ShortageVariantInput,
} from "@/lib/constants/stock-shortage";
import { getFulfillmentBottleneckQueue } from "@/lib/queries/fulfillment-bottleneck";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { getStockShortage } from "@/lib/queries/stock-shortage";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ THIẾU HÀNG GIAO ĐƠN ĐÃ CHỐT ═══════════
 *
 * Khoá năm điều:
 *  1. Phân bổ ĐÚNG THỨ TỰ: đơn lên trước được hàng trước; đơn hẹn giao xa xếp cuối; ổn định (chạy
 *     hai lần ra một).
 *  2. Tồn CHƯA BIẾT không bao giờ thành "thiếu" và không bao giờ thành "đủ".
 *  3. Việc cần làm đúng thứ tự chặn: sổ âm / Pancake còn đủ ⇒ kiểm đếm; xưởng đã đủ bù ⇒ giục,
 *     không đặt thêm; còn lại ⇒ đặt SX với số = Kế hoạch SX − hàng đã đặt xưởng (MỘT phép trừ).
 *  4. Lark không bị đổ tin: báo khi mới / nặng thêm, một bảng buổi sáng, một tin "đã đủ".
 *  5. Trên CSDL thật: tổng số cái đơn giữ theo mẫu BẰNG cột "đã chốt" của sổ kho, và hàng đợi
 *     fulfillment không còn bảo kho "đóng gói" một đơn mà kho không có hàng.
 *
 * Mọi mốc thời gian đều TƯƠNG ĐỐI với một `now` truyền vào (AGENTS.md mục 50) — không có quả bom hẹn giờ.
 */

const H = 3_600_000;

function v(id: string, over: Partial<ShortageVariantInput> = {}): ShortageVariantInput {
  return {
    variantId: id,
    productId: "p1",
    productCode: "Q005",
    productName: "Đầm hoa",
    color: "Đen",
    size: "M",
    sku: id,
    onHand: 0,
    stockKnown: true,
    pancakeStock: null,
    planSuggested: 10,
    incoming: 0,
    openPoQty: 0,
    openPoDueAt: null,
    alternatives: [],
    ...over,
  };
}

function line(orderId: string, variantId: string, qty: number, hoursAgo: number, now: Date, promisedInHours: number | null = null): ReservedLine {
  return { orderId, systemId: Number(orderId.replace(/\D/g, "")) || null, variantId, qty, insertedAt: new Date(now.getTime() - hoursAgo * H), promisedAt: promisedInHours === null ? null : new Date(now.getTime() + promisedInHours * H), customer: `Khách ${orderId}`, value: 500_000 };
}

export function testStockShortagePure() {
  const now = new Date("2026-09-24T03:00:00Z"); // 10:00 giờ VN

  // ───────── 1. FIFO + hẹn xa xếp cuối + tồn chưa biết ─────────
  const variants = [v("den-m", { onHand: 2, openPoQty: 1, openPoDueAt: new Date(now.getTime() + 48 * H), alternatives: [{ label: "Q005 Trắng/M", available: 4 }] }), v("trang-m", { color: "Trắng", onHand: 4 }), v("chua-nhap", { color: "Xanh", stockKnown: false })];
  const lines = [
    line("o3", "den-m", 2, 30, now),
    line("o1", "den-m", 1, 50, now),
    line("o5", "den-m", 1, 60, now, 240), // lên sớm nhất NHƯNG hẹn giao 10 ngày nữa ⇒ xếp cuối
    line("o2", "den-m", 1, 40, now),
    line("o4", "chua-nhap", 3, 20, now),
    line("o6", "trang-m", 1, 10, now),
  ];
  const snap = allocateStock(variants, lines, { now, urgentAfterHours: 24 });
  const st = (id: string) => snap.orders.get(id)?.state;
  assert.equal(st("o1"), "READY", "đơn lên trước được hàng trước");
  assert.equal(st("o2"), "READY");
  assert.equal(st("o3"), "WAITING_STOCK", "hết 2 cái cho o1, o2 thì o3 phải chờ");
  assert.equal(st("o5"), "WAITING_STOCK", "đơn hẹn giao xa không được giành hàng của đơn đang phải đi, dù lên đơn sớm nhất");
  assert.equal(st("o4"), "STOCK_UNKNOWN", "mẫu chưa có phiếu nhập: không biết, KHÔNG phải thiếu");
  assert.equal(st("o6"), "READY");

  const den = snap.variants.find((r) => r.variantId === "den-m");
  assert.ok(den, "Đen/M phải nằm trong bảng thiếu");
  assert.equal(den.shortQty, 3, "thiếu = 5 cái đang giữ − 2 cái tồn");
  assert.equal(den.reserved, 5);
  assert.equal(den.waitingOrders, 2);
  assert.ok(Math.abs(den.oldestWaitHours - 60) < 1e-6, "đơn chờ lâu nhất tính từ lúc lên đơn của đơn đang CHỜ (o5, 60 giờ)");
  assert.equal(den.urgent, true);
  assert.equal(den.action, "ORDER_PRODUCTION", "xưởng mới nhận 1 < thiếu 3 ⇒ phải đặt thêm");
  assert.equal(den.proposeQty, suggestedNetOfOpenPo(10, 1), "đề xuất đặt = Kế hoạch SX − đã đặt xưởng, CÙNG hàm với trang Quyết định vốn");
  assert.equal(den.uncoveredQty, 2);
  assert.ok(!snap.variants.some((r) => r.variantId === "chua-nhap"), "tồn chưa biết không bao giờ vào bảng thiếu");
  assert.ok(!snap.variants.some((r) => r.variantId === "trang-m"));
  assert.equal(snap.totals.waitingOrders, 2);
  assert.equal(snap.totals.unknownOrders, 1);
  assert.equal(snap.totals.readyOrders, 3);
  assert.equal(snap.totals.shortUnits, 3);

  // Ổn định: xáo đầu vào, chạy lại, ra cùng kết luận.
  const again = allocateStock([...variants].reverse(), [...lines].reverse(), { now, urgentAfterHours: 24 });
  assert.deepEqual([...again.orders.entries()].map(([k, o]) => [k, o.state]).sort(), [...snap.orders.entries()].map(([k, o]) => [k, o.state]).sort(), "phân bổ phải ổn định khi thứ tự đầu vào đổi");
  assert.deepEqual(again.variants.map((r) => [r.variantId, r.shortQty]), snap.variants.map((r) => [r.variantId, r.shortQty]));

  // Chi tiết cho CSKH phải nói: thiếu gì, xưởng đang làm bao nhiêu, còn màu nào cùng size.
  const detail = waitingOrderDetail(snap.orders.get("o3") as NonNullable<ReturnType<typeof snap.orders.get>>, new Map(snap.variants.map((r) => [r.variantId, r])), now);
  assert.ok(detail.includes("Q005 Đen/M ×2"), detail);
  assert.ok(detail.includes("xưởng đang làm 1 cái"), detail);
  assert.ok(detail.includes("Q005 Trắng/M (4)"), "phải gợi ý mẫu cùng size còn hàng để khách đổi");

  // ───────── 2. Hai dòng cùng mẫu trong một đơn là MỘT lượt nhận ─────────
  const gop = allocateStock([v("a", { onHand: 1 })], [line("x1", "a", 1, 5, now), line("x1", "a", 1, 5, now)], { now, urgentAfterHours: 24 });
  assert.equal(gop.variants[0]?.shortQty, 1);
  assert.equal(gop.variants[0]?.waitingOrders, 1);

  // ───────── 3. Việc cần làm theo đúng thứ tự chặn ─────────
  const act = (over: Partial<ShortageVariantInput>) => allocateStock([v("z", over)], [line("z1", "z", 3, 5, now)], { now, urgentAfterHours: 24 }).variants[0];
  assert.equal(act({ onHand: -2 })?.action, "COUNT_STOCK", "sổ kho âm ⇒ kiểm kê trước, không đặt SX theo con số sai");
  assert.equal(act({ onHand: -2 })?.shortQty, 3, "sổ âm: không phân được cái nào, không được thành 'thiếu 5'");
  assert.equal(act({ onHand: 0, pancakeStock: 7 })?.action, "COUNT_STOCK", "Pancake báo còn đủ ⇒ nhiều khả năng thiếu phiếu nhập, KIỂM ĐẾM chứ không đặt SX");
  assert.equal(act({ onHand: 0, pancakeStock: 1 })?.action, "ORDER_PRODUCTION", "Pancake cũng không đủ ⇒ không có lý do nghi sổ kho");
  const giuc = act({ onHand: 0, openPoQty: 5, openPoDueAt: new Date(now.getTime() - 24 * H) });
  assert.equal(giuc?.action, "CHASE_FACTORY", "xưởng đã nhận đủ bù ⇒ giục, KHÔNG đặt thêm");
  assert.ok(giuc?.actionText.includes("ĐÃ QUÁ hạn"), "lệnh xưởng quá hạn phải nói ra");
  assert.equal(act({ onHand: 0, planSuggested: null })?.proposeQty, null, "mẫu không có trong kế hoạch: đề xuất là CHƯA BIẾT, không phải 0");
  assert.equal(act({ onHand: 0, planSuggested: null })?.team, "PRODUCTION");
  assert.equal(act({ onHand: -1 })?.team, "WAREHOUSE");

  assert.equal(waitLabel(5.9), "5 giờ");
  assert.equal(waitLabel(50), "2 ngày 2 giờ");
  assert.equal(waitLabel(48), "2 ngày");

  // ───────── 4. Lark không đổ tin ─────────
  const at = (vnHour: number, day = "2026-09-24") => new Date(`${day}T${String((vnHour + 24 - 7) % 24).padStart(2, "0")}:05:00Z`);
  const sang = decideShortageDigest(EMPTY_DIGEST_LEDGER, { a: 3 }, at(8));
  assert.equal(sang.send, "MORNING", "lượt đầu từ 8 giờ VN còn thiếu ⇒ bảng tổng hợp buổi sáng");
  assert.equal(sang.ledgerIfSent.morningDay, "2026-09-24");
  const lapLai = decideShortageDigest(sang.ledgerIfSent, { a: 3 }, new Date(at(8).getTime() + 20 * 60_000));
  assert.equal(lapLai.send, null, "không có gì mới ⇒ im lặng");
  const nangThem = decideShortageDigest(sang.ledgerIfSent, { a: 5 }, new Date(at(8).getTime() + 30 * 60_000));
  assert.equal(nangThem.send, null, "nặng thêm nhưng mới 30 phút từ lần gửi trước ⇒ chờ, không đổ tin");
  assert.deepEqual(nangThem.ledgerIfSkipped.lastShort, { a: 3 }, "chưa báo thì sổ KHÔNG được nâng mức — lượt sau vẫn phải thấy nó nặng thêm");
  const nangThemSau = decideShortageDigest(sang.ledgerIfSent, { a: 5, b: 1 }, new Date(at(8).getTime() + 61 * 60_000));
  assert.equal(nangThemSau.send, "WORSE");
  assert.deepEqual(nangThemSau.changed, ["a", "b"]);
  const giam = decideShortageDigest({ ...sang.ledgerIfSent, lastShort: { a: 3 } }, { a: 1 }, at(14));
  assert.equal(giam.send, null, "thiếu giảm ⇒ không nhắn");
  assert.deepEqual(giam.ledgerIfSkipped.lastShort, { a: 1 }, "…nhưng sổ ghi mức thấp hơn để lần tăng lại vẫn được báo");
  const dem = decideShortageDigest(EMPTY_DIGEST_LEDGER, { a: 3 }, at(23));
  assert.equal(dem.send, null, "ngoài giờ làm việc không nhắn — sáng mai bảng tổng hợp gom lại");
  const truocTam = decideShortageDigest({ morningDay: "2026-09-23", lastSentAt: at(15, "2026-09-23").toISOString(), lastShort: { a: 3 } }, { a: 3 }, at(7));
  assert.equal(truocTam.send, null, "7 giờ: chưa tới giờ bảng buổi sáng, và không có gì mới");
  const het = decideShortageDigest({ ...sang.ledgerIfSent }, {}, at(15));
  assert.equal(het.send, "CLEARED", "lần trước còn thiếu, giờ hết ⇒ một tin 'đã đủ hàng'");
  assert.deepEqual(het.ledgerIfSent.lastShort, {});
  assert.equal(decideShortageDigest(het.ledgerIfSent, {}, at(16)).send, null, "đã báo đủ rồi thì thôi");

  // ───────── 5. Thẻ Lark: bảng có màu, size, số thiếu; nút mở tồn kho và đề xuất SX ─────────
  const card = buildShortageLarkCard(snap, { appUrl: "https://erp.example", reason: "WORSE", changed: ["den-m"] });
  const elements = card.elements as { tag: string; columns?: { name: string; display_name: string }[]; rows?: Record<string, unknown>[]; actions?: { url: string }[] }[];
  const table = elements.find((e) => e.tag === "table");
  assert.ok(table, "thẻ phải có BẢNG");
  const cols = (table.columns ?? []).map((c) => c.display_name);
  for (const c of ["Mã", "Màu", "Size", "Thiếu", "Đơn chờ", "Chờ lâu nhất", "Đã đặt xưởng", "Đề xuất đặt", "Việc cần làm"]) assert.ok(cols.includes(c), `thiếu cột ${c}`);
  assert.equal(table.rows?.length, 1);
  assert.equal(table.rows?.[0]?.color, "Đen");
  assert.equal(table.rows?.[0]?.size, "M");
  assert.equal(table.rows?.[0]?.short, 3);
  assert.ok(String(table.rows?.[0]?.code).includes("🆕"), "mẫu mới / nặng thêm phải được đánh dấu");
  const urls = elements.flatMap((e) => e.actions ?? []).map((a) => a.url);
  assert.ok(urls.includes(`https://erp.example${SHORTAGE_LINKS.stock}`), "phải có nút mở báo cáo tồn kho");
  assert.ok(urls.includes(`https://erp.example${SHORTAGE_LINKS.planning}`), "phải có nút mở đề xuất đặt sản xuất");
  assert.equal((card.header as { template: string }).template, "red", "có đơn chờ quá ngưỡng ⇒ thẻ đỏ");
  const cleared = buildShortageLarkCard({ ...snap, variants: [] }, { appUrl: "https://erp.example", reason: "CLEARED" });
  assert.equal((cleared.header as { template: string }).template, "green");
  const post = shortageAsPostLines(snap, { appUrl: "https://erp.example", reason: "MORNING" });
  assert.ok(post.lines.some((l) => l.some((p) => p.text.includes("thiếu 3"))), "bản văn bản dự phòng phải mang cùng dữ liệu");
  // ───────── 6. Ba nút: đã đặt rồi · sẽ đặt thêm · không đặt nữa ─────────
  const qd = (decision: ShortageDecision["decision"], shortQtyAtDecision: number): ShortageDecision => ({ decision, at: now.toISOString(), byUserId: "u1", byName: "Chị Lan", shortQtyAtDecision, note: "" });
  assert.equal(isShortageMuted(qd("ORDERED", 3), 3), true, "đã đặt ⇒ thôi nhắc ở đúng mức thiếu lúc bấm");
  assert.equal(isShortageMuted(qd("ORDERED", 3), 4), false, "có thêm đơn làm thiếu VƯỢT mức lúc bấm ⇒ nhắc lại");
  assert.equal(isShortageMuted(qd("WILL_ORDER", 3), 3), false, "sẽ đặt ⇒ VẪN nhắc tiếp");
  assert.equal(isShortageMuted(qd("STOP", 3), 99), true, "không đặt nữa ⇒ thôi nhắc hẳn, kể cả khi thiếu tăng");
  assert.equal(isShortageMuted(null, 3), false);

  const daDat = applyShortageDecisions(snap, { "den-m": qd("ORDERED", 3) });
  const denDaDat = daDat.variants.find((r) => r.variantId === "den-m");
  assert.equal(denDaDat?.muted, true);
  assert.equal(daDat.totals.mutedVariants, 1);
  assert.equal(daDat.totals.waitingOrders, snap.totals.waitingOrders, "tắt nhắc KHÔNG được giấu đơn đang chờ");
  assert.ok(denDaDat?.actionText.includes("Chị Lan"), "phải nói ai đã xác nhận");
  const ngung = applyShortageDecisions(snap, { "den-m": qd("STOP", 1) });
  const denNgung = ngung.variants.find((r) => r.variantId === "den-m");
  assert.equal(denNgung?.proposeQty, 0, "không đặt nữa ⇒ không đề xuất sản xuất");
  const ngungDetail = waitingOrderDetail(ngung.orders.get("o3") as NonNullable<ReturnType<typeof ngung.orders.get>>, new Map(ngung.variants.map((r) => [r.variantId, r])), now);
  assert.ok(ngungDetail.includes("NGỪNG"), "CSKH phải biết mẫu đã ngừng để đề nghị khách đổi / huỷ");

  // Thẻ Lark: mẫu đã tắt nhắc không vào bảng; mỗi dòng còn lại có ba link xác nhận.
  const theDaDat = buildShortageLarkCard(daDat, { appUrl: "https://erp.example", reason: "MORNING" });
  const bangDaDat = (theDaDat.elements as { tag: string; rows?: unknown[] }[]).find((e) => e.tag === "table");
  assert.equal(bangDaDat?.rows?.length, 0, "mẫu đã xác nhận đặt không được nhắc lại trong bảng");
  const cotXacNhan = String(table.rows?.[0]?.decide);
  for (const d of ["ORDERED", "WILL_ORDER", "STOP"] as const) assert.ok(cotXacNhan.includes(`https://erp.example${decisionLink("den-m", d)}`), `thiếu link ${d}`);
  assert.ok(cols.includes("Xác nhận"), "bảng phải có cột Xác nhận");

  // Dọn sổ: đợt thiếu hết thì "đã đặt"/"sẽ đặt" rơi, "không đặt nữa" giữ.
  const book = { a: qd("ORDERED", 2), b: qd("WILL_ORDER", 1), c: qd("STOP", 1), d: qd("ORDERED", 1) };
  assert.deepEqual(Object.keys(pruneShortageDecisions(book, { d: 1 }) ?? {}).sort(), ["c", "d"]);
  assert.equal(pruneShortageDecisions({ c: qd("STOP", 1) }, {}), null, "không có gì đổi ⇒ không ghi sổ");

  console.log("✓ Thiếu hàng giao đơn (hàm thuần): đơn lên trước được hàng trước · hẹn xa xếp cuối · tồn chưa biết không thành thiếu · sổ âm/Pancake đủ ⇒ kiểm đếm · xưởng đủ bù ⇒ giục · Lark: mới/nặng thêm, bảng buổi sáng, tin đã đủ, không đổ tin");
}

/* ═══════════════════ TRÊN CSDL THẬT ═══════════════════ */

const P = "ssh-";

async function cleanup(db: Db) {
  const ids = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.canonicalOrderOutcome).where(inArray(schema.canonicalOrderOutcome.orderId, ids));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, ids));
    await db.delete(schema.orders).where(inArray(schema.orders.id, ids));
  }
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.code, `${P}%`));
  const receipts = (await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(like(schema.stockReceipts.reference, `${P}%`))).map((r) => r.id);
  if (receipts.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, receipts));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receipts));
  }
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testStockShortageDb(db: Db) {
  await cleanup(db);
  const ago = (h: number) => new Date(Date.now() - h * H);
  await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm kiểm thiếu hàng", customId: "SSH01" });
  await db.insert(schema.productVariants).values([
    { id: `${P}den-m`, productId: `${P}prod`, sku: "SSH-DEN-M", color: "Đen", size: "M", retailPrice: 500_000 },
    { id: `${P}trang-m`, productId: `${P}prod`, sku: "SSH-TRANG-M", color: "Trắng", size: "M", retailPrice: 500_000 },
    { id: `${P}xanh-m`, productId: `${P}prod`, sku: "SSH-XANH-M", color: "Xanh", size: "M", retailPrice: 500_000 },
  ]);
  const [phieu] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: ago(200), reference: `${P}lo-1`, totalQuantity: 7, totalCost: 1_400_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  // Xanh/M CỐ Ý không có phiếu nhập ⇒ tồn CHƯA BIẾT.
  await db.insert(schema.stockReceiptItems).values([
    { receiptId: phieu.id, variantId: `${P}den-m`, quantity: 2, unitCost: 200_000 },
    { receiptId: phieu.id, variantId: `${P}trang-m`, quantity: 5, unitCost: 200_000 },
  ]);
  const order = async (id: string, variantId: string, qty: number, hoursAgo: number, promisedInHours: number | null = null) => {
    await db.insert(schema.orders).values({
      id: `${P}${id}`,
      systemId: 900_000 + Number(id.replace(/\D/g, "")),
      billFullName: `Khách ${id}`,
      billPhone: "0900000000",
      shipAddress: "1 Đường A",
      shipProvince: "Hà Nội",
      totalPriceAfterDiscount: 500_000 * qty,
      stage: "CONFIRMED",
      insertedAt: ago(hoursAgo),
      lastUpdateStatusAt: ago(hoursAgo),
      customerPromisedAt: promisedInHours === null ? null : new Date(Date.now() + promisedInHours * H),
    });
    await db.insert(schema.orderItems).values({ id: `${P}${id}-i`, orderId: `${P}${id}`, variantId, productId: `${P}prod`, productName: "Đầm kiểm thiếu hàng", quantity: qty, unitPrice: 500_000, lineTotal: 500_000 * qty });
  };
  await order("o1", `${P}den-m`, 1, 50);
  await order("o2", `${P}den-m`, 1, 40);
  await order("o3", `${P}den-m`, 2, 30);
  await order("o4", `${P}xanh-m`, 1, 20);
  await order("o5", `${P}den-m`, 1, 60, 240);
  const decisionBookBefore = await getSettingJson<Record<string, ShortageDecision>>(SHORTAGE_DECISIONS_KEY, {});
  await db.insert(schema.productionOrders).values({ code: `${P}sx-1`, productId: `${P}prod`, productCode: "SSH01", productName: "Đầm kiểm thiếu hàng", status: "SENT", colors: ["Đen"], sizes: ["M"], cells: { "Đen|M": 1 }, totalQty: 1, dueDate: new Date(Date.now() + 48 * H) });

  try {
    clearMemo();
    const s = await getStockShortage({ fresh: true, urgentAfterHours: 24 });
    const st = (id: string) => s.orders.get(`${P}${id}`)?.state;
    assert.equal(st("o1"), "READY");
    assert.equal(st("o2"), "READY");
    assert.equal(st("o3"), "WAITING_STOCK");
    assert.equal(st("o5"), "WAITING_STOCK", "đơn hẹn xa xếp cuối trên CSDL thật cũng vậy");
    assert.equal(st("o4"), "STOCK_UNKNOWN");
    const den = s.variants.find((r) => r.variantId === `${P}den-m`);
    assert.ok(den, "Đen/M phải thiếu");
    assert.equal(den.shortQty, 3);
    assert.equal(den.onHand, 2);
    assert.equal(den.openPoQty, 1, "hàng đã đặt xưởng phải được ghép về đúng mẫu mã");
    assert.ok(den.openPoDueAt, "hạn xưởng phải đi theo");
    assert.equal(den.action, "ORDER_PRODUCTION");
    assert.ok(den.alternatives.some((a) => a.label.includes("Trắng/M") && a.available === 5), `phải gợi ý Trắng/M còn 5 cái: ${JSON.stringify(den.alternatives)}`);

    // MỘT VỊ NGỮ: tổng số cái đơn giữ theo mẫu = cột "đã chốt" của sổ kho / Kế hoạch SX.
    const plan = await getReplenishmentPlan();
    const planDen = plan.rows.find((r) => r.variantId === `${P}den-m`);
    assert.equal(den.reserved, planDen?.committed, "số cái đơn giữ phải BẰNG cột 'đã chốt' của sổ kho — hai vị ngữ là hai con số");
    assert.equal(den.proposeQty, suggestedNetOfOpenPo(planDen?.suggested ?? 0, 1));

    // Hàng đợi fulfillment: kho KHÔNG được giao việc đóng gói đơn không có hàng.
    const q = await getFulfillmentBottleneckQueue();
    assert.ok(q.ok && q.stockCheckOk, "đọc được sổ kho thì phải tách được 'chờ hàng'");
    const c = (id: string) => q.cases.find((x) => x.orderId === `${P}${id}`);
    assert.equal(c("o3")?.reason, "OUT_OF_STOCK", "đơn không được phân hàng phải là 'kho không đủ hàng', không phải 'chưa có vận đơn'");
    assert.equal(c("o3")?.team, "CS", "đơn chờ hàng là việc CSKH báo khách — đặt xưởng đi theo mẫu mã, không nhân theo đơn");
    assert.ok(c("o3")?.reasonDetail.includes("Trắng/M"), c("o3")?.reasonDetail);
    assert.equal(c("o1")?.reason, "NOT_YET_SHIPPED", "đơn đã được phân hàng thì kho đóng gói như thường");
    assert.equal(c("o4")?.reason, "NOT_YET_SHIPPED", "tồn chưa biết KHÔNG được kết luận là thiếu");
    assert.ok(!c("o5"), "đơn hẹn xa vẫn nằm ngoài hàng đợi như trước");

    // Quyết định trong sổ settings phải tới được bảng thiếu — và KHÔNG đổi phân bổ.
    await setSettingJson(SHORTAGE_DECISIONS_KEY, { ...decisionBookBefore, [`${P}den-m`]: { decision: "ORDERED", at: new Date().toISOString(), byUserId: "u1", byName: "Kiểm thử", shortQtyAtDecision: 3, note: "" } });
    clearMemo();
    const sauXacNhan = await getStockShortage({ fresh: true, urgentAfterHours: 24 });
    const denSau = sauXacNhan.variants.find((r) => r.variantId === `${P}den-m`);
    assert.equal(denSau?.muted, true, "đã đặt ở đúng mức thiếu ⇒ thôi nhắc");
    assert.equal(denSau?.shortQty, 3, "xác nhận không được đổi số thiếu");
    assert.equal(sauXacNhan.orders.get(`${P}o3`)?.state, "WAITING_STOCK", "đơn vẫn chờ hàng — tắt nhắc không phải có hàng");
  } finally {
    await setSettingJson(SHORTAGE_DECISIONS_KEY, decisionBookBefore);
    await cleanup(db);
    clearMemo();
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.orders).where(like(schema.orders.id, `${P}%`));
  assert.equal(Number(n), 0, "bài kiểm phải tự dọn sạch");
  console.log("✓ Thiếu hàng giao đơn (CSDL): số cái đơn giữ = cột đã chốt của sổ kho · lệnh xưởng ghép đúng mẫu + hạn · fulfillment tách 'kho không đủ hàng' (CSKH) khỏi 'chưa có vận đơn' (kho) · tồn chưa biết không bị kết luận thiếu");
}
