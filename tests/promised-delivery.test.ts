import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { OrderStage } from "@/db/schema";
import {
  PROMISED_MAX_DAYS_AHEAD,
  PROMISED_MAX_DAYS_BEHIND,
  PROMISED_NEXT_ACTION,
  PROMISED_PRIORITY,
  PROMISED_STATES,
  promiseSuppressesInternalSla,
  promisedVerdict,
  sqlPromiseNotSuppressing,
} from "@/lib/constants/promised-delivery";
import { promisedDeliveryInput } from "@/lib/validation/promised-delivery";
import { getPromisedDeliveryQueue } from "@/lib/queries/promised-delivery";
import { getFulfillmentBottleneckQueue } from "@/lib/queries/fulfillment-bottleneck";
import { addDays, todayVN, vnEndOfDay } from "@/lib/format";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════════ KHÁCH HẸN NGÀY GIAO ═══════════
 *
 * Khoá năm điều, và điều thứ hai là điều dễ làm sai nhất:
 *
 *  1. Còn trong hẹn ⇒ KHÔNG sinh trễ hạn giả.
 *  2. Nhưng cái hẹn KHÔNG được làm đơn tàng hình: tới gần ngày, đơn phải TỰ quay lại hàng đợi.
 *     Một bản chỉ lọc "còn hạn thì ẩn" sẽ xanh ở điều 1 và hỏng im lặng ở điều 2 — ngày hẹn tới,
 *     đơn nằm lại đúng chỗ cũ và không ai biết phải gói nó.
 *  3. Quá hẹn là trễ với KHÁCH, nặng hơn trễ nội bộ ⇒ `URGENT`.
 *  4. Đổi ngày hẹn thì trạng thái đổi theo ngay, không cần job nào chạy.
 *  5. Hàng đợi nút thắt kho THẬT SỰ bỏ qua đơn còn trong hẹn (kiểm trên CSDL, không kiểm bằng lời).
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/promised-delivery.test.ts
 */

const NOW = new Date("2026-09-15T03:00:00.000Z"); // 10:00 giờ VN ngày 15/09
const ngay = (d: string) => vnEndOfDay(d);

