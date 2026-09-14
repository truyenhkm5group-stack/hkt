import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  buildDedupeKey,
  DUPLICATE_WINDOW_HOURS,
  normalizeAttrPhone,
  normalizeAttrText,
  pickAssignment,
  resolveDuplicateChains,
  windowsOverlap,
  type AssignmentWindow,
} from "@/lib/constants/fanpage-attribution";
import { assignFanpageMarketer, rebuildFanpageAttribution, revokeFanpageAssignment, syncFanpageRegistry } from "@/lib/attribution/fanpage";
import { getMarketerAttributionReport, listAttributionOrders } from "@/lib/queries/fanpage-attribution";

/**
 * ═══════════ QUY KẾT FANPAGE → MARKETER: BẢY TÌNH HUỐNG CHỦ SHOP ĐẶT RA ═══════════
 *
 * Bài này khoá đúng những chỗ mà nếu hỏng thì báo cáo VẪN HIỆN SỐ — chỉ là số đó nói về nhầm người,
 * hoặc nói về một đơn không có thật. Đó là kiểu hỏng tệ nhất vì không có lỗi, không có ô trống, chỉ
 * có một kết luận sai dùng để trả lương cho ai đó.
 *
 * Dữ liệu nằm gọn trong tháng 3/2024 — một quãng KHÔNG tệp fixture nào khác đụng tới — và mọi khoá
 * mang tiền tố `fpa-`, nên bài này không làm lệch tổng của bất kỳ bài nào khác.
 */

const P = "fpa-";
const at = (day: number, hour = 9, minute = 0) => new Date(Date.UTC(2024, 2, day, hour, minute, 0));
/** Kỳ báo cáo trùm đúng tháng 3/2024 — cách ly hoàn toàn khỏi fixture của các bài khác. */
const KY = { key: "custom" as const, from: new Date(Date.UTC(2024, 2, 1)), to: new Date(Date.UTC(2024, 3, 30, 23, 59, 59)), label: "T3/2024", fromKey: "2024-03-01", toKey: "2024-04-30" };

const AN = `${P}mkt-an`;
const BINH = `${P}mkt-binh`;
const PAGE_A = `${P}page-a`;
const PAGE_B = `${P}page-b`;

type ItemSpec = { sku: string; qty: number };

