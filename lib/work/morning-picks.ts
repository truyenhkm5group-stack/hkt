import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, WORK_PRIORITY_RANK, type WorkItem, type WorkPriority } from "@/lib/constants/work";
import { effectivePriority, escalationOf, sortByEscalation, type Escalation } from "@/lib/work/escalation";

/**
 * ═══════════ BA VIỆC ĐÁNG LÀM NHẤT SÁNG NAY — XẾP LIÊN PHÒNG ═══════════
 *
 * Trước 24/09/2026 mỗi phòng tự xếp hàng đợi của mình rất tốt, nhưng KHÔNG AI xếp giữa các phòng.
 * Trang chủ có "Việc cần làm hôm nay", nhưng nó đọc bảng `notifications` — tức là mù với care vận
 * đơn, dòng tiền chưa phân loại, quyết định quảng cáo, đơn nghi trùng, nút thắt kho và việc Tech,
 * vì sáu nguồn đó không bao giờ đi qua bảng cảnh báo. Chủ shop muốn biết sáng nay chạm vào đâu thì
 * phải mở bảy hàng đợi rồi tự so.
 *
 * Hàm này là HÀM THUẦN (không đọc/ghi CSDL): nhận đúng danh sách `collectWorkItems()` mà `/work`
 * đang hiện, trả về ba việc. Không có phép chấm điểm mới nào ở đây.
 *
 * ─── BA BƯỚC, VÀ VÌ SAO ĐÚNG BA ───
 *
 *  1. **Chỉ việc LÀM ĐƯỢC NGAY.** Bỏ việc đang chờ bên ngoài (`WAITING` — khách, ĐVVC, ngân hàng:
 *     không ai trong shop gỡ được) và việc người đã chủ động hoãn mà chưa vỡ hạn. Việc BỊ CHẶN thì
 *     GIỮ: chặn nội bộ chính là thứ chủ shop gỡ được mà người làm không gỡ được.
 *  2. **Mỗi phòng MỘT đầu việc**, lấy theo đúng thứ tự leo thang của màn hình trưởng phòng
 *     (`sortByEscalation`). Không lấy ba việc điểm cao nhất toàn shop: phòng nào sinh nhiều việc
 *     nhất (dòng tiền chưa phân loại có thể là hàng trăm dòng) sẽ chiếm cả ba ô, và danh sách
 *     thành "ba việc của phòng Kế toán" thay vì "ba chỗ đáng chạm vào".
 *  3. **Giữa các phòng: mức gấp trước, rồi TIỀN ĐANG TREO.** Cùng mức gấp thì khoản tiền lớn hơn
 *     đứng trước. Tiền CHƯA TRA ĐƯỢC không phải 0 (AGENTS.md mục 0.3) — nhưng cũng không so được,
 *     nên nó đứng sau các việc cùng mức CÓ số tiền, và dòng ấy phải nói ra rằng nó đứng đó vì chưa
 *     biết tiền, không phải vì ít tiền.
 *
 * Kết quả không ghi vào đâu cả và không giao việc cho ai. Nó là một đề nghị để người đọc — giao
 * việc vẫn là `reassignWork` do người bấm (AGENTS.md mục 25).
 */

export const MORNING_PICK_COUNT = 3;

/** Trạng thái được coi là "làm được ngay". `WAITING` cố ý vắng mặt. */
const ACTIONABLE = new Set<WorkItem["status"]>(["NEW", "ASSIGNED", "IN_PROGRESS", "BLOCKED"]);

export type MorningPick = {
  rank: number;
  item: WorkItem;
  department: DepartmentCode;
  departmentLabel: string;
  /** Mức ưu tiên ĐÃ LEO THANG — cùng mức mà màn hình trưởng phòng xếp theo. */
  priority: WorkPriority;
  escalation: Escalation | null;
  /** Tiền đang treo. `null` = CHƯA TRA ĐƯỢC, không phải 0. */
  moneyAtRisk: number | null;
  /** Số việc làm được ngay của phòng này (kể cả việc được chọn). */
  departmentActionable: number;
  /** `true` = đứng ở vị trí này vì chưa biết tiền, không phải vì ít tiền. */
  rankedWithoutMoney: boolean;
};

