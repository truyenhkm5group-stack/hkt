import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, WORK_PRIORITY_RANK, type WorkItem, type WorkPriority } from "@/lib/constants/work";
import {
  ESCALATION_LABEL,
  ESCALATION_LEAD_HOURS,
  ESCALATION_WARN_HOURS,
  escalationOn,
  type EscalationLevel,
  type StaffingConfig,
} from "@/lib/constants/workforce";

/**
 * ═══════════ LEO THANG SLA — TÍNH LÚC ĐỌC, KHÔNG GHI VÀO ĐÂU ═══════════
 *
 * ─── VÌ SAO KHÔNG CÓ JOB GHI MỨC ƯU TIÊN VÀO CSDL ───
 *
 * Cách hiển nhiên là chạy một job mỗi 15 phút, quét việc vỡ hạn rồi `update work_items set
 * priority='URGENT'`. Cách đó hỏng theo ba hướng cùng lúc, và đo được trên chính production này:
 *
 *  1. **Nó biến lớp ghi chú thành bản sao.** Hôm nay có 442 cảnh báo đang mở và 45 ca care; phần
 *     lớn đã vỡ hạn. Job đó sẽ tạo vài trăm dòng `work_items` chỉ để ghi một chữ "URGENT" —
 *     đúng thứ mà luật "PHÉP CHIẾU, KHÔNG PHẢI BẢN SAO" (AGENTS.md mục 19) cấm.
 *  2. **Nó luôn trễ.** Một việc vỡ hạn lúc 9h02 chỉ được nâng lúc 9h15. Giữa hai mốc đó, màn hình
 *     nói sai.
 *  3. **Nó ghi đè quyết định của người.** Trưởng phòng hạ một việc xuống "Thấp" vì đã gọi khách
 *     và khách hẹn tuần sau; 15 phút sau job kéo nó lại lên "Gấp".
 *
 * Mức leo thang là một HÀM CỦA THỜI GIAN và cái hạn. Tính nó lúc đọc thì luôn đúng tới từng giây,
 * không tốn một dòng CSDL nào, và không đụng vào bất cứ thứ gì người dùng đã đặt tay.
 *
 * ─── VẬY PHẦN "TỰ BÁO" NẰM Ở ĐÂU ───
 *
 * Ở `escalationDigest()`: MỘT tin nhắn cho mỗi phòng mỗi lượt chạy, liệt kê việc đã vỡ hạn lâu mà
 * vẫn chưa ai cầm. Không tạo một dòng `notifications` cho mỗi việc — làm thế thì một việc quá hạn
 * sẽ đẻ ra một cảnh báo, mà cảnh báo lại là một việc, và hàng đợi tự nhân bản chính nó.
 */

export type Escalation = {
  level: EscalationLevel;
  label: string;
  /** Mức ưu tiên HIỂN THỊ sau khi leo thang. Không ghi xuống CSDL. */
  priority: WorkPriority;
  /** Số giờ đã quá hạn (dương) hoặc còn lại (âm). */
  hours: number;
};

/**
 * Mức leo thang của một việc, hoặc `null` khi không có gì phải leo.
 *
 * Việc ĐÃ ĐÓNG, đang HOÃN trong hạn hẹn, hoặc KHÔNG ĐẶT HẠN thì không bao giờ leo thang: hai cái
 * đầu là đã có người xử lý, cái thứ ba là loại việc cố ý không đo bằng hạn (`SLA_STATES.NONE`).
 */
export function escalationOf(item: WorkItem, now: Date): Escalation | null {
  if (item.status === "DONE" || item.status === "CANCELLED") return null;
  const due = item.slaAt ?? item.dueAt;
  if (!due) return null;

  const snoozed = item.snoozedUntil !== null && item.snoozedUntil.getTime() > now.getTime();
  const gio = (now.getTime() - due.getTime()) / 3_600_000;
  const state = slaStateOf(due, now);

  if (state === "BREACHED") {
    // Vỡ hạn lâu mà VẪN CHƯA AI CẦM không còn là việc chậm — là việc không ai làm.
    if (gio >= ESCALATION_LEAD_HOURS && !item.assignee) {
      return { level: "STALE", label: ESCALATION_LABEL.STALE, priority: "URGENT", hours: gio };
    }
    return { level: "BREACH", label: ESCALATION_LABEL.BREACH, priority: "URGENT", hours: gio };
  }
  // Cái hẹn hoãn che được cảnh báo "sắp tới hạn", nhưng KHÔNG che được hạn đã vỡ (nhánh trên).
  if (state === "DUE_SOON" && !snoozed && -gio <= ESCALATION_WARN_HOURS) {
    return { level: "WARN", label: ESCALATION_LABEL.WARN, priority: "HIGH", hours: gio };
  }
  return null;
}

