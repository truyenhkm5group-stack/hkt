import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, sumMoney, type WorkItem } from "@/lib/constants/work";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { isMine } from "@/lib/queries/work";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ THẺ ĐIỂM NHÂN SỰ — SÁU TRỤC, KHÔNG MỘT CON SỐ ═══════════
 *
 * Yêu cầu nghiệp vụ nói thẳng: *"KHÔNG làm một con số điểm nhân viên ngu ngốc dựa trên task
 * count."* Tệp này thực thi điều đó ở ba chỗ:
 *
 * ─── 1. SÁU TRỤC ĐỂ RIÊNG ───
 *
 * `outcome · quality · sla · productivity · okr · bsc`. Không hàm nào ở đây cộng chúng lại. Muốn
 * một con số tổng thì chủ shop phải TỰ KHAI TRỌNG SỐ (`combineScore`), và kết quả luôn đi kèm
 * `coverage` — bao nhiêu trục thật sự đo được.
 *
 * ─── 2. SỐ LƯỢNG KHÔNG PHẢI NĂNG SUẤT ───
 *
 * Trục `productivity` luôn mang theo `avgDifficulty` (điểm ưu tiên trung bình) và `avgMoney`.
 * Mười ca khó không được đọc thấp hơn một trăm ca tầm thường, nên giao diện BẮT BUỘC hiện hai con
 * số đó cạnh số việc — `WorkerScorecard` không có trường "số việc" đứng một mình.
 *
 * ─── 3. KHÔNG TRỪ ĐIỂM VÌ THỨ NGƯỜI TA KHÔNG QUYẾT ĐƯỢC ───
 *
 * Trục `outcome` chỉ tính trên việc có `WORK_SOURCE_SPEC[...].outcomeAttributable === true`.
 * Care vận đơn nằm ngoài: bưu tá giao được hay không là chuyện của ĐVVC, người care chịu trách
 * nhiệm về việc HỌ LÀM (gọi kịp, ghi nhận, gửi yêu cầu) — và cái đó đo ở trục `sla`.
 */

export type ScoreAxis = {
  /** `null` = CHƯA ĐO ĐƯỢC. Không bao giờ thay bằng 0. */
  value: number | null;
  /** Mẫu số: con số trên đứng trên bao nhiêu quan sát. */
  sample: number;
  note: string;
};

export type WorkerScorecard = {
  key: string;
  userId: string | null;
  name: string;
  departments: DepartmentCode[];

  /** Việc đã đóng trong kỳ mà kết quả THUỘC TRÁCH NHIỆM của người này (0–100). */
  outcome: ScoreAxis;
  /** Chất lượng: việc đóng rồi phải mở lại / bị chặn nhiều lần (0–100, cao là tốt). */
  quality: ScoreAxis;
  /** Tỷ lệ việc CÓ HẠN đóng đúng hạn (0–100). */
  sla: ScoreAxis;
  /** Việc đã đóng trong kỳ — LUÔN đọc cùng `avgDifficulty` và `avgMoney`. */
  productivity: { closed: number; avgDifficulty: number | null; avgMoney: number | null; note: string };
  /** Tiến độ OKR cá nhân (0–100). `null` khi người này chưa có KR nào đo được. */
  okr: ScoreAxis;

  /** Ảnh chụp hiện tại, không phải của kỳ: việc đang cầm. */
  openNow: number;
  overdueNow: number;
  blockedNow: number;
  moneyNow: ReturnType<typeof sumMoney>;
};

export type PerformanceQuery = { from: Date; to: Date; department?: DepartmentCode | null };

/**
 * Đóng việc trong kỳ, đọc từ `work_item_events` — nhật ký CHỈ THÊM.
 *
 * Vì sao không đọc `work_items.completed_at`: dòng chiếu KHÔNG có `completed_at` (trạng thái nằm ở
 * nguồn), nên đọc cột đó chỉ thấy việc tay. Nhật ký sự kiện thì ghi mọi lần đóng ở cả hai loại, và
 * nó không bị viết lại — đúng thứ một thước đo hiệu suất cần.
 */
async function closedEventsInPeriod(q: PerformanceQuery) {
  const db = await getDb();
  const e = schema.workItemEvents;
  return db
    .select({ workKey: e.workKey, actorId: e.actorId, actorEmail: e.actorEmail, actorName: e.actorName, action: e.action, nextStatus: e.nextStatus, createdAt: e.createdAt })
    .from(e)
    .where(and(gte(e.createdAt, q.from), lte(e.createdAt, q.to), inArray(e.action, ["STATUS", "BLOCK", "NOTE", "ASSIGN", "CREATE"])));
}

