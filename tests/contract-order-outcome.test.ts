import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { RETURN_RULE } from "@/lib/constants/returns";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED } from "@/lib/queries/return-rate";

/**
 * CONTRACT TEST — khoá các luật nghiệp vụ ở docs/business-rules/ORDER_OUTCOME.md.
 *
 * Đỏ ở đây nghĩa là CODE SAI, không phải test sai. Không được sửa giá trị kỳ vọng để CI xanh;
 * muốn đổi luật thì sửa đặc tả trước, và việc đó do chủ sở hữu kho mã quyết định.
 */

let seq = 0;
const next = () => `ct-${++seq}`;

type Setup = {
  orderStage?: string;
  shipmentStage?: string;
  codAmount?: number;
  codCollected?: number;
  codStatus?: "NOT_APPLICABLE" | "PENDING" | "COLLECTED" | "RECONCILED" | "PAID_TO_BANK" | "DISPUTED";
  statementRef?: string | null;
  prepaid?: number;
  orderCod?: number;
  /** Sự kiện Viettel Post thật — chỉ nó mới được quyền kết luận trạng thái giao hàng. */
  vtpEvents?: { status: string; stage: string; leg?: "OUTBOUND" | "RETURN" }[];
  /** Vận đơn chiều hoàn do Viettel Post tạo, trỏ về mã gốc. */
  returnLeg?: boolean;
};

async function build(db: Db, s: Setup) {
  const id = next();
  const code = `PKE-${id}`;
  await db.insert(schema.orders).values({
    id,
    stage: (s.orderStage ?? "SHIPPED") as never,
    cod: s.orderCod ?? 0,
    prepaid: s.prepaid ?? 0,
    insertedAt: new Date(),
  });
  const [ship] = await db
    .insert(schema.shipments)
    .values({
      orderId: id,
      vtpOrderNumber: code,
      trackingCode: code,
      stage: (s.shipmentStage ?? "IN_TRANSIT") as never,
      codAmount: s.codAmount ?? 0,
      codCollected: s.codCollected ?? 0,
      codStatus: (s.codStatus ?? "PENDING") as never,
      codStatementRef: s.statementRef ?? null,
      deliveredAt: s.shipmentStage === "DELIVERED" ? new Date("2026-09-01T10:00:00Z") : null,
      vtpStatusDate: new Date("2026-09-01T10:00:00Z"),
    })
    .returning({ id: schema.shipments.id });

  for (const [i, e] of (s.vtpEvents ?? []).entries()) {
    await db.insert(schema.shipmentEvents).values({
      shipmentId: ship.id,
      source: "VTP_WEBHOOK",
      status: e.status,
      statusName: e.status,
      occurredAt: new Date(2026, 8, 1, 10 + i, 0, 0),
      normalizedStage: e.stage as never,
      legType: e.leg ?? "OUTBOUND",
    });
  }
  if (s.returnLeg) {
    await db.insert(schema.shipments).values({
      vtpOrderNumber: `${code}1P1`,
      trackingCode: `${code}1P1`,
      orderReference: code,
      stage: "RETURNING",
      codAmount: 0,
    });
  }
  return id;
}

async function outcome(db: Db, id: string) {
  const [r] = await db
    .select({ v: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, id));
  return r;
}

