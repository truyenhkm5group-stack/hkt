import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { getMorningPrioritiesTool } from "@/lib/ai/tools/erp";
import { clearMemo } from "@/lib/cache";
import { assessFbScopes, maskFbSecrets } from "@/lib/constants/fb-token-scopes";
import { getFbTokenScopes } from "@/lib/queries/fb-token-scopes";
import { bankExceptionScore, rankBankExceptions } from "@/lib/constants/finance-ops";
import { MONEY_UNKNOWN, type WorkItem, type WorkMoney } from "@/lib/constants/work";
import type { DepartmentCode } from "@/lib/constants/departments";
import type { StaffingConfig } from "@/lib/constants/workforce";
import { unclassifiedBankQueue } from "@/lib/queries/finance-ops";
import { buildCapacity } from "@/lib/queries/workforce";
import type { OrgPerson } from "@/lib/queries/work";
import { compareHeads, pickMorningWork } from "@/lib/work/morning-picks";
import { diagnoseDepartment, diagnoseOverdue, OVERDUE_DIAGNOSIS_MIN } from "@/lib/work/overdue-diagnosis";

/**
 * ═══════════ NÂNG THANG TỰ ĐỘNG HOÁ (24/09/2026) ═══════════
 *
 * Ba nấc được nâng trên bản đồ phòng ban, mỗi nấc một hàm — bài kiểm khoá đúng chỗ mỗi hàm dễ nói
 * sai nhất:
 *
 *  1. **Kế toán · Đề nghị** — dòng tiền chưa phân loại xếp theo tiền × số ngày treo. Chỗ dễ sai: xếp
 *     SAU khi cắt (cắt 300 dòng mới nhất rồi mới xếp) thì khoản lớn và cũ vẫn rơi khỏi hàng đợi.
 *  2. **Ban điều hành · Đề nghị** — ba việc liên phòng. Chỗ dễ sai: một phòng nhiều việc chiếm cả ba
 *     ô; tiền chưa biết bị coi là 0 hoặc là vô cùng; việc chờ bên ngoài lọt vào.
 *  3. **Nhân sự · Chẩn đoán** — vì sao quá hạn. Chỗ dễ sai: kết luận "thiếu người" khi chỉ là chưa ai
 *     nhận, hoặc "dồn ở một người" khi không có ai để chia.
 *
 * Mốc thời gian đi theo ĐỒNG HỒ THẬT (AGENTS.md mục 50): mọi dữ liệu dựng tương đối so với `now`
 * lấy lúc chạy, và mọi hàm được gọi với đúng `now` đó.
 */

const H = 3_600_000;

function nguoi(id: string, name: string, ...depts: DepartmentCode[]): OrgPerson {
  return { id, name, email: `${id}@t.local`, role: "CS", positionId: null, departments: depts.map((code) => ({ id: `d-${code}`, code, name: code, roleInDept: "MEMBER" as const })) };
}

const CFG: StaffingConfig = { departmentWip: {}, userWip: {}, skills: {}, away: {}, autoAssign: {}, escalationOff: {} };

