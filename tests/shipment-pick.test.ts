import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { chonVanDonDeGhep, vanDonDaiDien, type VanDonUngVien } from "@/lib/constants/shipment-pick";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import { upsertOrder } from "@/lib/integrations/pancake/sync";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { sql } from "drizzle-orm";

/**
 * ═══════════ MỘT ĐƠN GỬI HAI LẦN THÌ ĐỒNG BỘ PHẢI CHỌN ĐÚNG DÒNG ═══════════
 *
 * ĐO THẬT trên production 21/09/2026: lượt `orders_reconcile` 02:15 hỏng **23/492 đơn**, tất cả
 * cùng một câu — `duplicate key ... shipments_vtp_order_number_unique`, và mã bị trùng thuộc về
 * CHÍNH đơn đang đồng bộ (đơn 3459 có `PKE1519955287` lần gửi 1 và `PKE1523318522` lần gửi 2).
 *
 * Nguyên nhân: `orders.shipment` khai `one(...)` trên một khoá ngoại KHÔNG duy nhất, nên Drizzle
 * trả về một dòng bất kỳ. Nạp trúng lần gửi 1, Pancake nói về lần gửi 2 ⇒ mã khác nhau ⇒ mã nguồn
 * kết luận "lần gửi mới" ⇒ INSERT ⇒ đâm vào chính dòng lần gửi 2.
 *
 * Hậu quả không nằm ở dòng lỗi: cả lượt ghi của đơn ấy bị huỷ, nên **23 đơn không nhận được bất kỳ
 * cập nhật nào từ Pancake**, im lặng, mỗi mười lăm phút.
 *
 * Bài này khoá ba tính chất:
 *
 *   1. Luật chọn dòng — ba bậc chắc chắn, và chiều hoàn KHÔNG BAO GIỜ là ứng viên.
 *   2. Hồi quy đúng kịch bản production: gửi lần 2 rồi đồng bộ lại ⇒ KHÔNG đâm khoá, KHÔNG đẻ dòng
 *      thứ ba.
 *   3. Mã vận đơn thuộc đơn KHÁC vẫn phải dừng lại — và nói ra đơn nào đang giữ nó.
 */

const v = (o: Partial<VanDonUngVien>): VanDonUngVien => ({ vtpOrderNumber: null, trackingCode: null, attemptNo: 1, direction: "OUTBOUND", createdAt: null, ...o });

/* ═════════════ 1 · LUẬT THUẦN ═════════════ */

export function testChonVanDonPure() {
  const lan1 = v({ vtpOrderNumber: "PKE1519955287", trackingCode: "T1", attemptNo: 1, createdAt: new Date("2026-09-01T00:00:00Z") });
  const lan2 = v({ vtpOrderNumber: "PKE1523318522", trackingCode: "T2", attemptNo: 2, createdAt: new Date("2026-09-16T00:00:00Z") });

  // ───────── Bậc 1: mã vận đơn ĐVVC là danh tính chắc nhất ─────────
  assert.equal(chonVanDonDeGhep([lan1, lan2], { vtpOrderNumber: "PKE1523318522", trackingCode: null }), lan2, "đúng kịch bản 23 đơn hỏng trên production");
  assert.equal(chonVanDonDeGhep([lan1, lan2], { vtpOrderNumber: "PKE1519955287", trackingCode: null }), lan1, "Pancake nói về lần gửi cũ thì ghép vào lần gửi cũ");
  /* Thứ tự truyền vào KHÔNG được ảnh hưởng — đây chính là thứ `one()` không hứa. */
  assert.equal(chonVanDonDeGhep([lan2, lan1], { vtpOrderNumber: "PKE1519955287", trackingCode: null }), lan1);

  // ───────── Bậc 2: mã tra cứu ─────────
  assert.equal(chonVanDonDeGhep([lan1, lan2], { vtpOrderNumber: null, trackingCode: "T1" }), lan1);
  /* Mã vận đơn THẮNG mã tra cứu khi hai bậc chỉ về hai dòng khác nhau. */
  assert.equal(chonVanDonDeGhep([lan1, lan2], { vtpOrderNumber: "PKE1523318522", trackingCode: "T1" }), lan2, "bậc 1 phải thắng bậc 2");

  // ───────── Bậc 3: không mã nào ⇒ lần gửi MỚI NHẤT ─────────
  assert.equal(chonVanDonDeGhep([lan1, lan2], { vtpOrderNumber: null, trackingCode: null }), lan2, "ghép vào lần gửi đang chạy, không phải lần đã đóng");
  /*
    Hoà `attempt_no` thì lấy dòng tạo SAU — và `attempt_no` vẫn là căn cứ CHÍNH: một lượt nhập lại
    dữ liệu cũ có thể tạo dòng lần gửi 1 SAU dòng lần gửi 2, và mốc ghi khi ấy nói ngược.
  */
  const cuNhungTaoSau = v({ vtpOrderNumber: "X", attemptNo: 1, createdAt: new Date("2026-09-20T00:00:00Z") });
  assert.equal(chonVanDonDeGhep([cuNhungTaoSau, lan2], { vtpOrderNumber: null, trackingCode: null }), lan2, "số lần gửi là căn cứ chính, không phải mốc ghi");

  /*
    ───────── CHIỀU HOÀN KHÔNG BAO GIỜ LÀ ỨNG VIÊN ─────────

    Dòng chiều về là một vận đơn KHÁC (mã `<gốc>[số]P[số]`). Để Pancake ghi lên đó là xoá chứng từ
    chiều hoàn bằng dữ liệu chiều đi — AGENTS.md mục 3.7.
  */
  const hoan = v({ vtpOrderNumber: "PKE1523318522P1", direction: "RETURN", attemptNo: 9, createdAt: new Date("2026-09-19T00:00:00Z") });
  assert.equal(chonVanDonDeGhep([lan1, hoan], { vtpOrderNumber: null, trackingCode: null }), lan1, "chiều hoàn có số lần gửi lớn nhất vẫn KHÔNG được chọn");
  assert.equal(chonVanDonDeGhep([hoan], { vtpOrderNumber: null, trackingCode: null }), null, "chỉ có chiều hoàn ⇒ không có dòng nào để ghép, KHÔNG phải ghép bừa");
  /* Nhưng hỏi ĐÍCH DANH mã chiều hoàn thì vẫn không được trả nó về — luật lọc chiều đứng trước. */
  assert.equal(chonVanDonDeGhep([lan1, hoan], { vtpOrderNumber: "PKE1523318522P1", trackingCode: null }), lan1);

  // ───────── Dòng cũ chưa khai chiều = chiều đi ─────────
  const chuaKhai = v({ vtpOrderNumber: "Y", direction: null });
  assert.equal(chonVanDonDeGhep([chuaKhai], { vtpOrderNumber: null, trackingCode: null }), chuaKhai, "dữ liệu cũ không khai chiều thì vẫn là vận đơn của đơn ấy");

  assert.equal(chonVanDonDeGhep([], { vtpOrderNumber: "Z", trackingCode: null }), null);
}

