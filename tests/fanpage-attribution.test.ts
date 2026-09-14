import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  buildDedupeKey,
  DUPLICATE_CANDIDATE_WINDOW_HOURS,
  DUPLICATE_SCORE_THRESHOLD,
  DUPLICATE_SIGNALS,
  normalizeAttrPhone,
  normalizeAttrText,
  pickAssignment,
  resolveDuplicates,
  scoreDuplicatePair,
  windowsOverlap,
  type AssignmentWindow,
  type DedupeCandidate,
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
  spec: {
    id: string;
    pageId: string | null;
    at: Date;
    phone: string;
    name: string;
    address: string;
    items: ItemSpec[];
    stage?: "NEW" | "CONFIRMED" | "CANCELLED";
    revenue?: number;
    /* Dấu hiệu nguồn — mặc định KHÔNG có, để mỗi bài phải tự khai dấu hiệu nó đang thử. */
    conversationId?: string;
    postId?: string;
    dupFlag?: boolean;
    customerId?: string;
  },
) {
  if (spec.customerId) {
    await db.insert(schema.customers).values({ id: spec.customerId, name: spec.name }).onConflictDoNothing();
  }
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
      customerId: spec.customerId ?? null,
      conversationId: spec.conversationId ?? null,
      postId: spec.postId ?? null,
      raw: { duplicated_phone: spec.dupFlag === true },
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

  /* ═══ TÌNH HUỐNG 2 · Nhập lại ở page B — VÀ CHỈ KHI CÓ ĐỦ CHỨNG CỨ ═══
   *
   * Đây là chỗ luật phải phân biệt được hai chuyện trông GIỐNG HỆT nhau: một lần đặt bị gõ lại, và
   * một khách mua thêm bộ nữa trong cùng buổi chiều. "Cùng khách + cùng giỏ + trong 24 giờ" mô tả
   * đúng cả hai, nên nó không được phép tự kết luận.
   *
   * 2a — KHÔNG có dấu hiệu nguồn nào ngoài giá trị đơn và khoảng cách gần: TÍNH CẢ HAI.
   */

  await themDon(db, { id: `${P}o2-mua-them`, pageId: PAGE_B, at: at(5, 9, 5), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q001", qty: 1 }] });
  await doiSoat();
  const muaThem = await quyKet(`${P}o2-mua-them`);
  assert.equal(muaThem?.status, "ATTRIBUTED", "cùng khách + cùng giỏ + 5 phút NHƯNG không dấu hiệu nguồn nào ⇒ KHÔNG kết luận trùng, tính cả hai");
  assert.equal(muaThem?.marketerId, BINH, "và đơn ấy thuộc về người phụ trách page bán được nó");
  assert.equal((await donCua(BINH)).orders, 1, "Bình được tính đơn này");

  /* 2b — CÙNG DỮ KIỆN ẤY nhưng có đủ bốn dấu hiệu yếu (cùng định danh khách · cùng bài viết ·
   * cùng giá trị · Pancake đánh dấu SĐT trùng) ⇒ mới kết luận trùng, và đơn TRƯỚC thắng. */

  await themDon(db, { id: `${P}o2b-goc`, pageId: PAGE_A, at: at(6, 9, 0), phone: "0911000002", name: "Khách Y", address: "20 Lê Lợi", items: [{ sku: "FPA-Q002", qty: 1 }], customerId: `${P}cust-y`, postId: "post-y" });
  await themDon(db, { id: `${P}o2b-nhap-lai`, pageId: PAGE_B, at: at(6, 9, 5), phone: "0911000002", name: "Khách Y", address: "20 Lê Lợi", items: [{ sku: "FPA-Q002", qty: 1 }], customerId: `${P}cust-y`, postId: "post-y", dupFlag: true });
  await doiSoat();
  const dup = await quyKet(`${P}o2b-nhap-lai`);
  assert.equal(dup?.status, "DUPLICATE", "đủ bốn dấu hiệu yếu ⇒ kết luận trùng");
  assert.equal(dup?.duplicateOfOrderId, `${P}o2b-goc`, "đơn TRƯỚC (mốc nguồn sớm hơn) thắng quy kết");
  assert.equal(dup?.marketerId, null, "đơn trùng KHÔNG mang tên ai");
  assert.equal(dup?.sourcePageId, PAGE_B, "vẫn giữ page gốc để còn đối chiếu — loại quy kết khác hẳn với xoá dấu vết");
  assert.ok((dup?.duplicateScore ?? 0) >= DUPLICATE_SCORE_THRESHOLD, "phải lưu ĐIỂM chứng cứ");
  assert.ok((dup?.duplicateReason ?? "").includes("SAME_CUSTOMER_ID"), "và lưu RÕ đã dùng dấu hiệu nào — không có căn cứ thì không ai cãi lại được");
  assert.equal((await quyKet(`${P}o2b-goc`))?.marketerId, AN, "An giữ đơn gốc");
  assert.equal((await donCua(BINH)).revenue, 500_000, "Bình chỉ có doanh thu của đơn 2a, KHÔNG có đồng nào từ đơn trùng");
  // Đơn bị loại KHÔNG bị xoá khỏi ERP — chỉ bị loại khỏi quy kết.
  const [conNguyen] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, `${P}o2b-nhap-lai`)).limit(1);
  assert.ok(conNguyen, "đơn trùng vẫn nằm nguyên trong ERP");

  /* 2c — CÙNG HỘI THOẠI là dấu hiệu QUYẾT ĐỊNH: một mình nó đủ. */

  await themDon(db, { id: `${P}o2c-goc`, pageId: PAGE_A, at: at(6, 14, 0), phone: "0911000003", name: "Khách Z", address: "30 Lê Lợi", items: [{ sku: "FPA-Q003", qty: 1 }], conversationId: "conv-z", revenue: 111_000 });
  await themDon(db, { id: `${P}o2c-lai`, pageId: PAGE_A, at: at(6, 19, 0), phone: "0911000003", name: "Khách Z", address: "30 Lê Lợi", items: [{ sku: "FPA-Q003", qty: 1 }], conversationId: "conv-z", revenue: 222_000 });
  await doiSoat();
  const convDup = await quyKet(`${P}o2c-lai`);
  assert.equal(convDup?.status, "DUPLICATE", "cùng một cuộc trò chuyện ⇒ đủ sức kết luận một mình, dù khác giá trị và cách nhau 5 tiếng");
  assert.equal(convDup?.duplicateReason, "SAME_CONVERSATION", "và căn cứ ghi đúng MỘT dấu hiệu ấy, không kèm dấu hiệu không bật");

  /* ═══ TÌNH HUỐNG 3 · Cùng khách, KHÁC mã hàng, hai page ⇒ tính cả hai ═══ */

  await themDon(db, { id: `${P}o3-q004`, pageId: PAGE_B, at: at(5, 9, 10), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q004", qty: 1 }] });
  await doiSoat();
  const q004 = await quyKet(`${P}o3-q004`);
  assert.equal(q004?.status, "ATTRIBUTED", "khác mã hàng KHÔNG phải trùng đơn, dù cùng khách cùng giờ");
  assert.equal(q004?.marketerId, BINH, "Bình nhận đơn Q004 của chính page mình");
  // Sổ tại đây: An = o1 · o2b-goc · o2c-goc (o2c-lai bị loại vì trùng).
  //             Bình = o2-mua-them · o3-q004.
  assert.equal((await donCua(AN)).orders, 3, "An giữ ba đơn của page A, KHÔNG mất đơn nào vì luật trùng");
  assert.equal((await donCua(BINH)).orders, 2, "Bình được cả đơn mua thêm (2a) lẫn đơn khác mã (Q004)");

  /* ═══ TÌNH HUỐNG 4 · Cùng khách, cùng Q001, 30 ngày sau ⇒ KHÔNG phải trùng ═══ */

  await themDon(db, { id: `${P}o4-mua-lai`, pageId: PAGE_B, at: at(35, 9, 0), phone: "0911000001", name: "Khách X", address: "12 Lê Lợi", items: [{ sku: "FPA-Q001", qty: 1 }] });
  await doiSoat();
  const muaLai = await quyKet(`${P}o4-mua-lai`);
  assert.equal(muaLai?.status, "ATTRIBUTED", "khách mua lại sau 30 ngày là một lần bán THẬT, không phải bản nhập lại");
  assert.equal(muaLai?.marketerId, BINH, "và nó thuộc về người phụ trách page bán được lần đó");
  assert.equal((await donCua(BINH)).orders, 3, "Bình có thêm lần mua lại — cộng vào hai đơn trước đó");

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

  // Và trên CSDL: KHÔNG dòng trùng đơn nào được thiếu căn cứ — kể cả đơn đã huỷ bị đơn sống giành mất.
  const huyBiLoai = await quyKet(`${P}o8-huy`);
  assert.ok((huyBiLoai?.duplicateScore ?? 0) >= DUPLICATE_SCORE_THRESHOLD, "đơn huỷ bị loại vẫn phải lưu ĐIỂM đạt ngưỡng");
  assert.ok((huyBiLoai?.duplicateReason ?? "").includes("CANCELLED_SIBLING"), "và lưu đúng căn cứ đã dùng");

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

  const thieuCanCu = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.orderAttributions)
    .where(sql`${schema.orderAttributions.status} = 'DUPLICATE' and (${schema.orderAttributions.duplicateScore} is null or ${schema.orderAttributions.duplicateScore} < ${DUPLICATE_SCORE_THRESHOLD} or coalesce(${schema.orderAttributions.duplicateReason}, '') = '')`);
  assert.equal(Number(thieuCanCu[0].n), 0, "KHÔNG dòng trùng đơn nào trong CSDL được thiếu căn cứ hoặc mang điểm dưới ngưỡng");

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
    `✓ Quy kết fanpage → marketer: ${bao.totalOrders} đơn trong kỳ · ${bao.byStatus.ATTRIBUTED} quy kết được · ${bao.byStatus.DUPLICATE} trùng đơn (ngưỡng ${DUPLICATE_SCORE_THRESHOLD} điểm chứng cứ) · ${bao.byStatus.NO_ASSIGNMENT} chưa gán · ${bao.byStatus.NO_PAGE} không có page · idempotent sau 4 lượt chạy`,
  );
}