export function testPromisedDeliveryPure() {
  /* ─── 1 · Không có hẹn ⇒ không nói gì, và KHÔNG tha ─── */
  {
    const v = promisedVerdict(null, NOW);
    assert.equal(v.state, "NONE");
    assert.equal(v.promisedAt, null);
    assert.equal(v.hoursRemaining, null, "CHƯA BIẾT là null, không phải 0");
    assert.equal(v.priority, null, "không có hẹn thì cái hẹn không nói gì về mức ưu tiên");
    assert.equal(promiseSuppressesInternalSla(null, NOW), false, "đơn KHÔNG có hẹn tuyệt đối không được tha khỏi hạn nội bộ");
  }

  /* ─── 2 · Hẹn còn xa ⇒ tha, và KHÔNG phải việc của hôm nay ─── */
  {
    const v = promisedVerdict(ngay("2026-09-20"), NOW);
    assert.equal(v.state, "FUTURE");
    assert.equal(v.priority, null);
    assert.equal(promiseSuppressesInternalSla(ngay("2026-09-20"), NOW), true);
    assert.ok(v.hoursRemaining !== null && v.hoursRemaining > 100);
  }

  /* ─── 3 · T-1: đơn TỰ QUAY LẠI hàng đợi, thôi được tha ─── */
  {
    // Cuối ngày 16/09 giờ VN — còn ~38 giờ tính từ 10:00 ngày 15.
    const v = promisedVerdict(ngay("2026-09-16"), NOW);
    assert.equal(v.state, "DUE_SOON", "trước hẹn một ngày phải quay lại hàng đợi");
    assert.equal(v.priority, "NORMAL", "P2: chuẩn bị gói, chưa phải gấp");
    assert.equal(promiseSuppressesInternalSla(ngay("2026-09-16"), NOW), false, "thôi tha — lúc này việc gói hàng là việc thật");
  }

  /* ─── 4 · Đến ngày hẹn ⇒ P1 ─── */
  {
    const v = promisedVerdict(ngay("2026-09-15"), NOW);
    assert.equal(v.state, "DUE", "hôm nay là ngày khách hẹn");
    assert.equal(v.priority, "HIGH");
    assert.equal(promiseSuppressesInternalSla(ngay("2026-09-15"), NOW), false);
  }

  /* ─── 5 · Quá hẹn ⇒ trễ với KHÁCH, và luôn URGENT ─── */
  {
    const hom_qua = promisedVerdict(ngay("2026-09-14"), NOW);
    assert.equal(hom_qua.state, "BREACHED");
    assert.equal(hom_qua.priority, "URGENT");
    assert.ok(hom_qua.hoursRemaining !== null && hom_qua.hoursRemaining < 0, "giờ còn lại phải ÂM khi đã lỡ");
    assert.ok(hom_qua.nextAction.includes("Gọi khách"), "việc phải làm là gọi khách TRƯỚC khi họ phải hỏi");

    // Lỡ một ngày và lỡ mười ngày CÙNG mức: người đang chờ không quan tâm đơn nằm kho bao lâu.
    const muoi_ngay = promisedVerdict(ngay("2026-09-05"), NOW);
    assert.equal(muoi_ngay.priority, "URGENT");
    assert.equal(hom_qua.priority, muoi_ngay.priority);
  }

  /* ─── 6 · Đơn ĐÃ rời kho: lời hẹn thôi sinh việc ─── */
  {
    const v = promisedVerdict(ngay("2026-09-10"), NOW, true);
    assert.notEqual(v.state, "BREACHED", "kiện đã đi rồi thì phần việc của shop xong — không giữ một việc không ai làm được nữa");
    assert.ok(v.promisedAt, "vẫn trả mốc để màn hình in ra");
  }

  /* ─── 7 · Mọi trạng thái đều khai đủ nhãn và việc phải làm ─── */
  for (const st of PROMISED_STATES) {
    assert.ok(PROMISED_NEXT_ACTION[st]?.trim().length > 20, `${st}: phải có việc phải làm`);
    assert.ok(st in PROMISED_PRIORITY, `${st}: phải khai mức ưu tiên (kể cả null)`);
  }

  /* ─── 8 · Biểu thức SQL và hàm TypeScript nói cùng một điều ─── */
  {
    const bieu_thuc = sqlPromiseNotSuppressing("o.customer_promised_at");
    assert.ok(bieu_thuc.includes("is null"), "quên vế `is null` là làm MỌI đơn bình thường biến mất khỏi cảnh báo");
    assert.ok(bieu_thuc.includes("48 hours"), "ngưỡng phải suy từ hằng số, không gõ tay");
  }

  /* ─── 9 · Kiểm đầu vào ─── */
  {
    const ok = promisedDeliveryInput.safeParse({ orderId: "x", date: addDays(todayVN(), 3), note: "Khách đi công tác tới ngày 18" });
    assert.equal(ok.success, true);

    const xa = promisedDeliveryInput.safeParse({ orderId: "x", date: addDays(todayVN(), PROMISED_MAX_DAYS_AHEAD + 5), note: "hẹn xa" });
    assert.equal(xa.success, false, "hẹn quá xa gần như chắc chắn là gõ nhầm năm");

    const lui = promisedDeliveryInput.safeParse({ orderId: "x", date: addDays(todayVN(), -(PROMISED_MAX_DAYS_BEHIND + 5)), note: "hẹn cũ" });
    assert.equal(lui.success, false, "không dựng được một lịch sử tuỳ ý");

    const khong_ly_do = promisedDeliveryInput.safeParse({ orderId: "x", date: addDays(todayVN(), 3), note: "" });
    assert.equal(khong_ly_do.success, false, "một ngày hẹn không có lý do thì người sau không kiểm được");

    const sai_dang = promisedDeliveryInput.safeParse({ orderId: "x", date: "20/09/2026", note: "khách hẹn" });
    assert.equal(sai_dang.success, false, "chỉ nhận YYYY-MM-DD — client không được gửi một mốc tự diễn giải");
  }

  console.log("  ✓ khách hẹn ngày giao (thuần): 9 nhóm");
}

