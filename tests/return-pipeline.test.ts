import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { RETURN_PIPELINE } from "@/lib/constants/return-pipeline";
import { getReturnPipeline, worstReturnStage } from "@/lib/queries/return-pipeline";

/**
 * ═══════════ ĐƯỜNG ỐNG HÀNG HOÀN: MỖI KIỆN ĐÚNG MỘT KHÂU ═══════════
 *
 * VÌ SAO CẦN KHOÁ. Khâu của một kiện được quyết bằng MỘT chuỗi `case` trên năm mốc khác nhau
 * (`shipments.stage`, `return_received_at`, `return_inspections.status`, `condition`,
 * `stock_receipt_id`). Chuỗi đó phải xét từ trạng thái MUỘN nhất về sớm nhất — đảo thứ tự một
 * nhánh là một kiện đã đếm xong bị xếp lại vào "chờ đếm", và tiền của nó bị cộng vào cả hai chỗ.
 *
 * Không lỗi nào phát ra: bảng vẫn hiện, số vẫn ra, chỉ là tổng vốn kẹt lớn hơn sự thật.
 *
 * Bài kiểm dựng đủ NĂM tình huống trên cùng một bộ dữ liệu rồi khoá ba điều:
 *  1. tổng số kiện của các khâu = đúng dân số, không thừa không thiếu;
 *  2. mỗi kiện chỉ xuất hiện một lần;
 *  3. vốn KẸT không bao gồm kiện đã vào lại tồn hay đã kết luận mất.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/return-pipeline.test.ts
 */
