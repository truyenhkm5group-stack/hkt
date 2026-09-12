/**
 * ═══════════ TÁC ĐỘNG CỦA MỘT THAY ĐỔI TỔ CHỨC — XEM TRƯỚC, KHÔNG TỰ LÀM ═══════════
 *
 * Luật của bản này: **đổi phòng ban KHÔNG BAO GIỜ tự giao lại việc hàng loạt.** Một lượt giao lại
 * tự động là hàng chục việc đổi chủ trong một nhịp mà không ai kịp nhìn; nếu nó sai thì không có
 * cách nào gỡ lại, vì trạng thái cũ đã bị ghi đè ở từng miền nguồn. Thay vào đó: nói trước ai
 * đang cầm bao nhiêu việc và bao nhiêu tiền, rồi để người bấm quyết định.
 *
 * ─── VÌ SAO KHÔNG ĐẾM BẰNG `work_items` ───
 *
 * Bản trước đếm `work_items` và ra một con số gần như luôn bằng 0 — đúng kỹ thuật, sai ý nghĩa.
 * `work_items` chỉ giữ việc TAY và việc ĐỊNH KỲ; việc thật (case CSKH, care vận đơn, cảnh báo,
 * dòng tiền chưa phân loại) nằm ở miền nguồn của nó và chỉ hiện ra qua phép chiếu. Một cảnh báo
 * "xem trước" báo 0 còn tệ hơn không có cảnh báo nào: nó nói với người bấm rằng gỡ người này ra
 * chẳng ảnh hưởng tới ai.
 *
 * Nên đếm bằng ĐÚNG phép chiếu mà hàng đợi của chính người đó dùng (`collectWorkItems` +
 * `isMine`). Hai con số bằng nhau vì chúng là một con số.
 */
import { sumMoney, type WorkItem } from "@/lib/constants/work";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { isMine } from "@/lib/queries/work";

export type LeavingImpact = {
  /** Tổng số việc đang mở mà người này đang cầm. */
  holding: number;
  /** Chia theo phòng ban của việc — để thấy việc nào sẽ mất chủ khi họ rời phòng nào. */
  byDepartment: { code: DepartmentCode; label: string; count: number }[];
  /** Trong số đó, bao nhiêu đã quá hạn. */
  overdue: number;
  money: ReturnType<typeof sumMoney>;
  /** Vài việc tiêu biểu để người bấm nhận ra ngay đây là loại việc gì. */
  sample: { title: string; department: string }[];
};

export async function impactOfLeaving(user: { id: string; name: string; email: string }, now = new Date()): Promise<LeavingImpact> {
  const { items } = await collectWorkItems({ now });
  const mine = items.filter((i) => isMine(i, user) && i.status !== "DONE" && i.status !== "CANCELLED");

  const dem = new Map<DepartmentCode, number>();
  for (const i of mine) dem.set(i.department, (dem.get(i.department) ?? 0) + 1);

  return {
    holding: mine.length,
    byDepartment: [...dem.entries()]
      .map(([code, count]) => ({ code, label: DEPARTMENT_LABEL[code] ?? code, count }))
      .sort((a, b) => b.count - a.count),
    overdue: mine.filter((i) => quaHan(i, now)).length,
    money: sumMoney(mine),
    sample: mine.slice(0, 5).map((i) => ({ title: i.title, department: DEPARTMENT_LABEL[i.department] ?? i.department })),
  };
}

function quaHan(i: WorkItem, now: Date) {
  const han = i.slaAt ?? i.dueAt;
  return han !== null && han.getTime() < now.getTime();
}