export function testAutomationLadderPure() {
  const NOW = new Date();
  /** `h` giờ TRƯỚC `NOW` khi dương, SAU khi âm. */
  const T = (h: number) => new Date(NOW.getTime() - h * H);
  const tien = (v: number): WorkMoney => ({ atRisk: v, recoverable: null, confidence: "MEASURED", basis: "kiểm thử" });
  const mau = (over: Partial<WorkItem>): WorkItem => ({
    key: "k", sourceType: "MANUAL_TASK", sourceKey: "k", kind: null, title: "t", summary: "", department: "SALES", assignee: null,
    status: "NEW", statusAuthority: "WORK", priority: "NORMAL", score: 10, createdAt: T(5), startedAt: null, dueAt: null,
    slaAt: null, completedAt: null, snoozedUntil: null, businessEntity: "NONE", businessEntityId: "", sourceUrl: "",
    money: MONEY_UNKNOWN, tags: [], evidence: { source: "", detail: "" }, blockedReason: "", creationSource: "AUTO",
    actions: [], recommendedAction: "", ...over,
  });

  /* ═══════════ 1 · KẾ TOÁN: TIỀN × SỐ NGÀY TREO ═══════════ */
  {
    const rows = [
      { id: "nho-moi", amount: 50_000, txnAt: T(1) },
      { id: "lon-cu", amount: -50_000_000, txnAt: T(240) },
      { id: "nho-cu", amount: 50_000, txnAt: T(240) },
      { id: "lon-moi", amount: 50_000_000, txnAt: T(1) },
      { id: "a-vua-cu", amount: -5_000_000, txnAt: T(240) },
    ];
    const xep = rankBankExceptions(rows, NOW).map((r) => r.id);
    assert.equal(xep[0], "lon-cu", "khoản LỚN và CŨ phải đứng đầu — đó đúng là khoản bị né lâu nhất");
    /*
      50 triệu và 5 triệu cùng tuổi có CÙNG điểm (tiền bão hoà ở 5 triệu). Không có bước phá thế hoà
      bằng số tiền tuyệt đối thì thứ tự giữa chúng là ngẫu nhiên — đúng lỗi "50 triệu nằm cùng thứ tự
      với 50 nghìn" mà nấc này sinh ra để sửa, chỉ là ở thang lớn hơn.
    */
    assert.equal(bankExceptionScore(-50_000_000, T(240), NOW), bankExceptionScore(-5_000_000, T(240), NOW), "tiền bão hoà ở 5 triệu: hai khoản cùng tuổi cùng điểm");
    assert.ok(xep.indexOf("lon-cu") < xep.indexOf("a-vua-cu"), "cùng điểm thì khoản lớn hơn đứng trước");
    assert.ok(xep.indexOf("lon-moi") < xep.indexOf("nho-moi"), "cùng tuổi, tiền lớn đứng trước tiền nhỏ");
    assert.ok(xep.indexOf("nho-cu") < xep.indexOf("nho-moi"), "cùng tiền, khoản treo lâu đứng trước");
    assert.equal(xep[xep.length - 1], "nho-moi", "khoản nhỏ vừa vào sổ đứng cuối");
    assert.deepEqual(rankBankExceptions([...rows].reverse(), NOW).map((r) => r.id), xep, "thứ tự ỔN ĐỊNH, không phụ thuộc thứ tự đọc từ CSDL");
    // Tiền RA và tiền VÀO cùng số tiền tuyệt đối thì cùng điểm: chưa phân loại là chưa biết, dấu không nói gì về độ gấp.
    assert.equal(bankExceptionScore(-3_000_000, T(30), NOW), bankExceptionScore(3_000_000, T(30), NOW), "dấu tiền không đổi mức ưu tiên");
  }

  /* ═══════════ 2 · BAN ĐIỀU HÀNH: BA VIỆC LIÊN PHÒNG ═══════════ */
  {
    const quaHan = T(30); // hạn đã vỡ 30 giờ ⇒ leo thang lên Gấp
    const conXa = T(-200);
    const items: WorkItem[] = [
      // Kế toán: ba việc, cả ba đều to hơn mọi việc của phòng khác — nhưng chỉ ĐẦU VIỆC được vào.
      mau({ key: "fin-1", department: "FINANCE", slaAt: quaHan, money: tien(50_000_000), score: 60 }),
      mau({ key: "fin-2", department: "FINANCE", slaAt: quaHan, money: tien(40_000_000), score: 59 }),
      mau({ key: "fin-3", department: "FINANCE", slaAt: quaHan, money: tien(30_000_000), score: 58 }),
      // Kinh doanh: đầu việc là việc QUÁ HẠN 2 triệu, không phải việc 10 triệu còn xa hạn.
      mau({ key: "sal-1", department: "SALES", slaAt: quaHan, money: tien(2_000_000), score: 40 }),
      mau({ key: "sal-2", department: "SALES", slaAt: conXa, priority: "NORMAL", money: tien(10_000_000), score: 45 }),
      // Marketing: quá hạn, CHƯA TRA ĐƯỢC TIỀN.
      mau({ key: "mkt-1", department: "MARKETING", slaAt: quaHan, money: MONEY_UNKNOWN, score: 70 }),
      // Kho: mức Cao (chưa vỡ hạn) nhưng tiền lớn nhất — mức gấp đi trước tiền.
      mau({ key: "wh-1", department: "WAREHOUSE", slaAt: conXa, priority: "HIGH", money: tien(100_000_000), score: 50 }),
      // Giao vận: chỉ có việc CHỜ BÊN NGOÀI ⇒ phòng không được xét.
      mau({ key: "log-1", department: "LOGISTICS", status: "WAITING", slaAt: quaHan, money: tien(80_000_000) }),
      // Điều hành: một việc đang hoãn chưa tới hạn (bỏ) và một việc hoãn nhưng ĐÃ vỡ hạn (giữ).
      mau({ key: "mgt-hoan", department: "MANAGEMENT", snoozedUntil: T(-5), slaAt: conXa, money: tien(90_000_000) }),
      mau({ key: "mgt-vo", department: "MANAGEMENT", snoozedUntil: T(-5), slaAt: quaHan, money: tien(1_000_000), score: 30 }),
      // Việc đã xong không bao giờ là việc đáng làm.
      mau({ key: "hr-xong", department: "HR", status: "DONE", slaAt: quaHan, money: tien(999_000_000) }),
    ];

    const r = pickMorningWork(items, NOW);
    assert.deepEqual(r.picks.map((p) => p.item.key), ["fin-1", "sal-1", "mgt-vo"], "mức gấp trước, cùng mức thì tiền lớn trước, MỖI PHÒNG MỘT việc");
    assert.equal(new Set(r.picks.map((p) => p.department)).size, r.picks.length, "không phòng nào chiếm hai ô");
    assert.ok(!r.picks.some((p) => p.item.key === "fin-2"), "phòng sinh nhiều việc nhất KHÔNG được chiếm cả ba ô");
    assert.equal(r.departmentsWithWork, 5, "năm phòng có việc làm được ngay: Kế toán · Kinh doanh · Marketing · Kho · Điều hành");
    assert.deepEqual(r.skipped, { waiting: 1, snoozed: 1 }, "việc chờ bên ngoài và việc hoãn chưa tới hạn được ĐẾM, không biến mất im lặng");
    assert.ok(r.picks.every((p) => p.rank === r.picks.indexOf(p) + 1), "thứ hạng đánh từ 1");

    const nam = pickMorningWork(items, NOW, 5);
    assert.deepEqual(nam.picks.map((p) => p.item.key), ["fin-1", "sal-1", "mgt-vo", "mkt-1", "wh-1"]);
    const mkt = nam.picks.find((p) => p.department === "MARKETING")!;
    assert.equal(mkt.moneyAtRisk, null, "tiền chưa tra được là null, KHÔNG BAO GIỜ 0");
    assert.equal(mkt.rankedWithoutMoney, true, "đứng sau các việc cùng mức có tiền ⇒ phải nói là vì chưa biết tiền");
    assert.equal(nam.picks.find((p) => p.department === "WAREHOUSE")!.rankedWithoutMoney, false, "việc có tiền thì không mang cờ đó");
    assert.ok(nam.picks.findIndex((p) => p.department === "WAREHOUSE") > nam.picks.findIndex((p) => p.department === "MARKETING"), "mức Gấp (dù chưa biết tiền) đứng trên mức Cao (dù 100 triệu)");

    // Ổn định: đảo thứ tự đầu vào không đổi kết quả.
    assert.deepEqual(pickMorningWork([...items].reverse(), NOW, 5).picks.map((p) => p.item.key), nam.picks.map((p) => p.item.key), "cùng dữ liệu ⇒ cùng ba việc, bất kể thứ tự đọc");

    // Tiền chưa biết không được coi là VÔ CÙNG: một việc cùng mức có 1 đồng vẫn đứng trên nó.
    const motDong = mau({ key: "a", department: "SALES", slaAt: quaHan, money: tien(1), score: 1 });
    const chuaBiet = mau({ key: "b", department: "FINANCE", slaAt: quaHan, money: MONEY_UNKNOWN, score: 99 });
    assert.ok(compareHeads(motDong, chuaBiet, NOW) < 0, "cùng mức gấp: việc CÓ số tiền đứng trước việc chưa tra được tiền");
    // Nhưng tiền 0 ĐO ĐƯỢC là 0 thật, vẫn là "có số tiền".
    const khongDong = mau({ key: "c", department: "SALES", slaAt: quaHan, money: tien(0), score: 1 });
    assert.ok(compareHeads(khongDong, chuaBiet, NOW) < 0, "0 đo được vẫn là một con số — khác chưa biết");

    assert.deepEqual(pickMorningWork([], NOW), { picks: [], departmentsWithWork: 0, skipped: { waiting: 0, snoozed: 0 } }, "hàng đợi trống ⇒ không bịa việc");
  }

  /* ═══════════ 3 · NHÂN SỰ: VÌ SAO QUÁ HẠN ═══════════ */
  {
    const quaHan = T(10);
    const conXa = T(-100);
    const cam = (id: string | null, name: string) => ({ id, email: "", name });

    // 3a. Hết chỗ: 25 việc chưa ai cầm, một người còn 20 chỗ theo trần MẶC ĐỊNH.
    const people1 = [nguoi("u-an", "An", "SALES")];
    const viec1 = Array.from({ length: 25 }, (_, i) => mau({ key: `s${i}`, department: "SALES", slaAt: i < 5 ? quaHan : conXa }));
    const d1 = diagnoseDepartment("SALES", viec1, buildCapacity(people1, viec1, CFG, NOW), CFG, NOW);
    assert.equal(d1.cause, "NO_CAPACITY", "25 việc chưa ai cầm > 20 chỗ trống của cả phòng ⇒ thiếu người, không phải thiếu phân việc");
    assert.equal(d1.ceilingIsDefault, true, "trần chưa khai ⇒ kết luận hết chỗ chỉ là ƯỚC TÍNH");
    assert.equal(d1.freeSlots, 20);
    // CÙNG dữ liệu, trần khai 30 ⇒ phòng CÒN chỗ ⇒ nguyên nhân đổi hẳn sang "chưa ai nhận".
    const cfg30 = { ...CFG, departmentWip: { SALES: 30 } };
    const d1b = diagnoseDepartment("SALES", viec1, buildCapacity(people1, viec1, cfg30, NOW), cfg30, NOW);
    assert.equal(d1b.cause, "UNCLAIMED", "còn chỗ mà việc quá hạn nằm ở hàng đợi chung ⇒ sửa bằng phân việc, tuyển người không sửa được");
    assert.equal(d1b.ceilingIsDefault, false, "trần phòng đã khai ⇒ không còn là ước tính");

    // 3b. Dồn ở một người: An cầm 4/5 việc quá hạn, Bình còn chỗ.
    const people2 = [nguoi("u-an", "An", "FINANCE"), nguoi("u-binh", "Bình", "FINANCE")];
    const viec2 = [
      ...Array.from({ length: 4 }, (_, i) => mau({ key: `f-an-${i}`, department: "FINANCE", slaAt: quaHan, assignee: cam("u-an", "An") })),
      mau({ key: "f-binh", department: "FINANCE", slaAt: quaHan, assignee: cam("u-binh", "Bình") }),
    ];
    const d2 = diagnoseDepartment("FINANCE", viec2, buildCapacity(people2, viec2, CFG, NOW), CFG, NOW);
    assert.equal(d2.cause, "CONCENTRATED");
    assert.equal(d2.topHolder?.name, "An");
    assert.equal(d2.topHolder?.overdue, 4);
    assert.equal(d2.topHolder?.share, 0.8);
    // Bình đang nghỉ ⇒ KHÔNG có ai để chia ⇒ "dồn" không còn là lối ra, không được kết luận như vậy.
    const cfgNghi = { ...CFG, away: { "u-binh": { until: T(-48).toISOString(), reason: "phép" } } };
    const d2b = diagnoseDepartment("FINANCE", viec2, buildCapacity(people2, viec2, cfgNghi, NOW), cfgNghi, NOW);
    assert.equal(d2b.cause, "SPREAD", "không có người có mặt còn chỗ thì 'chia lại' là lời khuyên không làm được");
    assert.equal(d2b.present, 1);

    // 3c. Ô CHỮ: việc CSKH ghi TÊN chứ không ghi khoá — vẫn nhận ra đúng người đang ôm, và không coi chính họ là "người còn chỗ để chia".
    const viec3 = [
      ...Array.from({ length: 4 }, (_, i) => mau({ key: `c-${i}`, department: "FINANCE", slaAt: quaHan, assignee: cam(null, "  AN ") })),
      mau({ key: "c-binh", department: "FINANCE", slaAt: quaHan, assignee: cam("u-binh", "Bình") }),
    ];
    const cfgBinhDay = { ...CFG, userWip: { "u-binh": 1 } };
    const d3 = diagnoseDepartment("FINANCE", viec3, buildCapacity(people2, viec3, cfgBinhDay, NOW), cfgBinhDay, NOW);
    assert.equal(d3.cause, "SPREAD", "An cầm qua ô chữ vẫn là An; Bình đã đầy trần ⇒ không ai để chia ⇒ không phải 'dồn'");

    // 3d. Rải đều: ba người, mỗi người 2 việc quá hạn, phòng còn chỗ.
    const people4 = [nguoi("a", "A", "LOGISTICS"), nguoi("b", "B", "LOGISTICS"), nguoi("c", "C", "LOGISTICS")];
    const viec4 = ["a", "b", "c"].flatMap((u) => [0, 1].map((i) => mau({ key: `l-${u}-${i}`, department: "LOGISTICS", slaAt: quaHan, assignee: cam(u, u.toUpperCase()) })));
    assert.equal(diagnoseDepartment("LOGISTICS", viec4, buildCapacity(people4, viec4, CFG, NOW), CFG, NOW).cause, "SPREAD");

    // 3e. Quá ít để kết luận; không quá hạn; phòng trống; cả phòng nghỉ.
    const viec5 = Array.from({ length: OVERDUE_DIAGNOSIS_MIN - 1 }, (_, i) => mau({ key: `w${i}`, department: "WAREHOUSE", slaAt: quaHan }));
    const p5 = [nguoi("k", "Kho", "WAREHOUSE")];
    assert.equal(diagnoseDepartment("WAREHOUSE", viec5, buildCapacity(p5, viec5, CFG, NOW), CFG, NOW).cause, "TOO_FEW", "dưới ngưỡng mẫu ⇒ không nói nguyên nhân");
    const viec6 = [mau({ key: "ok", department: "WAREHOUSE", slaAt: conXa })];
    assert.equal(diagnoseDepartment("WAREHOUSE", viec6, buildCapacity(p5, viec6, CFG, NOW), CFG, NOW).cause, "NONE");
    const viec7 = [mau({ key: "hr", department: "HR", slaAt: quaHan })];
    const d7 = diagnoseDepartment("HR", viec7, buildCapacity([], viec7, CFG, NOW), CFG, NOW);
    assert.equal(d7.cause, "NO_STAFF", "phòng trống: MỘT việc quá hạn cũng đủ kết luận — không cần mẫu lớn");
    assert.equal(d7.members, 0);
    const cfgNghiHet = { ...CFG, away: { k: { until: T(-24).toISOString(), reason: "ốm" } } };
    const viec8 = Array.from({ length: 5 }, (_, i) => mau({ key: `x${i}`, department: "WAREHOUSE", slaAt: quaHan }));
    const d8 = diagnoseDepartment("WAREHOUSE", viec8, buildCapacity(p5, viec8, cfgNghiHet, NOW), cfgNghiHet, NOW);
    assert.equal(d8.cause, "NO_STAFF", "cả phòng đang nghỉ ⇒ không có ai làm hôm nay");
    assert.equal(d8.members, 1);

    // 3f. Việc đã đóng không phải việc quá hạn; phòng không có việc mở không hiện dòng nào.
    const tatCa = [...viec2, mau({ key: "done", department: "FINANCE", status: "DONE", slaAt: quaHan })];
    const ds = diagnoseOverdue(tatCa, buildCapacity(people2, tatCa, CFG, NOW), CFG, NOW);
    assert.deepEqual(ds.map((d) => d.department), ["FINANCE"], "chỉ phòng có việc đang mở mới có dòng chẩn đoán");
    assert.equal(ds[0].overdue, 5, "việc đã xong không bị đếm là quá hạn");
    assert.deepEqual(diagnoseOverdue(tatCa, buildCapacity(people2, tatCa, CFG, NOW), CFG, NOW, "SALES"), [], "phạm vi một phòng chỉ chẩn đoán phòng đó");
  }

  /* ═══════════ 4 · COPILOT ĐỌC ĐÚNG HÀM, VÀ KHÔNG LÀ CỬA SAU ═══════════ */
  assert.equal(getMorningPrioritiesTool.kind, "read", "tool xếp hạng chỉ ĐỌC");
  assert.equal(getMorningPrioritiesTool.policy, "auto");
  assert.equal(
    getMorningPrioritiesTool.permission,
    "work:all",
    "kết quả cắt ngang MỌI phòng ⇒ chỉ người được xem chéo phòng mới dùng được — nếu không, Copilot là cửa sau đọc hàng đợi phòng khác",
  );

  console.log("✓ Thang tự động hoá: Kế toán xếp tiền × ngày treo · ba việc liên phòng (mỗi phòng một ô, chưa biết tiền ≠ 0) · bảy nguyên nhân quá hạn, không kết luận 'người chậm'");
}