export async function testReturnPipeline(db: Db) {
  // ───────── 0. Hợp đồng khâu: đủ ô để dùng được, thứ tự không trùng ─────────
  const thuTu = RETURN_PIPELINE.map((s) => s.order);
  assert.deepEqual(thuTu, [...thuTu].sort((a, b) => a - b), "khâu phải khai theo đúng thứ tự dòng chảy");
  assert.equal(new Set(thuTu).size, thuTu.length, "hai khâu trùng số thứ tự");
  assert.equal(new Set(RETURN_PIPELINE.map((s) => s.key)).size, RETURN_PIPELINE.length, "trùng khoá khâu");
  for (const s of RETURN_PIPELINE) {
    assert.ok(s.moneyMeaning.length > 30, `${s.key} phải nói TIỀN Ở ĐÂY NGHĨA LÀ GÌ`);
    assert.ok(s.href.startsWith("/"), `${s.key} phải có đường tra ngược`);
    // Khâu không ai làm gì được thì KHÔNG được đặt hạn — đặt hạn ở đó chỉ tạo số trễ hạn giả.
    if (!s.actionable) assert.equal(s.slaHours, null, `${s.key} không có việc để làm thì không được đặt hạn`);
  }

  // ───────── 1. Dàn cảnh: năm kiện, năm khâu khác nhau ─────────
  await db.insert(schema.products).values({ id: "rp-prod", name: "Áo đường ống hoàn" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: "rp-var", productId: "rp-prod", sku: "RP-001", color: "Đen", size: "L", retailPrice: 400000 }).onConflictDoNothing();

  const canh: { id: string; stage: "RETURNING" | "RETURNED"; nhan?: Date | null; kiem?: "RECEIVED" | "INSPECTED"; dieuKien?: string; phieu?: boolean }[] = [
    { id: "rp-1", stage: "RETURNING" },
    { id: "rp-2", stage: "RETURNED" },
    { id: "rp-3", stage: "RETURNED", nhan: new Date("2026-09-01T00:00:00Z"), kiem: "RECEIVED" },
    { id: "rp-4", stage: "RETURNED", nhan: new Date("2026-09-01T00:00:00Z"), kiem: "INSPECTED", dieuKien: "DAMAGED" },
    { id: "rp-5", stage: "RETURNED", nhan: new Date("2026-09-01T00:00:00Z"), kiem: "INSPECTED", dieuKien: "RESTOCKABLE", phieu: true },
  ];

  const [phieuNhap] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RETURN", receivedAt: new Date("2026-09-02T00:00:00Z"), reference: "RP-TAI-NHAP", totalQuantity: 1, totalCost: 0, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });

  for (const c of canh) {
    await db.insert(schema.orders).values({ id: `${c.id}-o`, stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-01T00:00:00Z") }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({ id: c.id, orderId: `${c.id}-o`, vtpOrderNumber: c.id.toUpperCase(), stage: c.stage, returnedAt: new Date("2026-08-20T00:00:00Z"), returnReceivedAt: c.nhan ?? null })
      .onConflictDoNothing();
    if (c.kiem) {
      await db
        .insert(schema.returnInspections)
        .values({
          shipmentId: c.id,
          orderId: `${c.id}-o`,
          status: c.kiem,
          receivedAt: c.nhan ?? new Date(),
          receivedBy: "test",
          inspectedAt: c.kiem === "INSPECTED" ? new Date("2026-09-02T00:00:00Z") : null,
          inspectedBy: c.kiem === "INSPECTED" ? "test" : null,
          condition: c.dieuKien ?? null,
          note: c.dieuKien && c.dieuKien !== "RESTOCKABLE" ? "kiểm thử" : "",
          stockReceiptId: c.phieu ? phieuNhap.id : null,
        })
        .onConflictDoNothing();
    }
  }

  clearMemo();
  const p = await getReturnPipeline();
  const theo = new Map(p.stages.map((s) => [s.key, s]));

  // ───────── 2. Mỗi kiện đúng một khâu ─────────
  assert.ok((theo.get("RETURNING_TO_SENDER")?.parcels ?? 0) >= 1, "kiện đang trên đường về phải nằm ở khâu ĐVVC đang chở");
  assert.ok((theo.get("CARRIER_RETURN_DELIVERED")?.parcels ?? 0) >= 1, "kiện ĐVVC đã trả mà kho chưa nhận phải có khâu riêng");
  assert.ok((theo.get("INSPECTION_PENDING")?.parcels ?? 0) >= 1, "kiện kho đã nhận, chờ đếm phải có khâu riêng");
  assert.ok((theo.get("WRITTEN_OFF")?.parcels ?? 0) >= 1, "kiện đếm xong kết luận hỏng phải sang khâu mất hẳn");
  assert.ok((theo.get("RESTOCKED")?.parcels ?? 0) >= 1, "kiện đã lập phiếu tái nhập phải sang khâu đã vào tồn");

  // Dân số thật, đếm độc lập bằng chính điều kiện lọc của đường ống.
  const [{ n }] = (await db.execute(sql`
    select count(*)::int as n
      from shipments s
      left join return_inspections ins on ins.shipment_id = s.id
     where s.order_id is not null and (s.stage in ('RETURNING','RETURNED') or ins.id is not null)
  `).then((r) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])))) as { n: number }[];
  assert.equal(p.totalParcels, Number(n), "tổng kiện của các khâu phải BẰNG dân số thật — lệch nghĩa là có kiện bị đếm hai lần hoặc rơi mất");

  // ───────── 3. Vốn KẸT không gồm kiện đã xong ─────────
  const xong = (theo.get("RESTOCKED")?.goodsCost ?? 0) + (theo.get("WRITTEN_OFF")?.goodsCost ?? 0);
  const tongTatCa = p.stages.reduce((t, s) => t + s.goodsCost, 0);
  assert.equal(p.capitalLocked, tongTatCa - xong, "vốn kẹt phải LOẠI kiện đã vào lại tồn và kiện đã kết luận mất — chúng không còn kẹt nữa");
  assert.equal(p.capitalReleased, theo.get("RESTOCKED")?.goodsCost ?? 0, "vốn giải phóng chỉ đếm kiện ĐÃ có phiếu tái nhập");

  // ───────── 4. Khâu chỉ-theo-dõi không sinh việc ─────────
  for (const s of p.stages) {
    if (!s.actionable) assert.equal(s.actionableCount, 0, `${s.key} không có việc để làm thì không được đếm việc`);
    if (s.parcels === 0) assert.equal(s.slaBreach, 0, `${s.key} không có kiện nào thì không thể có kiện trễ hạn`);
  }
  const nang = worstReturnStage(p);
  assert.ok(nang === null || nang.actionable, "khâu 'nặng nhất' phải là khâu CÓ việc làm được — chỉ ra chỗ không ai làm gì được là vô nghĩa");

  console.log(
    `✓ Đường ống hàng hoàn: ${p.totalParcels} kiện chia ${p.stages.filter((s) => s.parcels > 0).length} khâu, mỗi kiện đúng một khâu · vốn kẹt tách khỏi vốn đã giải phóng và vốn mất hẳn · khâu chỉ-theo-dõi không sinh việc`,
  );
}

if (process.argv[1] && /return-pipeline\.test\.ts$/.test(process.argv[1])) {
  console.log("Bài kiểm này cần CSDL fixture — chạy qua `npm test`.");
}
