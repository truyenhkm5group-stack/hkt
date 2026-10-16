import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, type SlaState } from "@/lib/constants/work";
import { vnShortStamp } from "@/lib/format";
import type { HumanHandling, NeedsHumanCode } from "@/lib/sales-chatbot/inbox-states";
import { foldVi } from "@/lib/sales-chatbot/text";

/**
 * ═══════════ AI IM THÌ PHẢI CÓ CHỦ — PHẦN THUẦN (P0 11/10/2026, yêu cầu 9) ═══════════
 *
 * Chủ shop: «Tin mới của khách: AI chuyển người nhưng KHÔNG AI NHẬN». Trước bản này «chuyển người» chỉ là `status = 'HANDOFF'`:
 * không vào hàng đợi phòng nào, không có mốc để tính hạn, và tin báo chống trùng bằng khoá VĨNH VIỄN theo hội thoại. Tệp này khai
 * BẤT BIẾN kiểm được: mọi hội thoại AI không trả lời đều có CHỦ — một NGƯỜI (đang cầm) hoặc HÀNG ĐỢI PHÒNG có ít nhất một người xem
 * được hộp thư. Thiếu cả hai là «chuyển người không chủ» và được ĐẾM (`countUnownedHandoffs`), không giấu.
 *
 * Tệp THUẦN, an toàn cho trình duyệt (không `getDb`). Đường ghi ở `handoff-routing.ts`.
 */

/** Khoá nguồn việc (`WORK_SOURCES`) — cùng khoá ở `work.sla` / `work.ownership`. */
export const HANDOFF_QUEUE_SOURCE = "SALES_CHAT_HANDOFF" as const;

/**
 * Phần `set` mọi đường TRẢ HỘI THOẠI CHO AI phải trải vào (cùng câu ghi `status = 'OPEN'`): rời hàng đợi người ⇒ hết hạn, hết mốc báo.
 * Dấu cũ còn lại sẽ thành mốc (và khoá chống trùng) của đợt chờ người SAU — lượt quét `sales-health` dọn đường nào quên.
 */
export const HANDOFF_QUEUE_CLEAR = { handoffQueuedAt: null, handoffAlertedAt: null } as const;

/**
 * «AI không trả lời và đang chờ NGƯỜI» — tập hội thoại phải có chủ. Bốn trường hợp, đọc từ phân loại của hộp thư (`classifyInboxState`,
 * inbox-states.ts — một nguồn với thẻ «Cần người» / «Người đang xử lý»):
 *  · AI xin người / công cụ chuyển người (`AI_HANDOFF`) · AI hỏng trong khoảng chờ thử lại (`AI_DOWN`);
 *  · nhân viên bấm «Tiếp quản» (`MANUAL_TAKEOVER`) — AI im cho tới khi trả lại;
 *  · chat web chờ nhân viên trả lại (`webStaffHold`) — không tự hết hạn.
 * KHÔNG gồm AI nhường tạm sau câu tay của nhân viên (tự hết hạn, người vừa trả lời đang cầm) và chế độ AI gợi ý (lựa chọn vận hành
 * của shop, AI vẫn soạn). HÀM THUẦN — bản SQL là `aiSilentSql` (handoff-routing.ts), bài kiểm so hai bản trên cùng dữ liệu.
 *
 * KHÔNG phải máy trạng thái chủ trả lời: đó là việc của `response-ownership.ts` (AI_ACTIVE · HUMAN_ACTIVE · TEMPORARY_AI_PAUSE ·
 * HANDOFF_PENDING · RESOLVED — worker khác, cùng đợt P0). Vị từ này SẼ HỢP NHẤT với máy đó khi tích hợp: tập «phải có chủ» =
 * HANDOFF_PENDING ∪ HUMAN_ACTIVE (tiếp quản / chat web chờ trả lại), không gồm TEMPORARY_AI_PAUSE.
 */
export function isAiSilent(s: { needsHuman: NeedsHumanCode | null; humanHandling: HumanHandling | null }, webStaffHold: boolean): boolean {
  return s.needsHuman === "AI_HANDOFF" || s.needsHuman === "AI_DOWN" || s.humanHandling === "MANUAL_TAKEOVER" || webStaffHold;
}