export async function getPerformance(q: PerformanceQuery): Promise<WorkerScorecard[]> {
  const db = await getDb();
  const now = new Date();
  /*
    `closedSince: q.from` — thẻ điểm cần CẢ việc đang cầm lẫn việc đã đóng trong kỳ. Không có cửa sổ
    này thì `itemByKey` chỉ chứa việc đang mở, và mọi con số về độ khó / tiền / đúng hạn của việc ĐÃ
    ĐÓNG sẽ rỗng — tức là đúng phần quan trọng nhất của một thước đo hiệu suất.
  */
  const [{ items }, events, users, memberships] = await Promise.all([
    collectWorkItems({ now, closedSince: q.from }),
    closedEventsInPeriod(q),
    db.query.users.findMany({ columns: { id: true, name: true, email: true, active: true } }),
    db
      .select({ userId: schema.departmentMembers.userId, code: schema.departments.code })
      .from(schema.departmentMembers)
      .innerJoin(schema.departments, sql`${schema.departments.id} = ${schema.departmentMembers.departmentId}`)
      .where(sql`${schema.departmentMembers.active}`),
  ]);

  const deptOf = new Map<string, DepartmentCode[]>();
  for (const m of memberships) deptOf.set(m.userId, [...(deptOf.get(m.userId) ?? []), m.code as DepartmentCode]);

  const okrByUser = await individualOkrProgress();

  const closed = events.filter((e) => e.nextStatus === "DONE");
  const reopened = events.filter((e) => e.action === "STATUS" && e.nextStatus === "IN_PROGRESS");
  const blockedEvents = events.filter((e) => e.action === "BLOCK");

  const itemByKey = new Map(items.map((i) => [i.key, i]));

  const people = users.filter((u) => u.active && (!q.department || (deptOf.get(u.id) ?? []).includes(q.department)));

  return people
    .map((u) => {
      const me = { id: u.id, name: u.name, email: u.email };
      const myClosed = closed.filter((e) => e.actorId === u.id || e.actorEmail.toLowerCase() === u.email.toLowerCase());
      const myOpen = items.filter((i) => isMine(i, me) && i.status !== "DONE" && i.status !== "CANCELLED");

      /*
        TRỤC KẾT QUẢ. Chỉ đếm việc mà nguồn của nó khai `outcomeAttributable`. Với những việc đó,
        "đóng được" chính là kết quả — người xử lý đã đưa sự việc tới đích.
      */
      const attributable = myClosed.filter((e) => {
        const src = e.workKey.slice(0, e.workKey.indexOf(":")) as WorkSource;
        return WORK_SOURCE_SPEC[src]?.outcomeAttributable ?? false;
      });
      const notAttributable = myClosed.length - attributable.length;

      /*
        TRỤC CHẤT LƯỢNG. Việc đóng rồi mở lại là dấu hiệu làm chưa tới. Mẫu số là việc đã đóng —
        không có việc nào đóng thì KHÔNG có tỷ lệ nào để nói (`null`, không phải 100).
      */
      const myReopened = reopened.filter((e) => myClosed.some((c) => c.workKey === e.workKey && e.createdAt > c.createdAt)).length;

      /*
        TRỤC SLA. Mẫu số là việc CÓ ĐẶT HẠN mà người này đã đóng. Việc không đặt hạn rơi khỏi cả
        tử lẫn mẫu — gộp vào thì tỷ lệ đúng hạn được thổi lên bằng chính những việc không ai đo.
      */
      const closedWithSla = myClosed.map((e) => itemByKey.get(e.workKey)).filter((i): i is WorkItem => Boolean(i) && (i!.slaAt ?? i!.dueAt) !== null);
      const onTime = closedWithSla.filter((i) => {
        const due = i.slaAt ?? i.dueAt;
        return due !== null && due.getTime() >= (myClosed.find((e) => e.workKey === i.key)?.createdAt.getTime() ?? 0);
      }).length;

      const difficulties = myClosed.map((e) => itemByKey.get(e.workKey)?.score).filter((s): s is number => typeof s === "number");
      const monies = myClosed.map((e) => itemByKey.get(e.workKey)?.money.atRisk).filter((m): m is number => typeof m === "number");

      const myBlocked = blockedEvents.filter((e) => e.actorId === u.id).length;

      return {
        key: u.id,
        userId: u.id,
        name: u.name,
        departments: deptOf.get(u.id) ?? [],
        outcome: {
          value: myClosed.length ? Math.round((attributable.length / myClosed.length) * 100) : null,
          sample: myClosed.length,
          note: notAttributable ? `${notAttributable} việc có kết quả do bên ngoài quyết (ĐVVC, ngân hàng) — KHÔNG tính vào trục này` : "",
        },
        quality: {
          value: myClosed.length ? Math.round(((myClosed.length - myReopened) / myClosed.length) * 100) : null,
          sample: myClosed.length,
          note: myReopened ? `${myReopened} việc phải mở lại sau khi đóng` : "",
        },
        sla: {
          value: closedWithSla.length ? Math.round((onTime / closedWithSla.length) * 100) : null,
          sample: closedWithSla.length,
          note: closedWithSla.length < myClosed.length ? `${myClosed.length - closedWithSla.length} việc không đặt hạn, không vào mẫu số` : "",
        },
        productivity: {
          closed: myClosed.length,
          avgDifficulty: difficulties.length ? Math.round(difficulties.reduce((a, b) => a + b, 0) / difficulties.length) : null,
          avgMoney: monies.length ? Math.round(monies.reduce((a, b) => a + b, 0) / monies.length) : null,
          note: myBlocked ? `${myBlocked} lần báo bị chặn` : "",
        },
        okr: okrByUser.get(u.id) ?? { value: null, sample: 0, note: "Chưa có Key Result cá nhân nào đo được" },
        openNow: myOpen.length,
        overdueNow: myOpen.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length,
        blockedNow: myOpen.filter((i) => i.status === "BLOCKED").length,
        moneyNow: sumMoney(myOpen),
      } satisfies WorkerScorecard;
    })
    // Người không có việc nào đang cầm và không đóng việc nào trong kỳ thì không có gì để nói.
    .filter((s) => s.openNow > 0 || s.productivity.closed > 0 || s.okr.value !== null)
    .sort((a, b) => b.overdueNow - a.overdueNow || b.openNow - a.openNow);
}

