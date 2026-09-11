import { desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import {
  CASE_ACTION,
  RECOVERABILITY,
  CASE_TYPE_LABEL,
  ageLabel,
  caseScore,
  caseScoreBreakdown,
  caseStatusOf,
  scoreExplanation,
  slaFor,
  caseTypeOf,
  priorityOf,
  KIND_TO_CASE,
  teamOf,
  TEAM_LABEL,
  TEAM_ORDER,
  type CaseTeam,
  type CasePriority,
  type CaseStatus,
  type CaseType,
  type CaseSla,
  type QueueFilter,
  type ScoreParts,
} from "@/lib/constants/action-queue";

/**
 * HÀNG ĐỢI VIỆC — một danh sách duy nhất, xếp theo mức ưu tiên tính được.
 *
 * Nguồn là bảng `notifications` (đã có cơ chế chống trùng và tự đóng khi điều kiện hết), nên
 * không sinh thêm một bảng việc thứ hai để rồi hai nơi lệch nhau.
 *
 * NĂM TRẠNG THÁI TÁCH BẠCH, và trước đây chúng bị gộp:
 *  · ĐÃ ĐỌC        — có người nhìn thấy (`read_by`), KHÔNG phải một trạng thái việc;
 *  · CHƯA AI NHẬN  — việc đang trôi;
 *  · ĐÃ TIẾP NHẬN  — có người nhận (`acknowledged_*`);
 *  · ĐANG LÀM      — đã bắt tay vào (`started_*`);
 *  · ĐÃ XONG       — xử lý xong (`resolved_at`);
 *  · BỎ QUA        — cố ý không làm, CÓ LÝ DO (`ignored_*`).
 * "Đọc rồi" không có nghĩa là "có người làm", và "bỏ qua" không phải "đã xong".
 */

const n = schema.notifications;

export type ActionCase = {
  id: string;
  type: CaseType;
  typeLabel: string;
  /** Bộ phận chịu trách nhiệm. Suy từ loại việc, một chỗ duy nhất. */
  team: CaseTeam;
  teamLabel: string;
  entityType: string;
  entityId: string;
  priority: CasePriority;
  score: number;
  severity: string;
  title: string;
  /** Vì sao việc này xuất hiện. */
  reason: string;
  detectedAt: Date;
  ageHours: number;
  ageLabel: string;
  status: CaseStatus;
  /** Ai đang cầm việc. `null` = chưa ai nhận. */
  owner: { id: string; name: string } | null;
  acknowledgedBy: string | null;
  recommendedAction: string;
  href: string;
  /** Tiền đang treo ở việc này (đồng). 0 = không tra được / không phải việc về tiền. */
  financialImpact: number;
  /** Khả năng hành động bây giờ còn cứu được kết quả (0–1). */
  recoverability: number;
  /** Bằng chứng: việc này từ đâu ra, dựa trên cái gì. Không có bằng chứng thì không phải việc. */
  evidence: { source: string; detail: string };
  ignoredReason: string;
  /** Vì sao việc này xếp trên việc kia — từng phần điểm, để người đọc kiểm chứng được. */
  scoreParts: ScoreParts;
  scoreExplanation: string;
  /** Hạn xử lý. `null` khi loại việc CỐ Ý không đặt hạn (xem CASE_SLA_HOURS). */
  sla: CaseSla | null;
};

export type ActionQueue = {
  cases: ActionCase[];
  totals: Record<CasePriority, number>;
  byType: { type: CaseType; label: string; count: number }[];
  /**
   * Chia theo BỘ PHẬN — thứ trả lời được câu "việc này của ai" trước khi hỏi "làm cái nào trước".
   * Có cả số việc gấp, số trễ hạn và tiền treo của từng nhóm: một nhóm 400 việc nhẹ không cần chú
   * ý bằng một nhóm 20 việc đang trễ hạn với vài chục triệu treo.
   */
  byTeam: { team: CaseTeam; label: string; count: number; urgent: number; breached: number; unassigned: number; financialImpact: number }[];
  /** Việc chưa ai nhận — con số quan trọng nhất của một hàng đợi. */
  unassigned: number;
  /** Việc quá 3 ngày chưa ai nhận. */
  neglected: number;
  /** Tổng tiền đang treo ở toàn bộ việc đang mở. */
  financialImpact: number;
  /** Việc đã quá hạn xử lý. Chỉ đếm loại việc CÓ đặt hạn. */
  breached: number;
  /** Số việc khớp bộ lọc đang xem. */
  matched: number;
  /**
   * Tổng số việc ĐANG MỞ trong CSDL — đếm thật, không phụ thuộc bộ lọc và không bị `limit` cắt.
   */
  total: number;
  /** Tổng việc ĐANG MỞ bất kể bộ lọc — để người dùng biết đang xem một phần của cái gì. */
  openTotal: number;
  /**
   * Số việc được nạp và tính điểm trong lượt này (trần `pageSize`). Các con số tổng hợp bên trên
   * (`totals`, `byType`, `byTeam`, `financialImpact`, `breached`) chỉ nói về ngần này — nói khác đi
   * là nói quá.
   */
  loaded: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** `false` = đang lọc bằng tiêu chí chỉ tính được sau khi chấm điểm, nên `total` là ước lượng trên. */
  exactTotal: boolean;
};

/**
 * BẰNG CHỨNG của mỗi loại việc: con số này từ đâu ra.
 *
 * Một việc không nói được nó dựa trên cái gì thì người vận hành không có cách nào kiểm chứng, và
 * hàng đợi trở lại thành danh sách đọc rồi bỏ.
 */
const EVIDENCE_SOURCE: Record<string, string> = {
  ORDER: "Đơn Pancake",
  SHIPMENT: "Vận đơn + sự kiện Viettel Post",
  DATA_RULE: "Luật chất lượng dữ liệu",
  CS_CASE: "Case CSKH",
  VARIANT: "Sổ kho ERP",
  AD_ACCOUNT: "Tài khoản quảng cáo Meta",
  AD_CAMPAIGN: "Chi tiêu Meta + kết quả đơn",
};

/** Số tiền liên quan tới việc, nếu tra được — dùng cho phần "giá trị tiền" của điểm ưu tiên. */
async function amountsFor(entityIds: string[]): Promise<Map<string, number>> {
  if (!entityIds.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ id: schema.orders.id, amount: schema.orders.totalPriceAfterDiscount })
    .from(schema.orders)
    .where(sql`${schema.orders.id} in ${entityIds}`);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.id, Number(r.amount ?? 0));
  const shipments = await db
    .select({ id: schema.shipments.id, amount: schema.shipments.codAmount })
    .from(schema.shipments)
    .where(sql`${schema.shipments.id} in ${entityIds}`);
  for (const r of shipments) map.set(r.id, Number(r.amount ?? 0));
  return map;
}