async function themDon(
  db: Awaited<ReturnType<typeof getDb>>,
  spec: { id: string; pageId: string | null; at: Date; phone: string; name: string; address: string; items: ItemSpec[]; stage?: "NEW" | "CONFIRMED" | "CANCELLED"; revenue?: number },
) {
  await db
    .insert(schema.orders)
    .values({
      id: spec.id,
      systemId: null,
      stage: spec.stage ?? "CONFIRMED",
      insertedAt: spec.at,
      pageId: spec.pageId,
      shipPhone: spec.phone,
      billPhone: spec.phone,
      shipFullName: spec.name,
      billFullName: spec.name,
      shipFullAddress: spec.address,
      shipAddress: spec.address,
      totalPriceAfterDiscount: spec.revenue ?? 500_000,
      source: "Facebook",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values(spec.items.map((it, i) => ({ id: `${spec.id}-i${i}`, orderId: spec.id, sku: it.sku, productName: it.sku, quantity: it.qty, unitPrice: spec.revenue ?? 500_000 })))
    .onConflictDoNothing();
}

/** Dựng lại quy kết rồi xoá đệm báo cáo — hai việc luôn đi cùng nhau, quên vế sau là đọc phải số cũ. */
async function doiSoat() {
  const r = await rebuildFanpageAttribution();
  clearMemo();
  return r;
}

async function quyKet(orderId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.orderAttributions).where(eq(schema.orderAttributions.orderId, orderId)).limit(1);
  return row ?? null;
}

async function donCua(marketerId: string) {
  const report = await getMarketerAttributionReport(KY, { marketerId });
  const row = report.rows.find((r) => r.marketerId === marketerId);
  return { orders: row?.attributedOrders ?? 0, confirmedOrders: row?.confirmedOrders ?? 0, revenue: row?.confirmedRevenue ?? 0 };
}

export async function testFanpageAttribution() {
  const db = await getDb();

  /* ═══ 0 · HÀM THUẦN — khoá luật trước khi khoá đường đi qua CSDL ═══ */

  assert.equal(normalizeAttrPhone("+84 911 000 001"), "0911000001", "+84 và khoảng trắng về dạng 0…");
  assert.equal(normalizeAttrPhone("84911000001"), "0911000001");
  assert.equal(normalizeAttrText("  Nguyễn   Thị  Ánh "), "nguyen thi anh", "bỏ dấu, gộp khoảng trắng");

  const goHang = (sku: string, qty: number) => ({ sku, quantity: qty, productName: sku });
  const k1 = buildDedupeKey({ phone: "0911000001", name: "Anh", address: "12 Lê Lợi", items: [goHang("Q001", 1)] });
  const k2 = buildDedupeKey({ phone: "+84911000001", name: " anh ", address: "12 le loi", items: [goHang("Q001", 1)] });
  assert.equal(k1, k2, "cùng người cùng giỏ, khác cách gõ ⇒ CÙNG khoá");
  const kKhacSku = buildDedupeKey({ phone: "0911000001", name: "Anh", address: "12 Lê Lợi", items: [goHang("Q004", 1)] });
  assert.notEqual(k1, kKhacSku, "khác mã hàng ⇒ KHÁC khoá — đây là điều làm tình huống 3 chạy đúng");
  const kKhacSoLuong = buildDedupeKey({ phone: "0911000001", name: "Anh", address: "12 Lê Lợi", items: [goHang("Q001", 2)] });
  assert.notEqual(k1, kKhacSoLuong, "khác số lượng ⇒ KHÁC khoá");
  assert.equal(buildDedupeKey({ phone: "", name: "Anh", address: "x", items: [goHang("Q001", 1)] }), null, "không có SĐT ⇒ không đủ căn cứ xét trùng");
  assert.equal(buildDedupeKey({ phone: "0911000001", name: "Anh", address: "x", items: [] }), null, "không có dòng hàng ⇒ không đủ căn cứ xét trùng");
  // Thứ tự dòng hàng không được đổi khoá, nếu không hai lần đọc cùng một đơn ra hai khoá.
  assert.equal(
    buildDedupeKey({ phone: "0911000001", name: "A", address: "x", items: [goHang("Q001", 1), goHang("Q004", 2)] }),
    buildDedupeKey({ phone: "0911000001", name: "A", address: "x", items: [goHang("Q004", 2), goHang("Q001", 1)] }),
    "đổi thứ tự dòng hàng KHÔNG được đổi khoá",
  );

  const win = (id: string, mkt: string, from: Date, to: Date | null, active = true): AssignmentWindow => ({ id, fanpageId: "p", marketerId: mkt, effectiveFrom: from, effectiveTo: to, active });
  const dsPhanCong = [win("w1", AN, at(1), at(10)), win("w2", BINH, at(10), null)];
  assert.equal(pickAssignment(dsPhanCong, at(5))?.marketerId, AN, "đơn 05/03 thuộc người phụ trách 01→10/03");
  assert.equal(pickAssignment(dsPhanCong, at(12))?.marketerId, BINH, "đơn 12/03 thuộc người phụ trách từ 10/03");
  assert.equal(pickAssignment(dsPhanCong, at(10))?.marketerId, BINH, "nửa mở [from, to): đúng mốc bàn giao là của người MỚI");
  assert.equal(pickAssignment(dsPhanCong, at(0))?.marketerId, undefined, "trước mọi khoảng ⇒ chưa ai phụ trách");
  assert.equal(pickAssignment([win("w1", AN, at(1), null, false)], at(5)), null, "dòng đã thu hồi KHÔNG quyết định doanh thu của ai");
  assert.ok(windowsOverlap({ from: at(1), to: at(10) }, { from: at(5), to: null }), "chồng lấn phải phát hiện được");
  assert.ok(!windowsOverlap({ from: at(1), to: at(10) }, { from: at(10), to: null }), "kề nhau KHÔNG phải chồng lấn");

  /* ═══ 1 · SỔ FANPAGE tự phát hiện từ page_id của đơn ═══ */

  await themDon(db, { id: `${P}o1`, pageId: PAGE_A, at: at(5), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q001", qty: 1 }] });
  await syncFanpageRegistry(db);
  const [pageA] = await db.select().from(schema.fanpages).where(eq(schema.fanpages.externalPageId, PAGE_A)).limit(1);
  assert.ok(pageA, "fanpage phải được phát hiện từ page_id của đơn — không ai phải gõ tay một ID 15 chữ số");

  // Đơn mồi CHỈ để page B lọt vào sổ. Đặt ở tháng 2 — NGOÀI kỳ báo cáo — để nó không cộng vào bất
  // kỳ con số nào mà bài này đang khẳng định; một đơn mồi lọt vào tổng là một bài kiểm tự lừa mình.
  await themDon(db, { id: `${P}o-b-seed`, pageId: PAGE_B, at: new Date(Date.UTC(2024, 1, 15, 9)), phone: "0911009999", name: "Khách seed", address: "1 X", items: [{ sku: "FPA-SEED", qty: 1 }] });
  await syncFanpageRegistry(db);
  const [pageB] = await db.select().from(schema.fanpages).where(eq(schema.fanpages.externalPageId, PAGE_B)).limit(1);
  assert.ok(pageB, "fanpage thứ hai cũng phải vào sổ");

  const gan1 = await assignFanpageMarketer({ fanpageId: pageA.id, marketerId: AN, effectiveFrom: at(1) }, db);
  assert.ok(!("error" in gan1), "gán marketer cho fanpage A phải thành công");
  const gan2 = await assignFanpageMarketer({ fanpageId: pageB.id, marketerId: BINH, effectiveFrom: at(1) }, db);
  assert.ok(!("error" in gan2), "gán marketer cho fanpage B phải thành công");

  /* ═══ TÌNH HUỐNG 1 · Page A → An; khách X mua Q001 ⇒ An +1 đơn ═══ */

  await doiSoat();
  const qk1 = await quyKet(`${P}o1`);
  assert.equal(qk1?.status, "ATTRIBUTED", "đơn trên page đã gán phải quy kết được");
  assert.equal(qk1?.marketerId, AN, "và quy kết đúng cho An");
  assert.equal(qk1?.assignmentId, (gan1 as { assignmentId: string }).assignmentId, "ảnh chụp phải giữ CHÍNH dòng phân công đã dùng — đó là thứ truy ngược được");
  assert.equal((await donCua(AN)).orders, 1, "An có đúng 1 đơn");

  /* ═══ TÌNH HUỐNG 2 · Cùng khách, cùng Q001, nhập lại ở page B sau 5 phút ⇒ An giữ quy kết ═══ */

  await themDon(db, { id: `${P}o2-dup`, pageId: PAGE_B, at: at(5, 9, 5), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q001", qty: 1 }] });
  await doiSoat();
  const dup = await quyKet(`${P}o2-dup`);
  assert.equal(dup?.status, "DUPLICATE", "đơn nhập lại phải bị đánh dấu trùng");
  assert.equal(dup?.duplicateOfOrderId, `${P}o1`, "và phải chỉ đích danh đơn nào thắng — một kết luận không chỉ được đích là kết luận không kiểm chứng được");
  assert.equal(dup?.marketerId, null, "đơn trùng KHÔNG mang tên ai");
  assert.equal(dup?.sourcePageId, PAGE_B, "vẫn giữ page gốc để còn đối chiếu — loại quy kết khác hẳn với xoá dấu vết");
  assert.equal((await donCua(AN)).orders, 1, "An vẫn đúng 1 đơn");
  assert.equal((await donCua(BINH)).orders, 0, "Bình KHÔNG nhận đơn trùng");
  assert.equal((await donCua(BINH)).revenue, 0, "và cũng không nhận đồng doanh thu nào từ đơn trùng");
  // Đơn gốc KHÔNG bị xoá khỏi ERP — chỉ bị loại khỏi quy kết.
  const [conNguyen] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, `${P}o2-dup`)).limit(1);
  assert.ok(conNguyen, "đơn trùng vẫn nằm nguyên trong ERP");

  /* ═══ TÌNH HUỐNG 3 · Cùng khách, KHÁC mã hàng, hai page ⇒ tính cả hai ═══ */

  await themDon(db, { id: `${P}o3-q004`, pageId: PAGE_B, at: at(5, 9, 10), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q004", qty: 1 }] });
  await doiSoat();
  const q004 = await quyKet(`${P}o3-q004`);
  assert.equal(q004?.status, "ATTRIBUTED", "khác mã hàng KHÔNG phải trùng đơn, dù cùng khách cùng giờ");
  assert.equal(q004?.marketerId, BINH, "Bình nhận đơn Q004 của chính page mình");
  assert.equal((await donCua(AN)).orders, 1, "An giữ Q001");
  assert.equal((await donCua(BINH)).orders, 1, "Bình được Q004");

  /* ═══ TÌNH HUỐNG 4 · Cùng khách, cùng Q001, 30 ngày sau ⇒ KHÔNG phải trùng ═══ */

  await themDon(db, { id: `${P}o4-mua-lai`, pageId: PAGE_B, at: at(35, 9, 0), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q001", qty: 1 }] });
  await doiSoat();
  const muaLai = await quyKet(`${P}o4-mua-lai`);
  assert.equal(muaLai?.status, "ATTRIBUTED", "khách mua lại sau 30 ngày là một lần bán THẬT, không phải bản nhập lại");
  assert.equal(muaLai?.marketerId, BINH, "và nó thuộc về người phụ trách page bán được lần đó");
  assert.equal((await donCua(BINH)).orders, 2, "Bình có Q004 và lần mua lại");

  /* ═══ TÌNH HUỐNG 5 · Đổi người phụ trách KHÔNG được viết lại lịch sử ═══ */

  await themDon(db, { id: `${P}o5-truoc`, pageId: PAGE_A, at: at(5, 14, 0), phone: "0911000005", name: "Khách N5", address: "5 Trần Phú", items: [{ sku: "FPA-Q005", qty: 1 }] });
  await themDon(db, { id: `${P}o5-sau`, pageId: PAGE_A, at: at(12, 14, 0), phone: "0911000006", name: "Khách N6", address: "6 Trần Phú", items: [{ sku: "FPA-Q006", qty: 1 }] });
  await doiSoat();
  assert.equal((await quyKet(`${P}o5-truoc`))?.marketerId, AN, "trước khi chuyển page: cả hai đơn là của An");
  assert.equal((await quyKet(`${P}o5-sau`))?.marketerId, AN);

  // Chuyển fanpage A cho Bình kể từ 10/03.
  const chuyen = await assignFanpageMarketer({ fanpageId: pageA.id, marketerId: BINH, effectiveFrom: at(10), note: "chuyển page" }, db);
  assert.ok(!("error" in chuyen), "chuyển page cho người khác phải thành công");
  await doiSoat();

  assert.equal((await quyKet(`${P}o5-truoc`))?.marketerId, AN, "ĐƠN 05/03 VẪN LÀ CỦA AN sau khi đổi người phụ trách — đây là luật bất biến số 1");
  assert.equal((await quyKet(`${P}o1`))?.marketerId, AN, "và đơn đầu tiên cũng thế");
  assert.equal((await quyKet(`${P}o5-sau`))?.marketerId, BINH, "đơn 12/03 thuộc người phụ trách mới");

  // Khoảng cũ phải được ĐÓNG chứ không bị xoá — lịch sử là thứ chứng minh số cũ đúng.
  const lichSu = await db.select().from(schema.fanpageMarketerAssignments).where(eq(schema.fanpageMarketerAssignments.fanpageId, pageA.id));
  assert.equal(lichSu.length, 2, "đổi người là ĐÓNG một khoảng và MỞ một khoảng, không ghi đè");
  const khoangAn = lichSu.find((r) => r.marketerId === AN);
  assert.ok(khoangAn?.effectiveTo, "khoảng của An phải có mốc kết thúc");
  assert.equal(khoangAn?.effectiveTo?.getTime(), at(10).getTime(), "kết thúc đúng tại mốc bàn giao");

  /* ═══ TÌNH HUỐNG 6 · Chưa xác nhận ⇒ có quy kết nhưng doanh thu 0; xác nhận rồi ⇒ tăng đúng ═══ */

  await themDon(db, { id: `${P}o6-chua-chot`, pageId: PAGE_B, at: at(6, 10, 0), phone: "0911000007", name: "Khách N7", address: "7 Hai Bà", items: [{ sku: "FPA-Q007", qty: 1 }], stage: "NEW", revenue: 777_000 });
  await doiSoat();
  const truocChot = await donCua(BINH);
  const qk6 = await quyKet(`${P}o6-chua-chot`);
  assert.equal(qk6?.status, "ATTRIBUTED", "đơn chưa chốt VẪN có dòng quy kết — 'chưa chốt' khác hẳn 'không thuộc về ai'");
  assert.equal(qk6?.marketerId, BINH);
  const donChuaChot = await listAttributionOrders(
    { page: 1, pageSize: 50, sort: "sourceOrderAt", dir: "desc", q: `${P}o6-chua-chot`, filters: {}, period: KY },
    {},
  );
  assert.equal(donChuaChot.rows.find((r) => r.orderId === `${P}o6-chua-chot`)?.confirmed, false, "đơn chưa chốt không nằm trong phạm vi đã xác nhận");

  await db.update(schema.orders).set({ stage: "CONFIRMED" }).where(eq(schema.orders.id, `${P}o6-chua-chot`));
  await doiSoat();
  const sauChot = await donCua(BINH);
  assert.equal(sauChot.revenue - truocChot.revenue, 777_000, "xác nhận trên Pancake ⇒ doanh thu tăng ĐÚNG giá trị đơn, không hơn không kém");
  assert.equal(sauChot.orders, truocChot.orders, "số đơn quy kết KHÔNG đổi — đơn đã được quy kết từ lúc chưa chốt");
  assert.equal(sauChot.confirmedOrders - truocChot.confirmedOrders, 1, "nhưng số đơn ĐÃ XÁC NHẬN tăng 1");

  /* ═══ TÌNH HUỐNG 7 · Chạy lại nhiều lần KHÔNG được cộng đúp ═══ */

  const lan2 = await doiSoat();
  assert.equal(lan2.changed, 0, "chạy lại ngay trên cùng dữ liệu ⇒ KHÔNG dòng nào đổi (idempotent)");
  const sauLan2 = await donCua(BINH);
  await doiSoat();
  await doiSoat();
  const sauLan4 = await donCua(BINH);
  assert.deepEqual(sauLan4, sauLan2, "chạy bốn lần ra đúng một kết quả — doanh thu không cộng đúp");
  const [demDong] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.orderAttributions)
    .where(sql`${schema.orderAttributions.orderId} like ${`${P}%`}`);
  const [demDon] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.orders)
    .where(sql`${schema.orders.id} like ${`${P}%`}`);
  assert.equal(Number(demDong.n), Number(demDon.n), "mỗi đơn ĐÚNG MỘT dòng quy kết — khoá duy nhất là thứ chặn cộng đúp ở gốc");

  /* ═══ 8 · ĐƠN HUỶ RỒI TẠO LẠI: đơn SỐNG thắng, không phải đơn huỷ ═══ */

  await themDon(db, { id: `${P}o8-huy`, pageId: PAGE_B, at: at(7, 8, 0), phone: "0911000008", name: "Khách N8", address: "8 Bà Triệu", items: [{ sku: "FPA-Q008", qty: 1 }], stage: "CANCELLED", revenue: 600_000 });
  await themDon(db, { id: `${P}o8-tao-lai`, pageId: PAGE_B, at: at(7, 8, 30), phone: "0911000008", name: "Khách N8", address: "8 Bà Triệu", items: [{ sku: "FPA-Q008", qty: 1 }], stage: "CONFIRMED", revenue: 600_000 });
  await doiSoat();
  assert.equal((await quyKet(`${P}o8-tao-lai`))?.status, "ATTRIBUTED", "đơn tạo lại (còn sống) phải giữ quy kết, không bị đơn ĐÃ HUỶ trước nó nuốt mất");
  assert.equal((await quyKet(`${P}o8-huy`))?.status, "DUPLICATE", "đơn đã huỷ là bản bị thay thế");
  assert.equal((await quyKet(`${P}o8-huy`))?.duplicateOfOrderId, `${P}o8-tao-lai`);

  /* ═══ 9 · FANPAGE CHƯA GÁN: nói thẳng là chưa gán, không im lặng bỏ đơn ═══ */

  const PAGE_C = `${P}page-c`;
  await themDon(db, { id: `${P}o9-chua-gan`, pageId: PAGE_C, at: at(8, 8, 0), phone: "0911000009", name: "Khách N9", address: "9 Lý Thường Kiệt", items: [{ sku: "FPA-Q009", qty: 1 }] });
  await themDon(db, { id: `${P}o9-khong-page`, pageId: null, at: at(8, 8, 30), phone: "0911000010", name: "Khách N10", address: "10 Lý Thường Kiệt", items: [{ sku: "FPA-Q010", qty: 1 }] });
  await syncFanpageRegistry(db);
  await doiSoat();
  assert.equal((await quyKet(`${P}o9-chua-gan`))?.status, "NO_ASSIGNMENT", "page có đơn nhưng chưa ai phụ trách ⇒ nói rõ là CHƯA GÁN");
  assert.equal((await quyKet(`${P}o9-chua-gan`))?.sourcePageId, PAGE_C, "vẫn giữ page để biết phải đi gán cái nào");
  assert.equal((await quyKet(`${P}o9-khong-page`))?.status, "NO_PAGE", "đơn không có page là một lỗ hổng KHÁC, có cách sửa khác");

  /* ═══ 10 · CỘNG MỌI NHÓM PHẢI BẰNG TỔNG — không đơn nào bị đếm hai lần hay rơi ra ngoài ═══ */

  clearMemo();
  const bao = await getMarketerAttributionReport(KY, {});
  const tongNhom = Object.values(bao.byStatus).reduce((t, n) => t + n, 0);
  assert.equal(tongNhom, bao.totalOrders, "bốn nhóm tình trạng cộng lại phải bằng tổng đơn của kỳ");
  const tongTheoNguoi = bao.rows.reduce((t, r) => t + r.attributedOrders, 0);
  assert.equal(tongTheoNguoi + bao.duplicates.orders, bao.totalOrders, "mọi đơn thuộc đúng một dòng, hoặc là đơn trùng — không đơn nào bốc hơi");
  assert.equal(bao.missing, 0, "sau đối soát, không đơn nào trong kỳ còn thiếu dòng quy kết");

  /* ═══ 11 · THU HỒI MỘT DÒNG KHAI SAI: đơn tính lại, dòng KHÔNG biến mất ═══ */

  const khoangBinhTrenA = lichSu.find((r) => r.marketerId === BINH);
  assert.ok(khoangBinhTrenA, "phải có khoảng của Bình trên page A để thử thu hồi");
  const thuHoi = await revokeFanpageAssignment(khoangBinhTrenA.id, db);
  assert.ok(!("error" in thuHoi), "thu hồi phải thành công");
  await doiSoat();
  assert.equal((await quyKet(`${P}o5-sau`))?.status, "NO_ASSIGNMENT", "thu hồi dòng khai sai ⇒ đơn của khoảng đó quay về CHƯA GÁN, không im lặng giữ tên cũ");
  assert.equal((await quyKet(`${P}o5-truoc`))?.marketerId, AN, "và KHÔNG đụng tới khoảng của người khác");
  const conTrongSo = await db.select().from(schema.fanpageMarketerAssignments).where(eq(schema.fanpageMarketerAssignments.id, khoangBinhTrenA.id));
  assert.equal(conTrongSo.length, 1, "thu hồi là TẮT, không phải XOÁ — đơn đã quy kết bằng nó còn trỏ tới nó");
  assert.equal(conTrongSo[0].active, false);

  /* ═══ 12 · CHẶN Ở CSDL: một dòng 'DUPLICATE' KHÔNG được mang tên một người ═══ */

  let chan = false;
  try {
    await db.insert(schema.orderAttributions).values({
      orderId: `${P}o1`,
      status: "DUPLICATE",
      marketerId: AN,
      duplicateOfOrderId: `${P}o2-dup`,
      sourceOrderAt: at(5),
      ruleVersion: 1,
    });
  } catch {
    chan = true;
  }
  assert.ok(chan, "CSDL phải từ chối một dòng trùng đơn mang tên một người — nếu lọt thì doanh thu đếm hai lần mà báo cáo trông vẫn bình thường");

  /* ═══ 13 · LÁ CHẮN MÃ NGUỒN: doanh thu marketing không được đọc tiền của logistics ═══ */

  const nguon = fs.readFileSync(path.resolve(__dirname, "../lib/queries/fanpage-attribution.ts"), "utf8");
  // Quét MÃ CHẠY ĐƯỢC, không quét lời bình. Chính lời bình của tệp ấy nói "KHÔNG đọc ORDER_OUTCOME",
  // nên một phép quét thô sẽ đỏ vì đọc được câu cấm — lá chắn bắt nhầm là lá chắn bị gỡ bỏ.
  const code = nguon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const cam of ["cod_collected", "codCollected", "ORDER_OUTCOME", "cod_status", "codStatus", "shipments", "moneyToCollect"]) {
    assert.ok(!code.includes(cam), `báo cáo quy kết marketing KHÔNG được đọc "${cam}" — đó là chỉ số logistics, và marketer không quyết được việc shipper giao có thành công hay không`);
  }
  assert.ok(code.includes("CONFIRMED_STAGES"), "phải dùng LẠI phạm vi đơn đã xác nhận dùng chung, không tự viết điều kiện stage");

  console.log(
    `✓ Quy kết fanpage → marketer: ${bao.totalOrders} đơn trong kỳ · ${bao.byStatus.ATTRIBUTED} quy kết được · ${bao.byStatus.DUPLICATE} trùng đơn (cửa sổ ${DUPLICATE_WINDOW_HOURS}h) · ${bao.byStatus.NO_ASSIGNMENT} chưa gán · ${bao.byStatus.NO_PAGE} không có page · idempotent sau 4 lượt chạy`,
  );
}

/** Hàm thuần chia chuỗi — tách riêng để chạy được không cần CSDL. */
export function testDuplicateChainPure() {
  const key = "k";
  const c = (id: string, hours: number, alive = true) => ({ orderId: id, sourceOrderAt: new Date(Date.UTC(2024, 2, 1, hours)), dedupeKey: key, alive });

  // Chuỗi ba đơn trong cửa sổ: đơn thứ ba trỏ về ĐƠN THẮNG, không trỏ về đơn liền trước.
  const ba = resolveDuplicateChains([c("a", 0), c("b", 1), c("c", 2)], 24);
  assert.equal(ba.find((v) => v.orderId === "b")?.duplicateOfOrderId, "a");
  assert.equal(ba.find((v) => v.orderId === "c")?.duplicateOfOrderId, "a", "chuỗi truy ngược luôn sâu đúng một bậc");

  // Quá cửa sổ ⇒ chuỗi MỚI. Đây là điều giữ cho khách mua lại không bị nuốt mất.
  const xa = resolveDuplicateChains([c("a", 0), c("b", 25)], 24);
  assert.equal(xa.find((v) => v.orderId === "b")?.duplicateOfOrderId, null);

  // Mốc đo là ĐƠN ĐẦU CHUỖI, không phải đơn liền trước: nếu đo từ đơn liền trước thì dãy dưới đây
  // trượt dài thành "một lần đặt" vô tận.
  const truot = resolveDuplicateChains([c("a", 0), c("b", 20), c("c", 39)], 24);
  assert.equal(truot.find((v) => v.orderId === "b")?.duplicateOfOrderId, "a");
  assert.equal(truot.find((v) => v.orderId === "c")?.duplicateOfOrderId, null, "39h từ đầu chuỗi ⇒ chuỗi mới, dù chỉ cách đơn liền trước 19h");

  // Bằng giây ⇒ chốt hạ bằng order_id, để hai lần chạy không đổi chỗ doanh thu của hai người.
  const hoa = resolveDuplicateChains([c("z", 0), c("a", 0)], 24);
  assert.equal(hoa.find((v) => v.orderId === "z")?.duplicateOfOrderId, "a", "bằng giây thì id nhỏ hơn thắng — kết quả phải tất định");

  // Đơn huỷ không được thắng trong khi còn đơn sống.
  const coHuy = resolveDuplicateChains([c("a", 0, false), c("b", 1, true)], 24);
  assert.equal(coHuy.find((v) => v.orderId === "b")?.duplicateOfOrderId, null, "đơn SỐNG thắng");
  assert.equal(coHuy.find((v) => v.orderId === "a")?.duplicateOfOrderId, "b");

  // Cả chuỗi đều huỷ ⇒ vẫn gộp, chỉ là gộp về một con số 0 đúng nghĩa.
  const toanHuy = resolveDuplicateChains([c("a", 0, false), c("b", 1, false)], 24);
  assert.equal(toanHuy.find((v) => v.orderId === "b")?.duplicateOfOrderId, "a");

  // Không có khoá ⇒ KHÔNG bao giờ bị loại vì trùng (lề an toàn nghiêng về bỏ sót).
  const khongKhoa = resolveDuplicateChains([{ orderId: "x", sourceOrderAt: new Date(), dedupeKey: null, alive: true }], 24);
  assert.equal(khongKhoa[0].duplicateOfOrderId, null);

  console.log("✓ Chia chuỗi trùng đơn: cửa sổ, chốt hạ tất định, đơn sống thắng, thiếu căn cứ thì không loại");
}