/**
 * Hàm thuần chấm chứng cứ và gom cụm — chạy được không cần CSDL.
 *
 * Đây là nơi khoá điều quan trọng nhất của cả bản này: **cửa sổ thời gian KHÔNG BAO GIỜ tự mình
 * kết luận trùng đơn**. Nếu một ngày nào đó có người "đơn giản hoá" nó về lại "cùng khoá + trong
 * 24 giờ", bài này đỏ ngay.
 */
export function testDuplicateEvidencePure() {
  const KEY = "k";
  // `hours` nhận cả số lẻ (0,0834 h = 5 phút) — `Date.UTC` cắt cụt tham số nên phải cộng bằng mili giây.
  const base = (id: string, hours: number, over: Partial<DedupeCandidate> = {}): DedupeCandidate => ({
    orderId: id,
    sourceOrderAt: new Date(Date.UTC(2024, 2, 1) + Math.round(hours * 3_600_000)),
    dedupeKey: KEY,
    alive: true,
    conversationId: null,
    postId: null,
    customerId: null,
    orderValue: 500_000,
    pancakeDuplicateFlag: false,
    ...over,
  });
  const dupOf = (out: ReturnType<typeof resolveDuplicates>, id: string) => out.find((v) => v.orderId === id)?.duplicateOfOrderId ?? null;

  /* ── 1 · CỬA SỔ MỘT MÌNH KHÔNG ĐỦ ── */
  const chiGanNhau = resolveDuplicates([base("a", 0), base("b", 1)]);
  assert.equal(dupOf(chiGanNhau, "b"), null, "cùng khoá + cách 1 giờ + cùng giá trị vẫn KHÔNG đủ — đây là luật chống 'ngăn khách mua lại'");
  assert.equal(scoreDuplicatePair(base("a", 0), base("b", 1)).score, DUPLICATE_SIGNALS.SAME_VALUE.weight, "chỉ có đúng dấu hiệu giá trị");

  /* ── 2 · HAI DẤU HIỆU QUYẾT ĐỊNH, mỗi cái đủ đứng một mình ── */
  const cungHoiThoai = resolveDuplicates([base("a", 0, { conversationId: "c1" }), base("b", 6, { conversationId: "c1", orderValue: 900_000 })]);
  assert.equal(dupOf(cungHoiThoai, "b"), "a", "cùng hội thoại ⇒ trùng, dù khác giá trị và cách 6 giờ");

  const huyRoiTao = resolveDuplicates([base("a", 0, { alive: false }), base("b", 3)]);
  assert.equal(dupOf(huyRoiTao, "b"), null, "đơn CÒN SỐNG không bao giờ bị đánh dấu trùng khi nó là đơn thắng");
  assert.equal(dupOf(huyRoiTao, "a"), "b", "đơn ĐÃ HUỶ là bản bị thay thế — không được chiếm quy kết");

  /* ── 3 · ĐƯỜNG BỐN DẤU HIỆU YẾU ── */
  const ba = resolveDuplicates([base("a", 0, { customerId: "c", postId: "p" }), base("b", 5, { customerId: "c", postId: "p" })]);
  assert.equal(dupOf(ba, "b"), null, "ba dấu hiệu yếu (khách · bài viết · giá trị) CHƯA đủ — cổng cao là có chủ đích");
  const bon = resolveDuplicates([base("a", 0, { customerId: "c", postId: "p" }), base("b", 5, { customerId: "c", postId: "p", pancakeDuplicateFlag: true })]);
  assert.equal(dupOf(bon, "b"), "a", "bốn dấu hiệu yếu thì mới đủ");

  /* ── 4 · KHÁC GIỎ HÀNG ⇒ KHÁC KHOÁ ⇒ không bao giờ gặp nhau ── */
  const khacGio = resolveDuplicates([base("a", 0, { conversationId: "c1" }), base("b", 1, { conversationId: "c1", dedupeKey: "k2" })]);
  assert.equal(dupOf(khacGio, "b"), null, "khác mã hàng thì dù cùng hội thoại vẫn là hai đơn — 'khác SKU tính cả' không cần luật riêng");

  /* ── 5 · QUÁ CỬA SỔ ⇒ thôi xét, dù chứng cứ mạnh ── */
  const quaCuaSo = resolveDuplicates([base("a", 0, { conversationId: "c1" }), base("b", 25, { conversationId: "c1" })]);
  assert.equal(dupOf(quaCuaSo, "b"), null, "quá 24 giờ ⇒ mở cụm MỚI: khách mua lại trong cùng một hội thoại dài KHÔNG bị nuốt");

  /* ── 6 · SO VỚI ĐƠN ĐẠI DIỆN, không so với đơn liền trước ── */
  const truot = resolveDuplicates([base("a", 0, { conversationId: "c1" }), base("b", 20, { conversationId: "c1" }), base("c", 39, { conversationId: "c1" })]);
  assert.equal(dupOf(truot, "b"), "a");
  assert.equal(dupOf(truot, "c"), null, "39 giờ tính từ ĐẠI DIỆN ⇒ cụm mới, dù chỉ cách đơn liền trước 19 giờ — nếu không, một dãy đơn sẽ trượt dài vô tận");

  /* ── 7 · TẤT ĐỊNH: bằng giây thì chốt hạ bằng order_id, và chạy lại ra y hệt ── */
  const hoa1 = resolveDuplicates([base("z", 0, { conversationId: "c1" }), base("a", 0, { conversationId: "c1" })]);
  const hoa2 = resolveDuplicates([base("a", 0, { conversationId: "c1" }), base("z", 0, { conversationId: "c1" })]);
  assert.equal(dupOf(hoa1, "z"), "a", "bằng giây thì id nhỏ hơn thắng");
  assert.deepEqual(hoa1.map((v) => [v.orderId, v.duplicateOfOrderId]).sort(), hoa2.map((v) => [v.orderId, v.duplicateOfOrderId]).sort(), "đổi thứ tự đầu vào KHÔNG được đổi kết quả");

  /* ── 7b · MỌI DÒNG TRÙNG ĐƠN PHẢI MANG CHỨNG CỨ THẬT ──
   *
   * SỰ CỐ THẬT (production 14/09/2026): 46/83 dòng trùng đơn mang điểm 0 và căn cứ RỖNG — tất cả
   * đều là đơn ĐÃ HUỶ. Đơn đại diện mở cụm mà không phải chấm với ai; khi một đơn còn sống đến sau
   * và giành lấy quy kết, chính đại diện thành đơn trùng, và nó ghi lại "điểm lúc nhận vào cụm" =
   * 0. Kết luận vẫn đúng, nhưng hơn một nửa số dòng không nói được VÌ SAO — đúng thứ mà cột căn cứ
   * sinh ra để chống.
   *
   * Bất biến: dòng nào bị loại thì điểm phải ĐẠT NGƯỠNG và căn cứ phải khác rỗng. Không có ngoại lệ.
   */
  const daiDienThua = resolveDuplicates([base("a", 0, { alive: false }), base("b", 1, { customerId: "c", pancakeDuplicateFlag: true })]);
  const dongTrung = daiDienThua.find((v) => v.orderId === "a");
  assert.equal(dongTrung?.duplicateOfOrderId, "b", "đơn đã huỷ mở cụm vẫn phải nhường quy kết cho đơn còn sống");
  assert.ok((dongTrung?.score ?? 0) >= DUPLICATE_SCORE_THRESHOLD, `đơn đại diện bị loại vẫn phải mang điểm ĐẠT NGƯỠNG, không phải 0 (thực tế ${dongTrung?.score})`);
  assert.ok(dongTrung?.signals.includes("CANCELLED_SIBLING"), "và căn cứ phải nói đúng lý do: một đơn đã huỷ, đơn kia còn sống");

  /* ── 7c · ĐƠN ĐÃ HUỶ KHÔNG ĐƯỢC LÀM CẦU NỐI GIỮA HAI ĐƠN CÒN SỐNG ──
   *
   * SỰ CỐ THẬT (rà soát 14/09/2026, main e2cc4295): A đã huỷ 09:00 · B còn sống 09:05 · C còn
   * sống 10:00 — cùng khoá, cùng giá trị 499.000đ, không có hội thoại / bài viết / định danh
   * khách, Pancake không đánh dấu trùng.
   *
   * Cụm nhận thành viên bằng cách chấm với đơn SỚM NHẤT: A–B đạt ngưỡng nhờ `CANCELLED_SIBLING`,
   * A–C cũng đạt nhờ chính dấu hiệu đó. Nhưng đơn GIỮ QUY KẾT là B, và B–C chỉ có đúng một điểm
   * `SAME_VALUE` — dưới ngưỡng 4. C vẫn bị ghi là trùng của B với điểm 1: một lần bán có thật bị
   * xoá khỏi doanh thu của người bán nó, bằng một kết luận mà chính chứng cứ của nó bác bỏ.
   *
   * Bất biến: chứng cứ NHẬN VÀO CỤM phải chấm với đúng đơn mà kết luận sẽ trỏ tới.
   */
  const cauNoiDaHuy = resolveDuplicates([
    base("a", 0, { alive: false, orderValue: 499_000 }),
    base("b", 5 / 60, { orderValue: 499_000 }), // 09:05 — 5 phút sau A
    base("c", 1, { orderValue: 499_000 }), // 10:00 — 55 phút sau B
  ]);
  assert.equal(dupOf(cauNoiDaHuy, "a"), "b", "đơn đã huỷ vẫn nhường quy kết cho đơn còn sống sớm nhất");
  assert.equal(dupOf(cauNoiDaHuy, "b"), null, "đơn giữ quy kết không bao giờ tự là trùng của chính mình");
  assert.equal(
    dupOf(cauNoiDaHuy, "c"),
    null,
    "C chỉ nối với B qua MỘT điểm cùng-giá-trị — một đơn ĐÃ HUỶ không được làm cầu nối biến hai đơn còn sống thành một",
  );

  /* ── 7d · và cửa sổ vẫn KHÔNG trượt theo người giữ quy kết ──
   * A huỷ 00:00 (mở cụm) · B sống 00:00+ε giữ quy kết · C cùng hội thoại với B, 25 giờ sau A.
   * Nếu cửa sổ đo từ B thì C lọt vào; phải đo từ đơn SỚM NHẤT của cụm.
   */
  const khongTruotTheoNguoiGiu = resolveDuplicates([
    base("a", 0, { alive: false, conversationId: "c1" }),
    base("b", 0.5, { conversationId: "c1" }),
    base("c", 25, { conversationId: "c1" }),
  ]);
  assert.equal(dupOf(khongTruotTheoNguoiGiu, "c"), null, "quá 24 giờ tính từ đơn sớm nhất ⇒ cụm mới, dù cùng hội thoại với người giữ quy kết");

  // Bất biến ấy phải đúng trên MỌI kịch bản bài này dựng, không riêng ca vừa thử.
  for (const ketQua of [chiGanNhau, cungHoiThoai, huyRoiTao, ba, bon, khacGio, quaCuaSo, truot, hoa1, hoa2, daiDienThua, cauNoiDaHuy, khongTruotTheoNguoiGiu]) {
    for (const v of ketQua) {
      if (!v.duplicateOfOrderId) continue;
      assert.ok((v.score ?? 0) >= DUPLICATE_SCORE_THRESHOLD, `dòng trùng ${v.orderId} mang điểm ${v.score} — dưới ngưỡng thì không được kết luận trùng`);
      assert.ok(v.signals.length > 0, `dòng trùng ${v.orderId} không có căn cứ nào — một kết luận không giải thích được là một kết luận không kiểm lại được`);
    }
  }

  /* ── 8 · THIẾU CĂN CỨ ⇒ không bao giờ bị loại ── */
  const khongKhoa = resolveDuplicates([{ ...base("x", 0), dedupeKey: null }]);
  assert.equal(khongKhoa[0].duplicateOfOrderId, null);
  assert.equal(khongKhoa[0].score, null, "đơn không bị loại thì KHÔNG mang điểm chứng cứ");

  /* ── 9 · Sổ dấu hiệu phải tự nhất quán ── */
  const quyetDinh = Object.entries(DUPLICATE_SIGNALS).filter(([, v]) => v.weight >= DUPLICATE_SCORE_THRESHOLD);
  assert.equal(quyetDinh.length, 2, "đúng hai dấu hiệu quyết định (cùng hội thoại · huỷ-rồi-tạo-lại)");
  const yeu = Object.entries(DUPLICATE_SIGNALS).filter(([, v]) => v.weight < DUPLICATE_SCORE_THRESHOLD);
  assert.ok(yeu.length >= DUPLICATE_SCORE_THRESHOLD, "phải có đủ dấu hiệu yếu để đường thứ hai tồn tại được");
  for (const [k, v] of Object.entries(DUPLICATE_SIGNALS)) {
    assert.ok(v.label && v.hint, `dấu hiệu ${k} phải nói được nó là gì và vì sao — một điểm số không giải thích được thì không ai kiểm lại`);
  }

  console.log(
    `✓ Chứng cứ trùng đơn: cửa sổ ${DUPLICATE_CANDIDATE_WINDOW_HOURS}h CHỈ tìm ứng viên · ngưỡng ${DUPLICATE_SCORE_THRESHOLD} điểm · 2 dấu hiệu quyết định + ${yeu.length} dấu hiệu yếu · khác giỏ không bao giờ gặp nhau · tất định khi đổi thứ tự đầu vào`,
  );
}
