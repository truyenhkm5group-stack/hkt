import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DELIVERY_BUCKETS, EXCLUSIVE_BUCKETS } from "@/lib/constants/delivery-tower";
import { getDeliveryTower, tongRoThat } from "@/lib/queries/delivery-tower";

/**
 * ═══════════ THÁP ĐIỀU KHIỂN GIAO VẬN: MỖI KIỆN ĐÚNG MỘT RỔ ═══════════
 *
 * VÌ SAO CẦN KHOÁ. Rổ được quyết bằng một chuỗi điều kiện trên bốn thứ: chặng, mã lý do ĐVVC, ghi
 * chú bưu tá, và tuổi sự kiện. Đảo thứ tự một nhánh là một kiện nằm hai rổ — tổng lớn hơn dân số
 * thật, tiền bị cộng hai lần, và không lỗi nào phát ra.
 *
 * Bài kiểm này cũng khoá hai ranh giới nghiệp vụ:
 *
 *  · **Rổ tổng hợp không được cộng vào tổng.** "Cần care hôm nay" cố ý chồng lên ba rổ đầu. Nếu
 *    một ngày nào đó nó bị tính như rổ thường, mọi con số ngoại lệ sẽ phồng lên gần gấp đôi.
 *  · **Im lặng KHÔNG đổi kết quả đơn.** Kiện vào rổ "quá lâu không cập nhật" phải giữ nguyên chặng
 *    của nó. Tháp chỉ nói "cần hỏi", không bao giờ nói "chắc đã giao / chắc đã hoàn".
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/delivery-tower.test.ts
 */