/**
 * ───────────── BỘ LỌC ĐẨY ĐƯỢC XUỐNG CSDL ─────────────
 *
 * Phân trang chỉ đúng khi CÙNG MỘT điều kiện dùng cho cả danh sách lẫn phép đếm. Nên mọi bộ lọc
 * suy được từ cột trong bảng phải chạy TRONG SQL:
 *
 *   · bộ phận / loại việc → tập `kind` (ánh xạ `KIND_TO_CASE` đảo ngược được);
 *   · trạng thái          → các mốc thời gian;
 *   · người cầm việc      → `assigned_to`.
 *
 * Ba thứ KHÔNG đẩy xuống được vì chúng chỉ tồn tại sau khi tính điểm trong ứng dụng: MỨC ƯU TIÊN,
 * TIỀN TREO và TRỄ HẠN. Chúng vẫn lọc ở tầng ứng dụng, và `getActionQueue` nói rõ điều đó qua
 * `exactTotal` — không giả vờ rằng tổng vẫn chính xác khi đang lọc bằng chúng.
 */
function kindsFor(filter: QueueFilter | undefined): string[] | null {
  if (!filter?.type && !filter?.team) return null;
  const kinds = Object.entries(KIND_TO_CASE)
    .filter(([, caseType]) => (filter.type ? caseType === filter.type : true) && (filter.team ? teamOf(caseType) === filter.team : true))
    .map(([kind]) => kind);
  return kinds;
}

