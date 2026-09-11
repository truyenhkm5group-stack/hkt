import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CARRIER_DOCUMENT_SOURCES, isFinishedOutcome, LOGISTICS_DECIDING_SOURCES, LOGISTICS_EVIDENCE_AUTHORITY, OUTCOME_GROUP, SHIPMENT_STAGE_WRITERS } from "@/lib/constants/truth";
import { AUTO_REPAIRABLE_RULES, RECONCILIATION_RULES } from "@/lib/constants/reconciliation";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
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
import { DELIVERED_REVENUE } from "@/lib/queries/metrics";
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


  // ══ 13. TRẠNG THÁI ĐƠN PANCAKE KHÔNG BAO GIỜ THÀNH "ĐÃ GIAO" ══
  // Ca thật khiến luật này ra đời: Pancake nói "Đã nhận" (stage DELIVERED) trong khi chứng từ
  // Viettel Post mới nhất là 505 "Tồn - Thông báo chuyển hoàn". Kết quả canonical PHẢI là hoàn.
  const conflictOrder = `inv-order-${++seq}`;
  const conflictCode = nextCode();
  await db.insert(schema.orders).values({ id: conflictOrder, stage: "DELIVERED", cod: 849_000, prepaid: 0, insertedAt: new Date() });
  await applyVtpTracking(
    trackingPayload(conflictCode, 505, "Tồn - Thông báo chuyển hoàn bưu cục gốc", "06/09/2026 15:03:05", { IS_RETURNING: false }),
    "VTP_WEBHOOK",
    { allowCreate: true },
  );
  const [conflictShip] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, conflictCode));
  assert.equal(conflictShip.stage, "RETURNING", "13. mã 505 của ĐVVC phải cho ra ĐANG HOÀN");
  await db.update(schema.shipments).set({ orderId: conflictOrder }).where(eq(schema.shipments.id, conflictShip.id));
  const conflictOutcome = await outcomeOf(conflictOrder);
  assert.equal(conflictOutcome, "RETURNED", "13. Pancake nói 'Đã nhận' + ĐVVC nói đang hoàn ⇒ canonical là HOÀN");
  assert.notEqual(conflictOutcome, "DELIVERED", "13. trạng thái đơn Pancake KHÔNG được lật kết quả thành giao thành công");

  // Cùng luật đó ở tầng mapper: đơn Pancake "đã nhận"/"đã thanh toán" mà ĐVVC chưa nói gì thì cao
  // nhất chỉ được là ĐANG GIAO, và tuyệt đối không được sinh ra tiền đã thu.
  for (const pancakeStatus of ["delivered", "paid"]) {
    const mapped = mapOrder({
      id: `inv-map-${pancakeStatus}-${++seq}`,
      status: pancakeStatus === "paid" ? 16 : 3,
      cod: 499_000,
      money_to_collect: 499_000,
      inserted_at: "2026-09-01T00:00:00",
      partner: { partner_name: "Viettel Post", order_number_vtp: nextCode(), extend_code: null },
    });
    assert.ok(mapped?.shipment, `13. đơn ${pancakeStatus} phải sinh vận đơn để kiểm tra`);
    assert.notEqual(mapped.shipment.stage, "DELIVERED", `13. trạng thái đơn Pancake '${pancakeStatus}' không được thành ĐÃ GIAO`);
    assert.equal(mapped.shipment.deliveredAt, null, `13. không có chứng từ ĐVVC thì không được bịa mốc giao hàng`);
    assert.equal(mapped.shipment.codCollected, 0, `13. không được biến COD KHAI BÁO thành tiền ĐÃ THU`);
    assert.equal(mapped.shipment.isFinal, false, `13. không có chứng từ ĐVVC thì vận đơn chưa kết thúc`);
  }

  // Pancake chuyển tiếp "đã giao" KÈM `partner.cod` (COD ĐĂNG KÝ với ĐVVC — đặc tả §8: không phải
  // verified money). Trước đây số này bị ghi vào `cod_collected` và `Math.max` ở lần đồng bộ sau đè
  // lên số thực thu 30.000đ của bảng kê: đơn hoàn tự lật thành giao thành công.
  const relayed = mapOrder({
    id: `inv-map-relay-${++seq}`,
    status: 3,
    cod: 474_000,
    money_to_collect: 474_000,
    inserted_at: "2026-09-01T00:00:00",
    partner: { partner_name: "Viettel Post", order_number_vtp: nextCode(), extend_code: null, partner_status: "delivered", cod: 474_000, updated_at: "2026-09-03T10:00:00" },
  });
  assert.ok(relayed?.shipment, "13. đơn có partner_status phải sinh vận đơn");
  assert.equal(relayed.shipment.codCollected, 0, "13. partner.cod là COD ĐĂNG KÝ, không phải tiền đã thu — Pancake không bao giờ là nguồn tiền thực thu");

  // ══ 14. THANG THẨM QUYỀN CHỈ CÓ MỘT BẢN ══
  assert.deepEqual(
    [...LOGISTICS_DECIDING_SOURCES].sort(),
    [...CARRIER_DOCUMENT_SOURCES].sort(),
    "14. nguồn được quyền kết luận logistics phải khớp giữa thang thẩm quyền và bộ lọc sự kiện",
  );
  assert.ok(
    LOGISTICS_EVIDENCE_AUTHORITY.every((s) => (s.level === "NEVER" ? !s.decides : true)),
    "14. nguồn xếp hạng NEVER không bao giờ được quyền kết luận",
  );
  assert.equal(
    LOGISTICS_EVIDENCE_AUTHORITY.find((s) => s.source === "PAYMENT_COD")?.level,
    "NEVER",
    "14. tiền/COD phải mãi mãi ở mức NEVER cho chiều logistics",
  );

  // ══ 15. KHÔNG CÓ CHỨNG TỪ ĐVVC ⇒ CHƯA BIẾT, KHÔNG PHẢI "ĐANG GIAO" ══
  // Ca thật: 9 đơn Pancake "Đã nhận" ngày 13/08 và 29/08 — khối partner rỗng, không mã vận đơn,
  // 0 sự kiện. Nói "đang giao" là bịa ra một sự kiện vận chuyển chưa từng được chứng minh, và nó
  // giấu mất đúng nhóm đơn cần người xem lại.
  const blindOrder = `inv-order-${++seq}`;
  await db.insert(schema.orders).values({ id: blindOrder, stage: "DELIVERED", cod: 474_000, prepaid: 0, insertedAt: new Date() });
  const [blindShip] = await db.insert(schema.shipments).values({
    orderId: blindOrder, carrier: "Khác",
    vtpOrderNumber: null, trackingCode: null,           // không một mã nào
    stage: "DELIVERED", isFinal: true,                   // ảnh chụp cũ do Pancake đặt
    codAmount: 474_000, codCollected: 474_000, codStatus: "COLLECTED", // và tiền cũng đã bị khai là thu được
  }).returning({ id: schema.shipments.id });
  const blindEvents = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, blindShip.id));
  assert.equal(blindEvents.length, 0, "15. dựng đúng ca: không có sự kiện nào");
  const blindOutcome = await outcomeOf(blindOrder);
  assert.equal(blindOutcome, "UNKNOWN", "15. không mã, không sự kiện ⇒ CHƯA BIẾT");
  assert.notEqual(blindOutcome, "DELIVERED", "15. trạng thái Pancake + tiền khai KHÔNG tạo ra giao thành công");
  assert.notEqual(blindOutcome, "IN_TRANSIT", "15. cũng KHÔNG được nói đang giao — không có gì chứng minh gói hàng đang đi");
  assert.equal(OUTCOME_GROUP.UNKNOWN, "OPEN", "15. chưa biết là CHƯA KẾT THÚC, không vào tử số lẫn mẫu số GTC");
  assert.equal(isFinishedOutcome("UNKNOWN"), false, "15. chưa biết thì chưa kết thúc");
  // Vẫn là 'đang giao' khi CÓ chứng từ thật của ĐVVC — nhánh IN_TRANSIT không bị xoá, chỉ bị siết.
  const movingCode = nextCode();
  await applyVtpTracking(trackingPayload(movingCode, 400, "Đang vận chuyển", "05/09/2026 08:00:00"), "VTP_WEBHOOK", { allowCreate: true });
  const [movingShip] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, movingCode));
  const movingOrder = `inv-order-${++seq}`;
  await db.insert(schema.orders).values({ id: movingOrder, stage: "SHIPPED", cod: 474_000, prepaid: 0, insertedAt: new Date() });
  await db.update(schema.shipments).set({ orderId: movingOrder }).where(eq(schema.shipments.id, movingShip.id));
  assert.equal(await outcomeOf(movingOrder), "IN_TRANSIT", "15. có chứng từ ĐVVC thì ĐANG GIAO vẫn dùng được");

  // ══ 16. "GIAO THÀNH CÔNG" CỦA ĐVVC KHÔNG PHẢI LÀ KẾT LUẬN CUỐI ══
  // Ca thật PKE1484463365: tiêu đề "Giao thành công", COD khai 474.000đ, nhưng hành trình ghi
  // "Tồn - Giao không thành công · giao 1 phần · Thu hộ 30.000 · Trọng lượng hoàn 1.000", và có
  // vận đơn hoàn PKE14844633651P1 đã giao VỀ SHOP. Khách chỉ trả tiền xem hàng rồi không nhận.
  const partialOrder = `inv-order-${++seq}`;
  const partialCode = nextCode();
  await db.insert(schema.orders).values({ id: partialOrder, stage: "DELIVERED", cod: 474_000, prepaid: 0, insertedAt: new Date() });
  await db.insert(schema.shipments).values({
    orderId: partialOrder, carrier: "Viettel Post", vtpOrderNumber: partialCode, trackingCode: partialCode,
    stage: "DELIVERED", codAmount: 474_000, codCollected: 30_000, codStatus: "COLLECTED",
    deliveredAt: new Date("2026-08-08T03:10:19Z"), vtpStatusDate: new Date("2026-08-08T03:10:19Z"),
  });
  // Vận đơn hoàn là DÒNG RIÊNG, trỏ về vận đơn gốc qua `order_reference` — đúng quy ước sẵn có.
  await db.insert(schema.shipments).values({
    carrier: "Viettel Post", vtpOrderNumber: `${partialCode}1P1`, trackingCode: `${partialCode}1P1`,
    orderReference: partialCode, stage: "RETURNED", codAmount: 0, codStatus: "NOT_APPLICABLE",
  });
  assert.equal(await outcomeOf(partialOrder), "RETURNED",
    "16. hàng quay về theo vận đơn hoàn ⇒ đơn HOÀN, dù ĐVVC ghi 'Giao thành công'");
  // 30.000đ là tiền ĐVVC thu được lúc cho xem hàng — KHÔNG phải doanh thu bán hàng.
  const [partialRow] = await db.select({ v: DELIVERED_REVENUE }).from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, partialOrder));
  assert.equal(Number(partialRow?.v ?? 0), 0, "16. đơn hoàn không đóng góp một đồng doanh thu nào");
  // Ngay cả khi KHÔNG có vận đơn hoàn, số thực thu 30.000đ (< 50K) cũng đủ kết luận HOÀN.
  const thinOrder = `inv-order-${++seq}`;
  const thinCode = nextCode();
  await db.insert(schema.orders).values({ id: thinOrder, stage: "DELIVERED", cod: 474_000, prepaid: 0, insertedAt: new Date() });
  await db.insert(schema.shipments).values({ orderId: thinOrder, carrier: "Viettel Post", vtpOrderNumber: thinCode,
    stage: "DELIVERED", codAmount: 474_000, codCollected: 30_000, codStatus: "COLLECTED",
    vtpStatusDate: new Date("2026-08-08T03:10:19Z") });
  assert.equal(await outcomeOf(thinOrder), "RETURNED", "16. thực thu 30.000đ trên đơn khai 474.000đ ⇒ HOÀN, không phải giao thành công");

  // Vận đơn CHIỀU HOÀN mang trạng thái "Giao thành công" nghĩa là hàng về tới shop — tuyệt đối
  // không được cộng vào số đơn giao thành công cho khách.
  const legCode = `${nextCode()}1P1`;
  await applyVtpTracking(trackingPayload(legCode, 501, "Thành công - Phát thành công", "09/08/2026 10:10:00", { IS_RETURNING: true }), "VTP_WEBHOOK", { allowCreate: true });
  const [legShip] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, legCode));
  assert.equal(legShip.stage, "RETURNED", "16. 501 trên CHIỀU HOÀN = hàng về shop, không phải giao cho khách");
  assert.notEqual(legShip.stage, "DELIVERED");

  // ══ 17. MỘT ĐƠN CÓ NHIỀU LẦN GỬI — LẦN SAU KHÔNG XOÁ LỊCH SỬ LẦN TRƯỚC ══
  // Hình mẫu thật của shop: tạo vận đơn → "Shop hủy lấy" → tạo lại vận đơn thay thế → giao thành
  // công. Cả hai lần gửi đều là chứng từ có thật và phải cùng tồn tại trong ERP.
  const multiCode1 = nextCode();
  const multiCode2 = nextCode();
  await applyVtpTracking(trackingPayload(multiCode1, 107, "Huỷ - Shop hủy lấy", "02/08/2026 18:19:00"), "VTP_WEBHOOK", { allowCreate: true });
  await applyVtpTracking(trackingPayload(multiCode2, 501, "Thành công - Phát thành công", "05/08/2026 09:00:00", { IS_RETURNING: false }), "VTP_WEBHOOK", { allowCreate: true });
  const [lanGui1] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, multiCode1));
  const [lanGui2] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, multiCode2));
  assert.ok(lanGui1 && lanGui2, "17. hai lần gửi phải là HAI dòng vận đơn, không đè lên nhau");
  assert.notEqual(lanGui1.id, lanGui2.id, "17. lần gửi sau KHÔNG được ghi đè lần gửi trước");
  assert.equal(lanGui1.stage, "CANCELLED", "17. lần gửi bị huỷ giữ nguyên kết cục của nó");
  assert.equal(lanGui2.stage, "DELIVERED", "17. lần gửi thay thế giữ nguyên kết cục của nó");
  /**
   * MỘT ĐƠN, NHIỀU LẦN GỬI — và tiền vẫn chỉ đếm một lần.
   *
   * Từ 10/09/2026 `shipments.order_id` KHÔNG còn UNIQUE, nên giao thất bại rồi gửi lại, huỷ rồi tạo
   * lại, hay gửi hàng thay thế đều được lưu thành lần gửi riêng thay vì ghi đè lên lần trước.
   *
   * Nghĩa vụ đi kèm — và là điều bất biến này khoá: mọi đường tính TIỀN phải ở grain ĐƠN. Nếu không,
   * ngay lần gửi lại đầu tiên doanh thu và số đơn bị đếm HAI LẦN, trong im lặng. Xem `PRIMARY_ATTEMPT`
   * trong lib/queries/return-rate.ts.
   */
  const multiOrder = `inv-order-${++seq}`;
  await db.insert(schema.orders).values({ id: multiOrder, stage: "DELIVERED", cod: 474_000, prepaid: 0, insertedAt: new Date() });
  await db.update(schema.shipments).set({ orderId: multiOrder, attemptNo: 2, direction: "OUTBOUND" }).where(eq(schema.shipments.id, lanGui2.id));
  await db.update(schema.shipments).set({ orderReference: multiCode2 }).where(eq(schema.shipments.id, lanGui1.id));
  // CASE E: cùng một đơn nhận được lần gửi thứ hai — CSDL phải CHẤP NHẬN.
  await db.update(schema.shipments).set({ orderId: multiOrder, attemptNo: 1, direction: "OUTBOUND" }).where(eq(schema.shipments.id, lanGui1.id));
  const soLanGui = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, multiOrder));
  assert.equal(soLanGui.length, 2, "17. CASE E: một đơn phải giữ được CẢ HAI lần gửi — lần sau không nuốt lần trước");

  // ĐƯỜNG TÍNH TIỀN vẫn phải thấy ĐÚNG MỘT dòng cho đơn đó. Đây là nửa còn lại của việc mở 1:N:
  // mô hình cho phép nhiều lần gửi, và tiền vẫn đếm một lần.
  const [{ n: dongTinhTien }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id} and ${PRIMARY_ATTEMPT}`)
    .where(eq(schema.orders.id, multiOrder));
  assert.equal(Number(dongTinhTien), 1, "17. đơn hai lần gửi vẫn chỉ ra MỘT dòng ở đường tính tiền — không nhân đôi doanh thu");
  const canGui = await db.select().from(schema.shipments).where(eq(schema.shipments.orderReference, multiCode2));
  assert.equal(canGui.length, 1, "17. lần gửi trước vẫn còn nguyên như dòng riêng, không bị xoá");
  // Lịch sử của từng lần gửi vẫn nguyên vẹn, không lần nào nuốt sự kiện của lần kia.
  for (const sp of [lanGui1, lanGui2]) {
    const evs = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, sp.id));
    assert.ok(evs.length >= 1, "17. mỗi lần gửi giữ lịch sử riêng");
  }

  console.log(
    `✓ Bất biến nghiệp vụ: 17/17 điều được khoá (tiền không tạo ra 'đã giao' · chứng từ mới kết luận · mã lạ không thành công · KPI xác định · lặp & muộn vô hại · dữ liệu gốc còn nguyên · dựng lại = thời gian thực · tồn kho cân · hai chiều tách rời · sửa tay có nhật ký · trạng thái đơn Pancake không tạo ra 'đã giao' · thang thẩm quyền một bản · không chứng từ thì CHƯA BIẾT chứ không 'đang giao' · giao một phần rồi hoàn KHÔNG phải giao thành công · một đơn giữ được nhiều lần gửi)`,
  );
}