export async function testDeliveryTower(db: Db) {
  // ───────── 0. Hợp đồng rổ ─────────
  const thuTu = DELIVERY_BUCKETS.map((b) => b.order);
  assert.deepEqual(thuTu, [...thuTu].sort((a, b) => a - b), "rổ phải khai theo đúng thứ tự xét");
  assert.equal(new Set(DELIVERY_BUCKETS.map((b) => b.key)).size, DELIVERY_BUCKETS.length, "trùng khoá rổ");
  for (const b of DELIVERY_BUCKETS) {
    assert.ok(b.moneyMeaning.length > 30, `${b.key} phải nói TIỀN TRONG RỔ NGHĨA LÀ GÌ`);
    assert.ok(b.nextAction.length > 20, `${b.key} phải nói việc nên làm`);
    assert.ok(b.question.length > 10, `${b.key} phải nói nó trả lời câu hỏi nào`);
  }
  assert.equal(DELIVERY_BUCKETS.filter((b) => b.rollupOf).length, 1, "chỉ được có đúng MỘT rổ tổng hợp");
  assert.equal(EXCLUSIVE_BUCKETS.length, DELIVERY_BUCKETS.length - 1);

  // ───────── 1. Dàn cảnh: mỗi kiện một tình huống ─────────
  const gio = (h: number) => new Date(Date.now() - h * 3_600_000);
  const don = async (id: string, sysId: number) => {
    await db
      .insert(schema.orders)
      .values({ id, systemId: sysId, billFullName: `Khách ${sysId}`, billPhone: `090000${sysId}`, totalPriceAfterDiscount: 500000, insertedAt: gio(200), stage: "CONFIRMED" })
      .onConflictDoNothing();
  };
  type Kien = { id: string; stage: "PENDING" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERY_FAILED" | "RETURNING" | "RETURNED"; reason?: number; note?: string; tuoi: number | null; final?: boolean; cod?: number };
  const kien: Kien[] = [
    { id: "dt-nocontact", stage: "DELIVERY_FAILED", reason: 36, tuoi: 5, cod: 700000 },
    { id: "dt-hen", stage: "DELIVERY_FAILED", reason: 35, tuoi: 5, cod: 300000 },
    { id: "dt-note-nocontact", stage: "DELIVERY_FAILED", note: "khách không nghe máy, gọi 3 lần", tuoi: 6, cod: 200000 },
    { id: "dt-tuchoi", stage: "DELIVERY_FAILED", note: "khách từ chối nhận hàng", tuoi: 6, cod: 400000 },
    { id: "dt-stale", stage: "OUT_FOR_DELIVERY", tuoi: 100, cod: 900000 },
    { id: "dt-tuoi-ok", stage: "OUT_FOR_DELIVERY", tuoi: 2, cod: 500000 },
    { id: "dt-chom-cu", stage: "OUT_FOR_DELIVERY", tuoi: 30, cod: 600000 },
    { id: "dt-hoan-di", stage: "RETURNING", tuoi: 10, cod: 100000 },
    { id: "dt-hoan-ve", stage: "RETURNED", tuoi: 10, final: true, cod: 100000 },
    { id: "dt-mu", stage: "IN_TRANSIT", tuoi: null, cod: 800000 },
  ];
  let i = 1;
  for (const k of kien) {
    const orderId = `${k.id}-o`;
    await don(orderId, 9000 + i);
    await db
      .insert(schema.shipments)
      .values({
        id: k.id,
        orderId,
        carrier: "VTP",
        trackingCode: k.id.toUpperCase(),
        vtpOrderNumber: `V${k.id}`,
        stage: k.stage,
        isFinal: k.final ?? false,
        vtpReasonCode: k.reason ?? null,
        vtpNote: k.note ?? "",
        vtpStatusName: "Trạng thái thử",
        codAmount: k.cod ?? 0,
        receiverName: `Khách ${9000 + i}`,
        receiverPhone: `090000${i}`,
        createdAt: gio(240),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    if (k.tuoi !== null) {
      await db
        .insert(schema.shipmentEvents)
        .values({ shipmentId: k.id, source: "VTP_WEBHOOK", status: "500", statusName: "Sự kiện thử", note: k.note ?? "", occurredAt: gio(k.tuoi), normalizedStage: k.stage === "DELIVERY_FAILED" ? "DELIVERY_FAILED" : null })
        .onConflictDoNothing();
    }
    i += 1;
  }

  clearMemo();
  const thap = await getDeliveryTower();
  const cua = (id: string) => thap.buckets.filter((b) => !b.rollupOf).filter((b) => b.rows.some((r) => r.shipmentId === id));

  // ───────── 2. MỖI KIỆN ĐÚNG MỘT RỔ ─────────
  for (const k of kien) {
    const ro = cua(k.id);
    assert.ok(ro.length <= 1, `${k.id} nằm ${ro.length} rổ cùng lúc: ${ro.map((b) => b.key).join(", ")}`);
  }
  const tong = tongRoThat(thap);
  const rieng = new Set(thap.buckets.filter((b) => !b.rollupOf).flatMap((b) => b.rows.map((r) => r.shipmentId)));
  assert.equal(tong, rieng.size, "tổng các rổ THẬT phải bằng số kiện riêng biệt — có kiện bị đếm hai lần");
  assert.equal(tong, thap.exceptions, "tổng rổ thật phải bằng số kiện ngoại lệ");

  // ───────── 3. XẾP ĐÚNG CHỖ ─────────
  const roCua = (id: string) => cua(id)[0]?.key ?? null;
  assert.equal(roCua("dt-nocontact"), "NO_CONTACT", "mã lý do 36 của ĐVVC = không liên lạc được");
  assert.equal(roCua("dt-hen"), "AWAITING_REDELIVERY", "mã lý do 35 = đã hẹn phát lại, còn cửa giao");
  assert.equal(roCua("dt-note-nocontact"), "NO_CONTACT", "không có mã thì đọc ghi chú bưu tá");
  assert.equal(roCua("dt-tuchoi"), "DELIVERY_FAILED", "khách từ chối KHÔNG phải nhóm hẹn lại — khả năng cứu khác hẳn");
  assert.equal(roCua("dt-stale"), "STALE_NO_UPDATE", "đang đi giao im 100 giờ (ngưỡng 48) phải vào rổ cũ nghiêm trọng");
  assert.equal(roCua("dt-hoan-di"), "RETURNING");
  assert.equal(roCua("dt-hoan-ve"), "RETURN_AT_SHOP", "hoàn đã về shop mà kho chưa đếm vẫn phải thấy, dù ĐVVC coi là xong");
  assert.equal(roCua("dt-mu"), "DATA_GAP", "chưa từng có sự kiện nào ⇒ lỗ hổng dữ liệu, KHÔNG phải kiện khoẻ");

  /*
    ═══ ĐO KHÔNG CÓ NGHĨA LÀ PHẢI SINH VIỆC ═══

    Kiện im 30 giờ ở chặng đang đi giao đã quá ngưỡng "cũ" (24h) nhưng chưa tới ngưỡng NGHIÊM TRỌNG
    (48h). Nó phải được ĐO — và bị ĐẨY RA KHỎI rổ việc. Đo trên production 11/09/2026: bỏ ranh giới
    này là 182 kiện đổ vào rổ thay vì 18, và một danh sách không ai làm hết được thì cũng không ai
    mở lần thứ hai.
  */
  assert.equal(roCua("dt-chom-cu"), null, "kiện mới chớm cũ phải nằm ngoài rổ việc — đo, không sinh việc");
  assert.equal(roCua("dt-tuoi-ok"), null, "kiện tươi không được vào rổ nào");

  // ───────── 4. RỔ TỔNG HỢP GỘP ĐÚNG BA RỔ, VÀ KHÔNG ĐƯỢC CỘNG VÀO TỔNG ─────────
  const care = thap.buckets.find((b) => b.key === "CARE_TODAY")!;
  const baRo = ["NO_CONTACT", "DELIVERY_FAILED", "AWAITING_REDELIVERY"];
  const tongBa = thap.buckets.filter((b) => baRo.includes(b.key)).reduce((a, b) => a + b.count, 0);
  assert.equal(care.count, tongBa, "rổ tổng hợp phải bằng đúng tổng ba rổ nó gộp");
  assert.ok(care.count > 0 && tong < tong + care.count, "rổ tổng hợp có kiện nhưng KHÔNG được cộng vào tổng");

  // ───────── 5. IM LẶNG KHÔNG ĐỔI KẾT LUẬN ĐƠN ─────────
  const dongStale = thap.buckets.find((b) => b.key === "STALE_NO_UPDATE")!.rows.find((r) => r.shipmentId === "dt-stale")!;
  assert.equal(dongStale.stage, "OUT_FOR_DELIVERY", "kiện im lâu vẫn giữ nguyên chặng — tháp KHÔNG được suy ra 'chắc đã giao'");
  assert.ok(dongStale.lastEventAgeHours !== null && dongStale.lastEventAgeHours >= 48);

  // Cột thô và cột chuẩn hoá phải cùng có mặt: lệch giữa hai bên là thứ duy nhất phát hiện sai ánh xạ.
  assert.ok(dongStale.rawStatus.length > 0 && dongStale.stageLabel.length > 0, "phải hiện CẢ trạng thái thô của VTP lẫn cách ERP hiểu");

  // ───────── 6. BỘ DÒ VIỆC KHÔNG ĐƯỢC QUAY VỀ `updated_at` ─────────
  /*
    `updated_at` bị chạm bởi mọi lần ghi vào dòng vận đơn — nhập bảng kê COD, ghép đợt tiền. Dùng nó
    làm mốc "im lặng" khiến 182 kiện treo thật chỉ hiện ra 6. Nếu ai đó đổi lại, bài kiểm này đỏ.
  */
  const rules = fs.readFileSync(path.join(path.resolve(__dirname, ".."), "lib/alerts/rules.ts"), "utf8");
  const khoiStale = rules.slice(rules.indexOf("if (cfg.enabled.stale)"), rules.indexOf("if (cfg.enabled.returning)"));
  assert.ok(/MOC_DVVC/.test(khoiStale), "luật vận đơn treo phải đo từ SỰ KIỆN ĐVVC");
  assert.ok(!/lte\(sql`coalesce\(\$\{s\.vtpStatusDate\}, \$\{s\.updatedAt\}\)`/.test(khoiStale), "KHÔNG được quay lại đo im lặng bằng updated_at");
  assert.ok(/dedupeKey: `ship-stale:\$\{r\.shipmentId\}`/.test(khoiStale), "một kiện MỘT việc: khoá chống trùng không được kèm ngày, kẻo mỗi ngày đẻ thêm một việc");

  console.log(
    `✓ Tháp giao vận: ${thap.exceptions}/${thap.tracked} kiện vào ${EXCLUSIVE_BUCKETS.length} rổ, mỗi kiện đúng một rổ · rổ tổng hợp ${care.count} kiện KHÔNG cộng vào tổng · ` +
      `kiện chớm cũ được đo nhưng không sinh việc · im lặng 100 giờ vẫn giữ nguyên chặng`,
  );
}
