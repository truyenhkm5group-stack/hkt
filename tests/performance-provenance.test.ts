import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { METRIC_DEFINITION_VERSION, metricConfidence, periodKey, periodRange, rankable, SAMPLE_FLOOR } from "@/lib/constants/metric-provenance";
import { metricTrend } from "@/lib/queries/performance-history";
import { snapshotPerformance } from "@/lib/work/performance-snapshot";

/**
 * ═══════════════ MỘT CON SỐ HIỆU SUẤT PHẢI TỰ KHAI ĐƯỢC NÓ ĐỨNG TRÊN CÁI GÌ ═══════════════
 *
 * Bài này khoá ba thứ mà nếu mất đi thì thẻ điểm vẫn hiện số nhưng đã hết dùng được:
 *
 *  1. **Độ tin cậy là HÀM, không phải nhãn gõ tay.** Ai cũng gật gù với chữ "độ tin cậy" cho tới
 *     lúc phải điền nó; để người viết code tự chấm thì nó thành trang trí.
 *  2. **Mẫu bé không được xếp hạng.** 100% trên 2 quan sát và 100% trên 200 là hai chuyện khác nhau.
 *  3. **Lịch sử bất biến.** Chụp rồi thì chạy lại job không đổi được số — nếu đổi được thì cái gọi
 *     là "lịch sử" chỉ là ảnh chụp của lần chạy gần nhất.
 */

export function testMetricConfidenceIsAFunction() {
  const nen = { value: 90 as number | null, sample: 100, linkage: "USER_ID" as const, shared: false };

  assert.equal(metricConfidence(nen), "HIGH", "mẫu lớn, nối bằng khoá tài khoản, kết quả tự quyết ⇒ tin được");

  // CHƯA ĐO ĐƯỢC không bao giờ trượt thành "kém".
  assert.equal(metricConfidence({ ...nen, value: null }), "UNKNOWN", "không có giá trị ⇒ UNKNOWN");
  assert.equal(metricConfidence({ ...nen, sample: 0 }), "UNKNOWN", "mẫu số 0 ⇒ UNKNOWN, không phải 0%");

  // Cỡ mẫu.
  assert.equal(metricConfidence({ ...nen, sample: SAMPLE_FLOOR.low - 1 }), "LOW", `dưới ${SAMPLE_FLOOR.low} quan sát ⇒ yếu`);
  assert.equal(metricConfidence({ ...nen, sample: SAMPLE_FLOOR.medium - 1 }), "MEDIUM", `dưới ${SAMPLE_FLOOR.medium} quan sát ⇒ tạm tin`);

  // Nối bằng tên gõ tay thì mẫu lớn cũng không cứu được: sai người thì số đúng vẫn vô nghĩa.
  assert.equal(metricConfidence({ ...nen, linkage: "FREE_TEXT", sample: 5000 }), "LOW", "nối bằng TÊN GÕ TAY ⇒ luôn yếu, bất kể mẫu lớn tới đâu");

  // Kết quả bên ngoài đồng quyết định ⇒ trần là "tạm tin", đọc làm bối cảnh.
  assert.equal(metricConfidence({ ...nen, shared: true }), "MEDIUM", "kết quả chung ⇒ không bao giờ lên mức tin được");
  assert.equal(metricConfidence({ ...nen, linkage: "EMAIL" }), "MEDIUM", "nối bằng email ⇒ trần là tạm tin (đổi email là mất dấu)");

  // Xếp hạng là câu hỏi KHÁC với độ tin cậy.
  assert.equal(rankable(SAMPLE_FLOOR.medium - 1), false, "mẫu bé thì không xếp hạng người với người");
  assert.equal(rankable(SAMPLE_FLOOR.medium), true);

  console.log(`✓ Độ tin cậy là hàm: cỡ mẫu (${SAMPLE_FLOOR.low}/${SAMPLE_FLOOR.medium}) · cách nối người · kết quả chung — tên gõ tay luôn YẾU, kết quả chung trần là TẠM TIN`);
}

