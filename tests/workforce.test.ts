import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { MONEY_UNKNOWN, type WorkItem, type WorkPriority } from "@/lib/constants/work";
import {
  DEFAULT_WIP_LIMIT,
  ESCALATION_LEAD_HOURS,
  ESCALATION_WARN_HOURS,
  autoAssignOn,
  escalationOn,
  handlesSource,
  isAway,
  wipLimitOf,
  type StaffingConfig,
} from "@/lib/constants/workforce";
import { buildCapacity, holderKeyOf, sanitizeStaffing } from "@/lib/queries/workforce";
import { planDistribution, pickAssignee, rankItem, summarizeUnplaced } from "@/lib/work/distribution";
import { countEscalations, effectivePriority, escalationDigest, escalationOf, sortByEscalation } from "@/lib/work/escalation";
import { vnDay } from "@/lib/work/escalation-run";
import { buildInterventions } from "@/lib/queries/manager-day";
import { sanitizeWeights } from "@/lib/queries/work-config";
import { staffingSchema } from "@/lib/validation/workforce";
import { scoreboardOf, suggestActions } from "@/lib/queries/reviews";
import type { OrgPerson } from "@/lib/queries/work";

/**
 * ═══════════════ QUẢN TRỊ NHÂN LỰC THÔNG MINH ═══════════════
 *
 * Đặc tả: `docs/release-2026-09-12-workforce-v2.md`.
 *
 * Bài kiểm này khoá đúng những chỗ một máy phân việc tự động sẽ hỏng, và hỏng theo cách đắt nhất:
 *
 *  1. **Không bao giờ nhồi quá trần** — việc thừa phải NẰM LẠI kèm lý do, không bị nhét cho ai đó.
 *  2. **Kế hoạch phải ỔN ĐỊNH** — chạy hai lần ra cùng kết quả, nếu không thì không ai dám bấm.
 *  3. **Không dồn hết cho một người** — mỗi lần giao phải chiếm chỗ ngay trong bản nháp.
 *  4. **Leo thang CHỈ NÂNG, không bao giờ hạ** — và không ghi gì vào CSDL.
 *  5. **Người đang nghỉ không nhận việc.**
 *  6. **Không có điểm tổng khi chưa khai trọng số.**
 */

const H = 3_600_000;

function nguoi(id: string, name: string, ...depts: DepartmentCode[]): OrgPerson {
  return { id, name, email: `${id}@t.local`, role: "CS", positionId: null, departments: depts.map((code) => ({ id: `d-${code}`, code, name: code, roleInDept: "MEMBER" as const })) };
}