/**
 * Mức ưu tiên để XẾP THỨ TỰ ĐỌC: cao hơn giữa mức người đặt và mức leo thang.
 *
 * CHỈ NÂNG, KHÔNG BAO GIỜ HẠ. Một việc chủ shop đã đánh "Gấp" vì lý do ngoài hệ thống (khách VIP,
 * đơn của người quen) phải giữ nguyên là Gấp kể cả khi hạn còn xa.
 */
export function effectivePriority(item: WorkItem, now: Date): WorkPriority {
  const e = escalationOf(item, now);
  if (!e) return item.priority;
  return WORK_PRIORITY_RANK[e.priority] < WORK_PRIORITY_RANK[item.priority] ? e.priority : item.priority;
}

/** Xếp hàng đợi theo mức ưu tiên ĐÃ LEO THANG. Dùng ở màn hình sáng của trưởng phòng. */
export function sortByEscalation(items: WorkItem[], now: Date): WorkItem[] {
  return [...items].sort((a, b) => {
    const p = WORK_PRIORITY_RANK[effectivePriority(a, now)] - WORK_PRIORITY_RANK[effectivePriority(b, now)];
    if (p !== 0) return p;
    const da = (a.slaAt ?? a.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
    const db = (b.slaAt ?? b.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return b.score - a.score;
  });
}

export type EscalationCount = { department: DepartmentCode; label: string; warn: number; breach: number; stale: number; staleItems: WorkItem[] };

/** Đếm theo phòng, và giữ lại danh sách việc mức `STALE` để đưa vào tin nhắn / màn hình. */
export function countEscalations(items: WorkItem[], now: Date, cfg: StaffingConfig): EscalationCount[] {
  const theo = new Map<DepartmentCode, EscalationCount>();
  for (const i of items) {
    if (!escalationOn(i.department, cfg)) continue;
    const e = escalationOf(i, now);
    if (!e) continue;
    const cur = theo.get(i.department) ?? { department: i.department, label: DEPARTMENT_LABEL[i.department], warn: 0, breach: 0, stale: 0, staleItems: [] };
    if (e.level === "WARN") cur.warn += 1;
    else if (e.level === "BREACH") cur.breach += 1;
    else {
      cur.stale += 1;
      cur.staleItems.push(i);
    }
    theo.set(i.department, cur);
  }
  return [...theo.values()].sort((a, b) => b.stale - a.stale || b.breach - a.breach);
}

/**
 * Nội dung tin nhắn cho một phòng, hoặc `null` khi phòng đó không có gì đáng báo.
 *
 * NGƯỠNG BÁO LÀ `STALE`, không phải `BREACH`. Phòng nào cũng có việc vỡ hạn mỗi ngày; báo hết thì
 * tin nhắn trở thành tiếng ồn và người ta tắt thông báo — rồi lần thật sự cần báo cũng không ai
 * đọc. Chỉ báo việc đã vỡ hạn hơn một ngày mà VẪN chưa có ai cầm.
 */
export function escalationDigest(c: EscalationCount, appUrl: string): { title: string; lines: { text: string; href?: string }[][] } | null {
  if (c.stale === 0) return null;
  const top = c.staleItems.slice(0, 8);
  return {
    title: `⏰ ${c.label}: ${c.stale} việc vỡ hạn hơn ${ESCALATION_LEAD_HOURS} giờ mà chưa ai nhận`,
    lines: [
      [{ text: `Quá hạn: ${c.breach} · sắp vỡ hạn: ${c.warn} · chưa ai cầm quá ${ESCALATION_LEAD_HOURS} giờ: ${c.stale}` }],
      ...top.map((i) => [{ text: `• ${i.title}` }]),
      ...(c.stale > top.length ? [[{ text: `…và ${c.stale - top.length} việc nữa` }]] : []),
      [{ text: "Mở hàng đợi phòng", href: `${appUrl}/work/today?dept=${c.department}` }],
    ],
  };
}
