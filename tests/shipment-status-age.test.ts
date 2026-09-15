import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { ShipmentStage } from "@/db/schema";
import {
  DWELL_NEXT_ACTION,
  DWELL_SLA,
  dwellLevelOf,
  stageDwellFrom,
  thresholdOf,
  TERMINAL_STAGES,
  type DwellEvent,
} from "@/lib/constants/shipment-status-age";
import { getShipmentStatusAgeQueue } from "@/lib/queries/shipment-status-age";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════════ TUỔI CHẶNG HIỆN TẠI ═══════════
 *
 * Khoá sáu điều, và mỗi điều tương ứng một cách hỏng đã thấy ở kho mã này hoặc ở đặc tả:
 *
 *  1. Đồng hồ KHÔNG bị đặt lại bởi sự kiện CÙNG CHẶNG — đúng cái bẫy đã làm 106 kiện tàng hình
 *     trước đồng hồ im lặng (lib/constants/delivery-tower.ts, 13/09/2026).
 *  2. Mốc lấy từ LOẠT LIỀN KỀ CUỐI, không phải `min()` của mọi sự kiện cùng chặng — kiện quay lại
 *     tuyến sau khi giao hụt không được mang tuổi của lần trung chuyển đầu tiên.
 *  3. CHƯA BIẾT không bao giờ ra "Trong hạn".
 *  4. Hàm THUẦN: đảo thứ tự sự kiện, phát lại mười lần ⇒ cùng một kết quả.
 *  5. Bản SQL và bản TypeScript trả về CÙNG một mốc trên cùng dữ liệu — hai bản nói khác nhau là
 *     dạng hỏng im lặng nhất, vì mỗi bản đều tự nhất quán.
 *  6. Mọi chặng có ngưỡng đều có VIỆC PHẢI LÀM (yêu cầu mục 18: không có ngoại lệ chỉ có ghi chú).
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/shipment-status-age.test.ts
 */

const H = 3_600_000;
const NOW = new Date("2026-09-15T10:00:00.000Z");
const gio = (h: number) => new Date(NOW.getTime() - h * H);

function ev(stage: ShipmentStage | null, hoursAgo: number, source = "VTP_WEBHOOK"): DwellEvent {
  return { source, normalizedStage: stage, occurredAt: gio(hoursAgo) };
}

