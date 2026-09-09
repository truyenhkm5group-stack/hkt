import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AUTO_REPAIRABLE_RULES, RECONCILIATION_RULES, RECONCILIATION_RULE_ORDER } from "@/lib/constants/reconciliation";
import { checkShipmentConsistency, repairReconciliation, scanReconciliation } from "@/lib/sync/consistency";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { controlTowerDrill, getControlTower } from "@/lib/queries/control-tower";
import { clearMemo } from "@/lib/cache";

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
  // Tên đối tượng viết HOA đồng bộ với phần còn lại của nhật ký (SHIPMENT / ORDER / STOCK_RECEIPT…)
  // để trang Nhật ký lọc được theo một danh sách duy nhất.
  assert.equal(logs[0].entity, "SHIPMENT");
  const repairDetail = logs[0].detail as Record<string, unknown>;
  assert.ok(repairDetail.before && repairDetail.after, "phải ghi TRƯỚC và SAU, nếu không thì lúc số liệu lệch không lần ngược được");
  assert.ok(String(repairDetail.reason).length > 10, "phải ghi VÌ SAO sửa");
  assert.ok(String(repairDetail.correlationId).startsWith("reconcile-"), "phải nối được các thay đổi cùng một lần chạy");

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

  // ───────── 8. TRUNG TÂM ĐIỀU KHIỂN: con số trên thẻ và danh sách mở ra phải BẰNG NHAU ─────────
  clearMemo();
  const tower = await getControlTower();
  assert.ok(tower.issues.length > 0, "trung tâm điều khiển phải thấy được vi phạm");
  assert.equal(tower.ruleCount, RECONCILIATION_RULE_ORDER.length, "phải kiểm đủ mọi luật trong bộ luật");
  assert.equal(tower.issues[0].severity, "ERROR", "vi phạm nghiêm trọng phải nằm trên cùng");
  for (const issue of tower.issues) {
    assert.ok(issue.reason && issue.suggestedAction, `${issue.rule} phải có lý do và việc cần làm`);
    assert.ok(issue.detectedAt instanceof Date, `${issue.rule} phải có mốc phát hiện`);
    assert.ok(issue.entity, `${issue.rule} phải nói rõ vi phạm nằm trên loại đối tượng nào`);
    assert.ok(issue.sample.length > 0 && issue.sample.length <= 5, `${issue.rule} phải có ví dụ`);
    for (const row of issue.sample) assert.ok(row.code && row.evidence, `${issue.rule} phải nêu BẰNG CHỨNG cho từng dòng, không chỉ đếm`);
  }
  // Drill-down dùng CHÍNH câu truy vấn đã đếm nên tổng phải khớp tuyệt đối.
  const first = tower.issues[0];
  const drill = await controlTowerDrill(first.rule, 1, 5);
  assert.equal(drill.total, first.count, "số trên thẻ và số của danh sách mở ra phải bằng nhau");
  assert.ok(drill.rows.length <= 5);
  if (first.count > 5) {
    const page2 = await controlTowerDrill(first.rule, 2, 5);
    assert.ok(page2.rows.length > 0, "phân trang phải chạy");
    assert.notDeepEqual(page2.rows.map((r) => r.code), drill.rows.map((r) => r.code), "trang 2 phải khác trang 1");
  }
  // Luật mới của trung tâm điều khiển phải thật sự chạy được.
  for (const rule of ["DELIVERED_WITHOUT_LOGISTICS_EVIDENCE", "MISSING_PRODUCT_MAPPING", "ZERO_TOTAL_WITH_ITEMS", "DUPLICATE_TRACKING", "INVALID_EVENT_ORDER"] as const) {
    const r = await controlTowerDrill(rule, 1, 3);
    assert.ok(r.total >= 0, `${rule} phải chạy được`);
  }

  console.log(
    `✓ Trung tâm điều khiển: ${tower.firing}/${tower.ruleCount} luật đang có vi phạm · ${tower.totals.ERROR} nghiêm trọng · số trên thẻ khớp danh sách mở ra`,
  );

  // ───────── MỘT ĐƠN CÓ THỂ CÓ NHIỀU LẦN GỬI, VÀ TIỀN VẪN ĐẾM MỘT LẦN ─────────
  //
  // Trước 10/09/2026 ràng buộc `shipments_order_id_unique` chặn cứng lần gửi thứ hai. Cái giá không
  // nhìn thấy: đường đồng bộ GHI ĐÈ lên lần gửi đầu khi Pancake báo mã vận đơn mới — lần đầu biến
  // mất khỏi sổ, không cảnh báo.
  //
  // Nay ràng buộc đã gỡ. Nghĩa vụ đi kèm: mọi đường tính TIỀN phải ở grain ĐƠN, nếu không ngay lần
  // gửi lại đầu tiên doanh thu bị đếm hai lần trong im lặng.
  const [donGoc] = await db.select({ id: schema.orders.id }).from(schema.orders).limit(1);
  if (donGoc) {
    await db
      .insert(schema.shipments)
      .values([
        { id: "grain-vd-1", orderId: donGoc.id, vtpOrderNumber: "GRAIN001", stage: "CANCELLED", attemptNo: 90, direction: "OUTBOUND" },
        { id: "grain-vd-2", orderId: donGoc.id, vtpOrderNumber: "GRAIN002", stage: "DELIVERED", attemptNo: 91, direction: "OUTBOUND" },
      ])
      .onConflictDoNothing();

    const lanGui = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, donGoc.id));
    assert.ok(lanGui.length >= 2, "CASE E: CSDL phải CHẤP NHẬN lần gửi thứ hai của cùng một đơn");

    // CASE A: lần 1 huỷ, lần 2 giao thành công ⇒ đơn được đếm ĐÚNG MỘT LẦN, và lần quyết định là
    // lần tới tay khách.
    const [{ n: soDong }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.orders)
      .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id} and ${PRIMARY_ATTEMPT}`)
      .where(sql`${schema.orders.id} = ${donGoc.id}`);
    assert.equal(Number(soDong), 1, "CASE A: đơn có hai lần gửi vẫn chỉ ra MỘT dòng ở đường tính tiền — không nhân đôi doanh thu");

    const [chon] = await db
      .select({ id: schema.shipments.id })
      .from(schema.orders)
      .innerJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id} and ${PRIMARY_ATTEMPT}`)
      .where(sql`${schema.orders.id} = ${donGoc.id}`);
    assert.equal(chon.id, "grain-vd-2", "lần gửi TỚI TAY KHÁCH phải là lần quyết định, không phải lần huỷ");

    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ["grain-vd-1", "grain-vd-2"]));
    clearMemo();
  }

  // Luật đối soát nay là CHUÔNG BÁO cho trường hợp đáng ngờ: đơn có nhiều lần gửi là hợp lệ về mô
  // hình, nhưng vẫn đáng nhìn — nó có thể là gửi lại thật, cũng có thể là ghép nhầm vận đơn.
  clearMemo();
  const thap = await getControlTower();
  const luatNhieuVanDon = thap.issues.find((i) => i.rule === "ORDER_WITH_MULTIPLE_SHIPMENTS");
  assert.equal(luatNhieuVanDon, undefined, "dọn xong các lần gửi thử thì luật này phải im trở lại");

  console.log(
    `✓ Đối soát: ${a.issues.length} luật có vi phạm (${a.totals.ERROR} nghiêm trọng · ${a.totals.WARNING} cảnh báo) · chỉ ${AUTO_REPAIRABLE_RULES.length} luật được tự sửa · tiền KHÔNG bao giờ tạo ra "đã giao"`,
  );
}
