/**
 * ═══════════ TIẾN ĐỘ «VIỆC ĐANG CHẠY» + CHE LIÊN HỆ TRONG NHẬT KÝ — HÀM THUẦN ═══════════
 *
 * Dùng chung cho trang Săn khách (chiến dịch quét: ô đã quét / tổng ô) và tab Liên hệ (hàng đợi Zalo, hộp thư đi: việc đã xử
 * lý / việc trong lượt hôm nay). Chủ shop 30/10/2026: «sắp lại cho mạch lạc» — một thẻ tiến độ, ba ô kết quả, một nhật ký.
 *
 * Luật số (AGENTS mục 42): mẫu số 0 ⇒ `null` (in «—»), không phải 0%. Dự kiến xong chỉ có khi đã xử lý ít nhất một việc —
 * chưa có tốc độ thì không bịa ra một giờ xong.
 *
 * Tệp THUẦN, client-safe.
 */

export type RunCounts = {
  /** Việc đã có kết quả tốt (lead nhận · tin đã gửi · thư đã gửi / chạy thử). */
  success: number;
  /** Việc lỗi (ô lỗi API · sai số · thư lỗi nhà cung cấp). */
  failed: number;
  /** Việc bị bỏ qua có lý do (lọc bỏ · huỷ · giữ lại). */
  skipped: number;
  /** Việc còn chờ xử lý trong lượt. */
  pending: number;
};

export type RunProgress = RunCounts & {
  processed: number;
  total: number;
  /** 0–100, `null` khi lượt chưa có việc nào. */
  pct: number | null;
  /** ms kể từ mốc bắt đầu, `null` khi chưa biết mốc. */
  elapsedMs: number | null;
  /** ms dự kiến còn lại theo tốc độ trung bình, `null` khi chưa đủ căn cứ. */
  etaMs: number | null;
};

/** Phần trăm làm tròn 1 chữ số; mẫu số 0 ⇒ `null`. */
export function pctOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Tiến độ của một lượt. `processed` mặc định = thành công + thất bại + bỏ qua; chiến dịch quét truyền riêng (đơn vị là Ô,
 * còn ba ô kết quả đếm ĐỊA ĐIỂM). `total` = đã xử lý + còn chờ.
 */
export function runProgress(c: RunCounts & { processed?: number; startedAt?: string | Date | null; now?: Date }): RunProgress {
  const processed = Math.max(0, c.processed ?? c.success + c.failed + c.skipped);
  const total = processed + Math.max(0, c.pending);
  const now = c.now ?? new Date();
  const start = c.startedAt ? new Date(c.startedAt) : null;
  const elapsedMs = start && Number.isFinite(start.getTime()) ? Math.max(0, now.getTime() - start.getTime()) : null;
  const remaining = total - processed;
  const etaMs = elapsedMs != null && processed > 0 ? (remaining <= 0 ? 0 : Math.round((elapsedMs / processed) * remaining)) : null;
  return { ...c, processed, total, pct: pctOf(processed, total), elapsedMs, etaMs };
}

/** «2 giờ 05 phút», «12 phút», «< 1 phút»; `null` ⇒ «—». */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "< 1 phút";
  if (min < 60) return `${min} phút`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} giờ ${String(m).padStart(2, "0")} phút` : `${h} giờ`;
  return `${Math.round(h / 24)} ngày`;
}

/**
 * Che SĐT trong nhật ký: giữ 4 số đầu + 2 số kế, che phần còn lại — «0965 34 ****». Nhận `+84…` (đổi về 0…) và chuỗi có
 * dấu cách / chấm. Ít hơn 6 chữ số ⇒ che hết (không lộ một số ngắn). Rỗng ⇒ «—».
 */
export function maskPhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return "—";
  const local = digits.startsWith("84") && digits.length >= 10 ? `0${digits.slice(2)}` : digits;
  if (local.length < 6) return "*".repeat(Math.max(4, local.length));
  return `${local.slice(0, 4)} ${local.slice(4, 6)} ${"*".repeat(Math.max(4, local.length - 6))}`;
}

/** Che email: 2 ký tự đầu + «***» + tên miền đầy đủ — «ei***@saigonmarket.de». Không có @ ⇒ che hết. */
export function maskEmail(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  const at = s.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
}

/** Đối tượng của một dòng nhật ký: email nếu kênh là email (hoặc chỉ có email), không thì SĐT — luôn đã che. */
export function maskContact(c: { phone?: string | null; email?: string | null; channel?: string | null }): string {
  if ((c.channel === "EMAIL" || !c.phone) && c.email) return maskEmail(c.email);
  return c.phone ? maskPhone(c.phone) : "—";
}

/**
 * Che SĐT / email lẫn trong CHỮ TỰ DO của một dòng nhật ký (ghi chú nhân viên, lý do máy ghi): chuỗi 9–15 chữ số (cho phép
 * cách, chấm, gạch, «+») ⇒ `maskPhone`; địa chỉ email ⇒ `maskEmail`. Dãy số ngắn (giá, số lượng) giữ nguyên.
 */
export function maskInlineContacts(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
    .replace(/\+?\d[\d .-]{7,17}\d/g, (m) => {
      const n = m.replace(/\D/g, "").length;
      return n >= 9 && n <= 15 ? maskPhone(m) : m;
    });
}

/** Rút gọn nội dung một dòng nhật ký về một dòng ≤ `max` ký tự. */
export function shortText(raw: string | null | undefined, max = 90): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * «Thị trường» của một chiến dịch từ ảnh chụp tỉnh / nước đã lưu: tối đa 3 tên rồi «+n». Rỗng ⇒ «—» (chiến dịch Nearby
 * không có tỉnh thì người gọi tự in vùng quanh điểm).
 */
export function campaignMarket(provinces: readonly { label?: string | null }[] | null | undefined, max = 3): string {
  const names = (provinces ?? []).map((p) => (p?.label ?? "").trim()).filter(Boolean);
  if (!names.length) return "—";
  return names.length > max ? `${names.slice(0, max).join(" · ")} +${names.length - max}` : names.join(" · ");
}
