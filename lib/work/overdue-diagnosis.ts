import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { holderKeyOf, slaStateOf, type WorkItem } from "@/lib/constants/work";
import type { StaffingConfig } from "@/lib/constants/workforce";
import type { CapacityRow } from "@/lib/queries/workforce";

/**
 * ═══════════ VÌ SAO PHÒNG NÀY QUÁ HẠN — BỐN NGUYÊN NHÂN, MỖI CÁI MỘT CÁCH SỬA ═══════════
 *
 * Trước 24/09/2026 màn hình sáng in MỘT con số "quá hạn" cho mỗi phòng. Cùng con số 30 ấy có thể
 * mang bốn nghĩa trái ngược nhau, và cách sửa của mỗi nghĩa làm HỎNG các nghĩa còn lại:
 *
 *  · `NO_CAPACITY`  — cả phòng hết chỗ theo trần: việc chưa ai cầm NHIỀU HƠN tổng chỗ trống của mọi
 *                     người đang có mặt. Giao thêm cho ai cũng vô ích — thiếu NGƯỜI (hoặc trần đang
 *                     khai thấp hơn sức thật). Đây là câu trả lời cho "phòng này thiếu người".
 *  · `UNCLAIMED`    — phòng CÒN chỗ, nhưng phần lớn việc quá hạn nằm ở hàng đợi chung, chưa ai cầm.
 *                     Tuyển thêm người không sửa được cái này; phân việc thì sửa được.
 *  · `CONCENTRATED` — việc quá hạn dồn ở tay MỘT người trong khi người khác trong phòng còn chỗ.
 *                     Sửa bằng chia lại.
 *  · `SPREAD`       — quá hạn rải ở nhiều người, phòng không thiếu chỗ: nhịp chung chậm hơn hạn.
 *                     Sửa ở HẠN (`work.sla`) hoặc ở quy trình của nguồn đẻ ra nhiều việc quá hạn.
 *
 * ─── HÀM NÀY KHÔNG KẾT LUẬN "NGƯỜI NÀY CHẬM" ───
 *
 * `CONCENTRATED` nói việc ĐANG NẰM Ở ĐÂU, không nói ai làm kém (AGENTS.md mục 39: không auto-label
 * "nhân viên yếu"). Một người ôm 12 việc quá hạn có thể là người duy nhất chịu nhận việc khó. ERP
 * không có dữ liệu để phân biệt hai điều đó, nên nó chỉ nói điều nó biết: việc đang dồn, và phòng
 * còn chỗ để chia.
 *
 * ─── TRẦN LÀ MỘT LỜI KHAI, KHÔNG PHẢI MỘT PHÉP ĐO ───
 *
 * "Hết chỗ" đo bằng trần việc (`lib/constants/workforce.ts`), và trần mặc định 20 là một con số
 * KHAI, chưa ai đo. Nên phòng chưa khai trần riêng mang cờ `ceilingIsDefault`, và màn hình phải
 * in kết luận `NO_CAPACITY` của phòng đó là ƯỚC TÍNH (AGENTS.md mục 8.6).
 *
 * Người ở NHIỀU phòng được tính chỗ trống ở MỖI phòng họ thuộc — đếm thừa sức chứa, tức là nghiêng
 * về phía KHÔNG kết luận "thiếu người". Đó là hướng sai an toàn: kết luận thiếu người dẫn tới tuyển
 * người, và tuyển nhầm đắt hơn chậm một tuần mới thấy.
 *
 * Hàm THUẦN: nhận việc đang mở và bảng sức chứa (`buildCapacity`), không đọc/ghi CSDL.
 */

export const OVERDUE_CAUSES = ["NO_STAFF", "NO_CAPACITY", "UNCLAIMED", "CONCENTRATED", "SPREAD", "TOO_FEW", "NONE"] as const;
export type OverdueCause = (typeof OVERDUE_CAUSES)[number];

export const OVERDUE_CAUSE_LABEL: Record<OverdueCause, string> = {
  NO_STAFF: "Không có ai làm",
  NO_CAPACITY: "Phòng hết chỗ",
  UNCLAIMED: "Còn chỗ, chưa ai nhận",
  CONCENTRATED: "Dồn ở một người",
  SPREAD: "Chậm đều cả phòng",
  TOO_FEW: "Chưa đủ mẫu",
  NONE: "Không quá hạn",
};

export const OVERDUE_CAUSE_ACTION: Record<OverdueCause, string> = {
  NO_STAFF: "Xếp người vào phòng (Công việc → Cấu hình → Nhân sự và phòng ban), hoặc chuyển loại việc sang phòng có người (Công việc → Cấu hình → Luật việc).",
  NO_CAPACITY:
    "Giao thêm cho người đang có không giải quyết được — cả phòng đã hết chỗ. Thêm người, bớt việc đổ vào phòng (xem nguồn nào sinh nhiều việc nhất), hoặc nâng trần nếu trần đang khai thấp hơn sức thật.",
  UNCLAIMED: "Phòng vẫn còn chỗ: phân việc (xem trước rồi mới áp) hoặc giao tay. Đây KHÔNG phải thiếu người — tuyển thêm không sửa được.",
  CONCENTRATED: "Chia lại việc đang dồn sang người còn chỗ. Đây là chuyện phân bổ, không phải kết luận về người đang cầm.",
  SPREAD: "Quá hạn rải ở nhiều người mà phòng không thiếu chỗ: nhịp chung chậm hơn hạn. Xem lại hạn xử lý của nguồn có nhiều việc quá hạn nhất, hoặc quy trình của nó.",
  TOO_FEW: "Quá ít việc quá hạn để nói nguyên nhân — đọc từng việc thay vì đọc kết luận.",
  NONE: "",
};

