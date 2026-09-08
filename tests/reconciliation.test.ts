import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AUTO_REPAIRABLE_RULES, RECONCILIATION_RULES, RECONCILIATION_RULE_ORDER } from "@/lib/constants/reconciliation";
import { checkShipmentConsistency, repairReconciliation, scanReconciliation } from "@/lib/sync/consistency";

/**
 * BỘ MÁY ĐỐI SOÁT — kiểm thử khoá đúng một câu hỏi: ERP được phép TỰ SỬA những gì?
 *
 * Đây là chỗ ERP từng sai nặng nhất: job cũ thấy "COD đã về ngân hàng mà vận đơn chưa giao" liền
 * ghi thẳng vận đơn thành GIAO THÀNH CÔNG (F1), và hạ cod_status của đơn hoàn về "không thu hộ"
 * (F2). Bộ kiểm thử này bảo đảm điều đó không quay lại.
 */

let seq = 0;
const nextCode = () => `RC-${++seq}`;

async function shipment(
  db: Db,
  v: {
    stage?: string;
    codStatus?: "NOT_APPLICABLE" | "PENDING" | "COLLECTED" | "RECONCILED" | "PAID_TO_BANK" | "DISPUTED";
    codAmount?: number;
    codCollected?: number;
    deliveredAt?: Date | null;
    codPaidToBankAt?: Date | null;
    events?: { status: string; stage: string; at: Date }[];
  },
) {
  const codeStr = nextCode();
  const [row] = await db
    .insert(schema.shipments)
    .values({
      vtpOrderNumber: codeStr,
      trackingCode: codeStr,
      carrier: "Viettel Post",
      stage: (v.stage ?? "PENDING") as never,
      codStatus: (v.codStatus ?? "PENDING") as never,
      codAmount: v.codAmount ?? 0,
      codCollected: v.codCollected ?? 0,
      deliveredAt: v.deliveredAt ?? null,
      codPaidToBankAt: v.codPaidToBankAt ?? null,
      vtpStatusDate: new Date(),
    })
    .returning({ id: schema.shipments.id });
  for (const e of v.events ?? []) {
    await db.insert(schema.shipmentEvents).values({
      shipmentId: row.id,
      source: "VTP_WEBHOOK",
      status: e.status,
      statusName: e.status,
      occurredAt: e.at,
      normalizedStage: e.stage as never,
      legType: "OUTBOUND",
    });
  }
  return { id: row.id, code: codeStr };
}