/* ═════════════ 2 · HỒI QUY ĐÚNG KỊCH BẢN PRODUCTION ═════════════ */

const DON = "990477";

function donRaw(soLanGui: string | null, updatedAt: string) {
  const goc = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures-pancake-order.json"), "utf8")) as { data: Record<string, unknown> };
  return {
    ...goc.data,
    id: Number(DON),
    system_id: Number(DON),
    items: [],
    status: soLanGui ? 2 : 0,
    updated_at: updatedAt,
    partner: soLanGui
      ? { partner_id: 3, partner_name: "Viettel Post", extend_code: soLanGui, order_number_vtp: soLanGui, partner_status: "picked_up", total_fee: 30000, cod: 0, updated_at: updatedAt }
      : undefined,
  };
}

export async function testGuiLaiKhongDamKhoa() {
  const db = await getDb();

  // Lần gửi 1.
  const g1 = mapOrder(donRaw("PKE990000001", "2026-09-01T02:00:00"));
  assert.ok(g1);
  await upsertOrder(g1, { force: true });

  // Lần gửi 2 — mã mới ⇒ ĐÚNG là phải mở dòng mới (luật "mã mới = lần gửi mới", 10/09/2026).
  const g2 = mapOrder(donRaw("PKE990000002", "2026-09-16T02:00:00"));
  assert.ok(g2);
  await upsertOrder(g2, { force: true });
  const sauHaiLan = await db.query.shipments.findMany({ where: eq(schema.shipments.orderId, DON), columns: { vtpOrderNumber: true, attemptNo: true } });
  assert.equal(sauHaiLan.length, 2, "gửi lại bằng mã MỚI phải mở lần gửi thứ hai, không ghi đè lần đầu");

  /*
    ───────── ĐÂY LÀ LƯỢT ĐÃ HỎNG 23 ĐƠN MỖI MƯỜI LĂM PHÚT ─────────

    `orders_reconcile` đọc lại cùng đơn ấy với CÙNG mã lần gửi 2. Trước bản vá, dòng nạp về là lần
    gửi 1, mã khác nhau, và mã nguồn đi nhánh "lần gửi mới" — INSERT một mã đã tồn tại.
  */
  const doiChieu = mapOrder(donRaw("PKE990000002", "2026-09-17T02:00:00"));
  assert.ok(doiChieu);
  await upsertOrder(doiChieu, { force: true });

  const sauDoiChieu = await db.query.shipments.findMany({ where: eq(schema.shipments.orderId, DON), columns: { vtpOrderNumber: true, attemptNo: true } });
  assert.equal(sauDoiChieu.length, 2, "đối chiếu lại KHÔNG được đẻ dòng thứ ba");
  assert.deepEqual(
    sauDoiChieu.map((s) => s.vtpOrderNumber).sort(),
    ["PKE990000001", "PKE990000002"],
    "hai lần gửi còn nguyên, không lần nào bị ghi đè",
  );

  /*
    ───────── MÃ THUỘC ĐƠN KHÁC THÌ DỪNG, VÀ NÓI RA ĐƠN NÀO ─────────

    Sau bản vá, va chạm trong cùng một đơn không còn. Nhưng mã của đơn KHÁC vẫn là mâu thuẫn thật,
    và nó phải trả lời được "ai đang giữ mã ấy" thay vì ném một câu 23505 để người đọc tự đi tra.
  */
  const donKhac = mapOrder(donRaw("PKE990000002", "2026-09-18T02:00:00"));
  assert.ok(donKhac);
  await assert.rejects(
    () => upsertOrder({ ...donKhac, id: "990478" }, { force: true }),
    (e: Error) => e.message.includes("PKE990000002") && e.message.includes(DON),
    "phải nói rõ mã nào và đơn nào đang giữ nó",
  );
}