export const HANDOFF_UNOWNED_REASONS = ["NOT_QUEUED", "NO_RESPONDER"] as const;
export type HandoffUnownedReason = (typeof HANDOFF_UNOWNED_REASONS)[number];

export const HANDOFF_UNOWNED_LABEL: Record<HandoffUnownedReason, string> = {
  NOT_QUEUED: "Chưa vào hàng đợi người nào",
  NO_RESPONDER: "Cả tổ chức chưa có ai xem được hộp thư",
};

/** Việc phải làm để hết «không chủ» — một câu, đủ cụ thể để sửa được. */
export const HANDOFF_UNOWNED_FIX: Record<HandoffUnownedReason, string> = {
  NOT_QUEUED: "Lượt quét «Giám sát AI bán hàng» (5 phút) tự đưa vào hàng đợi; còn thấy sau 10 phút là đường chuyển người mới chưa nối — báo kỹ thuật.",
  NO_RESPONDER: "Cấp quyền xem hộp thư AI bán hàng (ai_sales:view) cho ít nhất một tài khoản đang hoạt động, rồi xếp người đó vào phòng phụ trách (Cấu hình → Nhân sự và phòng ban).",
};

/**
 * `SHARED` = HÀNG ĐỢI CHUNG (HOTFIX P0 12/10/2026): phòng phụ trách CHƯA có ai xem được hộp thư, nhưng tổ chức CÓ người xem được ⇒ hội
 * thoại thuộc hàng đợi chung của mọi người xem hộp thư (đúng tập người đã nhận tin báo `ALL_VIEWERS`), không phải «KHÔNG CHỦ». Đo
 * production 11/10: 248 hội thoại HSLC treo «KHÔNG CHỦ» chỉ vì phòng «Kinh doanh & CSKH» chưa có thành viên — trong khi chủ shop vẫn
 * xem được hộp thư. Cấu hình phòng thiếu người vẫn là lỗi phải sửa: lượt quét báo quản trị MỘT tin mỗi phòng mỗi ngày (luật 26).
 */
export type HandoffOwner =
  | { kind: "PERSON"; userId: string }
  | { kind: "DEPARTMENT"; department: DepartmentCode; responders: number }
  | { kind: "SHARED"; department: DepartmentCode; viewers: number }
  | { kind: "NONE"; department: DepartmentCode; reason: HandoffUnownedReason };

export type HandoffOwnerInput = {
  /** `isAiSilent` của hội thoại. */
  silent: boolean;
  assigneeUserId: string | null;
  /** Tài khoản đang cầm còn hoạt động — người đã khoá không trả lời được ai. */
  assigneeActive: boolean;
  queuedAt: Date | null;
  /** Phòng của hàng đợi (`departmentFor(SALES_CHAT_HANDOFF, …)` — đọc `work.ownership`). */
  department: DepartmentCode;
  /** Số người của phòng ĐANG hoạt động và xem được hộp thư (`ai_sales:view`). */
  responders: number;
  /** Số người ĐANG hoạt động xem được hộp thư của CẢ tổ chức — hàng đợi chung khi phòng chưa có ai. Vắng = 0 (hành vi cũ). */
  viewers?: number;
};

/**
 * Chủ của MỘT hội thoại, hoặc `null` khi AI đang trả lời (không áp dụng). Thứ tự: người đang cầm → hàng đợi phòng có người → KHÔNG
 * CHỦ kèm lý do. Hàng đợi phòng KHÔNG người là không chủ: một cái tên phòng trên màn hình không trả lời được khách. HÀM THUẦN.
 */
export function handoffOwnerOf(i: HandoffOwnerInput): HandoffOwner | null {
  if (!i.silent) return null;
  if (i.assigneeUserId && i.assigneeActive) return { kind: "PERSON", userId: i.assigneeUserId };
  if (!i.queuedAt) return { kind: "NONE", department: i.department, reason: "NOT_QUEUED" };
  if (i.responders <= 0) return (i.viewers ?? 0) > 0 ? { kind: "SHARED", department: i.department, viewers: i.viewers ?? 0 } : { kind: "NONE", department: i.department, reason: "NO_RESPONDER" };
  return { kind: "DEPARTMENT", department: i.department, responders: i.responders };
}

