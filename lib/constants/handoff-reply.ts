/*
  HANDOFF_UNANSWERED — MỘT định nghĩa, MỘT hàm (21/10/2026): ops `stuck-conversation-audit` (dòng A2) và Quality Supervisor (2B) cùng
  đọc tệp này, không ai viết lại luật. HÀM THUẦN, không đọc CSDL: nơi gọi tự đọc các mốc (cột hội thoại + dòng PAGE_REPLY của
  `sales_chat_inbound`, bỏ tin tự động / hệ thống, tách tiếng vọng AI_AGENT) rồi đưa vào `HandoffReplyFact`.
*/

/**
 * A2 — TRONG nhóm «chờ người»: tin khách cuối ĐÃ có ai trả lời chưa (chủ shop 21/10/2026: «Chưa có người nhận trực nhưng hội thoại được
 * trả lời rồi thì thôi» ⇒ «chưa ai cầm» KHÔNG phải lỗi). Nhân viên thường trả lời thẳng trên Pancake / page ⇒ ERP chỉ thấy dòng
 * `PAGE_REPLY` ở `sales_chat_inbound`, KHÔNG thấy ở `last_staff_at` (cột ấy chỉ ghi tin gửi từ hộp thư ERP) — nên «khách đang chờ trả lời»
 * của dòng A đếm THỪA. Tin tự động của page và chữ hệ thống KHÔNG phải câu trả lời (đúng tập của `PAGE_REPLY_AFTER_CUSTOMER_SQL`); tiếng vọng
 * của chính bot (`AI_AGENT`) tách riêng — đó là bot, không phải người. HANDOFF_UNANSWERED = không câu trả lời nào (người · page · bot) sau
 * tin khách cuối VÀ tin ấy đã quá SLA (`work.sla`). Trục «khách không nhắn gì sau lúc chuyển» CẮT NGANG các nhóm: tin GÂY RA lượt chuyển
 * vẫn có thể chưa ai trả lời, nên nó không được trừ khỏi số lỗi.
 */
export const HANDOFF_REPLY_CLASSES = ["ANSWERED_HUMAN", "ANSWERED_BOT", "UNANSWERED_OVER_SLA", "UNANSWERED_WITHIN_SLA", "UNANSWERED_NO_SLA", "NO_CUSTOMER_MESSAGE"] as const;
export type HandoffReplyClass = (typeof HANDOFF_REPLY_CLASSES)[number];

export type HandoffReplyFact = {
  lastCustomerAt: Date | null;
  lastBotAt: Date | null;
  /** Tin nhân viên gửi TỪ HỘP THƯ ERP. */
  lastStaffAt: Date | null;
  /** Dòng phía page mới nhất không phải tự động / hệ thống / bot (người trên Pancake · page chưa rõ người · ứng dụng khác). */
  pageHumanAt: Date | null;
  /** …trong đó dòng đã XÁC MINH là người (`VERIFIED_HUMAN`). */
  pageVerifiedAt: Date | null;
  /** Tiếng vọng của bot phía page (`AI_AGENT`). */
  pageAiAt: Date | null;
  /** Mốc chuyển người: dấu vào hàng đợi → `state.handoff.at`; không có ⇒ `null` (không đoán bằng `updated_at`). */
  handoffAt: Date | null;
};

const laterThan = (d: Date | null, ref: Date) => d !== null && d.getTime() > ref.getTime();

/** HÀM THUẦN. `slaMs = null` ⇒ không đọc được hạn hoặc chủ shop cố ý không đặt hạn — KHÔNG kết luận quá hạn. */
export function handoffReplyClass(f: HandoffReplyFact, now: Date, slaMs: number | null): HandoffReplyClass {
  const cust = f.lastCustomerAt;
  if (!cust) return "NO_CUSTOMER_MESSAGE";
  if (laterThan(f.lastStaffAt, cust) || laterThan(f.pageHumanAt, cust)) return "ANSWERED_HUMAN";
  if (laterThan(f.lastBotAt, cust) || laterThan(f.pageAiAt, cust)) return "ANSWERED_BOT";
  if (slaMs === null) return "UNANSWERED_NO_SLA";
  return now.getTime() - cust.getTime() > slaMs ? "UNANSWERED_OVER_SLA" : "UNANSWERED_WITHIN_SLA";
}

export type HandoffReplySplit = {
  total: number;
  byClass: Record<HandoffReplyClass, number>;
  /** Người trả lời CHỈ bằng dòng page chưa rõ người gửi (không phải tin ERP, không phải `VERIFIED_HUMAN`). */
  answeredUnverified: number;
  /** (c) khách KHÔNG nhắn gì sau mốc chuyển, theo nhóm. */
  quietAfterHandoff: Record<HandoffReplyClass, number>;
  quietTotal: number;
  /** Không có mốc chuyển ⇒ không xếp được vào (c). */
  handoffUnknown: number;
  /** HANDOFF_UNANSWERED theo tuổi tin khách cuối: > 24 giờ · > 72 giờ. */
  overSla24h: number;
  overSla72h: number;
};

/** HÀM THUẦN. */
export function handoffReplySplit(facts: readonly HandoffReplyFact[], now: Date, slaMs: number | null): HandoffReplySplit {
  const zero = () => Object.fromEntries(HANDOFF_REPLY_CLASSES.map((k) => [k, 0])) as Record<HandoffReplyClass, number>;
  const s: HandoffReplySplit = { total: 0, byClass: zero(), answeredUnverified: 0, quietAfterHandoff: zero(), quietTotal: 0, handoffUnknown: 0, overSla24h: 0, overSla72h: 0 };
  for (const f of facts) {
    const k = handoffReplyClass(f, now, slaMs);
    s.total += 1;
    s.byClass[k] += 1;
    if (k === "ANSWERED_HUMAN" && f.lastCustomerAt && !laterThan(f.lastStaffAt, f.lastCustomerAt) && !laterThan(f.pageVerifiedAt, f.lastCustomerAt)) s.answeredUnverified += 1;
    if (k === "UNANSWERED_OVER_SLA" && f.lastCustomerAt) {
      const h = (now.getTime() - f.lastCustomerAt.getTime()) / 3_600_000;
      if (h > 24) s.overSla24h += 1;
      if (h > 72) s.overSla72h += 1;
    }
    if (!f.handoffAt) s.handoffUnknown += 1;
    else if (!laterThan(f.lastCustomerAt, f.handoffAt)) {
      s.quietTotal += 1;
      s.quietAfterHandoff[k] += 1;
    }
  }
  return s;
}