/**
 * Đường CSDL của Kế toán: xếp TRƯỚC khi cắt. Bản cũ `order by txn_at desc limit N` cắt trước rồi mới
 * (không) xếp — khoản 50 triệu treo mười ngày rơi khỏi `/work` ngay khi tồn vượt 300 dòng.
 */
export async function testAutomationLadderQueries(db: Db) {
  const b = schema.bankTransactions;
  const now = new Date();
  const T = (h: number) => new Date(now.getTime() - h * H);
  await db.delete(b).where(sql`${b.id} like 'alad-%'`);
  try {
    await db.insert(b).values([
      { id: "alad-nho-moi", bankRef: "ALAD1", txnAt: T(1), amount: 50_000, description: "alad nho moi", counterparty: "", accountingGroup: "UNCLASSIFIED", source: "IMPORT" },
      { id: "alad-lon-cu", bankRef: "ALAD2", txnAt: T(240), amount: -50_000_000, description: "alad lon cu", counterparty: "", accountingGroup: "UNCLASSIFIED", source: "IMPORT" },
      { id: "alad-nho-cu", bankRef: "ALAD3", txnAt: T(240), amount: 50_000, description: "alad nho cu", counterparty: "", accountingGroup: "UNCLASSIFIED", source: "IMPORT" },
      { id: "alad-lon-moi", bankRef: "ALAD4", txnAt: T(2), amount: 50_000_000, description: "alad lon moi", counterparty: "", accountingGroup: "UNCLASSIFIED", source: "IMPORT" },
      // Đã phân loại ⇒ không bao giờ vào hàng đợi, dù tiền lớn nhất.
      { id: "alad-da-gan", bankRef: "ALAD5", txnAt: T(500), amount: -900_000_000, description: "alad da gan", counterparty: "", accountingGroup: "RENT_UTILITIES", source: "IMPORT" },
    ]);

    const full = await unclassifiedBankQueue(5_000, { now });
    const ids = full.rows.map((r) => r.id).filter((id) => id.startsWith("alad-"));
    assert.deepEqual(ids, ["alad-lon-cu", "alad-lon-moi", "alad-nho-cu", "alad-nho-moi"], "đường CSDL xếp đúng thứ tự của hàm thuần: lớn-cũ → lớn-mới → nhỏ-cũ → nhỏ-mới");
    assert.ok(full.total >= 4, "tổng đếm cả dòng không hiện");
    assert.equal(full.truncated, false);

    // Cắt SAU khi xếp: N dòng đầu phải là ĐÚNG tiền tố của danh sách đầy đủ.
    const k = full.rows.findIndex((r) => r.id === "alad-lon-cu") + 1;
    const cat = await unclassifiedBankQueue(k, { now });
    assert.deepEqual(cat.rows.map((r) => r.id), full.rows.slice(0, k).map((r) => r.id), "danh sách bị cắt phải là tiền tố của danh sách đã xếp — xếp rồi mới cắt");
    assert.ok(cat.rows.some((r) => r.id === "alad-lon-cu"), "khoản 50 triệu treo mười ngày KHÔNG được rơi khỏi danh sách bị cắt");
    assert.equal(cat.total, full.total, "tổng không phụ thuộc số dòng hiện");

    // Chế độ "recent" giữ thứ tự cũ cho gợi ý lương — và chính nó cho thấy vì sao thứ tự cũ sai cho hàng đợi.
    const moi = (await unclassifiedBankQueue(5_000, { now, order: "recent" })).rows.map((r) => r.id).filter((id) => id.startsWith("alad-"));
    assert.deepEqual(moi.slice(0, 2), ["alad-nho-moi", "alad-lon-moi"], "chế độ recent: mới nhất trước (1 giờ rồi 2 giờ)");
    assert.ok(moi.indexOf("alad-nho-moi") < moi.indexOf("alad-lon-cu"), "thứ tự thời gian đặt khoản 50 nghìn vừa vào TRÊN khoản 50 triệu treo mười ngày — đúng thứ nấc Đề nghị của Kế toán phải sửa");
  } finally {
    await db.delete(b).where(sql`${b.id} like 'alad-%'`);
  }
  console.log("✓ Thang tự động hoá (CSDL): dòng tiền chưa phân loại xếp rồi mới cắt — khoản lớn treo lâu không rơi khỏi hàng đợi");
}