/**
 * Hàng hiển thị trên hộp thư: «chờ X phút · phụ trách: … · hạn: …». Máy chủ tính (hạn theo `work.sla`), trình duyệt chỉ in.
 * `waitingFrom` = mốc khách bắt đầu chờ NGƯỜI: lúc vào hàng đợi nếu chưa có câu nhân viên nào sau đó; đã có ⇒ tin khách chưa ai trả lời
 * (nếu có); `null` = nhân viên đã trả lời, khách chưa nhắn thêm.
 */
export type HandoffQueueView = {
  queuedAt: string;
  waitingFrom: string | null;
  ownerKind: HandoffOwner["kind"];
  ownerLabel: string;
  unowned: HandoffUnownedReason | null;
  dueAt: string | null;
  slaState: SlaState;
};

export type HandoffViewInput = {
  owner: HandoffOwner;
  queuedAt: Date;
  assigneeName: string | null;
  lastStaffAt: Date | null;
  /** Mốc tin khách đang chờ trả lời (`WAITING_REPLY`) — `null` = không chờ. */
  waitingSince: Date | null;
  dueAt: Date | null;
};

export function handoffQueueView(i: HandoffViewInput, now: Date): HandoffQueueView {
  const repliedSinceQueue = i.lastStaffAt !== null && i.lastStaffAt.getTime() >= i.queuedAt.getTime();
  const waitingFrom = !repliedSinceQueue ? i.queuedAt : i.waitingSince;
  const ownerLabel =
    i.owner.kind === "PERSON"
      ? (i.assigneeName ?? "Người đã nhận")
      : i.owner.kind === "DEPARTMENT"
        ? `Phòng ${DEPARTMENT_LABEL[i.owner.department]} (chưa ai nhận)`
        : i.owner.kind === "SHARED"
          ? `Hàng đợi chung (phòng ${DEPARTMENT_LABEL[i.owner.department]} chưa có người) — chưa ai nhận`
          : `KHÔNG CHỦ — ${HANDOFF_UNOWNED_LABEL[i.owner.reason]}`;
  return {
    queuedAt: i.queuedAt.toISOString(),
    waitingFrom: waitingFrom ? waitingFrom.toISOString() : null,
    ownerKind: i.owner.kind,
    ownerLabel,
    unowned: i.owner.kind === "NONE" ? i.owner.reason : null,
    dueAt: i.dueAt ? i.dueAt.toISOString() : null,
    slaState: slaStateOf(i.dueAt, now),
  };
}

/** Một dòng chữ cho hàng / đầu khung chat. `nowMs` = đồng hồ trình duyệt (cập nhật mỗi phút). HÀM THUẦN. */
export function handoffQueueLine(v: HandoffQueueView, nowMs: number): string {
  const parts: string[] = [];
  if (v.waitingFrom) parts.push(`Chờ ${Math.max(0, Math.floor((nowMs - Date.parse(v.waitingFrom)) / 60_000))} phút`);
  else parts.push("Đã trả lời");
  parts.push(`Phụ trách: ${v.ownerLabel}`);
  if (v.dueAt) {
    const late = Math.floor((nowMs - Date.parse(v.dueAt)) / 60_000);
    parts.push(`Hạn: ${vnShortStamp(v.dueAt)}${late > 0 ? ` (quá ${late} phút)` : ""}`);
  } else parts.push("Không đặt hạn");
  return parts.join(" · ");
}

/** Khoá chống trùng của tin «chatbot chuyển khách» — MỘT tin mỗi ĐỢT chờ người (khoá cũ vĩnh viễn theo hội thoại là gốc lỗi). */
export function handoffEpisodeKey(conversationId: string, queuedAt: Date): string {
  return `sales-chat:handoff:${conversationId}:${queuedAt.toISOString()}`;
}

/**
 * Khoá của tin «khách nhắn thêm khi đang chờ người»: MỘT tin mỗi đợt mỗi CHU KỲ trả lời — nhân viên trả lời từ ERP thì chu kỳ mới, tin
 * khách sau đó báo lại MỘT lần. Khách nhắn 5 tin liền ⇒ 1 thông báo, không phải 5.
 */
