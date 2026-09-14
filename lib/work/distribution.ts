import type { DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, type WorkItem } from "@/lib/constants/work";
import { handlesSource, type StaffingConfig } from "@/lib/constants/workforce";
import type { CapacityRow } from "@/lib/queries/workforce";

/**
 * ═══════════ MÁY PHÂN VIỆC — VIỆC KHÓ NHẤT TỚI NGƯỜI HỢP NHẤT ═══════════
 *
 * Hàm ở đây THUẦN: nhận việc + người + cấu hình, trả về một BẢN KẾ HOẠCH. Không đọc CSDL, không
 * ghi gì. Ghi là việc của `lib/actions/workforce.ts`, và chỉ sau khi người bấm "Áp dụng".
 *
 * Tách như vậy để hai chuyện khác nhau không dính vào nhau: *"nên giao cho ai"* là một quyết định
 * kiểm chứng được bằng kiểm thử; *"ghi vào CSDL"* là một thao tác có hậu quả. Và nó cho phép màn
 * hình XEM TRƯỚC đúng thứ sẽ xảy ra — không ai bấm một nút phân 300 việc mà không nhìn trước.
 *
 * ─── HAI LẦN XẾP HẠNG, KHÔNG PHẢI MỘT ───
 *
 * 1. **Xếp việc**: quá hạn trước, rồi sắp vỡ hạn, rồi tiền, rồi điểm ưu tiên. Việc quan trọng nhất
 *    được chọn người TRƯỚC, lúc mọi người còn chỗ trống — nếu xếp ngược, việc gấp nhất sẽ rơi vào
 *    người cuối cùng còn chỗ, tức là người bận nhất.
 * 2. **Xếp người** cho từng việc: ai còn nhiều chỗ nhất, ai đang ít việc quá hạn nhất, ai khai
 *    đúng kỹ năng đó. Không xét "ai làm nhanh nhất" — đo được điều đó cần lịch sử đóng việc mà
 *    shop chưa có, và đoán thì sẽ thành một vòng lặp: người nhanh nhận nhiều nhất rồi chậm lại.
 *
 * ─── KHÔNG BAO GIỜ NHỒI QUÁ TRẦN ───
 *
 * Hết người còn chỗ thì việc còn lại **nằm nguyên ở hàng đợi phòng** và được đếm ở `unplaced` kèm
 * LÝ DO. Đó là tín hiệu thật (thiếu người / trần đặt thấp / cả phòng đang nghỉ), và nó phải đi
 * thẳng lên màn hình trưởng phòng chứ không bị giấu dưới một danh sách cá nhân không ai làm nổi.
 */

export type PlanAssignment = {
  key: string;
  title: string;
  source: string;
  userId: string;
  userName: string;
  /** Vì sao là người này. Hiện nguyên văn ở màn hình xem trước. */
  why: string;
  overdue: boolean;
  moneyAtRisk: number | null;
};

export type UnplacedReason = "NO_CANDIDATE" | "NO_CAPACITY" | "NO_SKILL" | "ALL_AWAY";

export const UNPLACED_LABEL: Record<UnplacedReason, string> = {
  NO_CANDIDATE: "Phòng chưa có ai",
  NO_CAPACITY: "Mọi người đã đầy trần",
  NO_SKILL: "Không ai khai nhận loại việc này",
  ALL_AWAY: "Cả phòng đang nghỉ",
};

export const UNPLACED_FIX: Record<UnplacedReason, string> = {
  NO_CANDIDATE: "Xếp người vào phòng ở Cấu hình → Nhân sự và phòng ban. Việc vẫn nằm ở hàng đợi phòng, không mất.",
  NO_CAPACITY: "Thiếu người thật, hoặc trần đặt quá thấp. Nâng trần ở Cấu hình → Sức chứa, hoặc thêm người.",
  NO_SKILL: "Ai đó đã khai kỹ năng hẹp hơn thực tế. Bỏ trống ô kỹ năng nghĩa là nhận mọi loại việc của phòng.",
  ALL_AWAY: "Mọi người trong phòng đang khai nghỉ. Sửa ngày nghỉ hoặc tự giao tay.",
};

export type PlanUnplaced = { key: string; title: string; source: string; reason: UnplacedReason; overdue: boolean };

export type DistributionPlan = {
  department: DepartmentCode;
  assignments: PlanAssignment[];
  unplaced: PlanUnplaced[];
  /** Ảnh chụp sức chứa SAU khi áp kế hoạch — để màn hình xem trước hiện được hậu quả. */
  after: { userId: string; name: string; before: number; added: number; after: number; limit: number }[];
  /** Số việc đã xét. `assignments.length + unplaced.length` luôn bằng số này. */
  considered: number;
};