export async function cleanupShipmentPickFixtures() {
  const db = await getDb();
  for (const id of [DON, "990478"]) {
    await db.delete(schema.shipments).where(eq(schema.shipments.orderId, id));
    await db.delete(schema.orders).where(eq(schema.orders.id, id));
  }
}

/* ═════════════ 3 · HAI LUẬT, VÀ CHÚNG KHÔNG ĐƯỢC TRÔI XA NHAU ═════════════ */

/**
 * `chonVanDonDeGhep` (đường GHI) và `vanDonDaiDien` (đường ĐỌC) trả lời hai câu hỏi KHÁC nhau —
 * "bản tin nói về dòng nào" và "dòng nào đại diện cho đơn". Nhưng `vanDonDaiDien` phải khớp TỪNG
 * BẬC với `PRIMARY_ATTEMPT` ở tầng SQL, thứ mà mọi báo cáo tiền đang nối bằng.
 *
 * Lệch một bậc là màn hình in mã vận đơn của lần gửi này trong khi cột tiền ngay cạnh tính theo
 * lần gửi kia — AGENTS.md mục 41, nơi SQL và TypeScript lặng lẽ nói hai điều khác nhau. Nên bài
 * này chạy CẢ HAI bản trên CÙNG dữ liệu rồi so từng đơn, thay vì đọc hai đoạn mã rồi tin là giống.
 */