/** Tiến độ OKR cá nhân, gộp theo người. Chỉ tính KR ĐO ĐƯỢC. */
async function individualOkrProgress(): Promise<Map<string, ScoreAxis>> {
  const db = await getDb();
  const rows = rowsOf<{ owner: string; n: number; avg: number }>(
    await db.execute(sql`
      select o.owner_user_id as owner, count(*)::int as n,
             avg(case when k.baseline is not null and k.target <> k.baseline
                      then greatest(0, (k.current - k.baseline) / (k.target - k.baseline) * 100)
                      when k.target <> 0 and k.direction = 'UP'   then greatest(0, k.current / k.target * 100)
                      when k.target <> 0 and k.direction = 'DOWN' and k.current <> 0 then greatest(0, k.target / k.current * 100)
                      else null end) as avg
      from okr_key_results k
      join okr_objectives o on o.id = k.objective_id
      where o.level = 'INDIVIDUAL' and o.owner_user_id is not null and o.status = 'ACTIVE' and k.current is not null
      group by o.owner_user_id
    `),
  );
  return new Map(rows.map((r) => [r.owner, { value: r.avg === null ? null : Math.round(Number(r.avg)), sample: Number(r.n), note: "" }]));
}

/**
 * Gộp các trục thành MỘT số — chỉ khi chủ sở hữu tự khai trọng số.
 *
 * Không có mặc định, cố ý: một bộ trọng số mặc định sẽ được dùng như thể nó có căn cứ, và ba tháng
 * sau nó thành "điểm nhân viên" mà không ai nhớ ai chọn các con số đó.
 *
 * `coverage` là phần trọng số thật sự đo được. Gộp 2/5 trục rồi gọi nó là điểm tổng thì con số đó
 * nói về 40% sự thật — người đọc phải nhìn thấy điều đó cạnh con số.
 */
export function combineScore(card: WorkerScorecard, weights: Partial<Record<"outcome" | "quality" | "sla" | "okr", number>>): { score: number | null; coverage: number } {
  const axes: [keyof typeof weights, number | null][] = [
    ["outcome", card.outcome.value],
    ["quality", card.quality.value],
    ["sla", card.sla.value],
    ["okr", card.okr.value],
  ];
  let total = 0;
  let scored = 0;
  let sum = 0;
  for (const [k, v] of axes) {
    const w = weights[k] ?? 0;
    if (w <= 0) continue;
    total += w;
    if (v === null) continue;
    scored += w;
    sum += v * w;
  }
  if (!total) return { score: null, coverage: 0 };
  return { score: scored ? Math.round(sum / scored) : null, coverage: scored / total };
}