export function handoffFollowupKey(conversationId: string, queuedAt: Date, lastStaffAt: Date | null): string {
  return `sales-chat:handoff-msg:${conversationId}:${queuedAt.toISOString()}:${lastStaffAt && lastStaffAt.getTime() >= queuedAt.getTime() ? lastStaffAt.toISOString() : "0"}`;
}

// ─────────────────────────── KHÁCH ĐÒI NGƯỜI / PHẢN ĐỐI LẶP (P0 #855) ───────────────────────────

/**
 * Lý do chuyển người do CHỮ KHÁCH (P0 #855, ca «ThuyNgo» 16/10/2026: khách phủ nhận món bot tự thêm bốn lần rồi hỏi «Robot hả» — bot gửi
 * thêm 2–3 câu xin lỗi / hỏi lại). Hai chuỗi này CỐ Ý không thuộc tập lý do tự hết hạn (`STAFF_COOLDOWN_REASONS` · AI hỏng —
 * `ai-hold-shared.ts`) ⇒ `aiHoldOf` đọc là CHỜ NGƯỜI, không cooldown nào trả hội thoại về AI; chỉ người bấm «Trả lại cho AI». Câu mở đầu
 * khớp nhóm thống kê có sẵn của `classifyHandoffReason` (events-shared.ts): «gặp người» ⇒ CUSTOMER_REQUEST · «Không xác định được sản
 * phẩm» ⇒ PRODUCT_UNCLEAR. Bài kiểm khoá cả hai.
 */
export const CUSTOMER_HANDOFF_REASON = {
  WANTS_HUMAN: "Khách muốn gặp người thật (hỏi có phải máy / đòi nhân viên)",
  REPEATED_OBJECTION: "Không xác định được sản phẩm — khách phản đối món bot nhập sai từ 2 lần, cần người kiểm lại đơn",
  /** Khách phủ nhận ĐÚNG một món bot / shop đã đưa vào giỏ / báo giá / đơn nháp («kg có order chả cá thu») — chủ shop: dừng ngay từ lần đầu. */
  DENIED_BOT_ITEM: "Không xác định được sản phẩm — khách phủ nhận món bot đưa vào đơn, không tự chốt, cần người gọi lại khách",
} as const;
export type CustomerHandoffCode = keyof typeof CUSTOMER_HANDOFF_REASON;

/** Số lần phản đối món (tính cả tin hiện tại) từ đó máy chủ chuyển người thay vì để AI xin lỗi thêm. */
export const OBJECTION_HANDOFF_AT = 2;

/** Người mà khách đòi gặp: nhân viên / người thật / admin / chủ shop / quản lý — KHÔNG «người» trần («người nhận», «người nhà»). */
const HUMAN_WHO = "(?:nhan vien|nguoi that|admin|chu shop|quan ly|tu van vien)";
/** Đuôi hỏi «có phải máy không» — chữ CÓ DẤU; KHÔNG gồm «không / ko / k» («có bán robot không», «có máy không» là hỏi hàng). */
const ASK_PARTICLE = "(?:hả|à|hở|hử|ha|ah|ak|sao|vậy|thế|đấy|đó|hông)";
const ASK_FILL = "(?:em|e|shop|chị|c|anh|a|ạ|vậy|v|nè|đấy|đó|thế)";

/**
 * Khách hỏi có phải MÁY không, hoặc đòi gặp NGƯỜI. Đọc trên chữ CÓ DẤU (bỏ dấu thì «mày», «may» cũng thành «may»; «à» ≠ «a»):
 *  · «robot / bot / chatbot / máy / trả lời tự động» đứng CUỐI câu, theo sau là ÍT NHẤT một trợ từ hỏi («Robot hả», «máy à», «bot hả em»),
 *    hoặc đi sau «là / nói chuyện với / đang nói chuyện với» («em là robot à», «đang nói chuyện với máy hả»);
 *  · «gặp / gọi / nói chuyện với / chuyển cho / cho chị gặp» + nhân viên · người thật · admin · chủ shop · quản lý.
 * «không gặp người nhận thì gửi bảo vệ», «em chuyển cho người nhà chị», «có ảnh người thật mặc không», «có bán robot không em» KHÔNG phải.
 * HÀM THUẦN.
 */