/** Việc nào đáng giao trước. Trả số càng NHỎ càng ưu tiên. */
export function rankItem(item: WorkItem, now: Date): number {
  const sla = slaStateOf(item.slaAt ?? item.dueAt, now);
  const bac = sla === "BREACHED" ? 0 : item.priority === "URGENT" ? 1 : sla === "DUE_SOON" ? 2 : 3;
  /*
    Trong cùng một bậc: tiền nhiều hơn trước, rồi điểm ưu tiên cao hơn.

    TIỀN CHƯA BIẾT KHÔNG PHẢI 0 (AGENTS.md mục 0.3). Nó xếp SAU mọi khoản tiền đã tra được, nhưng
    TRƯỚC một khoản 0đ có thật: 0đ đã tra ra là một việc thật sự không giữ đồng nào, còn chưa tra
    được thì có thể là bất cứ số nào. Số 0,5 là mốc nằm giữa — tiền VND là số nguyên nên không
    khoản thật nào rơi vào đó.
  */
  const tien = item.money.atRisk ?? 0.5;
  return bac * 1_000_000_000 - tien * 10 - item.score;
}

/**
 * Chọn người cho MỘT việc. Trả `null` kèm lý do khi không ai nhận được.
 *
 * Thứ tự chọn: còn nhiều chỗ nhất → ít việc quá hạn nhất → tên (để kết quả ỔN ĐỊNH, chạy hai lần
 * ra cùng một kế hoạch; một máy phân việc cho kết quả khác nhau mỗi lần bấm là một máy không ai
 * dám dùng).
 */
export function pickAssignee(item: WorkItem, rows: CapacityRow[], cfg: StaffingConfig): { row: CapacityRow; why: string } | { reason: UnplacedReason } {
  if (!rows.length) return { reason: "NO_CANDIDATE" };
  const coMat = rows.filter((r) => !r.away);
  if (!coMat.length) return { reason: "ALL_AWAY" };
  const dungNghe = coMat.filter((r) => handlesSource(r.userId, item.sourceType, cfg));
  if (!dungNghe.length) return { reason: "NO_SKILL" };
  const conCho = dungNghe.filter((r) => r.free > 0);
  if (!conCho.length) return { reason: "NO_CAPACITY" };

  const chon = [...conCho].sort((a, b) => b.free - a.free || a.overdue - b.overdue || a.name.localeCompare(b.name, "vi"))[0];
  const khaiNghe = (cfg.skills[chon.userId] ?? []).length > 0;
  const why = `còn ${chon.free}/${chon.limit} chỗ${chon.overdue ? ` · đang có ${chon.overdue} việc quá hạn` : " · không việc nào quá hạn"}${khaiNghe ? " · khai nhận đúng loại việc này" : ""}`;
  return { row: chon, why };
}

/**
 * Dựng kế hoạch phân việc cho MỘT phòng.
 *
 * `items` phải là việc ĐANG MỞ và CHƯA AI NHẬN của phòng đó. Máy không bao giờ lấy việc khỏi tay
 * người đang cầm — giao lại là một hành động riêng, có người quyết (`reassignWork`).
 */
export function planDistribution(
  department: DepartmentCode,
  items: WorkItem[],
  capacity: CapacityRow[],
  cfg: StaffingConfig,
  now: Date,
  opts: { limit?: number } = {},
): DistributionPlan {
  const max = opts.limit ?? 200;
  const xet = [...items].sort((a, b) => rankItem(a, now) - rankItem(b, now)).slice(0, max);

  // Bản sao sức chứa: hàm này KHÔNG được sửa dữ liệu của người gọi.
  const con = new Map(capacity.map((r) => [r.userId, { ...r }]));
  const them = new Map<string, number>();

  const assignments: PlanAssignment[] = [];
  const unplaced: PlanUnplaced[] = [];

  for (const item of xet) {
    const rows = [...con.values()];
    const ket = pickAssignee(item, rows, cfg);
    const quaHan = slaStateOf(item.slaAt ?? item.dueAt, now) === "BREACHED";
    if ("reason" in ket) {
      unplaced.push({ key: item.key, title: item.title, source: item.sourceType, reason: ket.reason, overdue: quaHan });
      continue;
    }
    const r = con.get(ket.row.userId)!;
    // Chiếm chỗ NGAY trong bản sao: việc thứ hai phải thấy người này đã bớt một chỗ, nếu không cả
    // kế hoạch sẽ dồn mọi việc vào đúng một người (người đang rảnh nhất lúc bắt đầu).
    r.free -= 1;
    r.load += 1;
    them.set(r.userId, (them.get(r.userId) ?? 0) + 1);
    assignments.push({
      key: item.key,
      title: item.title,
      source: item.sourceType,
      userId: r.userId,
      userName: r.name,
      why: ket.why,
      overdue: quaHan,
      moneyAtRisk: item.money.atRisk,
    });
  }

  return {
    department,
    assignments,
    unplaced,
    after: capacity
      .filter((r) => (them.get(r.userId) ?? 0) > 0)
      .map((r) => ({ userId: r.userId, name: r.name, before: r.load, added: them.get(r.userId) ?? 0, after: r.load + (them.get(r.userId) ?? 0), limit: r.limit })),
    considered: xet.length,
  };
}

/** Gộp lý do không xếp được thành câu nói cho trưởng phòng. */
export function summarizeUnplaced(unplaced: PlanUnplaced[]): { reason: UnplacedReason; count: number; label: string; fix: string }[] {
  const theo = new Map<UnplacedReason, number>();
  for (const u of unplaced) theo.set(u.reason, (theo.get(u.reason) ?? 0) + 1);
  return [...theo.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count, label: UNPLACED_LABEL[reason], fix: UNPLACED_FIX[reason] }));
}