export async function testWorkforce(db: Db) {
  clearMemo();
  const NOW = new Date("2026-09-12T10:00:00.000Z");
  /** `h` giờ TRƯỚC `NOW` khi dương, SAU khi âm — cùng quy ước với `tests/work-os.test.ts`. */
  const T = (h: number) => new Date(NOW.getTime() - h * H);

  const mau = (over: Partial<WorkItem>): WorkItem => ({
    key: "k", sourceType: "CS_CASE", sourceKey: "k", kind: null, title: "t", summary: "", department: "SALES", assignee: null,
    status: "NEW", statusAuthority: "SOURCE", priority: "NORMAL", score: 10, createdAt: T(5), startedAt: null, dueAt: null,
    slaAt: null, completedAt: null, snoozedUntil: null, businessEntity: "NONE", businessEntityId: "", sourceUrl: "",
    money: MONEY_UNKNOWN, tags: [], evidence: { source: "", detail: "" }, blockedReason: "", creationSource: "AUTO",
    actions: [], recommendedAction: "", ...over,
  });

  const CFG: StaffingConfig = { departmentWip: {}, userWip: {}, skills: {}, away: {}, autoAssign: {}, escalationOff: {} };

  /* ═══════════ 1 · SỔ NHÂN LỰC ═══════════ */
  assert.equal(wipLimitOf("u1", ["SALES"], CFG), DEFAULT_WIP_LIMIT, "chưa khai gì thì dùng trần mặc định");
  assert.equal(wipLimitOf("u1", ["SALES"], { ...CFG, departmentWip: { SALES: 5 } }), 5, "trần phòng thắng mặc định");
  assert.equal(wipLimitOf("u1", ["SALES"], { ...CFG, departmentWip: { SALES: 5 }, userWip: { u1: 9 } }), 9, "trần riêng thắng trần phòng");
  /*
    Người kiêm nhiều phòng lấy trần CAO NHẤT, KHÔNG cộng dồn: cộng dồn thì người kiêm ba phòng
    bỗng gánh được gấp ba, mà họ vẫn chỉ có một ngày làm việc.
  */
  assert.equal(wipLimitOf("u1", ["SALES", "FINANCE"], { ...CFG, departmentWip: { SALES: 5, FINANCE: 8 } }), 8, "nhiều phòng lấy trần cao nhất, không cộng");

  assert.equal(handlesSource("u1", "CS_CASE", CFG), true, "chưa khai kỹ năng = nhận MỌI loại việc của phòng");
  assert.equal(handlesSource("u1", "CS_CASE", { ...CFG, skills: { u1: ["BANK_EXCEPTION"] } }), false, "khai kỹ năng hẹp thì chỉ nhận loại đã khai");
  assert.equal(handlesSource("u1", "BANK_EXCEPTION", { ...CFG, skills: { u1: ["BANK_EXCEPTION"] } }), true);

  assert.equal(isAway("u1", CFG, NOW), false);
  assert.equal(isAway("u1", { ...CFG, away: { u1: { until: T(-48).toISOString(), reason: "phép" } } }, NOW), true, "đang trong kỳ nghỉ");
  assert.equal(isAway("u1", { ...CFG, away: { u1: { until: T(48).toISOString(), reason: "phép" } } }, NOW), false, "kỳ nghỉ đã hết");

  // Phân việc tự động MẶC ĐỊNH TẮT; leo thang MẶC ĐỊNH BẬT. Hai mặc định ngược nhau và cố ý.
  for (const d of DEPARTMENT_CODES) {
    assert.equal(autoAssignOn(d, CFG), false, `phân việc tự động của ${d} phải mặc định TẮT`);
    assert.equal(escalationOn(d, CFG), true, `leo thang của ${d} phải mặc định BẬT`);
  }

  assert.deepEqual(sanitizeStaffing({ departmentWip: { SALES: 5, KHONG_CO: 3 }, userWip: { u1: 9999 }, skills: { u1: ["CS_CASE", "SAI"] } }).departmentWip, { SALES: 5 }, "mã phòng lạ bị bỏ");
  assert.deepEqual(sanitizeStaffing({ userWip: { u1: 9999 } }).userWip, {}, "trần ngoài dải bị bỏ");
  assert.deepEqual(sanitizeStaffing({ skills: { u1: ["CS_CASE", "SAI"] } }).skills, { u1: ["CS_CASE"] }, "loại việc lạ bị bỏ, phần còn lại giữ");
  assert.deepEqual(sanitizeStaffing("rác").departmentWip, {}, "giá trị sai kiểu trả bảng rỗng chứ không ném lỗi");

  /* ═══════════ 2 · SỨC CHỨA ═══════════ */
  const ds = [nguoi("u1", "An", "SALES"), nguoi("u2", "Bình", "SALES"), nguoi("u3", "Cường", "FINANCE")];
  const dangCam: WorkItem[] = [
    mau({ key: "a1", assignee: { id: "u1", email: "", name: "An" } }),
    mau({ key: "a2", assignee: { id: "u1", email: "", name: "An" }, slaAt: T(2) }),
    // Ô CHỮ: case CSKH ghi TÊN chứ không ghi khoá người dùng — phải ghép được, nếu không bảng sức
    // chứa báo người đó đang rảnh trong khi họ đang ôm mấy chục case.
    mau({ key: "a3", assignee: { id: null, email: "", name: "  BÌNH  " } }),
  ];
  const cap = buildCapacity(ds, dangCam, { ...CFG, departmentWip: { SALES: 3 } }, NOW, "SALES");
  assert.equal(cap.length, 2, "chỉ người TRONG phòng mới vào bảng sức chứa của phòng đó");
  const an = cap.find((c) => c.userId === "u1")!;
  const binh = cap.find((c) => c.userId === "u2")!;
  assert.equal(an.load, 2);
  assert.equal(an.free, 1);
  assert.equal(an.overdue, 1);
  assert.equal(binh.load, 1, "ghép được người qua Ô CHỮ tên, không phân biệt hoa thường và khoảng trắng");
  assert.equal(holderKeyOf(mau({ assignee: null })), null, "việc chưa ai nhận trả về null, không phải chuỗi rỗng");

  // QUÁ TẢI ≠ NHIỀU VIỆC: 6 việc mà 4 quá hạn là đang chìm, dù trần là 20.
  const chim = buildCapacity([nguoi("u9", "Dũng", "SALES")], Array.from({ length: 6 }, (_, i) => mau({ key: `x${i}`, assignee: { id: "u9", email: "", name: "Dũng" }, slaAt: i < 4 ? T(2) : null })), CFG, NOW, "SALES")[0];
  assert.equal(chim.load, 6);
  assert.ok(chim.load < chim.limit, "chưa vượt trần");
  assert.equal(chim.overloaded, true, "quá nửa việc đang cầm đã vỡ hạn ⇒ vẫn là quá tải");

  /* ═══════════ 3 · MÁY PHÂN VIỆC ═══════════ */
  // Xếp việc: quá hạn trước mọi thứ, rồi gấp, rồi sắp vỡ hạn, rồi tiền.
  const quaHan = mau({ key: "q", slaAt: T(2) });
  const gap = mau({ key: "g", priority: "URGENT" as WorkPriority });
  const sapVo = mau({ key: "s", slaAt: T(-1) });
  const thuong = mau({ key: "t" });
  const xep = [thuong, sapVo, gap, quaHan].sort((a, b) => rankItem(a, NOW) - rankItem(b, NOW)).map((i) => i.key);
  assert.deepEqual(xep, ["q", "g", "s", "t"], "việc quan trọng nhất được chọn người TRƯỚC, lúc mọi người còn chỗ");

  // Tiền CHƯA BIẾT không được coi là 0 — nó xếp sau tiền đã biết nhưng TRƯỚC tiền bằng 0 thật.
  const coTien = mau({ key: "m1", money: { atRisk: 5_000_000, recoverable: null, confidence: "MEASURED", basis: "t" } });
  const khongTien = mau({ key: "m0", money: { atRisk: 0, recoverable: null, confidence: "MEASURED", basis: "t" } });
  const chuaBiet = mau({ key: "mu" });
  const xepTien = [khongTien, chuaBiet, coTien].sort((a, b) => rankItem(a, NOW) - rankItem(b, NOW)).map((i) => i.key);
  assert.deepEqual(xepTien, ["m1", "mu", "m0"], "tiền nhiều trước; chưa biết xếp trước 0đ thật vì nó có thể là bất cứ số nào");

  const capA = buildCapacity([nguoi("p1", "An", "SALES"), nguoi("p2", "Bình", "SALES")], [], { ...CFG, departmentWip: { SALES: 2 } }, NOW, "SALES");
  const viec = Array.from({ length: 6 }, (_, i) => mau({ key: `w${i}`, slaAt: T(i + 1) }));
  const plan = planDistribution("SALES", viec, capA, { ...CFG, departmentWip: { SALES: 2 } }, NOW);

  assert.equal(plan.assignments.length, 4, "hai người × trần 2 = 4 việc, KHÔNG hơn");
  assert.equal(plan.unplaced.length, 2, "hai việc thừa phải NẰM LẠI, không bị nhồi cho ai");
  assert.equal(plan.considered, 6, "mọi việc đều được xét — giao được cộng nằm lại phải bằng tổng");
  assert.equal(plan.assignments.length + plan.unplaced.length, plan.considered);
  assert.deepEqual(summarizeUnplaced(plan.unplaced).map((u) => u.reason), ["NO_CAPACITY"], "lý do phải nêu đúng: hết chỗ, không phải hết việc");
  assert.ok(summarizeUnplaced(plan.unplaced)[0].fix.length > 20, "mỗi lý do phải kèm LỐI RA, không chỉ nêu vấn đề");

  // KHÔNG DỒN HẾT CHO MỘT NGƯỜI: mỗi lần giao phải chiếm chỗ ngay trong bản nháp.
  const soViecMoiNguoi = new Map<string, number>();
  for (const a of plan.assignments) soViecMoiNguoi.set(a.userId, (soViecMoiNguoi.get(a.userId) ?? 0) + 1);
  assert.deepEqual([...soViecMoiNguoi.values()].sort(), [2, 2], "bốn việc chia đều hai người, không dồn cả bốn cho người rảnh nhất lúc bắt đầu");

  // KẾ HOẠCH ỔN ĐỊNH: chạy hai lần ra y hệt. Một máy cho kết quả khác nhau mỗi lần bấm là máy không ai dám dùng.
  const lai = planDistribution("SALES", viec, capA, { ...CFG, departmentWip: { SALES: 2 } }, NOW);
  assert.deepEqual(lai.assignments.map((a) => `${a.key}→${a.userId}`), plan.assignments.map((a) => `${a.key}→${a.userId}`), "chạy lại phải ra cùng một kế hoạch");

  // HÀM THUẦN: không được sửa dữ liệu của người gọi.
  assert.equal(capA[0].free, 2, "planDistribution KHÔNG được sửa bảng sức chứa truyền vào");

  // Mỗi dòng phải nói VÌ SAO là người đó — màn hình xem trước in nguyên văn.
  for (const a of plan.assignments) assert.ok(a.why.includes("chỗ"), `dòng ${a.key} phải giải thích vì sao chọn người này`);

  // Ảnh chụp "sau khi áp" phải đúng, nếu không màn hình xem trước nói dối về hậu quả.
  for (const r of plan.after) assert.equal(r.after, r.before + r.added);

  /* ═══════════ 4 · AI KHÔNG ĐƯỢC NHẬN VIỆC ═══════════ */
  assert.deepEqual(pickAssignee(mau({}), [], CFG), { reason: "NO_CANDIDATE" }, "phòng chưa có ai");
  const nghi = buildCapacity([nguoi("z1", "Em", "SALES")], [], { ...CFG, away: { z1: { until: T(-48).toISOString(), reason: "phép" } } }, NOW, "SALES");
  assert.deepEqual(pickAssignee(mau({}), nghi, { ...CFG, away: { z1: { until: T(-48).toISOString(), reason: "phép" } } }), { reason: "ALL_AWAY" }, "người đang nghỉ KHÔNG nhận việc");
  const saiNghe = buildCapacity([nguoi("z2", "Phúc", "SALES")], [], CFG, NOW, "SALES");
  assert.deepEqual(pickAssignee(mau({ sourceType: "CS_CASE" }), saiNghe, { ...CFG, skills: { z2: ["BANK_EXCEPTION"] } }), { reason: "NO_SKILL" }, "không ai khai nhận loại việc này");

  /* ═══════════ 5 · LEO THANG ═══════════ */
  assert.equal(escalationOf(mau({ slaAt: null }), NOW), null, "loại việc cố ý không đặt hạn thì không bao giờ leo thang");
  assert.equal(escalationOf(mau({ slaAt: T(2), status: "DONE" }), NOW), null, "việc đã xong không leo thang");
  assert.equal(escalationOf(mau({ slaAt: T(-100) }), NOW), null, "hạn còn xa thì chưa leo thang");
  assert.equal(escalationOf(mau({ slaAt: T(-ESCALATION_WARN_HOURS + 1) }), NOW)?.level, "WARN", "còn dưới ngưỡng cảnh báo là WARN");
  assert.equal(escalationOf(mau({ slaAt: T(2) }), NOW)?.level, "BREACH", "vỡ hạn là BREACH");
  assert.equal(escalationOf(mau({ slaAt: T(ESCALATION_LEAD_HOURS + 1) }), NOW)?.level, "STALE", "vỡ hạn lâu mà chưa ai cầm là STALE");
  assert.equal(
    escalationOf(mau({ slaAt: T(ESCALATION_LEAD_HOURS + 1), assignee: { id: "u1", email: "", name: "An" } }), NOW)?.level,
    "BREACH",
    "vỡ hạn lâu nhưng ĐÃ CÓ NGƯỜI CẦM thì chỉ là BREACH — có người làm khác hẳn không ai làm",
  );
  // Cái hẹn hoãn che được "sắp tới hạn", nhưng KHÔNG che được hạn đã vỡ.
  assert.equal(escalationOf(mau({ slaAt: T(-1), snoozedUntil: T(-24) }), NOW), null, "đang hoãn thì không cảnh báo sắp vỡ hạn");
  assert.equal(escalationOf(mau({ slaAt: T(2), snoozedUntil: T(-24) }), NOW)?.level, "BREACH", "cái hẹn KHÔNG xoá được hạn đã vỡ");

  // CHỈ NÂNG, KHÔNG BAO GIỜ HẠ.
  assert.equal(effectivePriority(mau({ slaAt: T(2), priority: "LOW" }), NOW), "URGENT", "vỡ hạn thì nâng lên Gấp");
  assert.equal(effectivePriority(mau({ slaAt: T(-100), priority: "URGENT" }), NOW), "URGENT", "mức Gấp người đặt tay KHÔNG bị hạ dù hạn còn xa");
  assert.equal(effectivePriority(mau({ slaAt: T(-ESCALATION_WARN_HOURS + 1), priority: "URGENT" }), NOW), "URGENT", "leo thang HIGH không được hạ một việc đang Gấp");

  const dem = countEscalations([mau({ key: "e1", slaAt: T(2) }), mau({ key: "e2", slaAt: T(ESCALATION_LEAD_HOURS + 2) }), mau({ key: "e3", slaAt: T(-1) })], NOW, CFG);
  assert.equal(dem[0].department, "SALES");
  assert.equal(dem[0].stale, 1);
  assert.equal(dem[0].breach, 1);
  assert.equal(dem[0].warn, 1);
  assert.equal(countEscalations([mau({ slaAt: T(2) })], NOW, { ...CFG, escalationOff: { SALES: true } }).length, 0, "tắt leo thang cho một phòng thì phòng đó không đếm");

  // NGƯỠNG BÁO LÀ `STALE`: phòng nào cũng có việc vỡ hạn mỗi ngày, báo hết thì thành tiếng ồn.
  assert.equal(escalationDigest({ department: "SALES", label: "Kinh doanh", warn: 9, breach: 40, stale: 0, staleItems: [] }, "https://x"), null, "40 việc quá hạn nhưng không việc nào bị bỏ quên ⇒ KHÔNG gửi tin");
  const tin = escalationDigest({ department: "SALES", label: "Kinh doanh", warn: 1, breach: 2, stale: 3, staleItems: [mau({ title: "Gọi khách A" })] }, "https://x");
  assert.ok(tin && tin.title.includes("3 việc"), "tin nhắn phải nói rõ bao nhiêu việc bị bỏ quên");

  assert.equal(vnDay(new Date("2026-09-12T18:00:00.000Z")), "2026-09-13", "mốc chống gửi lại theo NGÀY GIỜ VIỆT NAM, không theo UTC");

  const xepLeo = sortByEscalation([mau({ key: "low", priority: "LOW" }), mau({ key: "vo", priority: "LOW", slaAt: T(2) })], NOW).map((i) => i.key);
  assert.deepEqual(xepLeo, ["vo", "low"], "việc vỡ hạn nổi lên trước dù mức ưu tiên đặt tay là Thấp");

  /* ═══════════ 6 · NĂM VIỆC CẦN CAN THIỆP ═══════════ */
  const capQuaTai = buildCapacity([nguoi("o1", "Quá Tải", "SALES")], Array.from({ length: 30 }, (_, i) => mau({ key: `o${i}`, assignee: { id: "o1", email: "", name: "Quá Tải" } })), CFG, NOW, "SALES");
  const canThiep = buildInterventions(
    [
      mau({ key: "b", status: "BLOCKED", blockedReason: "chờ kế toán duyệt" }),
      mau({ key: "s", slaAt: T(ESCALATION_LEAD_HOURS + 5) }),
      mau({ key: "q", assignee: { id: "o1", email: "", name: "Quá Tải" } }),
      mau({ key: "binh_thuong" }),
    ],
    capQuaTai,
    NOW,
    new Set<DepartmentCode>(),
  );
  const loai = canThiep.map((i) => i.kind);
  assert.ok(loai.includes("BLOCKED"), "việc bị chặn phải vào danh sách can thiệp");
  assert.ok(loai.includes("STALE_UNASSIGNED"), "việc vỡ hạn lâu chưa ai cầm phải vào danh sách");
  assert.ok(loai.includes("OVERLOADED_HOLDER"), "việc nằm trong tay người quá tải phải vào danh sách");
  assert.ok(!canThiep.some((i) => i.key === "binh_thuong"), "việc bình thường KHÔNG vào danh sách can thiệp — đó là hàng đợi, không phải can thiệp");
  assert.ok(canThiep.length <= 5, "tối đa năm dòng: một cuộc họp sáng không xử lý nổi hơn năm việc");
  const phongTrong = buildInterventions([mau({ key: "n" })], [], NOW, new Set<DepartmentCode>(["SALES"]));
  assert.equal(phongTrong[0].kind, "NO_DEPARTMENT_STAFF", "phòng chưa có ai là lỗ hổng phải nêu tên, không phải im lặng");

  /* ═══════════ 6b · SỬA MỘT Ô PHẢI QUA ĐƯỢC LƯỢC ĐỒ ═══════════ */
  /*
    SỰ CỐ THẬT (bắt được ở QA trình duyệt, không phải ở kiểm thử). Zod 4 bắt `z.record(z.enum(...))`
    phải CÓ ĐỦ MỌI KHOÁ của enum. Màn hình cấu hình gửi đúng một mảnh mỗi lần bấm, nên mọi lượt
    sửa trần việc / bật tắt phân việc đều bị từ chối — `tsc` xanh, `eslint` xanh, kiểm thử thuần
    xanh, và người bấm nút thì thấy trần đặt xong mà máy vẫn chạy theo số cũ.
  */
  assert.equal(staffingSchema.safeParse({ departmentWip: { SALES: 5 } }).success, true, "gửi trần của MỘT phòng phải qua được — màn hình luôn gửi từng mảnh");
  assert.equal(staffingSchema.safeParse({ autoAssign: { SALES: true } }).success, true, "bật phân việc cho MỘT phòng phải qua được");
  assert.equal(staffingSchema.safeParse({ escalationOff: { WAREHOUSE: true } }).success, true, "tắt leo thang cho MỘT phòng phải qua được");
  assert.equal(staffingSchema.safeParse({ departmentWip: { SALES: 0 } }).success, false, "trần 0 việc là vô nghĩa, phải bị chặn");
  assert.equal(staffingSchema.safeParse({ departmentWip: { KHONG_CO: 5 } }).success, false, "mã phòng không có thật phải bị chặn ở cửa");

  /* ═══════════ 7 · ĐIỂM TỔNG CHỈ KHI CÓ TRỌNG SỐ ═══════════ */
  assert.deepEqual(sanitizeWeights({}), {}, "chưa khai gì thì không có trọng số nào");
  assert.deepEqual(sanitizeWeights({ outcome: 0, sla: 3 }), { sla: 3 }, "trọng số 0 = không dùng trục đó, phải BỎ khoá chứ không lưu số 0");
  assert.deepEqual(sanitizeWeights({ outcome: 999, quality: "x" }), {}, "trọng số ngoài dải hoặc sai kiểu bị bỏ");

  /* ═══════════ 8 · BẢNG ĐÍCH / THỰC TẾ CỦA HỌP TUẦN ═══════════ */
  const kr = (over: Partial<{ title: string; target: number; current: number | null; direction: "UP" | "DOWN"; progress: number | null }>) => ({
    id: "k", title: "KR", metricSource: "delivered_revenue", metricLabel: "l", trust: "MEASURED" as const, basis: "", unit: "VND" as const,
    direction: "UP" as const, baseline: null, target: 100, current: 60, currentAt: null, progress: 60, confidence: "UNKNOWN" as const, ownerName: "An", note: "", sample: null, state: "OK" as const,
    authoritativeTarget: null, targetConflict: false, ...over,
  });
  const objs = [
    { id: "o", level: "COMPANY" as const, title: "Mục tiêu", description: "", departmentCode: null, departmentName: "Toàn shop", ownerName: "An", period: "2026-Q3", status: "ACTIVE" as const, keyResults: [kr({}), kr({ direction: "DOWN", target: 10, current: 25, progress: 40 })], progress: 50, measuredCount: 2, totalCount: 2 },
    { id: "n", level: "COMPANY" as const, title: "Nháp", description: "", departmentCode: null, departmentName: "Toàn shop", ownerName: "B", period: "2026-Q3", status: "DRAFT" as const, keyResults: [kr({})], progress: null, measuredCount: 0, totalCount: 1 },
  ];
  const bang = scoreboardOf(objs);
  assert.equal(bang.length, 2, "mục tiêu NHÁP không vào bảng họp — chưa ai bật thì chưa phải cam kết của kỳ");
  assert.equal(bang[0].delta, 40, "chiều TĂNG: còn thiếu = đích − thực tế");
  assert.equal(bang[1].delta, 15, "chiều GIẢM: còn thiếu = thực tế − đích, nên số dương vẫn luôn nghĩa là chưa tới đích");
  assert.equal(scoreboardOf([{ ...objs[0], keyResults: [kr({ current: null, progress: null })] }])[0].delta, null, "chưa đo được thì chênh lệch cũng là null, không suy ra 0");

  const goiY = suggestActions({
    totals: { open: 10, overdue: 4, blocked: 2, unassigned: 3, moneyAtRisk: 0, moneyUnknown: 0 },
    bottleneck: { department: "WAREHOUSE", label: "Kho", reason: "50% quá hạn", overdue: 3, open: 6, blocked: 0 },
    topIssues: [{ key: "a", title: "x", department: "SALES", owner: "", moneyAtRisk: null, overdue: true, url: "", source: "CS_CASE" }],
    scoreboard: bang,
  });
  assert.ok(goiY.length > 0 && goiY.length <= 5, "đề xuất có giới hạn — danh sách dài là danh sách không ai làm");
  assert.ok(goiY.every((a) => a.owner.trim().length > 0), "mỗi đề xuất phải trỏ tới một người / một phòng có thật");
  assert.ok(goiY.every((a) => a.why.trim().length > 10), "mỗi đề xuất phải nói vì sao, nếu không nó chỉ là một câu khẩu hiệu");
  assert.ok(goiY.some((a) => a.text.includes("Kho")), "nút thắt phải thành một dòng việc");

  /* ═══════════ 9 · CHẠY THẬT TRÊN CSDL ═══════════ */
  /*
    Một lượt gọi thật để bắt đúng loại lỗi mà kiểm thử thuần KHÔNG thấy: SQL sai cột, sai độ mịn
    khi nối bảng, hoặc một hàm đọc cấu hình ném lỗi khi bảng `settings` trống. Sự cố 12/09 ở
    `assignableMembers()` (cột `id` mơ hồ) đúng là loại này — `tsc` xanh, `eslint` xanh, và trang
    vẫn đổ khi người thật mở nó.
  */
  const { getDeptPerformance } = await import("@/lib/queries/dept-performance");
  for (const d of ["SALES", "LOGISTICS", "WAREHOUSE", "FINANCE", "MARKETING"] as DepartmentCode[]) {
    const r = await getDeptPerformance({ department: d, from: T(24 * 30), to: NOW, people: [{ id: "u1", name: "An", email: "an@t.local" }] });
    assert.equal(r.department, d);
    assert.ok(Array.isArray(r.people) && Array.isArray(r.team) && Array.isArray(r.missing), `chỉ số phòng ${d} phải chạy được trên CSDL thật`);
  }
  const fin = await getDeptPerformance({ department: "FINANCE", from: T(24 * 30), to: NOW, people: [] });
  assert.ok(fin.team.some((m) => m.key === "reconciliation_completeness"), "kế toán phải có chỉ số mức SỔ, không chỉ mức người");
  assert.ok(
    fin.team.every((m) => m.basis.length > 20),
    "mỗi chỉ số phải nói rõ CĂN CỨ — một con số không kiểm chứng được thì không ai dám dùng để ra quyết định",
  );

  const soNguoi = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users).where(eq(schema.users.active, true));

  console.log(
    `✓ Quản trị nhân lực: trần việc (riêng > phòng > mặc định ${DEFAULT_WIP_LIMIT}, nhiều phòng lấy CAO NHẤT không cộng dồn) · ` +
      `máy phân việc KHÔNG nhồi quá trần (${plan.assignments.length} giao / ${plan.unplaced.length} nằm lại kèm lý do), chia đều không dồn một người, chạy lại ra cùng kế hoạch, không sửa dữ liệu đầu vào · ` +
      `người đang nghỉ và người khai hẹp kỹ năng bị loại đúng · leo thang CHỈ NÂNG không hạ, tính lúc đọc nên 0 dòng CSDL, ngưỡng gửi tin là "bị bỏ quên" chứ không phải "quá hạn" · ` +
      `năm việc can thiệp lọc đúng 4 tình huống · điểm tổng chỉ có khi khai trọng số · bảng đích/thực tế bỏ mục tiêu NHÁP và tính chênh theo chiều · ` +
      `5 phòng chạy truy vấn hiệu suất thật trên ${Number(soNguoi[0].n)} tài khoản`,
  );
}
