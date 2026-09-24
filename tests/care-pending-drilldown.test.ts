import assert from "node:assert/strict";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { diagnosePending, PENDING_DIAGNOSIS_IS_DEFECT, type PendingCaseFacts } from "@/lib/care/pending-diagnosis";
import { CARE_CASE_BUCKETS, getCarePerformanceByPic, listCareCases, type CareCaseBucket } from "@/lib/queries/care-performance";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ BẤM VÀO "ĐANG TREO" PHẢI RA ĐÚNG NHỮNG CA ĐÃ SINH RA CON SỐ ═══════════
 *
 * Chủ shop hỏi 23/09/2026: 46 ca đang treo của một người là những ca nào, và vì sao con số không
 * bằng số "Cần care". Hàm danh sách có sẵn (`listCareCases`) lọc theo `owner_at_resolution` — cột
 * mà ca treo LUÔN để trống — nên bấm vào "46" sẽ ra danh sách RỖNG, còn "Chưa nối được người" ra
 * mọi ca treo của cả đội. Bài này khoá bất biến duy nhất quan trọng: SỐ DÒNG = CON SỐ TRÊN Ô, cho
 * MỌI người × MỌI ô, trên toàn bộ dữ liệu mẫu (kể cả của các bài kiểm khác).
 */

const P = "cpd-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);
// Kỳ dựng từ đồng hồ thật cùng nhịp với dữ liệu gieo (luật 50): phủ từ 30 ngày trước tới 1 giờ sau.
const ky = (): Period => ({ key: "custom", from: gio(24 * 30), to: new Date(Date.now() + 3600_000), label: "kiểm thử", fromKey: null, toKey: null });

const coBan: PendingCaseFacts = {
  episodeNo: 1,
  latestEpisodeNo: 1,
  stage: "DELIVERY_FAILED",
  vtpStatus: 506,
  vtpStatusName: "Tồn - khách nghỉ",
  hasReplacement: false,
  queueView: "care",
};

function testDiagnosePure() {
  assert.equal(diagnosePending(coBan), "QUEUE_CARE");
  assert.equal(diagnosePending({ ...coBan, queueView: "waiting" }), "QUEUE_WAITING", "ca đang chờ KHÔNG ở tab Cần care — lý do lệch số phải nói ra");
  assert.equal(diagnosePending({ ...coBan, queueView: "escalated" }), "QUEUE_ESCALATED");
  assert.equal(diagnosePending({ ...coBan, queueView: "done" }), "QUEUE_DONE");
  assert.equal(diagnosePending({ ...coBan, queueView: null }), "OUT_OF_QUEUE");
  assert.equal(diagnosePending({ ...coBan, latestEpisodeNo: 2 }), "SUPERSEDED", "đợt cũ trên kiện CHƯA kết thúc ⇒ chờ chốt cùng kiện");
  assert.equal(PENDING_DIAGNOSIS_IS_DEFECT.SUPERSEDED, false, "đợt cũ chờ kiện kết thúc không phải lỗi — không được tô đỏ");
  assert.equal(diagnosePending({ ...coBan, stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công" }), "CARRIER_FINISHED", "ĐVVC đã giao mà đợt chưa chốt");
  assert.equal(diagnosePending({ ...coBan, stage: "RETURNING", vtpStatus: 515, vtpStatusName: "Bưu cục phát duyệt hoàn" }), "CARRIER_FINISHED", "đã DUYỆT hoàn là hết cửa — lẽ ra đã chốt");
  /*
    CHIỀU HOÀN CHƯA DUYỆT KHÔNG PHẢI "KIỆN ĐANG ĐI TIẾP". Đo production 23/09/2026: 31 ca đang mở
    trên kiện "Chờ xử lý" (không mã) chiều hoàn. Bản nháp dùng điều kiện MỞ ca và gọi chúng là
    "không còn việc cho người" trong khi chúng nằm ngay trong hàng đợi. Tab lấy từ hàng đợi thắng.
  */
  assert.equal(diagnosePending({ ...coBan, stage: "RETURNING", vtpStatus: null, vtpStatusName: "Chờ xử lý", queueView: "care" }), "QUEUE_CARE");
  assert.equal(diagnosePending({ ...coBan, stage: "RETURNING", vtpStatus: 505, vtpStatusName: "Yêu cầu chuyển hoàn", queueView: "waiting" }), "QUEUE_WAITING", "505 mới là ĐỀ NGHỊ hoàn — chưa phải kết cục");
  assert.equal(diagnosePending({ ...coBan, stage: "RETURNED", vtpStatus: 504, vtpStatusName: "Hoàn thành công", hasReplacement: true }), "AWAITING_EXCHANGE", "kiện gốc hoàn mà có đơn đổi ⇒ vòng đời cố ý chờ");
  assert.equal(diagnosePending({ ...coBan, stage: "DELIVERED", vtpStatus: 501, hasReplacement: true }), "CARRIER_FINISHED", "kiện gốc ĐÃ GIAO thì đơn đổi không phải lý do để chờ");
  // Thứ tự: kiện ĐÃ kết thúc mà đợt còn treo là lỗi, dù đó là đợt cũ hay đợt mới nhất.
  assert.equal(diagnosePending({ ...coBan, latestEpisodeNo: 3, stage: "DELIVERED", vtpStatus: 501 }), "CARRIER_FINISHED");
  assert.equal(PENDING_DIAGNOSIS_IS_DEFECT.QUEUE_WAITING, false, "chờ kết quả không phải lỗi — không được tô đỏ");
  assert.equal(PENDING_DIAGNOSIS_IS_DEFECT.OUT_OF_QUEUE, false);
}

async function gieo(db: Db, id: string, ship: Partial<typeof schema.shipments.$inferInsert>, cares: Partial<typeof schema.shipmentCare.$inferInsert>[]) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(72) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), stage: "DELIVERY_FAILED", codAmount: 250_000, pickedUpAt: gio(60), ...ship })
    .onConflictDoNothing();
  let n = 0;
  for (const c of cares) {
    n += 1;
    await db.insert(schema.shipmentCare).values({ shipmentId: `${P}${id}`, orderId: `${P}o-${id}`, episodeNo: n, active: false, careStatus: "RESOLVED", sourceTrigger: "CARRIER_EVENT", openedAt: gio(48 - n), careOutcome: "PENDING", updatedBy: "SYSTEM", ...c });
  }
}

