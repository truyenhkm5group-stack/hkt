import { CS_ACTIONABLE_STATUSES, CS_CASE_SLA_HOURS, humanAssignee } from "@/lib/constants/cs-domain";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { CS_QUICK_ACTION, type CsQuickActionKey } from "@/lib/constants/cs-actions";

/**
 * ═══════════ HẠN XỬ LÝ · ĐỘ ƯU TIÊN · VIỆC NÊN LÀM TIẾP — MỘT NƠI DUY NHẤT ═══════════
 *
 * Ba phép tính này trước đây nằm rải trong giao diện: bảng CSKH tự tính "quá hạn" bằng một phép
 * trừ giờ, hàng đợi theo khách xếp theo "khách nhiều việc nhất", và không màn hình nào nói được
 * *nên làm gì tiếp*. Ba nơi tính, ba câu trả lời — và cái lệch chỉ lộ ra khi có người ngồi so hai
 * màn hình, tức là không bao giờ.
 *
 * ─── TỆP NÀY THUẦN, VÀ NẰM Ở `lib/constants` CÓ LÝ DO ───
 *
 * Bảng CSKH là Client Component nên KHÔNG được import `lib/queries/*` (AGENTS.md mục 2). Đặt luật
 * ở đây thì máy chủ (xếp thứ tự, đếm chip) và trình duyệt (tô màu, in nhãn) chạy CÙNG một hàm.
 * Không hàm nào trong tệp đọc `Date.now()` ngầm — giờ luôn truyền vào, nên kiểm thử đóng được
 * đồng hồ và hai lượt chạy không bao giờ khác nhau.
 *
 * ─── KHÔNG CẦN AI ĐỂ QUYẾT MỘT LUẬT RÕ RÀNG ───
 *
 * "Việc nên làm tiếp" là một bảng tra xác định: loại case nào đang mở, khách có đang chờ không,
 * đã tới hạn hẹn chưa. Gọi một mô hình để trả lời câu đó là thêm một nguồn không giải thích được
 * vào giữa người trực và cái nút họ sắp bấm.
 */

/* ══════════════════════ HẠN XỬ LÝ ══════════════════════ */

export const CS_SLA_BUCKETS = ["OVERDUE", "DUE_TODAY", "DUE_SOON", "NOT_DUE"] as const;
export type CsSlaBucket = (typeof CS_SLA_BUCKETS)[number];

/** Ngưỡng "sắp đến hạn": còn dưới 1/4 quỹ thời gian của một case. Đi theo `CS_CASE_SLA_HOURS`, không phải một số thứ hai phải nhớ sửa. */
export const CS_DUE_SOON_HOURS = Math.max(1, Math.round(CS_CASE_SLA_HOURS / 4));

export const CS_SLA_BUCKET_LABEL: Record<CsSlaBucket, string> = {
  OVERDUE: "Quá hạn",
  DUE_TODAY: "Đến hạn hôm nay",
  DUE_SOON: "Sắp đến hạn",
  NOT_DUE: "Chưa đến hạn",
};

export const CS_SLA_BUCKET_HINT: Record<CsSlaBucket, string> = {
  OVERDUE: "Đã qua hạn xử lý hoặc đã qua giờ hẹn khách. Làm trước hết.",
  DUE_TODAY: "Hạn rơi vào trong ngày hôm nay.",
  DUE_SOON: `Hạn còn dưới ${CS_DUE_SOON_HOURS} giờ — chưa vỡ, nhưng làm ngay thì còn kịp.`,
  NOT_DUE: "Còn thời gian.",
};

/**
 * MÀU CHIP HẠN — CHỈ MÀU CHỮ, KHÔNG NỀN ĐẶC.
 *
 * Dòng CSKH đã có một dải nền đặc nói về TRẠNG THÁI case. Chip hạn nói về một hạng mục khác (thời
 * gian), nên nó không được trông giống cái nhãn kia — cùng luật đã chốt cho bàn care ở
 * `lib/care/filters.ts::CARE_SLA_BUCKET_TONE`, và `tests/cs-ui-contrast.test.ts` khoá lại.
 */
export const CS_SLA_BUCKET_TONE: Record<CsSlaBucket, string> = {
  OVERDUE: "text-rose-700 dark:text-rose-300",
  DUE_TODAY: "text-orange-700 dark:text-orange-300",
  DUE_SOON: "text-amber-700 dark:text-amber-300",
  NOT_DUE: "text-muted-foreground",
};

/** Dữ liệu tối thiểu của một case để tính hạn / ưu tiên. Cố ý hẹp: bảng nào cũng dựng được. */
export type CsCaseLike = {
  kind: string;
  status: string;
  createdAt: Date;
  followUpAt: Date | null;
  assignee: string;
};

