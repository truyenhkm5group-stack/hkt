import type { CodStatus, ShipmentStage } from "@/db/schema";
import { VTP_STATUS, vtpStatusMeta } from "@/lib/constants/viettelpost";
import { mapVtpStatusText } from "@/lib/integrations/viettelpost/statement";

/**
 * MỘT chỗ duy nhất dịch trạng thái Viettel Post sang trạng thái chuẩn của ERP.
 *
 * Trước đây có hai bộ dịch chạy song song và cho kết quả khác nhau cho cùng một sự việc:
 *  · webhook dịch theo MÃ SỐ (`vtpStatusMeta`);
 *  · nhập tệp dịch theo CHỮ (`mapVtpStatusText`), vì tệp xuất từ viettelpost.vn không có mã số.
 * Ví dụ thật: mã 504 "Thành công - Chuyển trả người gửi" — bộ mã cho ra RETURNED (đã hoàn, kết
 * thúc) còn bộ chữ cho ra RETURNING (đang hoàn). Cùng một vận đơn, nhập bằng hai đường thì ERP
 * kết luận hai kiểu.
 *
 * Thứ tự tin cậy: mã số chính thức → chữ → suy theo nhóm mã (5xx là đang phát…) → KHÔNG RÕ.
 * Không bao giờ im lặng quy về một trạng thái sai: không đủ căn cứ thì trả UNKNOWN để lớp trên
 * giữ nguyên trạng thái cũ và ghi vào hàng đợi cần xem lại.
 */
export type VtpResolved = {
  stage: ShipmentStage;
  /** Tên hiển thị: giữ nguyên chữ của ĐVVC nếu có, không thay bằng tên trong bảng của ERP. */
  name: string;
  final: boolean;
  code: number | null;
  /**
   * Gợi ý trạng thái tiền COD suy từ CHỮ của ĐVVC (ví dụ "đã thanh toán COD"). Chỉ là gợi ý để
   * hiển thị; tiền chỉ được coi là đã thu khi có số thực thu hoặc chứng từ bảng kê.
   */
  cod: CodStatus | null;
  /** Căn cứ đã dùng — để chẩn đoán khi số liệu bị nghi ngờ. */
  basis: "code" | "text" | "code-group" | "unknown";
};

export function resolveVtpStatus(input: { code?: number | null; text?: string | null }): VtpResolved {
  const text = String(input.text ?? "").trim();
  const code = input.code ?? null;
  const byText = text ? mapVtpStatusText(text) : null;
  const cod = byText && byText.stage !== "UNKNOWN" ? byText.cod : null;

  if (code !== null && VTP_STATUS[code]) {
    const meta = vtpStatusMeta(code, text);
    return { stage: meta.stage, name: meta.name, final: Boolean(meta.final), code, cod, basis: "code" };
  }
  if (byText && byText.stage !== "UNKNOWN") {
    return { stage: byText.stage, name: text, final: byText.final, code, cod, basis: "text" };
  }
  if (code !== null) {
    const meta = vtpStatusMeta(code, text);
    if (meta.stage !== "UNKNOWN") return { stage: meta.stage, name: meta.name, final: Boolean(meta.final), code, cod, basis: "code-group" };
  }
  return { stage: "UNKNOWN", name: text || "Chưa rõ trạng thái", final: false, code, cod, basis: "unknown" };
}

/** Mã số trong `shipment_events.status` có thể là số ("501") hoặc chữ; chỉ nhận dạng số. */
export function eventStatusCode(status: string): number | null {
  const trimmed = status.trim();
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : null;
}