export async function testCarePendingDrilldown(db: Db) {
  testDiagnosePure();

  const A = `${P}ua`;
  await db.insert(schema.users).values({ id: A, email: "cpd-a@shop.vn", name: "Người A", passwordHash: "x", role: "CS" }).onConflictDoNothing();

  // 1 · đang trong hàng đợi, A cầm
  await gieo(db, "q", { vtpStatus: 506, vtpStatusName: "Tồn - khách nghỉ" }, [{ active: true, careStatus: "IN_PROGRESS", ownerId: A }]);
  // 2 · A đã đóng, ĐVVC đã giao nhưng đợt chưa chốt (lỗi CARRIER_FINISHED)
  await gieo(db, "f", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công" }, [{ ownerId: A, doneAt: gio(30) }]);
  // 3 · kiện có hai đợt, CHƯA kết thúc: đợt 1 (A) chờ chốt cùng kiện, đợt 2 đang mở chưa ai nhận
  // Đợt 2 mở SAU lúc đợt 1 đóng — một lần mở lại THẬT. Mở trước lúc đóng mà không có sự kiện ĐVVC
  // xen giữa là bản sao do lỗi cũ (luật 62) và bị loại khỏi mọi con số — không phải thứ bài này đo.
  await gieo(db, "s", { vtpStatus: 506, vtpStatusName: "Tồn - khách nghỉ" }, [{ ownerId: A, doneAt: gio(40) }, { active: true, careStatus: "NEW", openedAt: gio(30) }]);
  // 4 · đã chốt, A cầm lúc chốt
  await gieo(db, "d", { stage: "DELIVERED", vtpStatus: 501 }, [{ careOutcome: "RESCUED_DIRECT", ownerId: A, ownerAtResolution: A, outcomeAt: gio(5) }]);
  // 5 · ca lịch sử chưa kết luận, A cầm — trước đây biến mất khỏi bảng
  await gieo(db, "u", { stage: "IN_TRANSIT", vtpStatus: 200 }, [{ careOutcome: null, ownerId: A }]);

  clearMemo();
  const bang = await getCarePerformanceByPic(ky());
  const giaTri = (r: (typeof bang)[number], b: CareCaseBucket) =>
    b === "FINISHED" ? r.finished : b === "RESCUED_DIRECT" ? r.direct : b === "RESCUED_EXCHANGE" ? r.exchange : b === "RESCUE_FAILED" ? r.failed : b === "PENDING" ? r.pending : r.unattributed;

  /* ═══ BẤT BIẾN: số dòng danh sách = con số trên ô, mọi người × mọi ô ═══ */
  for (const r of bang) {
    for (const b of CARE_CASE_BUCKETS) {
      const { total } = await listCareCases(ky(), { ownerId: r.userId, bucket: b });
      assert.equal(total, giaTri(r, b), `danh sách ${r.name} × ${b} phải có đúng ${giaTri(r, b)} dòng, được ${total}`);
    }
  }

  const a = bang.find((r) => r.userId === A);
  assert.ok(a, "người A phải có dòng");
  assert.equal(a.pending, 3, "A đang giữ 3 đợt chưa chốt: trong hàng đợi · đã đóng mà ĐVVC đã giao · đợt cũ của kiện hai đợt");
  assert.equal(a.unattributed, 1, "ca lịch sử của A phải được đếm, không biến mất");

  const treo = await listCareCases(ky(), { ownerId: A, bucket: "PENDING" });
  const lyDo = Object.fromEntries(treo.rows.map((r) => [r.shipmentId.slice(P.length), r.diagnosis]));
  assert.equal(lyDo.f, "CARRIER_FINISHED");
  assert.equal(lyDo.s, "SUPERSEDED");
  assert.ok(lyDo.q?.startsWith("QUEUE_") || lyDo.q === "OUT_OF_QUEUE", "mỗi ca treo nói đúng vì sao nó treo");
  assert.equal(treo.rows.find((r) => r.shipmentId === `${P}s`)?.latestEpisodeNo, 2, "dòng đợt cũ phải biết đợt mới nhất của kiện");

  // Đợt 2 chưa ai nhận thuộc "Chưa nối được người", KHÔNG thuộc A.
  const khong = await listCareCases(ky(), { ownerId: null, bucket: "PENDING" });
  assert.ok(khong.rows.some((r) => r.shipmentId === `${P}s` && r.episodeNo === 2), "ca chưa ai nhận nằm ở dòng Chưa nối được người");
  assert.ok(!khong.rows.some((r) => r.shipmentId === `${P}q`), "ca A đang cầm KHÔNG được lọt sang Chưa nối được người");

  const chot = await listCareCases(ky(), { ownerId: A, bucket: "FINISHED" });
  assert.ok(chot.rows.some((r) => r.shipmentId === `${P}d` && r.diagnosis === null), "ca đã chốt không mang chẩn đoán treo");

  console.log("✓ Bấm vào ô hiệu suất care: số dòng = con số, ca treo nói rõ vì sao");
}