export async function testReconciliation(db: Db) {
  // ───────── 0. Bộ luật: chỉ đúng hai luật được phép tự sửa ─────────
  assert.deepEqual(
    [...AUTO_REPAIRABLE_RULES].sort(),
    ["COD_NOT_APPLICABLE_WITH_AMOUNT", "DELIVERED_WITHOUT_DATE", "SHIPMENT_STATE_DRIFT"].sort(),
    "chỉ những luật sửa được THEO NGUỒN SỰ THẬT CỦA CHÍNH CHIỀU ĐÓ mới được tự sửa",
  );
  for (const key of ["PAYMENT_DELIVERED_CONFLICT", "COD_STATE_CONFLICT", "ORDER_SHIPMENT_CONFLICT", "INVENTORY_RETURN_CONFLICT"] as const) {
    assert.equal(RECONCILIATION_RULES[key].autoRepair, false, `${key} là lệch GIỮA HAI CHIỀU — máy không biết bên nào đúng, cấm tự sửa`);
  }
  assert.equal(RECONCILIATION_RULES.PAYMENT_DELIVERED_CONFLICT.severity, "ERROR");
  for (const key of RECONCILIATION_RULE_ORDER) {
    const r = RECONCILIATION_RULES[key];
    assert.ok(r.reason.length > 10 && r.suggestedAction.length > 10, `${key} phải nêu rõ nghĩa và việc cần làm`);
  }

  // ───────── 1. TIỀN ĐÃ VỀ NGÂN HÀNG KHÔNG ĐƯỢC BIẾN VẬN ĐƠN THÀNH "GIAO THÀNH CÔNG" ─────────
  // Đây chính là F1. Vận đơn còn đang trung chuyển, bảng kê đã trả tiền.
  const paid = await shipment(db, {
    stage: "IN_TRANSIT",
    codStatus: "PAID_TO_BANK",
    codAmount: 499_000,
    codCollected: 499_000,
    codPaidToBankAt: new Date("2026-09-05T00:00:00Z"),
    events: [{ status: "300", stage: "IN_TRANSIT", at: new Date("2026-09-04T08:00:00Z") }],
  });
  const scan = await scanReconciliation();
  const conflict = scan.issues.find((i) => i.rule === "PAYMENT_DELIVERED_CONFLICT");
  assert.ok(conflict && conflict.count > 0, "phải PHÁT HIỆN được xung đột tiền ↔ giao hàng");
  assert.equal(conflict.autoRepairable, false, "và phải nói rõ là KHÔNG tự sửa");
  // `sample` cố ý chỉ giữ vài ví dụ, nên vận đơn vừa dựng có thể không nằm trong đó — điều bắt
  // buộc là nó ĐƯỢC ĐẾM và KHÔNG bị sửa.
  assert.ok(conflict.sample.length > 0 && conflict.sample.length <= 10, "mẫu phải có ví dụ nhưng không đổ cả danh sách");

  await repairReconciliation({ apply: true, actor: "test:reconcile" });
  const [afterRepair] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, paid.id));
  assert.equal(afterRepair.stage, "IN_TRANSIT", "F1: sửa tự động KHÔNG được lấy tiền để kết luận đã giao");
  assert.equal(afterRepair.deliveredAt, null, "F1: không được bịa mốc giao hàng từ ngày tiền về ngân hàng");
  assert.equal(afterRepair.isFinal, false);

  // ───────── 2. ĐƠN HOÀN KHÔNG BỊ XOÁ DẤU VẾT THU HỘ ─────────
  // Đây là F2: bản cũ hạ cod_status của vận đơn hoàn/huỷ về NOT_APPLICABLE.
  const returned = await shipment(db, {
    stage: "RETURNED",
    codStatus: "PENDING",
    codAmount: 849_000,
    events: [{ status: "504", stage: "RETURNED", at: new Date("2026-09-04T08:00:00Z") }],
  });
  await repairReconciliation({ apply: true, actor: "test:reconcile" });
  const [afterReturn] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, returned.id));
  assert.equal(afterReturn.codStatus, "PENDING", "F2: đơn hoàn vẫn giữ dấu vết thu hộ — không hạ về 'không thu hộ'");
  assert.equal(afterReturn.codAmount, 849_000, "F2: số tiền thu hộ khai báo không được xoá");

  // ───────── 3. SỬA ĐƯỢC: ảnh chụp lệch lịch sử thì dựng lại theo LỊCH SỬ ─────────
  const drift = await shipment(db, {
    stage: "PENDING",
    codAmount: 300_000,
    events: [
      { status: "200", stage: "PICKED_UP", at: new Date("2026-09-03T08:00:00Z") },
      { status: "501", stage: "DELIVERED", at: new Date("2026-09-04T09:00:00Z") },
    ],
  });
  const dry = await repairReconciliation({ apply: false });
  assert.ok(dry.stateRebuilt.candidates > 0, "chạy thử phải đếm ra số vận đơn sẽ dựng lại");
  assert.equal(dry.stateRebuilt.changed, 0, "chạy thử KHÔNG được ghi gì");
  const [stillDrifted] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, drift.id));
  assert.equal(stillDrifted.stage, "PENDING", "chạy thử không đụng vào dữ liệu");

  const applied = await repairReconciliation({ apply: true, actor: "test:reconcile" });
  assert.ok(applied.stateRebuilt.changed > 0);
  const [fixed] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, drift.id));
  assert.equal(fixed.stage, "DELIVERED", "ảnh chụp phải khớp lịch sử — lịch sử là nguồn sự thật của chiều logistics");
  assert.ok(fixed.deliveredAt, "mốc giao lấy từ chính sự kiện của ĐVVC");
  assert.equal(fixed.deliveredAt?.toISOString(), "2026-09-04T09:00:00.000Z");

  // ───────── 4. SỬA ĐƯỢC: 'không thu hộ' sai theo chính số tiền thu hộ ─────────
  const mislabelled = await shipment(db, { stage: "IN_TRANSIT", codStatus: "NOT_APPLICABLE", codAmount: 499_000 });
  await repairReconciliation({ apply: true, actor: "test:reconcile" });
  const [labelFixed] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, mislabelled.id));
  assert.equal(labelFixed.codStatus, "PENDING", "có tiền thu hộ thì không được ghi 'không thu hộ'; PENDING = CHƯA BIẾT");

  // ───────── 5. Việc sửa phải TRUY NGUYÊN ĐƯỢC ─────────
  const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "reconcile.repair"));
  assert.ok(logs.length > 0, "mỗi lần tự sửa phải để lại nhật ký");
  assert.equal(logs[0].entity, "shipment");

  // ───────── 6. Quét chỉ đọc: chạy hai lần cho cùng kết quả, không đổi dữ liệu ─────────
  const a = await scanReconciliation();
  const b = await scanReconciliation();
  assert.deepEqual(
    a.issues.map((i) => [i.rule, i.count]),
    b.issues.map((i) => [i.rule, i.count]),
    "quét chỉ đọc phải xác định: chạy lại cho đúng con số cũ",
  );
  assert.ok(a.totals.ERROR + a.totals.WARNING > 0, "fixture phải có lệch để kiểm tra");

  // Quét gia tăng phải hẹp hơn hoặc bằng quét toàn bộ.
  const incremental = await scanReconciliation({ sinceDays: 1 });
  const full = a.issues.find((i) => i.rule === "SHIPMENT_STATE_DRIFT")?.count ?? 0;
  const inc = incremental.issues.find((i) => i.rule === "SHIPMENT_STATE_DRIFT")?.count ?? 0;
  assert.ok(inc <= full, "quét gia tăng không được ra nhiều hơn quét toàn bộ");

  // ───────── 7. Điểm vào của job vẫn quét trước, và nói rõ cái gì cố ý không sửa ─────────
  const job = await checkShipmentConsistency({ fix: false });
  assert.equal(job.fix, false);
  assert.ok(job.issues.length > 0, "job phải trả về danh sách vấn đề, không chỉ vài con số rời rạc");
  assert.ok(
    job.repair.reportedOnly.some((r) => r.rule === "PAYMENT_DELIVERED_CONFLICT" && r.why.length > 0),
    "báo cáo phải nói rõ vì sao có những thứ CỐ Ý không sửa",
  );

  console.log(
    `✓ Đối soát: ${a.issues.length} luật có vi phạm (${a.totals.ERROR} nghiêm trọng · ${a.totals.WARNING} cảnh báo) · chỉ ${AUTO_REPAIRABLE_RULES.length} luật được tự sửa · tiền KHÔNG bao giờ tạo ra "đã giao"`,
  );
}