export type MorningPicks = {
  picks: MorningPick[];
  /** Số phòng đang có ít nhất một việc làm được ngay — mẫu số của "ba trên bao nhiêu phòng". */
  departmentsWithWork: number;
  /** Việc mở KHÔNG được xét, kèm lý do — không để chúng biến mất im lặng. */
  skipped: { waiting: number; snoozed: number };
};

function knownMoney(i: WorkItem): number | null {
  return i.money.confidence === "UNKNOWN" ? null : i.money.atRisk;
}

/**
 * Thứ tự giữa các ĐẦU VIỆC của các phòng. Xuất ra để kiểm thử khoá từng vế, không để gọi riêng.
 *
 * Vế cuối theo `key` để hai lần gọi trên cùng dữ liệu ra cùng thứ tự — một danh sách "ba việc" mà
 * đổi chỗ mỗi lần tải lại trang thì không ai tin nó.
 */
export function compareHeads(a: WorkItem, b: WorkItem, now: Date): number {
  const p = WORK_PRIORITY_RANK[effectivePriority(a, now)] - WORK_PRIORITY_RANK[effectivePriority(b, now)];
  if (p !== 0) return p;
  const ma = knownMoney(a);
  const mb = knownMoney(b);
  if (ma !== null && mb === null) return -1;
  if (ma === null && mb !== null) return 1;
  if (ma !== null && mb !== null && ma !== mb) return mb - ma;
  if (a.score !== b.score) return b.score - a.score;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function pickMorningWork(items: WorkItem[], now: Date, count = MORNING_PICK_COUNT): MorningPicks {
  const skipped = { waiting: 0, snoozed: 0 };
  const byDept = new Map<DepartmentCode, WorkItem[]>();

  for (const i of items) {
    if (i.status === "WAITING") {
      skipped.waiting += 1;
      continue;
    }
    if (!ACTIONABLE.has(i.status)) continue;
    // Cái hẹn hoãn che được việc chưa tới hạn, KHÔNG che được việc đã vỡ hạn — cùng luật với leo thang.
    const hoan = i.snoozedUntil !== null && i.snoozedUntil.getTime() > now.getTime();
    if (hoan && slaStateOf(i.slaAt ?? i.dueAt, now) !== "BREACHED") {
      skipped.snoozed += 1;
      continue;
    }
    byDept.set(i.department, [...(byDept.get(i.department) ?? []), i]);
  }

  const heads = [...byDept.entries()].map(([department, list]) => ({ department, head: sortByEscalation(list, now)[0], actionable: list.length }));
  heads.sort((x, y) => compareHeads(x.head, y.head, now));

  const chosen = heads.slice(0, Math.max(0, count));
  const picks: MorningPick[] = chosen.map((h, idx) => {
    const money = knownMoney(h.head);
    // "Vì chưa biết tiền" chỉ đúng khi CÓ một việc cùng mức gấp đứng sau nó mà có số tiền — nếu
    // không, việc này đứng đây vì mức gấp của nó, và nói "vì chưa biết tiền" là sai.
    const pr = effectivePriority(h.head, now);
    const coViecCungMucCoTien = heads.some((o) => o !== h && effectivePriority(o.head, now) === pr && knownMoney(o.head) !== null);
    return {
      rank: idx + 1,
      item: h.head,
      department: h.department,
      departmentLabel: DEPARTMENT_LABEL[h.department],
      priority: pr,
      escalation: escalationOf(h.head, now),
      moneyAtRisk: money,
      departmentActionable: h.actionable,
      rankedWithoutMoney: money === null && coViecCungMucCoTien,
    };
  });

  return { picks, departmentsWithWork: heads.length, skipped };
}
