import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { chonVanDonDeGhep, type VanDonUngVien } from "@/lib/constants/shipment-pick";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import { upsertOrder } from "@/lib/integrations/pancake/sync";

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