export async function testHaiLuatKhongTroiXaNhau() {
  const db = await getDb();
  const DON2 = "990479";
  await db.insert(schema.orders).values({ id: DON2, systemId: 990479, status: 2, statusName: "x", stage: "SHIPPED", insertedAt: new Date("2026-09-01T00:00:00Z") });
  const dong = [
    { orderId: DON2, attemptNo: 1, direction: "OUTBOUND", stage: "DELIVERED" as const, vtpOrderNumber: "PKE990000101", carrier: "Viettel Post" },
    { orderId: DON2, attemptNo: 2, direction: "OUTBOUND", stage: "IN_TRANSIT" as const, vtpOrderNumber: "PKE990000102", carrier: "Viettel Post" },
    { orderId: DON2, attemptNo: 3, direction: "OUTBOUND", stage: "PENDING" as const, vtpOrderNumber: "PKE990000103", carrier: "Viettel Post" },
  ];
  await db.insert(schema.shipments).values(dong);

  const rows = await db.query.shipments.findMany({ where: eq(schema.shipments.orderId, DON2) });
  const ts = vanDonDaiDien(rows);

  /*
    HỎI SQL BẰNG CHÍNH `PRIMARY_ATTEMPT`, không viết lại điều kiện.

    Viết lại là dựng bản thứ ba, và khi ấy bài kiểm chỉ chứng minh hai bản tôi vừa gõ giống nhau.
  */
  const sqlRows = await db
    .select({ id: schema.shipments.id })
    .from(schema.orders)
    .innerJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id} and ${PRIMARY_ATTEMPT}`)
    .where(eq(schema.orders.id, DON2));

  assert.equal(sqlRows.length, 1, "PRIMARY_ATTEMPT phải cho ĐÚNG một dòng cho mỗi đơn");
  assert.ok(ts, "bản TypeScript phải chọn được một dòng");
  assert.equal(ts.id, sqlRows[0].id, "bản TypeScript và PRIMARY_ATTEMPT phải chọn CÙNG một lần gửi");
  /* Và cả hai phải chọn lần ĐÃ GIAO, dù nó không phải lần gửi mới nhất. */
  assert.equal(ts.vtpOrderNumber, "PKE990000101", "lần tới tay khách thắng — lần gửi thay thế sau đó không xoá được sự thật ấy");

  /*
    VÀ ĐÂY LÀ CHỖ HAI LUẬT CỐ Ý KHÁC NHAU.

    Cùng dữ liệu ấy, một bản tin KHÔNG mang mã nào thuộc về lần gửi ĐANG CHẠY, không phải lần đã
    giao xong: ghi tình trạng hiện thời lên một vận đơn đã đóng là bôi lên chứng từ.
  */
  /*
    ───────── CHIỀU HOÀN KHÔNG ĐẠI DIỆN CHO ĐƠN — VÀ MỘT CHỖ LỆCH PHẢI NÓI RA ─────────

    `vanDonDaiDien` LOẠI dòng chiều hoàn; `PRIMARY_ATTEMPT` ở tầng SQL thì KHÔNG có vế ấy. Hai bên
    vẫn cho cùng kết quả hôm nay, và lý do là một phép ĐO chứ không phải một niềm tin: vận đơn
    chiều về mang `order_id NULL` (AGENTS.md mục 3.7), production 21/09/2026 có **0 dòng `RETURN`
    gắn vào đơn**. Nên tập ứng viên của SQL không bao giờ chứa dòng chiều hoàn.
    Nếu một ngày có, bài kiểm ngay trên sẽ đỏ — và lúc đó phải sửa `PRIMARY_ATTEMPT`, không phải
    gỡ vế lọc ở đây. Lọc ở phía TypeScript là phía HẸP hơn (mục 31).
  */
  /*
    Dòng chiều hoàn này mang `stage = DELIVERED` — KHÔNG phải tình huống bịa: Viettel Post ghi
    "Phát thành công" (mã 501) cho CẢ chiều hoàn, và đó chính là cái bẫy mà `leg_type` sinh ra để
    chặn (AGENTS.md mục 3.2). Nếu vế lọc chiều bị gỡ, dòng này thắng ở bậc "đã giao" VÀ ở bậc số
    lần gửi — nghĩa là màn hình sẽ in vận đơn CHIỀU VỀ làm vận đơn của đơn.
  */
  const hoanGanVaoDon = { ...dong[2], attemptNo: 9, direction: "RETURN", vtpOrderNumber: "PKE990000103P1", stage: "DELIVERED" as const };
  const coHoan = vanDonDaiDien([...rows, { ...rows[0], ...hoanGanVaoDon, id: "gia-lap-hoan" }]);
  assert.equal(coHoan?.id, ts.id, "dòng chiều hoàn KHÔNG được đại diện cho đơn, dù số lần gửi lớn nhất");

  const deGhi = chonVanDonDeGhep(rows, { vtpOrderNumber: null, trackingCode: null });
  assert.equal(deGhi?.vtpOrderNumber, "PKE990000103", "đường GHI đi theo lần gửi đang chạy");
  assert.notEqual(deGhi?.id, ts.id, "hai câu hỏi khác nhau thì được phép ra hai câu trả lời — và bài kiểm nói rõ điều đó");

  await db.delete(schema.shipments).where(eq(schema.shipments.orderId, DON2));
  await db.delete(schema.orders).where(eq(schema.orders.id, DON2));
}

/* ═════════════ 4 · CÁI BẪY KHÔNG ĐƯỢC MỌC LẠI Ở BẢNG KHÁC ═════════════ */

export function testKhongCoOneTrenKhoaNgoaiKhongDuyNhat() {
  const schemaSrc = readFileSync(path.join(process.cwd(), "db/schema.ts"), "utf8");
  /*
    Mọi `one(...)` phải trỏ vào cột `id` của bảng đích — tức khoá chính, tức DUY NHẤT.

    `orders.shipment` từng trỏ vào `shipments.orderId`, một khoá ngoại KHÔNG duy nhất, và Drizzle
    khi ấy trả về một dòng BẤT KỲ. Nó đã tốn 23 đơn không đồng bộ được mỗi mười lăm phút. Quan hệ
    ấy đã bị gỡ; bài kiểm này là thứ giữ cho nó không mọc lại ở một bảng khác — nơi lần sau sẽ
    không ai nghĩ tới.
  */
  const re = /(\w+): one\((\w+), \{ fields: \[(\w+)\.(\w+)\], references: \[(\w+)\.(\w+)\] \}/g;
  const xau: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaSrc))) {
    const [, ten, , , , bangRef, cotRef] = m;
    if (cotRef !== "id") xau.push(`${ten} → ${bangRef}.${cotRef}`);
  }
  assert.deepEqual(xau, [], `quan hệ one(...) phải trỏ vào khoá chính; những quan hệ sau trỏ vào cột có thể trùng: ${xau.join(" · ")}`);
  assert.ok(re.source.length > 0);
}
