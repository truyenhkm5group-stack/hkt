import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { fanpageAccessStatus, fanpageDisplayName } from "@/lib/constants/fanpage-access";
import { judgePageEvidence, type EvidenceOrder } from "@/lib/attribution/fanpage-evidence";
import { assignFanpageMarketer, rebuildFanpageAttribution, setFanpageAlias, syncFanpageRegistry } from "@/lib/attribution/fanpage";

/**
 * ═══════════ FANPAGE LỊCH SỬ: QUẢN LÝ ĐƯỢC KHI API KHÔNG CÒN ĐỌC ĐƯỢC TÊN ═══════════
 *
 * Bài này khoá đúng chỗ đã làm 129 đơn treo trên production: màn hình khai báo chỉ hiện một dãy 15
 * chữ số vì Pancake không trả tên, nên không ai gán nổi marketer cho page nào. Quy kết vốn đi bằng
 * `page_id` — thứ thiếu chỉ là một cái tên cho NGƯỜI đọc.
 */

const P = "fph-";
const at = (day: number, hour = 9) => new Date(Date.UTC(2024, 5, day, hour));

export function testFanpageAccessPure() {
  const t1 = new Date(Date.UTC(2024, 5, 1));
  const t2 = new Date(Date.UTC(2024, 5, 2));

  assert.equal(fanpageAccessStatus(t2, t2), "ACTIVE", "thấy trong lần liệt kê gần nhất");
  assert.equal(fanpageAccessStatus(t1, t2), "HISTORICAL", "mốc cũ hơn lần liệt kê gần nhất ⇒ không còn quyền");
  assert.equal(fanpageAccessStatus(null, t2), "HISTORICAL", "chưa bao giờ thấy ⇒ page lịch sử");
  /*
    NHÁNH QUAN TRỌNG NHẤT: API chưa bao giờ gọi được thì KHÔNG kết luận gì.
    Ngày 15/09/2026 Pancake trả HTTP 502 cho cả danh sách page. Nếu trạng thái được LƯU thay vì SUY
    RA, đúng hôm ấy cả 15 page bị ghi "mất quyền" và không có gì sửa lại được.
  */
  assert.equal(fanpageAccessStatus(null, null), "UNKNOWN", "chưa lần nào đọc được danh sách ⇒ CHƯA XÁC ĐỊNH, không phải 'mất quyền'");
  assert.equal(fanpageAccessStatus(t1, null), "UNKNOWN");

  // Tên hiển thị: tên NGƯỜI đặt thắng tên API, cuối cùng mới tới Page ID.
  assert.equal(fanpageDisplayName({ alias: "Page cũ của Hiếu", name: "Tên API", externalPageId: "123" }), "Page cũ của Hiếu");
  assert.equal(fanpageDisplayName({ alias: "", name: "Tên API", externalPageId: "123" }), "Tên API");
  assert.equal(fanpageDisplayName({ alias: "", name: "", externalPageId: "123" }), "123", "không có tên nào thì hiện Page ID — KHÔNG hiện chuỗi rỗng");

  console.log("✓ Trạng thái truy cập fanpage: suy ra từ hai mốc · API lỗi ⇒ CHƯA XÁC ĐỊNH (không kết luận mất quyền) · alias thắng tên API");
}

