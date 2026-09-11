import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { CASE_SLA_HOURS, CASE_STATUS_LABEL, CASE_TYPE_LABEL, caseStatusOf, RECOVERABILITY, TEAM_LABEL, caseScore, caseScoreBreakdown, caseTypeOf, priorityOf, scoreExplanation, slaFor, teamOf, type CaseType } from "@/lib/constants/action-queue";
import { getActionQueue, queueThroughput } from "@/lib/queries/action-queue";

/**
 * HÀNG ĐỢI VIỆC.
 *
 * Điều phải khoá: mức ưu tiên là QUY TẮC đọc được, không phải cảm tính; và ba trạng thái
 * đã đọc / đã tiếp nhận / đã xong không được gộp làm một.
 */
export async function testActionQueue(db: Db) {
  // ───────── 1. Công thức ưu tiên: bốn yếu tố, mỗi yếu tố đẩy điểm lên ─────────
  const base = { severity: "warning", ageHours: 0, amount: 0, type: "DELIVERY_STALE" as const };
  const older = caseScore({ ...base, ageHours: 24 * 7 });
  const richer = caseScore({ ...base, amount: 5_000_000 });
  const worse = caseScore({ ...base, severity: "critical" });
  const plain = caseScore(base);
  assert.ok(older > plain, "việc để lâu hơn phải được ưu tiên hơn");
  assert.ok(richer > plain, "việc dính nhiều tiền hơn phải được ưu tiên hơn");
  assert.ok(worse > plain, "việc nghiêm trọng hơn phải được ưu tiên hơn");

  // KHẢ NĂNG CỨU ĐƯỢC là yếu tố phân biệt hàng đợi việc với danh sách cảnh báo.
  const failed = caseScore({ severity: "warning", ageHours: 24, amount: 500_000, type: "DELIVERY_FAILED" });
  const returning = caseScore({ severity: "warning", ageHours: 24, amount: 500_000, type: "RETURNING" });
  assert.ok(failed > returning, "đơn giao thất bại (còn gọi lại được) phải đứng trên đơn đã đang hoàn về");
  assert.ok(RECOVERABILITY.DELIVERY_FAILED > RECOVERABILITY.RETURNING);

  // Tuổi việc bão hoà: để 3 tuần không được gấp gấp ba lần để 1 tuần.
  const oneWeek = caseScore({ ...base, ageHours: 24 * 7 });
  const threeWeeks = caseScore({ ...base, ageHours: 24 * 21 });
  assert.equal(oneWeek, threeWeeks, "tuổi việc phải bão hoà, nếu không việc cũ sẽ nhấn chìm việc mới");

  // ───────── 1b. Hai yếu tố mới, và tổng vẫn nằm trong 0–100 ─────────
  // CÓ KHÁCH ĐANG CHỜ tách khỏi mức nghiêm trọng: một luật dữ liệu sai có thể rất nghiêm trọng
  // nhưng không ai ngồi chờ; một đơn giao hụt thì có khách thật đang cầm điện thoại.
  const waiting = caseScore({ severity: "warning", ageHours: 24, amount: 0, type: "CS_CASE" });
  const internal = caseScore({ severity: "warning", ageHours: 24, amount: 0, type: "COD_OVERDUE" });
  const partsWaiting = caseScoreBreakdown({ severity: "warning", ageHours: 24, amount: 0, type: "CS_CASE" });
  const partsInternal = caseScoreBreakdown({ severity: "warning", ageHours: 24, amount: 0, type: "COD_OVERDUE" });
  assert.ok(partsWaiting.customer > 0 && partsInternal.customer === 0, "chỉ việc có khách chờ mới được cộng phần đó");
  assert.ok(waiting > internal, "việc có khách đang chờ phải đứng trên việc nội bộ cùng mức nghiêm trọng");

  // SẮP CHÁY HÀNG: càng gần ngày hết hàng càng gấp; chưa tra được thì không cộng điểm ảo.
  const soon = caseScoreBreakdown({ severity: "warning", ageHours: 0, type: "STOCKOUT_RISK", daysToStockout: 2 });
  const later = caseScoreBreakdown({ severity: "warning", ageHours: 0, type: "STOCKOUT_RISK", daysToStockout: 12 });
  const unknownStock = caseScoreBreakdown({ severity: "warning", ageHours: 0, type: "STOCKOUT_RISK", daysToStockout: null });
  assert.ok(soon.proximity > later.proximity, "cháy hàng trong 2 ngày phải gấp hơn cháy hàng sau 12 ngày");
  assert.equal(unknownStock.proximity, 0, "chưa dự báo được thì KHÔNG cộng điểm — không biết không phải là gấp");

  // Trần điểm: mọi yếu tố kịch khung vẫn không vượt 100.
  const maxed = caseScore({ severity: "critical", ageHours: 24 * 365, amount: 999_000_000, type: "DELIVERY_FAILED", daysToStockout: 0 });
  assert.ok(maxed <= 100, `điểm ưu tiên phải nằm trong 0–100, nhận ${maxed}`);

  // Phải giải thích được vì sao: điểm mà người đọc không kiểm chứng được thì không khác gì cảm tính.
  assert.ok(scoreExplanation(partsWaiting).includes("khách đang chờ"), "lời giải thích phải nêu đúng yếu tố nổi bật");

  assert.equal(priorityOf(95), "URGENT");
  assert.equal(priorityOf(55), "HIGH");
  assert.equal(priorityOf(35), "NORMAL");
  assert.equal(priorityOf(10), "LOW");
  assert.equal(caseTypeOf("SHIPMENT_FAILED"), "DELIVERY_FAILED");
  assert.equal(caseTypeOf("KHONG_CO_LOAI_NAY"), "OTHER");

  // ───────── 1c. Hạn xử lý: có hạn thì phải đo được, không hạn thì phải có lý do ─────────
  const now = new Date("2026-09-08T10:00:00+07:00");
  const detected = new Date("2026-09-08T00:00:00+07:00"); // 10 giờ trước
  const inTime = slaFor("DELIVERY_FAILED", detected, now); // hạn 24 giờ
  const late = slaFor("CS_CASE", detected, now); // hạn 4 giờ
  assert.ok(inTime && !inTime.breached && inTime.hoursRemaining > 0, "việc còn trong hạn không được báo trễ");
  assert.ok(late && late.breached && late.hoursRemaining < 0, "case CSKH 10 giờ chưa xử lý phải là trễ hạn");
  assert.ok(late.label.includes("trễ hạn"), "nhãn trễ hạn phải đọc được bằng tiếng Việt");
  assert.equal(inTime.dueAt.getTime(), detected.getTime() + 24 * 3_600_000, "hạn tính từ lúc PHÁT HIỆN, không phải từ bây giờ");

  // CỐ Ý KHÔNG ĐẶT HẠN cho việc mà không ai làm gì được, hoặc cần người đối chiếu chứng từ:
  // đặt hạn ở đó chỉ tạo số trễ hạn giả và ép ghép bừa vận đơn — đúng thứ luật cấm.
  assert.equal(slaFor("RETURNING", detected, now), null, "đang chuyển hoàn thì chưa làm được gì, không đặt hạn");
  assert.equal(CASE_SLA_HOURS.AMBIGUOUS_ORDER_SHIPMENT_MAPPING, null, "việc cần người đối chiếu KHÔNG được đặt hạn");
  assert.equal(CASE_SLA_HOURS.ORPHAN_SHIPMENT, null);
  // Mọi loại việc phải khai hạn một cách tường minh (số hoặc null), không được thiếu khoá.
  for (const t of Object.keys(CASE_TYPE_LABEL) as (keyof typeof CASE_TYPE_LABEL)[]) {
    assert.ok(t in CASE_SLA_HOURS, `${t}: thiếu khai hạn xử lý`);
  }
  // Việc có khách đang chờ phải có hạn ngắn hơn việc nội bộ.
  assert.ok((CASE_SLA_HOURS.CS_CASE ?? 0) < (CASE_SLA_HOURS.COD_OVERDUE ?? 0), "khách chờ phải gấp hơn việc đòi tiền nội bộ");

  // ───────── 2. Hàng đợi thật: mỗi việc phải đủ thông tin để làm ─────────
  const queue = await getActionQueue({ limit: 200 });
  assert.ok(queue.cases.length > 0, "fixture phải có việc đang mở");
  for (const c of queue.cases) {
    assert.ok(c.typeLabel && CASE_TYPE_LABEL[c.type], `${c.id}: phải có loại việc`);
    assert.ok(c.recommendedAction.length > 10, `${c.id}: phải nói rõ nên làm gì`);
    assert.ok(c.detectedAt instanceof Date, `${c.id}: phải có thời điểm phát hiện`);
    assert.ok(c.ageHours >= 0 && c.ageLabel.length > 0, `${c.id}: phải có tuổi việc`);
    assert.ok(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "IGNORED"].includes(c.status));
    // Mỗi việc phải nói được nó dựa trên bằng chứng nào — không có bằng chứng thì không phải việc.
    assert.ok(c.evidence.source.length > 0 && c.evidence.detail.length > 0, `${c.id}: phải có bằng chứng`);
    assert.ok(c.financialImpact >= 0, `${c.id}: tiền liên quan không được âm`);
    assert.ok(c.recoverability > 0 && c.recoverability <= 1, `${c.id}: phải biết còn cứu được bao nhiêu`);
    assert.ok(c.score >= 0 && c.score <= 100, `${c.id}: điểm ưu tiên phải trong 0–100`);
    assert.ok(c.scoreExplanation.length > 0, `${c.id}: phải giải thích được vì sao xếp ưu tiên như vậy`);
    const sum = Math.round(c.scoreParts.severity + c.scoreParts.age + c.scoreParts.money + c.scoreParts.recoverability + c.scoreParts.customer + c.scoreParts.proximity);
    assert.equal(sum, c.score, `${c.id}: tổng các phần điểm phải đúng bằng điểm hiển thị`);
    if (c.sla) assert.equal(c.sla.breached, c.sla.hoursRemaining < 0, `${c.id}: cờ trễ hạn phải khớp số giờ còn lại`);
  }
  // ───────── HẠN XỬ LÝ ĐẾM TỪ LÚC ERP GIAO VIỆC, KHÔNG TỪ MỐC NGHIỆP VỤ ─────────
  //
  // Production 10/09/2026: 237/237 "đơn mới chưa xử lý" trễ hạn ngay lúc sinh ra — luật chờ 24 giờ
  // mới mở việc, nhưng hạn 12 giờ đếm từ lúc LÊN ĐƠN. Cờ trễ hạn vì thế không phân biệt được gì.
  const [vuaGiao] = await db
    .insert(schema.notifications)
    .values({ kind: "ORDER_PENDING", severity: "warning", title: "Đơn nằm 10 ngày, việc vừa được giao", body: "kiểm hạn xử lý", href: "/orders/sla-1", entityType: "ORDER", entityId: "sla-anchor-1", dedupeKey: "sla-anchor-1", occurredAt: new Date(Date.now() - 10 * 86_400_000) })
    .returning({ id: schema.notifications.id });
  const viecVuaGiao = (await getActionQueue({ limit: 500, filter: { type: "NEW_ORDER_UNPROCESSED" } })).cases.find((c) => c.id === vuaGiao.id);
  assert.ok(viecVuaGiao, "việc vừa giao phải có trong hàng đợi");
  assert.ok(viecVuaGiao.ageHours >= 239, "tuổi việc vẫn đo từ mốc nghiệp vụ (đơn nằm 10 ngày)");
  assert.ok(viecVuaGiao.sla && !viecVuaGiao.sla.breached, "việc VỪA được giao không thể đã trễ hạn — hạn đếm từ lúc giao việc, không từ lúc lên đơn");
  await db.delete(schema.notifications).where(eq(schema.notifications.id, vuaGiao.id));

  // Xếp giảm dần theo điểm — người mở trang làm từ trên xuống là đúng thứ tự.
  for (let n = 1; n < queue.cases.length; n += 1) {
    assert.ok(queue.cases[n - 1].score >= queue.cases[n].score, "hàng đợi phải xếp theo mức ưu tiên giảm dần");
  }
  const totalByPriority = queue.totals.URGENT + queue.totals.HIGH + queue.totals.NORMAL + queue.totals.LOW;
  assert.equal(totalByPriority, queue.cases.length, "tổng theo mức ưu tiên phải bằng tổng việc");
  assert.equal(queue.byType.reduce((t, r) => t + r.count, 0), queue.cases.length, "tổng theo loại phải bằng tổng việc");

  // ───────── 3. Năm trạng thái tách bạch: đã đọc ≠ tiếp nhận ≠ đang làm ≠ xong ≠ bỏ qua ─────────
  // Người thật để gán việc — cột người nhận có khoá ngoại sang users, cố ý để không gán cho
  // một cái tên không tồn tại rồi mất dấu trách nhiệm.
  const [owner] = await db
    .insert(schema.users)
    .values({ email: `queue-${Date.now()}@test.local`, name: "Nhân viên kiểm thử", passwordHash: "x", role: "CS" })
    .returning({ id: schema.users.id });

  const target = queue.cases[0];
  const [before] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, target.id));
  assert.equal(before.acknowledgedAt, null, "việc mới chưa được tiếp nhận");
  // Đánh dấu đã đọc KHÔNG được biến việc thành đã tiếp nhận.
  await db.update(schema.notifications).set({ readBy: ["u-test"] }).where(eq(schema.notifications.id, target.id));
  const afterRead = await getActionQueue({ limit: 200 });
  assert.equal(afterRead.cases.find((c) => c.id === target.id)?.status, "OPEN", "đọc rồi KHÔNG có nghĩa là có người làm");

  // Tiếp nhận thì trạng thái đổi và có người cầm việc.
  await db
    .update(schema.notifications)
    .set({ acknowledgedAt: new Date(), acknowledgedBy: owner.id, assignedTo: owner.id })
    .where(eq(schema.notifications.id, target.id));
  const afterAck = await getActionQueue({ limit: 200 });
  assert.equal(afterAck.cases.find((c) => c.id === target.id)?.status, "ACKNOWLEDGED", "đã tiếp nhận phải hiện đúng trạng thái");
  assert.equal(afterAck.cases.find((c) => c.id === target.id)?.owner?.id, owner.id, "phải biết ai đang cầm việc");

  // ĐANG LÀM khác ĐÃ TIẾP NHẬN: giơ tay không phải là đang chạy.
  await db.update(schema.notifications).set({ startedAt: new Date(), startedBy: owner.id }).where(eq(schema.notifications.id, target.id));
  const afterStart = await getActionQueue({ limit: 200 });
  assert.equal(afterStart.cases.find((c) => c.id === target.id)?.status, "IN_PROGRESS", "đã bắt tay vào phải khác với mới giơ tay");

  // BỎ QUA khác ĐÃ XONG. Việc bỏ qua vẫn hiện (để còn lật lại được) nhưng không tính là đang trôi
  // và không cộng tiền vào tổng — nếu gộp vào "đã xong" thì con số "đã xong" thành vô nghĩa.
  const second = queue.cases.find((c) => c.id !== target.id && c.financialImpact > 0) ?? queue.cases[1];
  if (second) {
    await db
      .update(schema.notifications)
      .set({ ignoredAt: new Date(), ignoredBy: owner.id, ignoredReason: "Khách đã tự huỷ, không cần làm" })
      .where(eq(schema.notifications.id, second.id));
    const afterIgnore = await getActionQueue({ limit: 200 });
    const ignored = afterIgnore.cases.find((c) => c.id === second.id);
    assert.equal(ignored?.status, "IGNORED", "bỏ qua phải là trạng thái riêng, không phải đã xong");
    assert.ok(ignored?.ignoredReason.length, "bỏ qua PHẢI có lý do — gạt việc đi không nói vì sao là xoá bằng chứng");
    assert.ok(afterIgnore.financialImpact <= afterStart.financialImpact, "tiền của việc đã bỏ qua không được cộng vào tổng đang treo");
  }

  // Đóng việc thì nó rời khỏi hàng đợi. Ràng buộc CSDL bắt phải khai VÌ SAO đóng — không có đường
  // nào đóng một việc mà không nói nó được đóng bằng cách nào.
  await db
    .update(schema.notifications)
    .set({ resolvedAt: new Date(), resolution: "MANUAL", resolvedBy: null })
    .where(eq(schema.notifications.id, target.id));
  const afterResolve = await getActionQueue({ limit: 200 });
  assert.equal(afterResolve.cases.find((c) => c.id === target.id), undefined, "việc đã xong không còn nằm trong hàng đợi");

  // ───────── 3b. Bộ lọc chỉ cắt danh sách, KHÔNG được đổi các con số tổng hợp ─────────
  // Nếu tổng cũng bị lọc thì chọn một bộ lọc là thấy "hết việc rồi" — đúng kiểu số liệu tự trấn an.
  const all = await getActionQueue({ limit: 200 });
  const onlyUrgentish = await getActionQueue({ limit: 200, filter: { minAmount: 1 } });
  assert.equal(onlyUrgentish.total, all.total, "tổng số việc không được đổi theo bộ lọc");
  assert.equal(onlyUrgentish.financialImpact, all.financialImpact, "tổng tiền treo không được đổi theo bộ lọc");
  assert.ok(onlyUrgentish.matched <= onlyUrgentish.total, "số việc đang xem không thể nhiều hơn tổng");
  assert.ok(onlyUrgentish.cases.every((c) => c.financialImpact >= 1), "lọc theo tiền phải cắt đúng");

  const unassignedOnly = await getActionQueue({ limit: 200, filter: { owner: "" } });
  assert.ok(unassignedOnly.cases.every((c) => !c.owner), "lọc 'chưa ai nhận' không được lẫn việc đã có người");

  // Xếp theo tiền và theo tuổi phải thật sự đổi thứ tự, không phải nhãn suông.
  const byMoney = await getActionQueue({ limit: 200, filter: { sort: "money" } });
  for (let i = 1; i < byMoney.cases.length; i += 1) {
    assert.ok(byMoney.cases[i - 1].financialImpact >= byMoney.cases[i].financialImpact, "xếp theo tiền phải giảm dần");
  }
  const byAge = await getActionQueue({ limit: 200, filter: { sort: "age" } });
  for (let i = 1; i < byAge.cases.length; i += 1) {
    assert.ok(byAge.cases[i - 1].ageHours >= byAge.cases[i].ageHours, "xếp theo tuổi phải giảm dần");
  }

  // ───────── 4. Loại việc mới phải có đủ nhãn, hành động và mức cứu được ─────────
  for (const t of ["ORDER_CONFIRMATION_STALE", "RETURN_RECEIVED_PENDING_INSPECTION", "CUSTOMER_RECOVERY", "CANCELLED_BUT_SHIPPING", "STOCKOUT_RISK", "ADS_ANOMALY", "PROFITABILITY_ALERT"] as const) {
    assert.ok(CASE_TYPE_LABEL[t]?.length, `${t}: thiếu nhãn tiếng Việt`);
    assert.ok(RECOVERABILITY[t] > 0, `${t}: phải khai mức còn cứu được`);
  }
  assert.equal(caseTypeOf("ORDER_CONFIRMED_STALE"), "ORDER_CONFIRMATION_STALE");
  assert.equal(caseTypeOf("RETURN_PENDING_INSPECTION"), "RETURN_RECEIVED_PENDING_INSPECTION");
  // Hàng hoàn chưa tái nhập phải đứng trên đơn đang hoàn về: một bên còn lấy lại được nguyên lô
  // hàng vào tồn, một bên chỉ còn chờ hậu quả.
  assert.ok(RECOVERABILITY.RETURN_RECEIVED_PENDING_INSPECTION > RECOVERABILITY.RETURNING);
  // Mất khách QUEN phải gấp hơn một đơn hoàn thường: mất người đã tin shop một lần là mất cả chuỗi
  // mua về sau, không chỉ một đơn. Và cửa sổ gọi lại ngắn hơn hẳn.
  assert.ok(
    caseScore({ severity: "warning", ageHours: 12, amount: 500_000, type: "CUSTOMER_RECOVERY" }) >
      caseScore({ severity: "warning", ageHours: 12, amount: 500_000, type: "RETURNING" }),
    "mất khách quen phải xếp trên đơn đang hoàn thường",
  );
  assert.ok((CASE_SLA_HOURS.CUSTOMER_RECOVERY ?? 0) < (CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION ?? 0), "gọi lại khách gấp hơn kiểm đếm hàng hoàn");

  // ĐÃ HUỶ MÀ HÀNG VẪN ĐANG ĐI là việc gấp NHẤT trong các loại: kiện hàng đang chạy tính bằng GIỜ,
  // và chặn kịp thì cứu được cả hàng lẫn hai chiều cước. Để tới nơi là hết cứu.
  assert.equal(CASE_SLA_HOURS.CANCELLED_BUT_SHIPPING, 6, "hạn phải tính bằng giờ, không phải ngày");
  assert.ok((CASE_SLA_HOURS.CANCELLED_BUT_SHIPPING ?? 0) < (CASE_SLA_HOURS.DELIVERY_FAILED ?? 0), "chặn hàng đang chạy gấp hơn gọi lại đơn giao hụt");
  assert.equal(RECOVERABILITY.CANCELLED_BUT_SHIPPING, 1, "chặn kịp là cứu được toàn bộ");
  assert.equal(caseTypeOf("CANCELLED_BUT_SHIPPING"), "CANCELLED_BUT_SHIPPING");

  // ───────── MỖI VIỆC PHẢI THUỘC VỀ MỘT BỘ PHẬN ─────────
  //
  // Đo trên production 09/09/2026: 1.009 việc đang mở, KHÔNG việc nào có chủ. Một hàng đợi xếp
  // đúng thứ tự nhưng ai mở lên cũng thấy toàn việc của người khác thì không ai bắt đầu từ đâu.
  // "Chưa phân nhóm" không được phép tồn tại: nó biến thành nơi việc rơi vào rồi nằm im.
  for (const type of Object.keys(CASE_TYPE_LABEL) as CaseType[]) {
    assert.ok(TEAM_LABEL[teamOf(type)], `loại việc ${type} chưa gán bộ phận nào — sẽ không ai cầm`);
  }
  assert.equal(teamOf("RETURN_RECEIVED_PENDING_INSPECTION"), "WAREHOUSE", "đếm hàng hoàn là việc của kho");
  assert.equal(teamOf("CANCELLED_BUT_SHIPPING"), "LOGISTICS", "chặn kiện đang chạy là việc của giao vận");
  assert.equal(teamOf("COD_OVERDUE"), "FINANCE", "đòi tiền là việc của kế toán");
  assert.equal(teamOf("CUSTOMER_RECOVERY"), "CS", "gọi lại khách là việc của chăm sóc khách");

  // Tổng theo bộ phận phải BẰNG số việc đang mở — nếu lệch thì có việc rơi ra ngoài mọi nhóm và
  // không bao giờ hiện lên màn hình của ai.
  const dangMo = queue.cases.filter((c) => c.status !== "IGNORED" && c.status !== "RESOLVED").length;
  const tongNhom = queue.byTeam.reduce((t, x) => t + x.count, 0);
  assert.equal(tongNhom, dangMo, "cộng các bộ phận phải bằng tổng việc đang mở, không việc nào lọt ra ngoài");
  assert.ok(
    queue.byTeam.every((t) => t.unassigned <= t.count && t.breached <= t.count && t.urgent <= t.count),
    "số phụ của mỗi nhóm không được vượt tổng của chính nhóm đó",
  );

  // ───────── "ĐÃ ĐÓNG" KHÔNG PHẢI LÀ "ĐÃ LÀM" ─────────
  //
  // Ba đường dẫn tới cùng cột `resolved_at` nhưng nói ba chuyện khác hẳn nhau. Trước đây cả ba ghi
  // giống hệt nhau, nên 3.896 việc đã đóng trên production không trả lời được câu "đội xử lý được
  // bao nhiêu". Lấy con số đó đo năng suất là đo nhầm.
  assert.equal(caseStatusOf({ resolvedAt: new Date(), resolution: "MANUAL" }), "RESOLVED", "người bấm đóng là công của đội");
  assert.equal(caseStatusOf({ resolvedAt: new Date(), resolution: "AUTO" }), "AUTO_RESOLVED", "điều kiện tự hết KHÔNG phải công của ai");
  assert.equal(caseStatusOf({ resolvedAt: new Date(), resolution: "STALE" }), "CLOSED_STALE", "tắt cảnh báo là thôi theo dõi, không phải đã xử lý");
  assert.equal(caseStatusOf({ resolvedAt: new Date(), resolution: "UNKNOWN" }), "AUTO_RESOLVED", "dòng lịch sử không được tính là công của người");
  assert.equal(caseStatusOf({ resolvedAt: new Date() }), "AUTO_RESOLVED", "thiếu nguồn gốc thì KHÔNG được mặc định là người làm");
  // Mốc bỏ qua vẫn thắng khi chưa đóng, và thứ tự ưu tiên không đổi.
  assert.equal(caseStatusOf({ ignoredAt: new Date() }), "IGNORED");
  assert.equal(caseStatusOf({ startedAt: new Date() }), "IN_PROGRESS");
  assert.equal(caseStatusOf({}), "OPEN");

  // Nhãn phải nói đúng bản chất — người đọc bảng không được hiểu "tự đóng" thành "đã xử lý".
  assert.notEqual(CASE_STATUS_LABEL.AUTO_RESOLVED, CASE_STATUS_LABEL.RESOLVED, "hai trạng thái khác nhau phải có hai nhãn khác nhau");
  assert.ok(!CASE_STATUS_LABEL.AUTO_RESOLVED.includes("xong"), "nhãn 'tự đóng' không được gợi ý là ai đó làm xong");

  // Thông lượng: phần trăm do người làm chỉ tính trên phần ĐÃ BIẾT nguồn gốc.
  const tp = await queueThroughput(null, null);
  assert.ok(tp.byPeople >= 0 && tp.automatic >= 0 && tp.stale >= 0 && tp.unknown >= 0);
  if (tp.byPeople + tp.automatic + tp.stale === 0) {
    assert.equal(tp.peopleShare, null, "chưa biết gì thì tỷ lệ phải là CHƯA BIẾT, không phải 0%");
  }

  // ───────── TỔNG PHẢI LÀ TỔNG THẬT, KHÔNG PHẢI TỔNG CỦA PHẦN VỪA NẠP ─────────
  //
  // Lỗi thật trên production: trang nạp 300 việc rồi lấy chính số đó làm tổng, trong khi có 966 việc
  // đang mở. Chủ shop nhìn thấy hàng đợi nhỏ hơn thực tế ba lần — và quyết định "có cần thêm người
  // không" dựa trên con số đó.
  //
  // Dựng lại ĐÚNG kịch bản production: 966 việc, trang 300.
  const DAN_SO = 966;
  const moc = Date.now();
  await db
    .insert(schema.notifications)
    .values(
      Array.from({ length: DAN_SO }, (_, i) => ({
        kind: "COD_OVERDUE",
        severity: "warning",
        title: `Việc phân trang ${i}`,
        body: "dựng lại kịch bản 966 việc đang mở",
        href: "/cod",
        entityType: "SHIPMENT",
        entityId: `paging-${i}`,
        dedupeKey: `paging-test:${i}`,
        occurredAt: new Date(moc - i * 60_000),
        readBy: [] as string[],
      })),
    )
    .onConflictDoNothing();

  const trang1 = await getActionQueue({ limit: 300, page: 1 });
  assert.equal(trang1.loaded, 300, "một trang phải nạp đúng 300 việc");
  assert.ok(trang1.total >= DAN_SO, `tổng phải là dân số đầy đủ (≥${DAN_SO}), đang là ${trang1.total}`);
  assert.ok(trang1.total > trang1.loaded, "tổng phải LỚN HƠN số nạp — đây chính là chỗ từng sai");
  assert.equal(trang1.page, 1);
  assert.equal(trang1.pageSize, 300);
  assert.ok(trang1.hasMore, "còn việc ở trang sau thì phải nói có");
  assert.ok(trang1.exactTotal, "không lọc bằng tiêu chí tính sau thì tổng phải là con số chính xác");

  // Trang sau phải là việc KHÁC, không lặp lại trang đầu.
  const trang2 = await getActionQueue({ limit: 300, page: 2 });
  assert.equal(trang2.total, trang1.total, "tổng không đổi theo trang đang xem");
  const trung = trang2.cases.filter((c) => trang1.cases.some((x) => x.id === c.id));
  assert.equal(trung.length, 0, "trang 2 không được lặp lại việc của trang 1");

  // Trang cuối: không còn gì phía sau.
  const cuoi = await getActionQueue({ limit: 300, page: Math.ceil(trang1.total / 300) });
  assert.ok(!cuoi.hasMore, "trang cuối phải báo hết");

  // Lọc bằng tiêu chí chỉ tính được sau khi chấm điểm ⇒ phải TỰ KHAI rằng tổng là ước lượng trên.
  const locUuTien = await getActionQueue({ limit: 300, page: 1, filter: { priority: "URGENT" } });
  assert.equal(locUuTien.exactTotal, false, "lọc theo mức ưu tiên thì tổng ở CSDL không biết tới nó — phải khai ra");

  // Dọn để không ảnh hưởng các phép đếm khác trong bộ kiểm thử.
  await db.delete(schema.notifications).where(sql`${schema.notifications.dedupeKey} like 'paging-test:%'`);

  console.log(
    `✓ Hàng đợi việc: ${queue.cases.length} việc · ${queue.totals.URGENT} gấp · ${queue.unassigned} chưa ai nhận · ${queue.byTeam.length} bộ phận (${queue.byTeam.map((t) => `${TEAM_LABEL[t.team]} ${t.count}`).join(" · ")}) · ưu tiên theo quy tắc giải thích được`,
  );
}