export async function testPromisedDeliveryDb(db: Db) {
  const P = "prom-";
  let seq = 0;

  async function seedOrder(id: string, opts: { promisedDays: number | null; stage?: OrderStage; hoursAgo?: number }) {
    await db
      .insert(schema.orders)
      .values({
        id: P + id,
        systemId: 6_600_000 + seq,
        billFullName: "Trần Văn Hẹn",
        billPhone: "0977000111",
        shipAddress: "45 Nguyễn Trãi, Phường 7",
        shipProvince: "Hồ Chí Minh",
        totalPriceAfterDiscount: 750_000,
        stage: opts.stage ?? "CONFIRMED",
        // Đơn CŨ theo mặc định: nếu không có lời hẹn thì nó PHẢI bị hàng đợi nút thắt bắt.
        insertedAt: new Date(Date.now() - (opts.hoursAgo ?? 240) * 3_600_000),
        lastUpdateStatusAt: new Date(Date.now() - (opts.hoursAgo ?? 240) * 3_600_000),
        customerPromisedAt: opts.promisedDays === null ? null : vnEndOfDay(addDays(todayVN(), opts.promisedDays)),
        customerPromisedNote: opts.promisedDays === null ? "" : "Khách đi công tác",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.orderItems)
      .values({ id: `${P}${id}-i`, orderId: P + id, sku: "HEN-M", productName: "Áo hẹn", quantity: 1, unitPrice: 750_000, lineTotal: 750_000 })
      .onConflictDoNothing();
    seq += 1;
  }

  await seedOrder("khong-hen", { promisedDays: null });
  await seedOrder("hen-xa", { promisedDays: 10 });
  await seedOrder("hen-mai", { promisedDays: 1 });
  await seedOrder("hen-hom-nay", { promisedDays: 0 });
  await seedOrder("lo-hen", { promisedDays: -3 });

  clearMemo();
  const q = await getPromisedDeliveryQueue();
  const by = new Map(q.rows.map((r) => [r.orderId, r]));

  assert.ok(!by.has(`${P}khong-hen`), "đơn không có hẹn không thuộc hàng đợi này");
  assert.equal(by.get(`${P}hen-xa`)?.verdict.state, "FUTURE");
  assert.equal(by.get(`${P}hen-mai`)?.verdict.state, "DUE_SOON");
  assert.equal(by.get(`${P}hen-hom-nay`)?.verdict.state, "DUE");
  assert.equal(by.get(`${P}lo-hen`)?.verdict.state, "BREACHED");

  assert.ok(q.byState.FUTURE >= 1, "đơn còn trong hẹn phải ĐẾM ĐƯỢC — đó là lời hứa shop đang giữ");
  assert.ok(q.actionable >= 2, "tới hạn + đã lỡ là việc phải làm hôm nay");
  assert.ok(q.breached >= 1);
  // Lỡ hẹn xếp trên cùng.
  assert.equal(q.rows[0]?.verdict.state, "BREACHED", "lỡ hẹn với khách phải đứng đầu hàng đợi");

  // Tên người ghi: chưa có khoá ⇒ null, KHÔNG bịa tên.
  assert.equal(by.get(`${P}hen-xa`)?.recordedBy, null, "dòng chưa nối khoá tài khoản thì để trống, không đoán người");

  /* ─── ĐIỀU QUAN TRỌNG NHẤT: hàng đợi nút thắt kho thật sự đổi hành vi ─── */
  clearMemo();
  const nutThat = await getFulfillmentBottleneckQueue();
  const bottleneckIds = new Set(nutThat.cases.map((c) => c.orderId));

  assert.ok(bottleneckIds.has(`${P}khong-hen`), "đơn cũ KHÔNG có hẹn vẫn phải bị bắt là nút thắt — nếu không, vế lọc đã bắt nhầm cả đơn thường");
  assert.ok(!bottleneckIds.has(`${P}hen-xa`), "đơn còn trong hẹn KHÔNG được đếm là tắc");
  // Và đây là điều mà một bản 'chỉ ẩn đi' sẽ làm sai:
  assert.ok(bottleneckIds.has(`${P}hen-mai`), "TỚI GẦN NGÀY HẸN đơn phải QUAY LẠI hàng đợi — cái hẹn là đồng hồ ngược, không phải công tắc tàng hình");
  assert.ok(bottleneckIds.has(`${P}hen-hom-nay`), "đến ngày hẹn mà chưa gửi thì đó là việc gấp");
  assert.ok(bottleneckIds.has(`${P}lo-hen`), "đã lỡ hẹn thì càng phải nằm trong hàng đợi");

  /* ─── Chạy lại ra cùng kết quả ─── */
  clearMemo();
  const lai = await getPromisedDeliveryQueue();
  assert.deepEqual(
    lai.rows.map((r) => `${r.orderId}:${r.verdict.state}`),
    q.rows.map((r) => `${r.orderId}:${r.verdict.state}`),
    "chạy hai lần phải ra cùng danh sách theo cùng thứ tự",
  );

  console.log(`  ✓ khách hẹn ngày giao (CSDL): ${q.rows.length} đơn có hẹn · ${q.byState.FUTURE} còn trong hẹn · ${q.actionable} phải làm hôm nay · ${q.breached} đã lỡ`);
}