/** Dưới ngần này việc quá hạn thì không kết luận nguyên nhân: 2 việc quá hạn là 2 câu chuyện, không phải một xu hướng. */
export const OVERDUE_DIAGNOSIS_MIN = 3;

/** Một người cầm từ ngần này phần việc quá hạn ĐANG CÓ NGƯỜI CẦM trở lên thì là "dồn". */
export const OVERDUE_CONCENTRATION_SHARE = 0.6;

export type OverdueDiagnosis = {
  department: DepartmentCode;
  label: string;
  cause: OverdueCause;
  open: number;
  overdue: number;
  /** Việc quá hạn chưa ai cầm. */
  overdueUnclaimed: number;
  /** Việc đang mở chưa ai cầm (cả chưa quá hạn). */
  unclaimed: number;
  members: number;
  present: number;
  /** Tổng chỗ còn trống của người đang có mặt, theo trần. */
  freeSlots: number;
  /** `true` = trần của phòng là mặc định chưa ai khai ⇒ `NO_CAPACITY` chỉ là ước tính. */
  ceilingIsDefault: boolean;
  /** Người đang cầm nhiều việc quá hạn nhất của phòng — chỉ có khi `cause = CONCENTRATED`. */
  topHolder: { name: string; overdue: number; share: number } | null;
  /** Nguồn có nhiều việc quá hạn nhất — chỗ đầu tiên để xem khi `SPREAD` / `NO_CAPACITY`. */
  topSource: { source: string; overdue: number } | null;
};

function isOverdue(i: WorkItem, now: Date): boolean {
  return slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED";
}

export function diagnoseDepartment(department: DepartmentCode, items: WorkItem[], capacity: CapacityRow[], cfg: StaffingConfig, now: Date): OverdueDiagnosis {
  const open = items.filter((i) => i.department === department && i.status !== "DONE" && i.status !== "CANCELLED");
  const overdue = open.filter((i) => isOverdue(i, now));
  const members = capacity.filter((c) => c.departments.includes(department));
  const present = members.filter((c) => !c.away);
  const unclaimed = open.filter((i) => holderKeyOf(i) === null).length;
  const overdueUnclaimed = overdue.filter((i) => holderKeyOf(i) === null).length;
  const freeSlots = present.reduce((s, c) => s + c.free, 0);
  const ceilingIsDefault = cfg.departmentWip[department] === undefined && !present.some((c) => cfg.userWip[c.userId] !== undefined);

  const bySource = new Map<string, number>();
  for (const i of overdue) bySource.set(i.sourceType, (bySource.get(i.sourceType) ?? 0) + 1);
  const topSourceEntry = [...bySource.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];

  const base: OverdueDiagnosis = {
    department,
    label: DEPARTMENT_LABEL[department],
    cause: "NONE",
    open: open.length,
    overdue: overdue.length,
    overdueUnclaimed,
    unclaimed,
    members: members.length,
    present: present.length,
    freeSlots,
    ceilingIsDefault,
    topHolder: null,
    topSource: topSourceEntry ? { source: topSourceEntry[0], overdue: topSourceEntry[1] } : null,
  };

  if (overdue.length === 0) return base;
  // Không có ai làm là nguyên nhân mạnh nhất và KHÔNG cần mẫu lớn: một việc quá hạn trong phòng trống vẫn là phòng trống.
  if (present.length === 0) return { ...base, cause: "NO_STAFF" };
  if (overdue.length < OVERDUE_DIAGNOSIS_MIN) return { ...base, cause: "TOO_FEW" };
  if (unclaimed > freeSlots) return { ...base, cause: "NO_CAPACITY" };
  if (overdueUnclaimed * 2 >= overdue.length) return { ...base, cause: "UNCLAIMED" };

  const byHolder = new Map<string, { name: string; n: number }>();
  for (const i of overdue) {
    const k = holderKeyOf(i);
    if (!k) continue;
    const cur = byHolder.get(k) ?? { name: i.assignee?.name ?? k, n: 0 };
    cur.n += 1;
    byHolder.set(k, cur);
  }
  const held = overdue.length - overdueUnclaimed;
  const [topKey, top] = [...byHolder.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))[0] ?? [null, null];
  if (topKey && top && held > 0) {
    const share = top.n / held;
    // "Dồn" chỉ có nghĩa khi CÓ chỗ để chia: một người khác trong phòng, đang có mặt, còn chỗ trống.
    const conChoDeChia = present.some((c) => c.free > 0 && c.userId !== topKey && `name:${c.name.trim().toLowerCase()}` !== topKey);
    if (share >= OVERDUE_CONCENTRATION_SHARE && conChoDeChia) {
      return { ...base, cause: "CONCENTRATED", topHolder: { name: top.name, overdue: top.n, share } };
    }
  }
  return { ...base, cause: "SPREAD" };
}

/** Chẩn đoán cho mọi phòng đang có việc mở (hoặc chỉ một phòng khi `scope` có giá trị). Thứ tự: `DEPARTMENT_ORDER`. */
export function diagnoseOverdue(items: WorkItem[], capacity: CapacityRow[], cfg: StaffingConfig, now: Date, scope: DepartmentCode | null = null): OverdueDiagnosis[] {
  const depts = scope ? [scope] : DEPARTMENT_ORDER;
  return depts.map((d) => diagnoseDepartment(d, items, capacity, cfg, now)).filter((d) => d.open > 0);
}