export function customerDemandsHuman(text: string): boolean {
  const raw = text.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const f = foldVi(raw);
  if (!f) return false;
  if (new RegExp(`(?:^| )(?:gap|goi|noi chuyen voi|noi chuyen truc tiep voi|chuyen (?:cho|qua|sang)|xin gap|muon gap|can gap)(?: (?:chi|anh|em|minh|toi|c|a|e))?(?: (?:gap|voi))? ${HUMAN_WHO}(?: |$)`).test(f)) return true;
  const machine = "(?:robot|ro bot|bot|chatbot|máy|trả lời tự động|tự động)";
  if (new RegExp(`(?:^|\\s)${machine}(?:\\s+${ASK_FILL})*\\s+${ASK_PARTICLE}(?:\\s+${ASK_FILL})*$`, "u").test(raw)) return true;
  if (new RegExp(`(?:^|\\s)(?:là|nói chuyện với|đang nói chuyện với|chat với)\\s+${machine}(?:\\s+(?:${ASK_PARTICLE}|${ASK_FILL}))*$`, "u").test(raw)) return true;
  return false;
}

/**
 * Bộ đếm phản đối món của LƯỢT MUA hiện tại, lưu trong trạng thái hội thoại (`state.objectionTally`). Phản đối đã nói ra thì món ấy thường đã
 * bị bỏ khỏi giỏ, nên không thể đếm lại về sau bằng cách đọc lịch sử theo tên món — phải đếm ĐÚNG LÚC tin tới. Reset khi: sang lượt mua
 * khác (`cycle`), có mốc «trả lại cho AI» (`ai.resumed`) mới hơn lần phản đối gần nhất, hoặc đã chuyển người vì phản đối. HÀM THUẦN.
 */
export type ObjectionTally = { n: number; at: string; cycle: number };
export function nextObjectionTally(prev: ObjectionTally | undefined, i: { objectionNow: boolean; cycle: number; now: Date; resumedAt: Date | null }): ObjectionTally | undefined {
  const fresh = prev && prev.cycle === i.cycle && !(i.resumedAt && Date.parse(prev.at) <= i.resumedAt.getTime()) ? prev : undefined;
  if (!i.objectionNow) return fresh;
  return { n: (fresh?.n ?? 0) + 1, at: i.now.toISOString(), cycle: i.cycle };
}

/**
 * Quyết định chuyển người theo CHỮ KHÁCH, trước lượt AI. `objections` = số lần phản đối của lượt mua hiện tại GỒM tin này
 * (`nextObjectionTally`); `objectionNow` = tin này là phản đối (`itemObjectionCue`) — chỉ chuyển ĐÚNG lúc khách phản đối lần nữa. `onCustomerRequest`
 * = công tắc của chủ shop «chuyển khi khách muốn gặp người» (`cfg.handoff.onCustomerRequest`): tắt ⇒ vế đòi người không chạy (phản đối lặp
 * vẫn chuyển — đó là bot đọc sai, không phải yêu cầu của khách). `null` = AI trả lời tiếp. HÀM THUẦN.
 */
/**
 * `deniedBotItem` (P0 #855, quyết định 16/10/2026) = tin này phủ nhận ĐÚNG một món bot / shop đã đưa ra (`botProposedDenial`, cart-commitment.ts)
 * ⇒ chuyển người ngay LẦN ĐẦU: đơn đang mâu thuẫn với lời khách, máy không được tự chốt nó. «Không đặt thêm gì nữa», «không đặt cọc» không
 * phải (câu không phủ nhận món nào). Vắng ⇒ như cũ.
 */
export function customerHandoffVerdict(i: { text: string; objections: number; objectionNow: boolean; onCustomerRequest?: boolean; deniedBotItem?: boolean }): { code: CustomerHandoffCode; reason: string } | null {
  if (i.deniedBotItem) return { code: "DENIED_BOT_ITEM", reason: CUSTOMER_HANDOFF_REASON.DENIED_BOT_ITEM };
  if (i.onCustomerRequest !== false && customerDemandsHuman(i.text)) return { code: "WANTS_HUMAN", reason: CUSTOMER_HANDOFF_REASON.WANTS_HUMAN };
  if (i.objectionNow && i.objections >= OBJECTION_HANDOFF_AT) return { code: "REPEATED_OBJECTION", reason: CUSTOMER_HANDOFF_REASON.REPEATED_OBJECTION };
  return null;
}