export function testPeriodKeys() {
  // Tuần ISO: thứ Năm quyết định năm, nên ngày cuối năm không rơi nhầm kỳ.
  assert.equal(periodKey("WEEKLY", new Date("2026-09-13T00:00:00Z")), "2026-W37");
  assert.equal(periodKey("MONTHLY", new Date("2026-09-13T00:00:00Z")), "2026-09");

  const tuan = periodRange("WEEKLY", new Date("2026-09-13T12:00:00Z"));
  assert.equal(tuan.from.toISOString().slice(0, 10), "2026-09-07", "tuần bắt đầu thứ Hai");
  assert.equal(tuan.to.toISOString().slice(0, 10), "2026-09-13", "và kết thúc Chủ nhật");

  const thang = periodRange("MONTHLY", new Date("2026-09-13T12:00:00Z"));
  assert.equal(thang.from.toISOString().slice(0, 10), "2026-09-01");
  assert.equal(thang.to.toISOString().slice(0, 10), "2026-09-30");

  console.log("✓ Khoá kỳ: tuần ISO bắt đầu thứ Hai, tháng trọn vẹn — đọc được bằng mắt (2026-W37 · 2026-09)");
}

export async function testSnapshotImmutability(db: Db) {
  const P = "psn-";
  const phong = await db.query.departments.findMany({ columns: { id: true, code: true } });
  const logistics = phong.find((d) => d.code === "LOGISTICS")!;
  await db.insert(schema.users).values({ id: `${P}u1`, email: `${P}a@t.local`, name: "Chụp A", role: "CS", passwordHash: "x", active: true });
  await db.insert(schema.departmentMembers).values({ departmentId: logistics.id, userId: `${P}u1`, roleInDept: "MEMBER", active: true });

  const at = new Date("2026-09-07T12:00:00Z");
  const now = new Date("2026-09-28T00:00:00Z");

  /* ═══ 1 · KHÔNG CHỤP KỲ CHƯA ĐÓNG ═══ */
  const dangChay = await snapshotPerformance({ kind: "WEEKLY", at: now, now });
  assert.ok(dangChay.skippedReason, "kỳ chưa đóng phải bị từ chối kèm lý do, không âm thầm chụp số nửa vời");
  assert.equal(dangChay.written, 0);

  /* ═══ 2 · CHỤP KỲ ĐÃ ĐÓNG ═══ */
  const lan1 = await snapshotPerformance({ kind: "WEEKLY", at, now });
  assert.equal(lan1.period, "2026-W37");
  assert.ok(lan1.written > 0, "phải chụp được ít nhất một chỉ số cho người trong phòng Giao vận");

  /* ═══ 3 · BẤT BIẾN: chạy lại KHÔNG ghi thêm và KHÔNG đổi số đã có ═══ */
  const truoc = await db.execute(sql`select metric_key, value, sample from performance_snapshots where period = '2026-W37' order by metric_key`);
  const lan2 = await snapshotPerformance({ kind: "WEEKLY", at, now });
  assert.equal(lan2.written, 0, "chạy lại job KHÔNG được ghi thêm dòng nào");
  assert.ok(lan2.skipped > 0, "và phải nói rõ đã bỏ qua bao nhiêu dòng — đó là bằng chứng bất biến, không phải lỗi");
  const sau = await db.execute(sql`select metric_key, value, sample from performance_snapshots where period = '2026-W37' order by metric_key`);
  assert.deepEqual(
    (sau as unknown as { rows: unknown[] }).rows,
    (truoc as unknown as { rows: unknown[] }).rows,
    "số đã chụp không được đổi dù chỉ một chữ số — nếu đổi được thì 'lịch sử' chỉ là ảnh chụp của lần chạy gần nhất",
  );

  /* ═══ 4 · XUẤT XỨ ĐI CÙNG TỪNG DÒNG ═══ */
  const mot = await db.query.performanceSnapshots.findFirst({ where: sql`period = '2026-W37' and subject_type = 'PERSON'` });
  assert.ok(mot, "phải có ít nhất một dòng mức NGƯỜI");
  assert.equal(mot!.definitionVersion, METRIC_DEFINITION_VERSION, "phiên bản công thức phải được ghi kèm — không có nó thì xu hướng gãy khúc đọc là gì cũng được");
  assert.ok(mot!.attribution.length > 20, "luật quy kết phải đi theo con số, không nằm yên trong tài liệu");
  assert.ok(mot!.basis.length > 10, "nguồn số liệu phải ghi kèm để người đọc kiểm chứng được");
  assert.ok(["USER_ID", "EMAIL", "FREE_TEXT"].includes(mot!.linkage), "cách nối người phải được ghi lại");
  assert.ok(mot!.value === null || mot!.sample > 0, "có giá trị thì phải có mẫu số");

  /* ═══ 5 · XU HƯỚNG ĐỌC TỪ ẢNH CHỤP, VÀ NÓI RA KHI CÔNG THỨC ĐỔI ═══ */
  await snapshotPerformance({ kind: "WEEKLY", at: new Date("2026-09-14T12:00:00Z"), now });

  /*
    Người này không có hoạt động thật trong hai tuần đó, nên mọi dòng đều `null` — và đó CHÍNH LÀ
    hành vi đúng vừa kiểm ở trên. Để kiểm phần XU HƯỚNG thì cần hai kỳ CÓ SỐ, nên gán thẳng bằng
    SQL ở đây. Việc đó không phá tính bất biến: bất biến là luật áp lên JOB (`onConflictDoNothing`),
    không phải lên bàn tay người viết kiểm thử.
  */
  await db.execute(sql`update performance_snapshots set value = 80, sample = 40, confidence = 'HIGH' where period = '2026-W37' and metric_key = 'care_sla' and subject_id = ${P + "u1"}`);
  await db.execute(sql`update performance_snapshots set value = 92, sample = 50, confidence = 'HIGH' where period = '2026-W38' and metric_key = 'care_sla' and subject_id = ${P + "u1"}`);

  const xu = await metricTrend({ subjectType: "PERSON", subjectId: `${P}u1`, kind: "WEEKLY" });
  const careSla = xu.find((t) => t.metricKey === "care_sla");
  assert.ok(careSla, "phải dựng được xu hướng cho chỉ số đã có hai kỳ");
  assert.equal(careSla!.latest?.period, "2026-W38", "kỳ gần nhất phải là kỳ mới hơn");
  assert.equal(careSla!.previous?.period, "2026-W37");
  assert.equal(careSla!.delta, 12, "chênh lệch tính theo ĐƠN VỊ của chính chỉ số (92 − 80), không phải phần trăm của phần trăm");
  assert.equal(careSla!.definitionChanged, false, "cùng phiên bản công thức thì chênh lệch đọc được là tốt lên");

  // Kỳ CHƯA ĐO ĐƯỢC không được coi là một điểm rơi về 0.
  const khacNull = xu.find((t) => t.metricKey === "care_recovered");
  assert.ok(khacNull, "chỉ số chưa đo được vẫn phải có mặt trong lịch sử");
  assert.equal(khacNull!.latest, null, "toàn kỳ null ⇒ không có 'kỳ gần nhất đo được', và KHÔNG được quy về 0");
  assert.equal(khacNull!.delta, null, "thiếu một đầu thì chênh lệch là CHƯA BIẾT, không phải 0");

  // Giả lập một kỳ tính bằng công thức đời khác ⇒ phải bật cờ, không vẽ mũi tên như thật.
  await db.execute(sql`update performance_snapshots set definition_version = 2 where period = '2026-W38'`);
  const xu2 = await metricTrend({ subjectType: "PERSON", subjectId: `${P}u1`, kind: "WEEKLY" });
  assert.equal(xu2.find((t) => t.metricKey === "care_sla")?.definitionChanged, true, "hai kỳ tính bằng hai phiên bản công thức ⇒ phải báo rõ, vì lúc đó chênh lệch không đọc là tốt/xấu được");

  // Dọn: kho kiểm thử dùng chung một CSDL.
  await db.execute(sql`delete from performance_snapshots where subject_id like ${P + "%"} or subject_type = 'DEPARTMENT'`);
  await db.execute(sql`delete from department_members where user_id like ${P + "%"}`);
  await db.execute(sql`delete from users where id like ${P + "%"}`);

  console.log(
    `✓ Ảnh chụp hiệu suất: kỳ chưa đóng bị từ chối · chụp ${lan1.written} dòng · chạy lại ghi 0 và số cũ nguyên vẹn · mỗi dòng mang nguồn/quy kết/cách nối người/phiên bản · xu hướng đọc từ ảnh chụp và báo khi công thức đổi đời`,
  );
}