export function testShipmentStatusAgePure() {
  /* ─── 1 · Sự kiện CÙNG CHẶNG không đặt lại đồng hồ ─── */
  {
    // ĐVVC gửi "phân công bưu tá" mỗi 6 giờ suốt 5 ngày. Kiện vẫn đứng yên ở PENDING.
    const events = [0, 6, 12, 18, 24, 48, 72, 96, 110, 120].map((h) => ev("PENDING", h));
    const v = stageDwellFrom(events, "PENDING", NOW);
    assert.equal(v.eventsInRun, 10, "cả 10 sự kiện thuộc một loạt");
    assert.ok(v.ageHours !== null && Math.abs(v.ageHours - 120) < 0.001, "tuổi chặng đo từ sự kiện SỚM NHẤT của loạt, không phải sự kiện mới nhất");
    assert.equal(v.level, "EXCEPTION", "120 giờ đứng yên ở PENDING vượt ngưỡng 96");
  }

  /* ─── 2 · Loạt liền kề cuối, không phải min() của mọi sự kiện cùng chặng ─── */
  {
    // IN_TRANSIT (200h) → OUT_FOR_DELIVERY (100h) → DELIVERY_FAILED (90h) → IN_TRANSIT (10h)
    const events = [ev("IN_TRANSIT", 200), ev("OUT_FOR_DELIVERY", 100), ev("DELIVERY_FAILED", 90), ev("IN_TRANSIT", 10)];
    const v = stageDwellFrom(events, "IN_TRANSIT", NOW);
    assert.ok(v.ageHours !== null && Math.abs(v.ageHours - 10) < 0.001, "tuổi phải là 10 giờ (lần quay lại tuyến), KHÔNG phải 200 giờ");
    assert.equal(v.eventsInRun, 1);
    assert.equal(v.level, "OK", "10 giờ trong tuyến là bình thường");
  }

  /* ─── 3 · Sự kiện không mang chặng: bỏ qua, không cắt loạt ─── */
  {
    const events = [ev("PENDING", 80), ev(null, 40), ev("UNKNOWN", 20), ev("PENDING", 5)];
    const v = stageDwellFrom(events, "PENDING", NOW);
    assert.ok(v.ageHours !== null && Math.abs(v.ageHours - 80) < 0.001, "dòng NULL/UNKNOWN không được cắt loạt — nếu cắt, tuổi tụt từ 80 xuống 5 giờ");
    assert.equal(v.eventsInRun, 2);
  }

  /* ─── 4 · CHƯA BIẾT không bao giờ là "Trong hạn" ─── */
  {
    // Không sự kiện nào mang chặng hiện tại.
    const v = stageDwellFrom([ev("PENDING", 50)], "OUT_FOR_DELIVERY", NOW);
    assert.equal(v.since, null);
    assert.equal(v.ageHours, null, "CHƯA BIẾT là null, không phải 0");
    assert.equal(v.level, null, "không có mốc thì không kết luận mức");
    assert.equal(v.unrated, "NO_EVIDENCE");
    assert.notEqual(v.level, "OK");

    // Không có sự kiện nào cả (vận đơn cũ dựng từ tệp nhập trước khi có bảng sự kiện).
    const trong = stageDwellFrom([], "IN_TRANSIT", NOW);
    assert.equal(trong.unrated, "NO_EVIDENCE");
    assert.equal(trong.eventsInRun, 0);
  }

  /* ─── 5 · Chặng kết thúc: đo được, nhưng không xếp mức ─── */
  for (const stage of TERMINAL_STAGES) {
    const v = stageDwellFrom([ev(stage, 500)], stage, NOW);
    assert.ok(v.ageHours !== null, `${stage}: tuổi vẫn đo được`);
    assert.equal(v.level, null, `${stage}: không đặt hạn`);
    assert.equal(v.unrated, "TERMINAL_STAGE", `${stage}: lý do phải là chặng kết thúc, không phải thiếu chứng cứ`);
  }

  /* ─── 6 · Hàm THUẦN: đảo thứ tự và phát lại đều ra cùng kết quả ─── */
  {
    const events = [ev("IN_TRANSIT", 200), ev("OUT_FOR_DELIVERY", 100), ev("IN_TRANSIT", 30), ev("IN_TRANSIT", 12)];
    const chuan = stageDwellFrom(events, "IN_TRANSIT", NOW);
    const daoNguoc = stageDwellFrom([...events].reverse(), "IN_TRANSIT", NOW);
    const phatLai = stageDwellFrom([...events, ...events, ...events], "IN_TRANSIT", NOW);
    assert.deepEqual(daoNguoc.since, chuan.since, "đảo thứ tự không được đổi mốc");
    assert.deepEqual(phatLai.since, chuan.since, "phát lại webhook không được đổi mốc");
    assert.equal(chuan.eventsInRun, 2);
    // Phát lại làm SỐ ĐẾM tăng (đó là số dòng thật trong bảng), nhưng MỐC thì không đổi — và mốc
    // mới là thứ mọi cảnh báo đứng lên.
    assert.equal(phatLai.eventsInRun, 6);
  }

  /* ─── 7 · Ranh giới ngưỡng: ĐẠT tới ngưỡng là đã ở mức đó ─── */
  {
    const t = DWELL_SLA.OUT_FOR_DELIVERY!;
    assert.equal(dwellLevelOf(t.exception, t), "EXCEPTION", "đúng bằng ngưỡng ngoại lệ đã là ngoại lệ");
    assert.equal(dwellLevelOf(t.exception - 0.001, t), "WARNING");
    assert.equal(dwellLevelOf(t.warning, t), "WARNING");
    assert.equal(dwellLevelOf(t.watch, t), "WATCH");
    assert.equal(dwellLevelOf(t.watch - 0.001, t), "OK");
    assert.equal(dwellLevelOf(0, t), "OK");
  }

  /* ─── 8 · Ghi đè của chủ shop thắng mặc định, và tắt được hạn ─── */
  {
    const nới = stageDwellFrom([ev("OUT_FOR_DELIVERY", 30)], "OUT_FOR_DELIVERY", NOW, { OUT_FOR_DELIVERY: { exception: 72, warning: 48, watch: 24 } });
    assert.equal(nới.level, "WATCH", "nới ngưỡng thì 30 giờ chỉ còn là để mắt");
    const tắt = stageDwellFrom([ev("OUT_FOR_DELIVERY", 30)], "OUT_FOR_DELIVERY", NOW, { OUT_FOR_DELIVERY: null });
    assert.equal(tắt.level, null);
    assert.equal(tắt.unrated, "NO_THRESHOLD", "tắt hạn phải nói rõ là chưa khai ngưỡng, không phải đang ổn");
    assert.ok(tắt.ageHours !== null, "tắt hạn KHÔNG làm mất phép đo");
    // Ghi đè một phần trên chặng đã có mặc định chỉ đổi đúng mức được khai.
    const motPhan = thresholdOf("IN_TRANSIT", { IN_TRANSIT: { exception: 120 } });
    assert.equal(motPhan?.exception, 120);
    assert.equal(motPhan?.watch, DWELL_SLA.IN_TRANSIT!.watch, "mức không khai vẫn giữ mặc định");
  }

  /* ─── 9 · Nguồn cấp mốc được ghi lại, và chứng từ gốc thắng bản chuyển tiếp khi bằng giờ ─── */
  {
    const chuyenTiep = stageDwellFrom([ev("PENDING", 50, "PANCAKE")], "PENDING", NOW);
    assert.equal(chuyenTiep.sinceBasis, "PANCAKE_RELAY", "Pancake chuyển tiếp VẪN là chứng cứ cho đồng hồ vận hành");
    assert.ok(chuyenTiep.ageHours !== null, "bỏ Pancake ra là làm mù khoảng một nghìn vận đơn đang sống");

    const bangGio = stageDwellFrom([ev("PENDING", 50, "PANCAKE"), ev("PENDING", 50, "VTP_WEBHOOK")], "PENDING", NOW);
    assert.equal(bangGio.sinceBasis, "CARRIER_DOCUMENT", "bằng giờ thì chứng từ gốc thắng");

    // Nguồn lạ (không nằm trong sổ) không được làm chứng.
    const la = stageDwellFrom([ev("PENDING", 50, "NGUON_LA")], "PENDING", NOW);
    assert.equal(la.unrated, "NO_EVIDENCE");
  }

  /* ─── 10 · Mọi chặng có ngưỡng đều có VIỆC PHẢI LÀM ─── */
  for (const [stage, t] of Object.entries(DWELL_SLA)) {
    const action = DWELL_NEXT_ACTION[stage as ShipmentStage];
    assert.ok(action && action.trim().length > 20, `${stage}: phải có câu việc phải làm`);
    if (!t) continue;
    assert.ok(t.watch <= t.warning && t.warning <= t.exception, `${stage}: ba ngưỡng phải tăng dần`);
    assert.ok(t.why.trim().length > 30, `${stage}: ngưỡng không có lý do là ngưỡng không ai dám sửa`);
  }

  console.log("  ✓ tuổi chặng hiện tại (thuần): 10 nhóm");
}