function queueWhere(options: { assignedTo?: string; filter?: QueueFilter }): SQL {
  const conds: SQL[] = [sql`${n.resolvedAt} is null`];
  if (options.assignedTo) conds.push(sql`${n.assignedTo} = ${options.assignedTo}`);

  const f = options.filter;
  const kinds = kindsFor(f);
  if (kinds) conds.push(kinds.length ? sql`${n.kind} in ${kinds}` : sql`false`);

  if (f?.owner !== undefined) conds.push(f.owner === "" ? sql`${n.assignedTo} is null` : sql`${n.assignedTo} = ${f.owner}`);

  if (f?.status) {
    // Hàng đợi chỉ nạp việc CHƯA đóng, nên chỉ bốn trạng thái này xuất hiện được.
    if (f.status === "IGNORED") conds.push(sql`${n.ignoredAt} is not null`);
    else if (f.status === "IN_PROGRESS") conds.push(sql`${n.ignoredAt} is null and ${n.startedAt} is not null`);
    else if (f.status === "ACKNOWLEDGED") conds.push(sql`${n.ignoredAt} is null and ${n.startedAt} is null and ${n.acknowledgedAt} is not null`);
    else if (f.status === "OPEN") conds.push(sql`${n.ignoredAt} is null and ${n.startedAt} is null and ${n.acknowledgedAt} is null`);
    else conds.push(sql`false`);
  }
  return conds.reduce((a, b) => sql`${a} and ${b}`);
}

/** Bộ lọc CHỈ tính được sau khi chấm điểm — không đẩy xuống CSDL được. */
function hasComputedFilter(f: QueueFilter | undefined): boolean {
  return Boolean(f?.priority || f?.minAmount || f?.breachedOnly);
}

/**
 * BỘ LỌC HÀNG ĐỢI. Lọc SAU khi tính điểm, cố ý:
 * các con số tổng hợp (bao nhiêu việc, bao nhiêu tiền, bao nhiêu trễ hạn) phải nói về TOÀN BỘ hàng
 * đợi, không đổi theo bộ lọc đang xem — nếu không, lọc một cái là thấy "hết việc rồi".
 */
function matchesFilter(c: ActionCase, f: QueueFilter): boolean {
  if (f.type && c.type !== f.type) return false;
  if (f.team && c.team !== f.team) return false;
  if (f.priority && c.priority !== f.priority) return false;
  if (f.status && c.status !== f.status) return false;
  if (f.owner !== undefined && (f.owner === "" ? Boolean(c.owner) : c.owner?.id !== f.owner)) return false;
  if (f.minAmount && c.financialImpact < f.minAmount) return false;
  if (f.breachedOnly && !c.sla?.breached) return false;
  return true;
}

/**
 * SỐ NGÀY CÒN ĐỦ HÀNG của các mẫu mã đang có việc trong hàng đợi.
 *
 * Đây là thứ làm cho yếu tố "sắp cháy hàng" của công thức ưu tiên thật sự chạy: cháy hàng sau 2
 * ngày và sau 12 ngày cùng một mức cảnh báo nhưng khác hẳn nhau về việc phải làm hôm nay.
 *
 * Dùng lại `getReplenishmentPlan` (đã có bộ nhớ đệm) chứ KHÔNG tính lại — một công thức tồn kho
 * duy nhất cho toàn ERP.
 */
async function daysToStockoutFor(variantIds: string[]): Promise<Map<string, number | null>> {
  if (!variantIds.length) return new Map();
  try {
    const plan = await getReplenishmentPlan();
    const wanted = new Set(variantIds);
    const map = new Map<string, number | null>();
    for (const row of plan.rows) {
      if (wanted.has(row.variantId)) map.set(row.variantId, row.daysOfCover);
    }
    return map;
  } catch {
    // Chưa tính được kế hoạch: để CHƯA BIẾT, và công thức ưu tiên sẽ không cộng điểm nào.
    return new Map();
  }
}