/**
 * Token Facebook có quyền gì — HỎI Facebook, kết luận bằng hàm thuần. Ba chỗ dễ nói sai nhất:
 * coi "không hỏi được" là "thiếu" (tô đỏ oan), coi quyền BỊ TỪ CHỐI là có quyền, và in token ra
 * màn hình qua một câu lỗi chép lại URL.
 */
export async function testFbTokenScopes() {
  // 1. Có ads_management ở trạng thái granted ⇒ READY; quyền đọc thiếu thì nêu riêng.
  const du = assessFbScopes({ hasToken: true, permissions: [{ permission: "ads_management", status: "granted" }, { permission: "ads_read", status: "granted" }] });
  assert.equal(du.state, "READY");
  assert.deepEqual(du.missingRead, ["business_management"], "quyền ĐỌC ERP đang dùng mà token thiếu phải được nêu ra, dù quyền ghi đã đủ");
  assert.equal(du.assetAccess, "UNKNOWN", "phân quyền TÀI SẢN không nằm trong token — không bao giờ tự nhận là đã biết");

  // 2. Có tên nhưng bị TỪ CHỐI ⇒ MISSING, và câu lý do nói đúng là bị từ chối.
  const tuChoi = assessFbScopes({ hasToken: true, permissions: [{ permission: "ads_management", status: "declined" }, { permission: "ads_read", status: "granted" }] });
  assert.equal(tuChoi.state, "MISSING", "quyền có tên mà status = declined thì KHÔNG dùng được");
  assert.deepEqual(tuChoi.declined, ["ads_management"]);
  assert.match(tuChoi.reason, /TỪ CHỐI/);

  // 3. Chỉ có quyền đọc ⇒ MISSING, và câu lý do chỉ đúng lối ra (tạo token MỚI).
  const chiDoc = assessFbScopes({ hasToken: true, permissions: [{ permission: "ads_read", status: "granted" }, { permission: "business_management", status: "granted" }] });
  assert.equal(chiDoc.state, "MISSING");
  assert.match(chiDoc.reason, /tạo mã mới|FACEBOOK_ACCESS_TOKEN/, "phải nói: thêm quyền cho System User KHÔNG đủ — phải tạo token mới");

  // 4. Không hỏi được ⇒ UNKNOWN, KHÔNG BAO GIỜ MISSING (AGENTS.md mục 0.3).
  assert.equal(assessFbScopes({ hasToken: false, permissions: null }).state, "UNKNOWN", "chưa có token ⇒ chưa biết, không phải thiếu");
  const loi = assessFbScopes({ hasToken: true, permissions: null, error: "Facebook: fetch failed https://graph.facebook.com/v21.0/me/permissions?access_token=EAAB1234567890abcdefXYZ" });
  assert.equal(loi.state, "UNKNOWN", "Facebook không trả lời ⇒ chưa biết");
  assert.ok(!loi.reason.includes("EAAB1234567890abcdefXYZ"), "câu lỗi đi lên màn hình KHÔNG được mang token (kho PUBLIC)");
  assert.ok(loi.reason.includes("access_token=***"));
  assert.equal(maskFbSecrets("token EAAGabcdefghijklmnopqrstu hết hạn"), "token EAA*** hết hạn", "chuỗi token Meta trần cũng bị che");

  // 5. Đường truy vấn không có token ⇒ UNKNOWN mà KHÔNG gọi mạng.
  const cu = process.env.FACEBOOK_ACCESS_TOKEN;
  delete process.env.FACEBOOK_ACCESS_TOKEN;
  clearMemo();
  try {
    const r = await getFbTokenScopes();
    assert.equal(r.state, "UNKNOWN", "máy không có token ⇒ trang Cấu hình hiện 'chưa biết', không sập và không đỏ oan");
  } finally {
    if (cu !== undefined) process.env.FACEBOOK_ACCESS_TOKEN = cu;
    clearMemo();
  }
  console.log("✓ Quyền token Facebook: đủ / thiếu / bị từ chối / chưa biết tách bạch · không hỏi được KHÔNG phải thiếu · câu lỗi không mang token");
}