/**
 * BẢN SQL VÀ BẢN TYPESCRIPT PHẢI NÓI CÙNG MỘT ĐIỀU.
 *
 * Đây là bài quan trọng nhất của tệp: hai bản đều tự nhất quán, nên khi chúng lệch nhau thì không
 * màn hình nào báo lỗi — chỉ là hàng đợi hiện một con số và báo cáo hiện một con số khác.
 */
export async function testShipmentStatusAgeDb(db: Db) {
  const P = "sage-";

  async function seedOrder(id: string, value: number) {
    await db
      .insert(schema.orders)
      .values({
        id: P + id,
        systemId: 7_700_000 + Math.floor(Math.random() * 90_000),
        billFullName: `Khách ${id}`,
        billPhone: "0912000111",
        shipAddress: "12 Lê Lợi",
        shipProvince: "Hà Nội",
        totalPriceAfterDiscount: value,
        stage: "SHIPPED",
        insertedAt: gio(500),
      })
      .onConflictDoNothing();
  }

  async function seedShipment(id: string, stage: ShipmentStage, cod: number, events: { stage: ShipmentStage | null; hoursAgo: number; source?: string }[]) {
    await seedOrder(id, cod || 300_000);
    await db
      .insert(schema.shipments)
      .values({
        id: P + id,
        orderId: P + id,
        carrier: "VTP",
        direction: "OUTBOUND",
        trackingCode: (P + id).toUpperCase(),
        vtpOrderNumber: `V${P}${id}`,
        stage,
        codAmount: cod,
        receiverName: `Khách ${id}`,
        receiverPhone: "0912000111",
        createdAt: gio(400),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    let i = 0;
    for (const e of events) {
      await db
        .insert(schema.shipmentEvents)
        .values({
          shipmentId: P + id,
          source: e.source ?? "VTP_WEBHOOK",
          status: `st-${i++}`,
          statusName: e.stage ?? "không rõ",
          occurredAt: gio(e.hoursAgo),
          normalizedStage: e.stage,
        })
        .onConflictDoNothing();
    }
  }

  // 1 · Kiện đứng yên ở PENDING 120 giờ, ĐVVC vẫn gửi tin đều đặn — đúng ca 106 kiện tàng hình.
  await seedShipment("pending-stuck", "PENDING", 890_000, [0, 6, 24, 60, 120].map((h) => ({ stage: "PENDING" as ShipmentStage, hoursAgo: h })));
  // 2 · Đang giao 30 giờ chưa có kết cục.
  await seedShipment("ofd-stuck", "OUT_FOR_DELIVERY", 450_000, [
    { stage: "IN_TRANSIT", hoursAgo: 90 },
    { stage: "OUT_FOR_DELIVERY", hoursAgo: 30 },
  ]);
  // 3 · Quay lại tuyến sau khi giao hụt: tuổi phải tính từ lần quay lại, không từ lần đầu.
  await seedShipment("retry", "IN_TRANSIT", 200_000, [
    { stage: "IN_TRANSIT", hoursAgo: 300 },
    { stage: "OUT_FOR_DELIVERY", hoursAgo: 100 },
    { stage: "DELIVERY_FAILED", hoursAgo: 96 },
    { stage: "IN_TRANSIT", hoursAgo: 8 },
  ]);
  // 4 · Vận đơn cũ không có sự kiện nào: CHƯA BIẾT, không phải 0 và không phải "trong hạn".
  await seedShipment("legacy", "IN_TRANSIT", 700_000, []);
  // 5 · Sự kiện chuyển tiếp qua Pancake vẫn làm chứng được.
  await seedShipment("relay", "PENDING", 150_000, [{ stage: "PENDING", hoursAgo: 100, source: "PANCAKE" }]);
  // 6 · Kiện đã giao xong: nằm ngoài tập theo dõi hoàn toàn.
  await seedShipment("done", "DELIVERED", 500_000, [{ stage: "DELIVERED", hoursAgo: 200 }]);

  clearMemo();
  const { rows, summary } = await getShipmentStatusAgeQueue();
  const byId = new Map(rows.map((r) => [r.shipmentId, r]));
  const get = (id: string) => {
    const r = byId.get(P + id);
    assert.ok(r, `${id} phải có mặt trong hàng đợi`);
    return r!;
  };

  const stuck = get("pending-stuck");
  assert.ok(stuck.statusAgeHours !== null && Math.abs(stuck.statusAgeHours - 120) < 1, `PENDING đứng yên: tuổi ~120 giờ, đo được ${stuck.statusAgeHours}`);
  assert.equal(stuck.eventsInRun, 5, "5 sự kiện cùng chặng — ĐVVC vẫn gửi tin mà kiện không nhích");
  assert.equal(stuck.level, "EXCEPTION");
  assert.equal(stuck.slaBreached, true);
  assert.equal(stuck.team, "WAREHOUSE", "kiện chưa rời kho là việc của kho, không phải giao vận");
  assert.ok(stuck.nextAction.length > 20, "ngoại lệ phải có việc phải làm");

  const ofd = get("ofd-stuck");
  assert.ok(ofd.statusAgeHours !== null && Math.abs(ofd.statusAgeHours - 30) < 1, "đang giao: tuổi đo từ mốc vào OUT_FOR_DELIVERY");
  assert.equal(ofd.level, "EXCEPTION", "30 giờ đang giao vượt ngưỡng 24");
  assert.equal(ofd.team, "CS", "đang giao có khách thật đang chờ");

  const retry = get("retry");
  assert.ok(retry.statusAgeHours !== null && Math.abs(retry.statusAgeHours - 8) < 1, `quay lại tuyến: tuổi ~8 giờ chứ không phải 300, đo được ${retry.statusAgeHours}`);
  assert.equal(retry.level, "OK");

  const legacy = get("legacy");
  assert.equal(legacy.stageSince, null);
  assert.equal(legacy.statusAgeHours, null, "không chứng cứ ⇒ CHƯA BIẾT, không phải 0");
  assert.equal(legacy.level, null);
  assert.equal(legacy.unrated, "NO_EVIDENCE");
  assert.equal(legacy.statusAgeLabel, "chưa biết", "CHƯA BIẾT in ra bằng chữ, không phải '0 giờ'");
  assert.equal(legacy.slaBreached, null, "chưa đo được thì chưa kết luận quá hạn");

  const relay = get("relay");
  assert.equal(relay.sinceBasis, "PANCAKE_RELAY");
  assert.ok(relay.statusAgeHours !== null && Math.abs(relay.statusAgeHours - 100) < 1, "sự kiện Pancake chuyển tiếp vẫn cấp được mốc");

  assert.ok(!byId.has(P + "done"), "kiện đã tới chặng kết thúc không nằm trong tập theo dõi");

  // Tổng hợp: kiện CHƯA BIẾT phải nằm riêng, tuyệt đối không lẫn vào nhóm "trong hạn".
  assert.ok(summary.unrated.NO_EVIDENCE.count >= 1, "phải đếm được số kiện rơi khỏi cohort");
  assert.ok(summary.unrated.NO_EVIDENCE.money >= 700_000, "và tiền đang treo trên nhóm đó");
  assert.ok(summary.breached >= 2, "hai kiện quá hạn ở trên phải có mặt");
  assert.equal(summary.byLevel.EXCEPTION.count, summary.breached, "quá hạn = mức ngoại lệ, một định nghĩa");

  /* ─── BẢN SQL == BẢN TYPESCRIPT ─── */
  const now = summary.measuredAt;
  for (const id of ["pending-stuck", "ofd-stuck", "retry", "legacy", "relay"]) {
    const row = get(id);
    const events = await db.query.shipmentEvents.findMany({ where: (t, { eq }) => eq(t.shipmentId, P + id) });
    const pure = stageDwellFrom(
      events.map((e) => ({ source: e.source, normalizedStage: e.normalizedStage, occurredAt: e.occurredAt })),
      row.stage,
      now,
    );
    assert.equal(
      pure.since?.toISOString() ?? null,
      row.stageSince?.toISOString() ?? null,
      `${id}: mốc vào chặng của SQL và của TypeScript phải bằng nhau`,
    );
    assert.equal(pure.eventsInRun, row.eventsInRun, `${id}: số sự kiện trong loạt phải bằng nhau`);
    assert.equal(pure.level, row.level, `${id}: mức phải bằng nhau`);
    assert.equal(pure.sinceBasis, row.sinceBasis, `${id}: nguồn cấp mốc phải bằng nhau`);
  }

  /* ─── CHẠY HAI LẦN RA CÙNG KẾT QUẢ (không có trạng thái ẩn) ─── */
  clearMemo();
  const lai = await getShipmentStatusAgeQueue();
  assert.equal(lai.rows.length, rows.length);
  assert.equal(lai.summary.breached, summary.breached);

  console.log(`  ✓ tuổi chặng hiện tại (CSDL): ${rows.length} kiện · ${summary.breached} quá hạn · ${summary.unrated.NO_EVIDENCE.count} chưa biết mốc`);
}
