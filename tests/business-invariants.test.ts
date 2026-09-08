import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { SHIPMENT_STAGE_WRITERS } from "@/lib/constants/truth";
import { AUTO_REPAIRABLE_RULES, RECONCILIATION_RULES } from "@/lib/constants/reconciliation";
import { storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { deriveShipmentState, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { runCanonicalBackfill } from "@/lib/sync/backfill";
import { repairReconciliation } from "@/lib/sync/consistency";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { getDashboardData } from "@/lib/queries/dashboard";
import { getReturnRateSummary } from "@/lib/queries/return-rate";
import { availableStockExpr, erpStockExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ═══════════════ BỘ KIỂM THỬ BẤT BIẾN NGHIỆP VỤ ═══════════════
 *
 * 12 điều KHÔNG ĐƯỢC PHÉP SAI, bất kể ai sửa code sau này. Đỏ ở đây nghĩa là CODE SAI.
 * Bộ này chạy trong `npm test`, và `npm test` là điều kiện CHẶN của workflow deploy.
 *
 * Đặc tả: docs/business-rules/ORDER_OUTCOME.md · docs/metrics-contract.md ·
 * lib/constants/truth.ts · docs/erp-data-truth-audit.md.
 */

let seq = 0;
const nextCode = () => `INV-${++seq}`;

function trackingPayload(orderNumber: string, status: number, name: string, at: string, extra: Record<string, unknown> = {}) {
  return normalizeTracking({ ORDER_NUMBER: orderNumber, ORDER_STATUS: status, STATUS_NAME: name, ORDER_STATUSDATE: at, ...extra });
}

/** Duyệt mã nguồn để khoá những bất biến không thể kiểm bằng dữ liệu. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

export async function testBusinessInvariants(db: Db) {
  clearMemo();

  // ══ 1. TIỀN MỘT MÌNH KHÔNG BAO GIỜ TẠO RA "GIAO THÀNH CÔNG" ══
  const orderId = `inv-order-${++seq}`;
  const code = nextCode();
  await db.insert(schema.orders).values({ id: orderId, stage: "PAID", cod: 499_000, prepaid: 0, insertedAt: new Date() });
  const [paidShip] = await db
    .insert(schema.shipments)
    .values({
      orderId,
      vtpOrderNumber: code,
      trackingCode: code,
      stage: "IN_TRANSIT",
      codAmount: 499_000,
      codCollected: 499_000,
      codStatus: "PAID_TO_BANK",
      codPaidToBankAt: new Date(),
      vtpStatusDate: new Date("2026-09-01T00:00:00Z"),
    })
    .returning({ id: schema.shipments.id });
  const outcomeOf = async (id: string) => {
    const [r] = await db
      .select({ v: ORDER_OUTCOME })
      .from(schema.orders)
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(eq(schema.orders.id, id));
    return r?.v as string;
  };
  assert.notEqual(await outcomeOf(orderId), "DELIVERED", "1. tiền đã về ngân hàng + Pancake báo đã thanh toán vẫn KHÔNG phải giao thành công");
  await repairReconciliation({ apply: true, actor: "test:invariants" });
  const [afterRepair] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, paidShip.id));
  assert.equal(afterRepair.stage, "IN_TRANSIT", "1. không job nào được lấy tiền để ghi trạng thái giao hàng");

  // ══ 2. "GIAO THÀNH CÔNG" ĐÒI CHỨNG TỪ LOGISTICS ĐƯỢC CÔNG NHẬN ══
  // Chỉ nguồn đến thẳng từ ĐVVC mới được kết luận; bản sao Pancake thì không.
  await db.insert(schema.shipmentEvents).values({
    shipmentId: paidShip.id,
    source: "PANCAKE",
    status: "501",
    statusName: "Phát thành công",
    occurredAt: new Date("2026-09-20T00:00:00Z"),
    normalizedStage: "DELIVERED",
    legType: "OUTBOUND",
  });
  await materializeShipmentState(db, paidShip.id);
  const [afterPancake] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, paidShip.id));
  assert.equal(afterPancake.stage, "IN_TRANSIT", "2. bản sao hành trình Pancake KHÔNG phải chứng từ logistics");
  assert.notEqual(await outcomeOf(orderId), "DELIVERED");
  assert.ok(
    RECONCILIATION_RULES.DELIVERED_WITHOUT_LOGISTICS_EVIDENCE.severity === "ERROR",
    "2. ghi 'đã giao' mà không có chứng từ phải là vi phạm NGHIÊM TRỌNG",
  );

  // ══ 3. TRẠNG THÁI NGOÀI KHÔNG HIỂU ĐƯỢC THÌ KHÔNG ĐƯỢC ÂM THẦM THÀNH CÔNG ══
  assert.equal(resolveVtpStatus({ code: 9999, text: "" }).stage, "UNKNOWN");
  assert.equal(resolveVtpStatus({ code: null, text: "chữ lạ hoắc" }).stage, "UNKNOWN");
  const oddCode = nextCode();
  await applyVtpTracking(trackingPayload(oddCode, 300, "Đóng tải - vận chuyển đi", "01/09/2026 08:00:00"), "VTP_WEBHOOK", { allowCreate: true });
  await applyVtpTracking(trackingPayload(oddCode, 8888, "Trạng thái chưa từng thấy", "05/09/2026 08:00:00"), "VTP_WEBHOOK", { allowCreate: true });
  const [oddShip] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, oddCode));
  assert.equal(oddShip.stage, "IN_TRANSIT", "3. mã lạ giữ nguyên trạng thái cũ, không được nhảy sang thành công");

  // ══ 4. CÙNG KPI + CÙNG BỘ LỌC ⇒ CÙNG CON SỐ ══
  clearMemo();
  const dash = await getDashboardData(ALL);
  const gtc = await getReturnRateSummary(ALL, "");
  assert.equal(dash.kpi.successRate, gtc.successRate === null ? null : Math.round(gtc.successRate * 10) / 10, "4. GTC phải giống nhau ở Tổng quan và báo cáo");

  // ══ 5. GÓI TIN LẶP ⇒ TRẠNG THÁI CUỐI Y HỆT ══
  const dupCode = nextCode();
  const packet = trackingPayload(dupCode, 501, "Thành công - Phát thành công", "03/09/2026 09:00:00", { IS_RETURNING: false });
  await applyVtpTracking(packet, "VTP_WEBHOOK", { allowCreate: true });
  const [dup1] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupCode));
  for (let i = 0; i < 3; i += 1) await applyVtpTracking(packet, "VTP_WEBHOOK", { allowCreate: true });
  const [dup2] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupCode));
  assert.equal(dup1.stage, dup2.stage, "5. gửi lại bốn lần vẫn ra một trạng thái");
  assert.equal(dup1.deliveredAt?.getTime(), dup2.deliveredAt?.getTime(), "5. các mốc cũng không được xê dịch");
  const dupEvents = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, dup1.id));
  assert.equal(dupEvents.length, 1, "5. lịch sử không được nhân bản");
  // Chống trùng ở tầng gói tin: bốn lần gửi chỉ để lại một dòng webhook.
  const key = webhookDedupeKey("VIETTELPOST", [dupCode, 501, "2026-09-03T02:00:00.000Z"]);
  for (let i = 0; i < 4; i += 1) await storeWebhook("VIETTELPOST", "tracking", dupCode, { DATA: {} }, {}, { dedupeKey: key, occurredAt: new Date("2026-09-03T02:00:00Z") });
  const stored = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.dedupeKey, key!));
  assert.equal(stored.length, 1, "5. bốn lần gửi lại chỉ để lại một dòng gói tin");
  assert.equal(stored[0].deliveryCount, 4, "5. nhưng vẫn phải đếm được đã gửi lại mấy lần");

  // ══ 6. SỰ KIỆN CŨ ĐẾN SAU KHÔNG ĐƯỢC PHÁ TRẠNG THÁI ══
  await applyVtpTracking(trackingPayload(dupCode, 300, "Đóng tải - vận chuyển đi", "01/09/2026 08:00:00"), "VTP_WEBHOOK", { allowCreate: true });
  const [afterLate] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupCode));
  assert.equal(afterLate.stage, "DELIVERED", "6. gói tin cũ đến muộn không được kéo lùi trạng thái");

  // ══ 7. DỮ LIỆU GỐC ĐƯỢC BẢO TOÀN ══
  assert.ok(stored[0].payload, "7. payload gốc của gói tin phải còn nguyên");
  const [rawShip] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupCode));
  assert.ok(rawShip.raw && typeof rawShip.raw === "object", "7. bản ghi gốc của ĐVVC phải được giữ trên vận đơn");
  const oddEvents = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, oddShip.id));
  assert.ok(oddEvents.some((e) => e.status === "8888"), "7. sự kiện ERP không hiểu vẫn phải được lưu, không bị nuốt");

  // ══ 8. DỰNG LẠI = THỜI GIAN THỰC trên cùng tập sự kiện ══
  const rebuilt = await runCanonicalBackfill({ apply: true, actor: "test:invariants" });
  const [afterRebuild] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupCode));
  assert.equal(afterRebuild.stage, afterLate.stage, "8. dựng lại từ lịch sử phải ra đúng kết quả của luồng thời gian thực");
  assert.equal(afterRebuild.deliveredAt?.getTime(), afterLate.deliveredAt?.getTime());
  const again = await runCanonicalBackfill({ apply: false });
  assert.equal(again.changed, 0, "8. dựng lại lần nữa phải báo 0 thay đổi — nếu không thì chưa hội tụ");
  assert.ok(rebuilt.total > 0);

  // ══ 9. TỒN KHO: GIỮ CHỖ VÀ NHẢ CHỖ PHẢI CÂN ══
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const stockRows = await db
    .select({
      variantId: schema.productVariants.id,
      stock: erpStockExpr(sales, receipts),
      available: availableStockExpr(sales, receipts),
      reserved: sql<number>`coalesce(${sales.reserved}, 0)`,
      received: sql<number>`coalesce(${receipts.received}, 0)`,
      shipped: sql<number>`coalesce(${sales.shipped}, 0)`,
      receiptDocs: sql<number>`coalesce(${receipts.receiptDocs}, 0)`,
    })
    .from(schema.productVariants)
    .leftJoin(sales, eq(sales.variantId, schema.productVariants.id))
    .leftJoin(receipts, eq(receipts.variantId, schema.productVariants.id));
  let checked = 0;
  for (const r of stockRows) {
    const stock = Number(r.stock ?? 0);
    const available = Number(r.available ?? 0);
    const reserved = Number(r.reserved ?? 0);
    assert.equal(available, stock - reserved, `9. khả dụng phải đúng bằng tồn trừ hàng đã giữ chỗ (${r.variantId})`);
    assert.equal(stock, Number(r.received ?? 0) - Number(r.shipped ?? 0), `9. tồn phải đúng bằng phiếu kho trừ hàng đã xuất (${r.variantId})`);
    if (Number(r.receiptDocs ?? 0) > 0) {
      assert.ok(stock <= Number(r.received ?? 0), `9. tồn không được vượt tổng nhập (${r.variantId})`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "9. fixture phải có mẫu mã đã nhập kho để kiểm tra");

  // ══ 10. TIỀN VÀ GIAO HÀNG LÀ HAI CHIỀU TÁCH RỜI ══
  // Đổi tiền không được làm đổi trạng thái giao hàng, và ngược lại.
  const [beforeMoney] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, dup1.id));
  await db.update(schema.shipments).set({ codCollected: 0, codStatus: "PENDING" }).where(eq(schema.shipments.id, dup1.id));
  await materializeShipmentState(db, dup1.id);
  const [afterMoney] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, dup1.id));
  assert.equal(afterMoney.stage, beforeMoney.stage, "10. xoá sạch tiền không được làm đổi trạng thái giao hàng");
  await db.update(schema.shipments).set({ codCollected: beforeMoney.codCollected, codStatus: beforeMoney.codStatus }).where(eq(schema.shipments.id, dup1.id));
  // Và chỉ đúng hai luồng được ghi shipments.stage — xem giải thích ở lib/constants/truth.ts.
  assert.deepEqual([...SHIPMENT_STAGE_WRITERS], ["lib/integrations/viettelpost/state.ts", "lib/integrations/pancake/sync.ts"]);
  const offenders: string[] = [];
  for (const file of sourceFiles("lib").concat(sourceFiles("app"))) {
    const rel = file.replace(/\\/g, "/");
    if (SHIPMENT_STAGE_WRITERS.some((w) => rel.endsWith(w))) continue;
    const src = readFileSync(file, "utf8");
    // Bắt mẫu `.update(schema.shipments)` / `.update(s)` có `stage:` trong khối `.set({...})` ngay sau đó.
    for (const match of src.matchAll(/\.update\((?:schema\.shipments|s)\)[\s\S]{0,600}?\.set\(\{([\s\S]{0,600}?)\}\)/g)) {
      if (/\bstage:/.test(match[1])) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `10. chỉ các luồng trong SHIPMENT_STAGE_WRITERS được ghi shipments.stage; vi phạm: ${offenders.join(", ")}`);

  // Pancake được phép ghi trạng thái CHỈ KHI chưa có chứng từ nào của ĐVVC. Kiểm tra bằng dữ liệu:
  // vận đơn nào đã có chứng từ thì ảnh chụp phải khớp lịch sử, dù Pancake nói gì.
  const withCarrierTruth = await db
    .select({ id: schema.shipments.id, stage: schema.shipments.stage })
    .from(schema.shipments)
    .where(sql`${schema.shipments.vtpStatusDate} is not null`)
    .limit(200);
  let carrierChecked = 0;
  for (const row of withCarrierTruth) {
    const derivedState = await deriveShipmentState(db, row.id);
    if (!derivedState) continue;
    assert.equal(row.stage, derivedState.stage, `10. vận đơn ${row.id} có chứng từ ĐVVC nhưng ảnh chụp không khớp lịch sử`);
    carrierChecked += 1;
  }
  assert.ok(carrierChecked > 0, "10. fixture phải có vận đơn mang chứng từ ĐVVC để kiểm tra");

  // ══ 11. CÔNG THỨC CHỈ SỐ PHẢI XÁC ĐỊNH ══
  clearMemo();
  const run1 = await getDashboardData(ALL);
  clearMemo();
  const run2 = await getDashboardData(ALL);
  assert.equal(run1.kpi.successRevenue, run2.kpi.successRevenue, "11. cùng dữ liệu, cùng bộ lọc thì cùng con số");
  assert.equal(run1.kpi.successCogs, run2.kpi.successCogs);
  assert.equal(run1.kpi.successRate, run2.kpi.successRate);
  assert.equal(run1.finance.estimatedProfit, run2.finance.estimatedProfit);

  // ══ 12. SỬA TAY / TỰ SỬA PHẢI CÓ NHẬT KÝ ══
  const repairLogs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "reconcile.repair"));
  const backfillLogs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "backfill.canonical-state"));
  assert.ok(repairLogs.length > 0, "12. mỗi lần bộ máy đối soát tự sửa phải để lại nhật ký");
  assert.ok(backfillLogs.length > 0, "12. mỗi lần dựng lại lịch sử phải để lại nhật ký");
  // Và số luật được phép tự sửa vẫn đúng ba luật xác định — không ai được lặng lẽ mở rộng.
  assert.equal(AUTO_REPAIRABLE_RULES.length, 3, "12. mở rộng danh sách luật tự sửa phải là quyết định tường minh");

  console.log(
    `✓ Bất biến nghiệp vụ: 12/12 điều được khoá (tiền không tạo ra 'đã giao' · chứng từ mới kết luận · mã lạ không thành công · KPI xác định · lặp & muộn vô hại · dữ liệu gốc còn nguyên · dựng lại = thời gian thực · tồn kho cân · hai chiều tách rời · sửa tay có nhật ký)`,
  );
}