export function testPageEvidencePure() {
  const o = (pageId: string, day: number, marketerId: string | null): EvidenceOrder => ({ pageId, orderAt: at(day), marketerId });

  // 1 · Một marketer duy nhất ⇒ gán được, hiệu lực từ ngày SỚM NHẤT CÓ BẰNG CHỨNG.
  const motNguoi = judgePageEvidence([o("p1", 10, null), o("p1", 12, "an"), o("p1", 14, "an")]);
  assert.equal(motNguoi[0].verdict, "PROVABLE");
  assert.equal(motNguoi[0].marketerId, "an");
  assert.equal(motNguoi[0].ordersBeforeEvidence, 1, "đơn ngày 10 nằm TRƯỚC bằng chứng ⇒ vẫn chưa quy kết");
  assert.ok(motNguoi[0].effectiveFrom && motNguoi[0].effectiveFrom.getTime() <= at(12).getTime(), "hiệu lực phải trùm ngày có bằng chứng sớm nhất");
  assert.ok(motNguoi[0].effectiveFrom && motNguoi[0].effectiveFrom.getTime() > at(10, 23).getTime(), "nhưng KHÔNG được lùi về trước ngày đó");

  /*
    2 · CA THẬT trên production: page `757928024065008` có đơn từ 19/08/2025 nhưng bằng chứng quảng
    cáo sớm nhất là 08/09/2026 — cách nhau MƯỜI BA THÁNG. Suy người phụ trách hôm nay ngược về một
    năm trước là bịa, nên đơn cũ phải Ở LẠI trạng thái chưa quy kết.
  */
  const cachXa = judgePageEvidence([
    { pageId: "p2", orderAt: new Date(Date.UTC(2025, 7, 19)), marketerId: null },
    { pageId: "p2", orderAt: new Date(Date.UTC(2026, 8, 8)), marketerId: "hieu" },
  ]);
  assert.equal(cachXa[0].verdict, "PROVABLE");
  assert.equal(cachXa[0].ordersBeforeEvidence, 1, "đơn cách bằng chứng 13 tháng KHÔNG được gán theo");

  // 3 · Hai marketer ⇒ nhập nhằng ⇒ KHÔNG gán gì.
  const haiNguoi = judgePageEvidence([o("p3", 10, "an"), o("p3", 11, "binh")]);
  assert.equal(haiNguoi[0].verdict, "AMBIGUOUS");
  assert.equal(haiNguoi[0].marketerId, null, "nhập nhằng thì KHÔNG mang tên ai — chọn bừa là ghi doanh thu lên nhầm người");

  // 4 · Không bằng chứng nào ⇒ để nguyên.
  const khongCo = judgePageEvidence([o("p4", 10, null), o("p4", 11, null)]);
  assert.equal(khongCo[0].verdict, "NO_EVIDENCE");
  assert.equal(khongCo[0].effectiveFrom, null);

  // 5 · TẤT ĐỊNH: đổi thứ tự đầu vào không đổi kết quả.
  const xuoi = judgePageEvidence([o("p5", 10, "an"), o("p5", 11, "an")]);
  const nguoc = judgePageEvidence([o("p5", 11, "an"), o("p5", 10, "an")]);
  assert.deepEqual(xuoi, nguoc, "kết quả phải là hàm thuần của dữ liệu, không phụ thuộc thứ tự");

  console.log("✓ Bằng chứng fanpage: một người ⇒ gán từ mốc CÓ bằng chứng · nhập nhằng ⇒ không gán · không bằng chứng ⇒ để nguyên · tất định");
}