/**
 * HẠN CỦA MỘT CASE.
 *
 * Có hẹn khách thì HẠN LÀ CÁI HẸN — một case đã hẹn "gọi lại chiều mai" không quá hạn chỉ vì nó
 * được tạo từ ba hôm trước; ngược lại, tới giờ hẹn mà chưa gọi thì nó quá hạn ngay, dù case còn
 * mới. Không có hẹn thì hạn là `created_at + CS_CASE_SLA_HOURS`.
 *
 * Case đã đóng KHÔNG có hạn (`null`) — "chưa biết" chứ không phải "chưa đến hạn". Tô một case đã
 * xong là quá hạn thì người xem học cách bỏ qua màu.
 */
export function csDueAt(c: CsCaseLike): Date | null {
  if (!(CS_ACTIONABLE_STATUSES as readonly string[]).includes(c.status)) return null;
  if (c.followUpAt) return c.followUpAt;
  return new Date(c.createdAt.getTime() + CS_CASE_SLA_HOURS * 3_600_000);
}

export function csSlaBucket(dueAt: Date | null, now: Date): CsSlaBucket {
  if (!dueAt) return "NOT_DUE";
  const conLai = dueAt.getTime() - now.getTime();
  if (conLai <= 0) return "OVERDUE";
  if (conLai <= CS_DUE_SOON_HOURS * 3_600_000) return "DUE_SOON";
  // "Hôm nay" theo NGÀY LỊCH của người dùng, không theo 24 giờ tới: một hạn lúc 23h tối nay và một
  // hạn lúc 1h sáng mai cách nhau hai tiếng nhưng là hai ngày làm việc khác nhau.
  return sameCalendarDay(dueAt, now) ? "DUE_TODAY" : "NOT_DUE";
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * NHÃN HẠN VIẾT CHO NGƯỜI ĐỌC: "Quá hạn 2 ngày", "Còn 3 giờ".
 *
 * Bản cũ in "3 ngày trước" cho TUỔI của case và để người đọc tự suy ra còn hạn hay không. Tuổi và
 * hạn là hai thứ khác nhau: một case ba ngày tuổi đã hẹn tuần sau thì hoàn toàn đúng tiến độ.
 */
export function csSlaLabel(dueAt: Date | null, now: Date): string {
  if (!dueAt) return "—";
  const ms = dueAt.getTime() - now.getTime();
  const qua = ms <= 0;
  const phut = Math.floor(Math.abs(ms) / 60_000);
  const gio = Math.floor(phut / 60);
  const ngay = Math.floor(gio / 24);
  const luong = ngay >= 1 ? `${ngay} ngày` : gio >= 1 ? `${gio} giờ` : `${Math.max(1, phut)} phút`;
  return qua ? `Quá hạn ${luong}` : `Còn ${luong}`;
}

/* ══════════════════════ ĐỘ ƯU TIÊN ══════════════════════ */

/**
 * MỨC NGHIÊM TRỌNG THEO LOẠI CASE — thang 0–100, chỉ để XẾP THỨ TỰ.
 *
 * Không phải một chỉ số kinh doanh, không vào thẻ điểm ai, và cố ý không có "trọng số tiền": một
 * khiếu nại chất lượng của đơn 200K vẫn phải được gọi trước một case tư vấn size của đơn 2 triệu,
 * vì cái thứ nhất đang mất khách còn cái thứ hai thì chưa.
 */
export const CS_KIND_SEVERITY: Record<CsKind, number> = {
  COMPLAINT: 90,
  WRONG_PRICE: 80,
  RETURN: 75,
  EXCHANGE_SIZE: 70,
  EXCHANGE_COLOR: 70,
  URGE_DELIVERY: 65,
  ORDER_NOT_CREATED: 60,
  WRONG_ADDRESS: 55,
  WRONG_PHONE: 55,
  PHONE_VERIFY: 40,
  SIZE_ADVICE: 35,
  OTHER: 20,
  // Case giao vận không thuộc hàng đợi CSKH (`lib/constants/cs-domain.ts`); để 0 để nếu nó lọt vào
  // một danh sách nào đó thì nó nằm cuối chứ không chen lên đầu.
  DELIVERY_FAILED: 0,
};

/**
 * LOẠI CASE MÀ KHÁCH ĐANG CHỜ CÂU TRẢ LỜI.
 *
 * Khác với "case đang mở": một case sai địa chỉ là việc nội bộ phải sửa trước khi gửi, khách không
 * ngồi chờ ai gọi. Còn khiếu nại, giục giao, đổi mẫu thì có một con người đang chờ ở đầu kia — và
 * đó là lý do chúng nhảy lên trước trong hàng đợi.
 */
export const CS_CUSTOMER_WAITING_KINDS: readonly CsKind[] = ["COMPLAINT", "URGE_DELIVERY", "EXCHANGE_SIZE", "EXCHANGE_COLOR", "RETURN", "WRONG_PRICE", "SIZE_ADVICE"];

/**
 * ═══ QUÁ HẠN LÀ BỘI SỐ CỦA MỨC NGHIÊM TRỌNG, KHÔNG PHẢI MỘT KHOẢN CỘNG CỐ ĐỊNH ═══
 *
 * Bản đầu cộng thẳng +100 cho mọi case quá hạn. Hệ quả đo được ngay trên fixture: một case TƯ VẤN
 * SIZE quá hạn hai mươi ngày (35 + 100) xếp trên một KHIẾU NẠI mới mở (90). Đó đúng là cái bẫy
 * "cũ nhất trước" mà khối chú thích bên dưới cảnh báo, chỉ đi vào bằng cờ quá hạn thay vì bằng
 * tuổi — và nó tệ hơn, vì nó trông có lý.
 *
 * Nên phần thưởng của hạn TỶ LỆ với mức nghiêm trọng: quá hạn KHUẾCH ĐẠI vị trí của một việc
 * trong hạng của nó, chứ không nhấc nó vượt hạng. Một khiếu nại quá hạn vẫn đứng trên một khiếu
 * nại mới; một tư vấn size quá hạn vẫn đứng dưới một khiếu nại mới.
 */
const HE_SO_HAN: Record<CsSlaBucket, number> = { OVERDUE: 0.6, DUE_TODAY: 0.3, DUE_SOON: 0.15, NOT_DUE: 0 };

/** Điểm ưu tiên của MỘT case. Số càng lớn càng phải làm trước. */
export function csCasePriority(c: CsCaseLike, now: Date): number {
  const severity = CS_KIND_SEVERITY[c.kind as CsKind] ?? 20;
  const hanBonus = severity * HE_SO_HAN[csSlaBucket(csDueAt(c), now)];
  const dangCho = CS_CUSTOMER_WAITING_KINDS.includes(c.kind as CsKind) ? 30 : 0;
  // Chưa ai nhận thì nhích lên: một việc không có tên người là việc dễ bị bỏ quên nhất trong hàng đợi.
  const chuaAiNhan = humanAssignee(c.assignee) ? 0 : 15;
  // Tuổi chỉ là phần PHÁ HOÀ, tối đa 20 điểm: để nó lớn hơn thì hàng đợi lại thành "cũ nhất trước"
  // và mọi việc gấp mới sinh sẽ nằm dưới một khối tồn đọng không ai đụng tới.
  const tuoiNgay = Math.max(0, (now.getTime() - c.createdAt.getTime()) / 86_400_000);
  return Math.round(severity + hanBonus + dangCho + chuaAiNhan + Math.min(20, Math.round(tuoiNgay)));
}

/* ══════════════════════ VIỆC NÊN LÀM TIẾP ══════════════════════ */

export const CS_NEXT_ACTIONS = [
  "COMPLAINT_CRITICAL",
  "EXCHANGE_RETURN_URGENT",
  "CUSTOMER_WAITING",
  "ORDER_CREATION_BLOCKED",
  "FOLLOW_UP_DUE",
  "GENERAL_FOLLOW_UP",
  "NOTHING",
] as const;
export type CsNextActionKey = (typeof CS_NEXT_ACTIONS)[number];

export type CsNextAction = {
  key: CsNextActionKey;
  /** Câu VIỆC PHẢI LÀM, viết cho người sắp bấm nút — không phải mô tả trạng thái. */
  label: string;
  /** Nút nên bấm. `null` khi việc nằm ngoài ERP (chỉ còn chờ). */
  cta: CsQuickActionKey | null;
  /** Case cụ thể mà lời khuyên này nói tới — để nút mở đúng chỗ. */
  caseId: string | null;
  /** Vì sao lại là việc này. Không có câu này thì không ai tin cái nhãn. */
  reason: string;
};

/** Case dùng cho phép chọn việc tiếp theo — thêm `id` so với `CsCaseLike`. */
export type CsCaseForAction = CsCaseLike & { id: string };

/**
 * ═══════════ VIỆC NÊN LÀM TIẾP CHO MỘT KHÁCH ═══════════
 *
 * Luật XÁC ĐỊNH, xếp theo thứ tự dưới. Case đầu tiên khớp thang cao nhất là câu trả lời — và khi
 * hai case cùng thang thì lấy case có điểm ưu tiên lớn hơn, rồi tới case cũ hơn. Chạy hai lần ra
 * cùng một kết quả, kể cả khi danh sách vào theo thứ tự khác.
 *
 * ─── KHÔNG SINH CASE MỚI ĐỂ HIỆN LỜI KHUYÊN ───
 *
 * Hàm này chỉ ĐỌC. Một dòng gợi ý biến thành một dòng `cs_cases` là hàng đợi tự nhân đôi: người ta
 * đóng cái gợi ý và tưởng đã xử lý việc thật.
 */
export function getCustomerNextAction(cases: CsCaseForAction[], now: Date): CsNextAction {
  const mo = cases.filter((c) => (CS_ACTIONABLE_STATUSES as readonly string[]).includes(c.status));
  if (!mo.length) return { key: "NOTHING", label: "Không còn việc nào đang mở", cta: null, caseId: null, reason: "Mọi case của khách này đã đóng." };

  const xep = [...mo].sort((a, b) => csCasePriority(b, now) - csCasePriority(a, now) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const dau = (pred: (c: CsCaseForAction) => boolean) => xep.find(pred) ?? null;
  const nhan = (c: CsCaseForAction) => CS_KIND_LABEL[c.kind as CsKind] ?? c.kind;

  // 1. Khiếu nại chất lượng — mất khách nhanh nhất, và mỗi giờ trôi qua càng khó cứu.
  const khieuNai = dau((c) => c.kind === "COMPLAINT");
  if (khieuNai) {
    return { key: "COMPLAINT_CRITICAL", label: "Gọi khách xử lý khiếu nại", cta: "CHAT", caseId: khieuNai.id, reason: `${nhan(khieuNai)} · ${csSlaLabel(csDueAt(khieuNai), now)}` };
  }

  // 2. Đổi / trả đã quá hạn — khách đã quyết định, chỉ còn chờ shop thao tác.
  const doiTra = dau((c) => ["EXCHANGE_SIZE", "EXCHANGE_COLOR", "RETURN"].includes(c.kind) && csSlaBucket(csDueAt(c), now) === "OVERDUE");
  if (doiTra) {
    return { key: "EXCHANGE_RETURN_URGENT", label: "Chốt đổi / trả cho khách", cta: "OPEN_ORDER", caseId: doiTra.id, reason: `${nhan(doiTra)} · ${csSlaLabel(csDueAt(doiTra), now)}` };
  }

  // 3. Khách đang chờ câu trả lời.
  const dangCho = dau((c) => CS_CUSTOMER_WAITING_KINDS.includes(c.kind as CsKind));
  if (dangCho) {
    return { key: "CUSTOMER_WAITING", label: "Trả lời khách đang chờ", cta: "CHAT", caseId: dangCho.id, reason: `${nhan(dangCho)} · ${csSlaLabel(csDueAt(dangCho), now)}` };
  }

  // 4. Đủ thông tin mà chưa lên đơn — đây là chỗ MẤT ĐƠN, không phải chỗ chăm sóc.
  const chuaLenDon = dau((c) => c.kind === "ORDER_NOT_CREATED");
  if (chuaLenDon) {
    return { key: "ORDER_CREATION_BLOCKED", label: "Lên đơn trên Pancake", cta: "OPEN_POS", caseId: chuaLenDon.id, reason: `${nhan(chuaLenDon)} · ${csSlaLabel(csDueAt(chuaLenDon), now)}` };
  }

  // 5. Đã hẹn và tới giờ.
  const toiHen = dau((c) => Boolean(c.followUpAt && c.followUpAt.getTime() <= now.getTime()));
  if (toiHen) {
    return { key: "FOLLOW_UP_DUE", label: "Tới giờ hẹn — quay lại khách", cta: "CONTACTED", caseId: toiHen.id, reason: `${nhan(toiHen)} · ${csSlaLabel(csDueAt(toiHen), now)}` };
  }

  const con = xep[0];
  return { key: "GENERAL_FOLLOW_UP", label: `Xử lý: ${nhan(con)}`, cta: CS_QUICK_ACTION.CONTACTED.key, caseId: con.id, reason: csSlaLabel(csDueAt(con), now) };
}

/**
 * ═══ BẤM HÀNG LOẠT: CHỈ NHỮNG VIỆC CÓ NGHĨA GIỐNG NHAU TRÊN MỌI LOẠI CASE ═══
 *
 * "Nhận việc", "gán người", "hẹn lại" có cùng một nghĩa dù case là khiếu nại hay đổi size: chúng
 * nói về AI LÀM và LÀM LÚC NÀO, không nói case đã xong.
 *
 * "Đã xử lý" thì KHÔNG. Đóng một lượt 40 case thuộc bảy loại khác nhau là khẳng định bảy việc khác
 * nhau đều đã hoàn tất — không ai kiểm được câu đó, và nó xoá luôn hàng đợi thật. Muốn đóng thì
 * đóng từng case, ở đúng dòng của nó.
 */
export const CS_BULK_ACTIONS: readonly CsQuickActionKey[] = ["CLAIM", "SNOOZE"];

export function isBulkSafe(action: CsQuickActionKey): boolean {
  return CS_BULK_ACTIONS.includes(action);
}