export async function getActionQueue(
  options: { limit?: number; page?: number; assignedTo?: string; filter?: QueueFilter } = {},
): Promise<ActionQueue> {
  const db = await getDb();
  const limit = options.limit ?? 200;
  const page = Math.max(1, options.page ?? 1);
  const offset = (page - 1) * limit;
  const where = queueWhere(options);
  const rows = await db
    .select({
      id: n.id,
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body,
      href: n.href,
      entityType: n.entityType,
      entityId: n.entityId,
      occurredAt: n.occurredAt,
      createdAt: n.createdAt,
      assignedTo: n.assignedTo,
      assignedAt: n.assignedAt,
      acknowledgedBy: n.acknowledgedBy,
      acknowledgedAt: n.acknowledgedAt,
      startedAt: n.startedAt,
      ignoredAt: n.ignoredAt,
      ignoredReason: n.ignoredReason,
      ownerName: schema.users.name,
      ownerEmail: schema.users.email,
    })
    .from(n)
    .leftJoin(schema.users, eq(schema.users.id, n.assignedTo))
    .where(where)
    .orderBy(desc(n.createdAt))
    .limit(limit)
    .offset(offset);

  /**
   * TỔNG THẬT, KHÔNG PHẢI TỔNG CỦA PHẦN VỪA NẠP.
   *
   * `rows` bị cắt ở `limit` (trang Cần xử lý nạp 300). Production đang có **966 việc đang mở**, nên
   * lấy `rows.length` làm tổng là hiển thị 300 và nói đó là tất cả — người đọc tin rằng hàng đợi
   * nhỏ hơn thực tế ba lần. Đếm thẳng trong CSDL thì con số đúng bất kể nạp bao nhiêu.
   */
  // ĐẾM BẰNG CHÍNH ĐIỀU KIỆN CỦA DANH SÁCH — không nạp 966 dòng chỉ để đếm.
  // Bốn phép đọc dưới đây không phụ thuộc nhau: chạy song song. Hàng đợi cố ý KHÔNG đệm (người vừa
  // bấm "Tôi nhận" phải thấy ngay), nên mỗi vòng đi-về tiết kiệm được là tiết kiệm ở mọi lần mở trang.
  const [[{ filteredTotal }], [{ openTotal }], amounts, stockDays] = await Promise.all([
    db.select({ filteredTotal: sql<number>`count(*)` }).from(n).where(where),
    // Và tổng việc đang mở BẤT KỂ bộ lọc, để người dùng biết mình đang xem một phần của cái gì.
    db.select({ openTotal: sql<number>`count(*)` }).from(n).where(isNull(n.resolvedAt)),
    amountsFor([...new Set(rows.map((r) => r.entityId).filter(Boolean))]),
    daysToStockoutFor([...new Set(rows.filter((r) => r.entityType === "VARIANT").map((r) => r.entityId).filter(Boolean))]),
  ]);
  const now = Date.now();

  const cases: ActionCase[] = rows.map((r) => {
    const type = caseTypeOf(r.kind);
    const detectedAt = r.occurredAt ?? r.createdAt;
    const ageHours = Math.max(0, (now - detectedAt.getTime()) / 3_600_000);
    const scoreInput = {
      severity: r.severity,
      ageHours,
      amount: amounts.get(r.entityId) ?? null,
      type,
      // Chưa tra được thì để `null` — KHÔNG BIẾT không phải là GẤP.
      daysToStockout: r.entityType === "VARIANT" ? (stockDays.get(r.entityId) ?? null) : null,
    };
    const scoreParts = caseScoreBreakdown(scoreInput);
    const score = caseScore(scoreInput);
    return {
      id: r.id,
      type,
      typeLabel: CASE_TYPE_LABEL[type],
      team: teamOf(type),
      teamLabel: TEAM_LABEL[teamOf(type)],
      entityType: r.entityType,
      entityId: r.entityId,
      priority: priorityOf(score),
      score,
      severity: r.severity,
      title: r.title,
      reason: r.body,
      detectedAt,
      ageHours,
      ageLabel: ageLabel(ageHours),
      status: caseStatusOf(r),
      owner: r.assignedTo ? { id: r.assignedTo, name: r.ownerName || r.ownerEmail || r.assignedTo } : null,
      acknowledgedBy: r.acknowledgedBy,
      recommendedAction: CASE_ACTION[type],
      href: r.href,
      financialImpact: amounts.get(r.entityId) ?? 0,
      recoverability: RECOVERABILITY[type],
      evidence: { source: EVIDENCE_SOURCE[r.entityType] ?? "Hệ thống ERP", detail: r.body },
      ignoredReason: r.ignoredReason ?? "",
      scoreParts,
      scoreExplanation: scoreExplanation(scoreParts),
      /*
        HẠN XỬ LÝ TÍNH TỪ LÚC ERP GIAO VIỆC (`created_at`), KHÔNG TỪ MỐC NGHIỆP VỤ (`occurred_at`).

        Đo trên production 10/09/2026: 237/237 "đơn mới chưa xử lý" và 203/203 "đã chốt chưa gửi"
        đều TRỄ HẠN — vì luật chỉ mở việc khi đơn đã quá 24 giờ (`pendingHours`) nhưng hạn 12 giờ lại
        đếm từ lúc LÊN ĐƠN. Việc vừa sinh ra đã trễ, nên cờ trễ hạn không còn phân biệt được gì và
        con số "trễ hạn" trên trang chủ / Điều hành là vô nghĩa.

        Tuổi việc (`ageHours`) vẫn đo từ mốc nghiệp vụ — đó là câu "đơn này đã nằm bao lâu". Hạn xử
        lý là câu khác: "từ lúc được giao, người ta có bao lâu". Không thể trễ một việc chưa được giao.
      */
      sla: slaFor(type, r.createdAt, new Date(now)),
    };
  });

  // MẶC ĐỊNH xếp theo tác động: người mở trang làm từ trên xuống là đúng thứ tự.
  const sort = options.filter?.sort ?? "impact";
  cases.sort((a, b) => {
    if (sort === "money" && a.financialImpact !== b.financialImpact) return b.financialImpact - a.financialImpact;
    if (sort === "age" && a.ageHours !== b.ageHours) return b.ageHours - a.ageHours;
    return b.score - a.score || b.ageHours - a.ageHours;
  });

  const totals: Record<CasePriority, number> = { URGENT: 0, HIGH: 0, NORMAL: 0, LOW: 0 };
  const byTypeMap = new Map<CaseType, number>();
  let unassigned = 0;
  let neglected = 0;
  let financialImpact = 0;
  let breached = 0;
  for (const c of cases) {
    totals[c.priority] += 1;
    byTypeMap.set(c.type, (byTypeMap.get(c.type) ?? 0) + 1);
    // Việc đã "Bỏ qua" có người quyết định rồi: không cộng tiền, không tính là đang trôi.
    if (c.status === "IGNORED") continue;
    financialImpact += c.financialImpact;
    if (c.sla?.breached) breached += 1;
    if (!c.owner) {
      unassigned += 1;
      if (c.ageHours > 72) neglected += 1;
    }
  }
  // Chia theo bộ phận. Việc "Bỏ qua có lý do" đã có người quyết nên không tính vào phần đang trôi.
  const teamStats = new Map<CaseTeam, { count: number; urgent: number; breached: number; unassigned: number; financialImpact: number }>();
  for (const c of cases) {
    if (c.status === "IGNORED" || c.status === "RESOLVED") continue;
    const cur = teamStats.get(c.team) ?? { count: 0, urgent: 0, breached: 0, unassigned: 0, financialImpact: 0 };
    cur.count += 1;
    if (c.priority === "URGENT") cur.urgent += 1;
    if (c.sla?.breached) cur.breached += 1;
    if (!c.owner) cur.unassigned += 1;
    cur.financialImpact += c.financialImpact;
    teamStats.set(c.team, cur);
  }
  const byTeam = TEAM_ORDER.filter((t) => teamStats.has(t)).map((team) => ({ team, label: TEAM_LABEL[team], ...teamStats.get(team)! }));

  const byType = [...byTypeMap.entries()]
    .map(([type, count]) => ({ type, label: CASE_TYPE_LABEL[type], count }))
    .sort((a, b) => b.count - a.count);

  // Bộ lọc chỉ cắt DANH SÁCH hiển thị; mọi con số tổng hợp ở trên vẫn nói về toàn bộ hàng đợi.
  const filter = options.filter;
  const visible = filter ? cases.filter((c) => matchesFilter(c, filter)) : cases;

  return {
    cases: visible,
    totals,
    byType,
    byTeam,
    unassigned,
    neglected,
    financialImpact,
    breached,
    matched: visible.length,
    total: Number(filteredTotal ?? cases.length),
    openTotal: Number(openTotal ?? cases.length),
    loaded: cases.length,
    page,
    pageSize: limit,
    hasMore: offset + cases.length < Number(filteredTotal ?? 0),
    /**
     * Tổng đếm trong CSDL CÓ phản ánh đúng bộ lọc đang xem hay không.
     *
     * `false` khi người dùng lọc theo mức ưu tiên / tiền treo / trễ hạn — ba thứ chỉ tính được sau
     * khi chấm điểm trong ứng dụng, nên phép đếm ở CSDL không biết tới chúng. Nói thẳng ra còn hơn
     * hiển thị một con số trông chính xác mà không phải.
     */
    exactTotal: !hasComputedFilter(options.filter),
  };
}