export async function testFanpageHistoryDb() {
  const db = await getDb();
  const PAGE = `${P}page-lich-su`;

  // Đơn trên một page mà API Pancake KHÔNG liệt kê (token không còn quyền) ⇒ `name` rỗng.
  await db
    .insert(schema.orders)
    .values([
      { id: `${P}o1`, stage: "CONFIRMED", insertedAt: at(10), pageId: PAGE, shipPhone: "0912000001", shipFullName: "Khách A", shipFullAddress: "1 A", totalPriceAfterDiscount: 300_000, source: "Facebook" },
      { id: `${P}o2`, stage: "CONFIRMED", insertedAt: at(20), pageId: PAGE, shipPhone: "0912000002", shipFullName: "Khách B", shipFullAddress: "2 B", totalPriceAfterDiscount: 400_000, source: "Facebook" },
    ])
    .onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values([
      { id: `${P}o1-i0`, orderId: `${P}o1`, sku: "FPH-A", productName: "FPH-A", quantity: 1, unitPrice: 300_000 },
      { id: `${P}o2-i0`, orderId: `${P}o2`, sku: "FPH-B", productName: "FPH-B", quantity: 1, unitPrice: 400_000 },
    ])
    .onConflictDoNothing();

  await syncFanpageRegistry(db);
  const [page] = await db.select().from(schema.fanpages).where(eq(schema.fanpages.externalPageId, PAGE)).limit(1);
  assert.ok(page, "page phải vào sổ dù API không đọc được tên");
  assert.equal(page.name, "", "API không liệt kê ⇒ tên rỗng");
  assert.equal(page.lastSeenInApiAt, null, "và KHÔNG có mốc liệt kê — đó là dấu hiệu 'page lịch sử'");
  assert.equal(fanpageDisplayName(page), PAGE, "màn hình phải hiện Page ID thay vì một ô trống");

  /* ═══ 1 · PAGE KHÔNG CÒN QUYỀN VẪN GÁN ĐƯỢC MARKETER BẰNG PAGE_ID ═══ */

  const gan = await assignFanpageMarketer({ fanpageId: page.id, marketerId: `${P}mkt-hieu`, effectiveFrom: at(15) }, db);
  assert.ok(!("error" in gan), "gán marketer KHÔNG được phụ thuộc vào việc API còn đọc được tên page");

  /* ═══ 2 · ĐẶT TÊN GỢI NHỚ: đổi NHÃN, không bao giờ đổi DANH TÍNH ═══ */

  const doiTen = await setFanpageAlias(page.id, "Page cũ của Hiếu", db);
  assert.ok(!("error" in doiTen));
  const [sauDoiTen] = await db.select().from(schema.fanpages).where(eq(schema.fanpages.id, page.id)).limit(1);
  assert.equal(sauDoiTen.alias, "Page cũ của Hiếu");
  assert.equal(sauDoiTen.externalPageId, PAGE, "PAGE_ID PHẢI GIỮ NGUYÊN — mọi đơn đã quy kết đều trỏ tới nó");
  assert.equal(sauDoiTen.name, "", "và alias KHÔNG được ghi đè lên tên của API");
  assert.equal(fanpageDisplayName(sauDoiTen), "Page cũ của Hiếu", "tên người đặt thắng khi hiển thị");

  // Đồng bộ lại: API vẫn không liệt kê page này ⇒ alias phải còn nguyên.
  await syncFanpageRegistry(db);
  const [sauDongBo] = await db.select().from(schema.fanpages).where(eq(schema.fanpages.id, page.id)).limit(1);
  assert.equal(sauDongBo.alias, "Page cũ của Hiếu", "ĐỒNG BỘ KHÔNG ĐƯỢC CHẠM VÀO TÊN NGƯỜI ĐẶT");
  assert.equal(sauDongBo.externalPageId, PAGE);

  /* ═══ 3 · PHÂN CÔNG LỊCH SỬ KHÔNG ĐỔI QUY KẾT CỦA ĐƠN NGOÀI KHOẢNG HIỆU LỰC ═══ */

  await rebuildFanpageAttribution({ db });
  clearMemo();
  const quyKet = async (id: string) => (await db.select().from(schema.orderAttributions).where(eq(schema.orderAttributions.orderId, id)).limit(1))[0];
  const truoc = await quyKet(`${P}o1`);
  const sau = await quyKet(`${P}o2`);
  assert.equal(truoc?.status, "NO_ASSIGNMENT", "đơn ngày 10 nằm TRƯỚC mốc hiệu lực 15 ⇒ vẫn chưa quy kết");
  assert.equal(truoc?.marketerId, null, "và tuyệt đối không mang tên ai");
  assert.equal(sau?.status, "ATTRIBUTED", "đơn ngày 20 nằm trong khoảng ⇒ quy kết được");
  assert.equal(sau?.marketerId, `${P}mkt-hieu`);

  /* ═══ 4 · ĐỐI SOÁT LẠI KHÔNG CỘNG ĐÚP ═══ */

  const lan2 = await rebuildFanpageAttribution({ db });
  assert.equal(lan2.changed, 0, "chạy lại ngay ⇒ không dòng nào đổi (idempotent)");
  const [dem] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.orderAttributions)
    .where(sql`${schema.orderAttributions.orderId} like ${`${P}%`}`);
  const [demDon] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.orders)
    .where(sql`${schema.orders.id} like ${`${P}%`}`);
  assert.equal(Number(dem.n), Number(demDon.n), "mỗi đơn đúng một dòng quy kết");

  /* ═══ 5 · ĐƠN KHÔNG CÓ PAGE_ID KHÔNG BAO GIỜ TỰ ĐƯỢC GÁN MARKETER ═══ */

  await db
    .insert(schema.orders)
    .values({ id: `${P}o-nopage`, stage: "CONFIRMED", insertedAt: at(20), pageId: null, shipPhone: "0912000003", shipFullName: "Khách C", shipFullAddress: "3 C", totalPriceAfterDiscount: 500_000, source: "Khác" })
    .onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: `${P}o-nopage-i0`, orderId: `${P}o-nopage`, sku: "FPH-C", productName: "FPH-C", quantity: 1, unitPrice: 500_000 })
    .onConflictDoNothing();
  await rebuildFanpageAttribution({ db });
  const khongPage = await quyKet(`${P}o-nopage`);
  assert.equal(khongPage?.status, "NO_PAGE", "đơn không có nguồn fanpage phải ở NO_PAGE");
  assert.equal(khongPage?.marketerId, null, "và KHÔNG bao giờ được gán marketer chỉ để làm hết số treo");

  console.log("✓ Fanpage lịch sử: page mất quyền vẫn gán được bằng Page ID · alias không đụng page_id và đồng bộ không xoá · đơn ngoài khoảng hiệu lực giữ nguyên · đối soát không cộng đúp · NO_PAGE không tự gán");
}