export async function testOrderOutcomeContract(db: Db) {
  const check = async (label: string, setup: Setup, expected: string) => {
    const id = await build(db, setup);
    const r = await outcome(db, id);
    assert.equal(r?.v, expected, `${label} — xem docs/business-rules/ORDER_OUTCOME.md`);
  };

  // ───────── Tiền KHÔNG BAO GIỜ suy ra trạng thái giao hàng ─────────
  await check(
    "đang giao + đã thu 499K vẫn là ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-1", vtpEvents: [{ status: "300", stage: "IN_TRANSIT" }] },
    "IN_TRANSIT",
  );
  await check(
    "đang hoàn + đã thu 499K vẫn là HOÀN",
    { shipmentStage: "RETURNING", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-2", vtpEvents: [{ status: "505", stage: "RETURNING" }] },
    "RETURNED",
  );
  await check(
    "đã hoàn + tiền đã về ngân hàng vẫn là HOÀN",
    { shipmentStage: "RETURNED", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-3", vtpEvents: [{ status: "504", stage: "RETURNED" }] },
    "RETURNED",
  );
  await check(
    "Pancake báo đã thanh toán nhưng không có chứng từ ĐVVC thì KHÔNG được kết luận giao thành công",
    { orderStage: "PAID", shipmentStage: "PENDING", orderCod: 499_000, codStatus: "COLLECTED" },
    "IN_TRANSIT",
  );

  // ───────── Ranh giới tiền, chỉ áp dụng khi ĐÃ giao thật ─────────
  const daGiao = (collected: number): Setup => ({
    shipmentStage: "DELIVERED",
    codAmount: 499_000,
    codCollected: collected,
    statementRef: "BK-X",
    vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }],
  });
  await check("giao + xác minh 49.999 → HOÀN", daGiao(49_999), "RETURNED");
  await check("giao + xác minh 50.000 → KHÔNG THÀNH CÔNG", daGiao(50_000), "RETURNED_BY_RULE");
  await check("giao + xác minh 100.000 → KHÔNG THÀNH CÔNG", daGiao(100_000), "RETURNED_BY_RULE");
  await check("giao + xác minh 100.001 → GIAO THÀNH CÔNG", daGiao(100_001), "DELIVERED");
  assert.equal(RETURN_RULE.maxCodForReturn, 50_000, "ngưỡng hoàn phải là 50.000");
  assert.equal(RETURN_RULE.maxCodForFakeDelivery, 100_000, "ngưỡng giao thành công phải là 100.000");

  // ───────── Chiều hoàn ─────────
  await check(
    "mã 501 của CHIỀU HOÀN không phải giao thành công tới khách",
    { shipmentStage: "DELIVERED", codAmount: 499_000, vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "RETURN" }] },
    "RETURNED",
  );
  await check(
    "có vận đơn chiều hoàn thì hàng đã quay về, dù ĐVVC ghi 501",
    { shipmentStage: "DELIVERED", codAmount: 499_000, returnLeg: true, vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "RETURNED",
  );

  // ───────── UNKNOWN không phải 0 ─────────
  const chuaCoChungTu = await build(db, {
    shipmentStage: "DELIVERED",
    codAmount: 499_000,
    codCollected: 0,
    statementRef: null,
    vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }],
  });
  const r = await outcome(db, chuaCoChungTu);
  assert.equal(r?.v, "DELIVERED", "logistics đã giao thì kết quả GIAO HÀNG là DELIVERED");
  assert.equal(r?.verified, "UNVERIFIED", "chưa có chứng từ tiền là CHƯA XÁC MINH, không được coi là thu 0đ");

  // ───────── Hàng hoàn không tự vào tồn ─────────
  const hoan = await build(db, { shipmentStage: "RETURNED", codAmount: 499_000, vtpEvents: [{ status: "504", stage: "RETURNED" }] });
  const [shipHoan] = await db
    .select({ nhan: schema.shipments.returnReceivedAt })
    .from(schema.shipments)
    .where(eq(schema.shipments.orderId, hoan));
  assert.equal(shipHoan.nhan, null, "đơn hoàn KHÔNG tự sinh mốc kho nhận hàng — tồn chỉ tăng khi kho xác nhận");

  // ───────── Chống trôi: chỉ MỘT công thức, và nguồn phải trỏ về đặc tả ─────────
  const spec = readFileSync("docs/business-rules/ORDER_OUTCOME.md", "utf8");
  assert.ok(spec.includes("ORDER_OUTCOME"), "đặc tả phải tồn tại và nêu tên công thức chuẩn");
  const nguon = readFileSync("lib/queries/return-rate.ts", "utf8");
  assert.ok(nguon.includes("docs/business-rules/ORDER_OUTCOME.md"), "nguồn chuẩn phải trỏ về đặc tả");
  const soCongThuc = (nguon.match(/export const ORDER_OUTCOME\b/g) ?? []).length;
  assert.equal(soCongThuc, 1, "chỉ được có ĐÚNG MỘT công thức ORDER_OUTCOME trong toàn kho mã");

  console.log(`✓ Contract kết quả đơn: ${seq} tình huống khoá đúng đặc tả (tiền không suy ra giao hàng · ranh giới 50K/100K · chiều hoàn · UNKNOWN≠0 · tồn kho)`);
}