/**
 * ───────────── ĐỘI THỰC SỰ XỬ LÝ ĐƯỢC BAO NHIÊU VIỆC ─────────────
 *
 * Câu hỏi tưởng dễ mà trước đây ERP không trả lời được. Cột `resolved_at` gộp ba chuyện khác hẳn
 * nhau: người ngồi làm xong, điều kiện tự hết (đơn đi tiếp, tiền về, hàng về), và loại cảnh báo bị
 * tắt. Production 09/09/2026 có 3.896 việc đã đóng — lấy con số đó báo cáo năng suất là báo nhầm,
 * vì phần lớn có thể chẳng ai đụng vào.
 *
 * `chuaBiet` là các việc đóng TRƯỚC khi có cột nguồn gốc. Cố ý giữ riêng thay vì đoán: chưa biết thì
 * là chưa biết, không dồn vào bên nào để bảng trông đẹp.
 */
export type QueueThroughput = {
  /** Người bấm đóng — công của đội, đếm được. */
  byPeople: number;
  /** Điều kiện phát hiện không còn. Không ai làm gì cả. */
  automatic: number;
  /** Loại cảnh báo bị tắt nên thôi theo dõi. KHÔNG phải đã xử lý. */
  stale: number;
  /** Đóng trước khi có cột nguồn gốc — không quy được cho ai. */
  unknown: number;
  /** Bỏ qua có lý do. */
  ignored: number;
  /** Tỷ lệ việc đóng được là do người làm, trên phần ĐÃ BIẾT nguồn gốc. `null` khi chưa biết gì. */
  peopleShare: number | null;
};

