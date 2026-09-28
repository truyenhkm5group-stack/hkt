/**
 * ═══════════ UY TÍN SĐT THEO PANCAKE — "TỶ LỆ HOÀN" VÀ "CẢNH BÁO SĐT" NHƯ WEB POS HIỆN ═══════════
 *
 * Nguồn: `GET /shops/<shop>/orders/bad_report_info?phone_number=<SĐT>` của Pancake — ĐÚNG đường web
 * POS gọi để vẽ hai cột ấy (đọc từ mã web POS và đo bằng `phone-probe` ngày 28/09/2026: API key gọi
 * được, HTTP 200). Đơn lẻ và danh sách đơn của Open API KHÔNG kèm các số này.
 *
 * Công thức chép ĐÚNG web POS (`getReturnRate` · `renderWarningPhoneNumber`):
 *   · Tỷ lệ hoàn = Σ order_fail ÷ Σ (order_success + order_fail) trên mọi SĐT trong
 *     `reports_by_phone`, làm tròn tới phần trăm. Không có đơn nào ⇒ POS để TRỐNG ⇒ ở đây `null`.
 *   · Cảnh báo SĐT = số lần SĐT bị các shop khác báo (`warning_phone_number`), kèm lý do.
 *
 * ĐÂY LÀ SỐ CỦA PANCAKE TRÊN TOÀN MẠNG (mọi shop dùng Pancake), KHÔNG PHẢI kết quả đơn của ERP:
 * "thất bại" theo định nghĩa của Pancake, không đi qua `ORDER_OUTCOME` và không được dùng cho bất kỳ
 * phép tính doanh thu / tỷ lệ GTC / lương nào (AGENTS.md mục 0, 47). Nó chỉ là bối cảnh cho người
 * đóng gói / CSKH trước khi gửi hàng, và màn hình phải ghi rõ "theo Pancake".
 *
 * KHÔNG giữ danh tính người báo (`reported_by` — tên + Facebook của NGƯỜI KHÁC) và KHÔNG giữ SĐT
 * trong kết quả: ERP chỉ cần số đếm và câu lý do.
 */

export type PhoneWarning = { reason: string; at: string | null };

export type PhoneReputation = {
  orderSuccess: number;
  orderFail: number;
  /** % hoàn theo Pancake, làm tròn như POS. `null` = Pancake chưa có đơn nào của SĐT — CHƯA BIẾT, không phải 0%. */
  returnRatePct: number | null;
  warningCount: number;
  warnings: PhoneWarning[];
};

/** Độ dài tối đa một câu lý do giữ lại — đủ đọc, không để một câu dài làm vỡ ô bảng. */
export const WARNING_REASON_MAX = 160;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Đọc `data` của `bad_report_info`. Hình dạng lạ ⇒ `null` (chưa biết), KHÔNG phải "0 đơn · 0 cảnh báo":
 * đọc hỏng mà in ra 0% là nói với người đóng gói rằng khách này sạch.
 */
export function parseBadReportInfo(data: unknown): PhoneReputation | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const reports = d.reports_by_phone;
  const list = Array.isArray(d.warning_phone_number) ? d.warning_phone_number : [];
  if ((reports !== undefined && (reports === null || typeof reports !== "object")) || (reports === undefined && !Array.isArray(d.warning_phone_number))) return null;

  let orderSuccess = 0;
  let orderFail = 0;
  let warningSum = 0;
  for (const r of Object.values((reports ?? {}) as Record<string, unknown>)) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    orderSuccess += num(x.order_success);
    orderFail += num(x.order_fail);
    warningSum += num(x.warning);
  }
  const warnings: PhoneWarning[] = list
    .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === "object")
    .map((w) => ({
      reason: String(w.reason ?? "").replace(/\s+/g, " ").trim().slice(0, WARNING_REASON_MAX),
      at: typeof w.inserted_at === "string" ? w.inserted_at : null,
    }));
  const finished = orderSuccess + orderFail;
  return {
    orderSuccess,
    orderFail,
    returnRatePct: finished ? Math.round((orderFail / finished) * 100) : null,
    // POS đếm trên danh sách lần báo; hai nguồn trong cùng phản hồi phải khớp, lệch thì lấy số lớn hơn.
    warningCount: Math.max(warningSum, warnings.length),
    warnings,
  };
}

/** SĐT dạng Pancake nhận: chỉ chữ số, đầu 84 đổi về 0. Không đủ 9 chữ số ⇒ `null` (không hỏi). */
export function normalizePhoneForPancake(phone: string | null | undefined): string | null {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("84") && d.length >= 11) d = `0${d.slice(2)}`;
  return d.length >= 9 ? d : null;
}

/** Ngưỡng rủi ro — nguồn DUY NHẤT là cấu hình cảnh báo (`AlertConfig.phoneRisk*`, sửa trên trang Cảnh báo). */
export type PhoneRiskThresholds = { phoneRiskReturnRatePct: number; phoneRiskWarningCount: number; phoneRiskMinOrders: number };

export type PhoneRiskReason = "RETURN_RATE" | "WARNINGS";

/**
 * Đơn chờ xuất có RỦI RO CAO không, và vì sao. VƯỢT ngưỡng mới tính (`>`, đúng lời chủ shop
 * "> 40%", "> 10"), và so trên ĐÚNG con số màn hình đang in (`returnRatePct` đã làm tròn như POS) —
 * để không có ô in "40%" mà bị gắn cảnh báo "> 40%". Chưa biết (`null`) ⇒ không kết luận gì.
 * Tỷ lệ hoàn chỉ xét khi SĐT đã có ít nhất `phoneRiskMinOrders` đơn kết thúc (mẫu nhỏ là nhiễu).
 */
export function phoneRiskReasons(rep: PhoneReputation | null | undefined, t: PhoneRiskThresholds): PhoneRiskReason[] {
  if (!rep) return [];
  const out: PhoneRiskReason[] = [];
  const finished = rep.orderSuccess + rep.orderFail;
  if (rep.returnRatePct !== null && finished >= Math.max(1, t.phoneRiskMinOrders) && rep.returnRatePct > t.phoneRiskReturnRatePct) out.push("RETURN_RATE");
  if (rep.warningCount > t.phoneRiskWarningCount) out.push("WARNINGS");
  return out;
}

/** Câu lý do dùng chung cho khung cảnh báo trên trang và tin cảnh báo — một cách nói, không hai. */
export function phoneRiskText(rep: PhoneReputation, reasons: PhoneRiskReason[]): string {
  return reasons
    .map((l) => (l === "RETURN_RATE" ? `Pancake: hoàn ${rep.returnRatePct}% (${rep.orderFail}/${rep.orderSuccess + rep.orderFail} đơn)` : `SĐT bị báo ${rep.warningCount} lần trên Pancake`))
    .join(" · ");
}