export async function queueThroughput(from: Date | null, to: Date | null): Promise<QueueThroughput> {
  const db = await getDb();
  const window =
    from && to
      ? sql`${n.resolvedAt} between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz`
      : sql`${n.resolvedAt} is not null`;
  const [row] = await db
    .select({
      byPeople: sql<number>`count(*) filter (where ${n.resolution} = 'MANUAL')`,
      automatic: sql<number>`count(*) filter (where ${n.resolution} = 'AUTO')`,
      stale: sql<number>`count(*) filter (where ${n.resolution} = 'STALE')`,
      unknown: sql<number>`count(*) filter (where ${n.resolution} = 'UNKNOWN' or ${n.resolution} is null)`,
      ignored: sql<number>`count(*) filter (where ${n.ignoredAt} is not null)`,
    })
    .from(n)
    .where(window);

  const byPeople = Number(row?.byPeople ?? 0);
  const automatic = Number(row?.automatic ?? 0);
  const stale = Number(row?.stale ?? 0);
  const known = byPeople + automatic + stale;
  return {
    byPeople,
    automatic,
    stale,
    unknown: Number(row?.unknown ?? 0),
    ignored: Number(row?.ignored ?? 0),
    peopleShare: known > 0 ? Math.round((byPeople / known) * 1000) / 10 : null,
  };
}
