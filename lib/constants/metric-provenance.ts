/**
 * ═══════════ MỘT CON SỐ HIỆU SUẤT PHẢI TỰ KHAI ĐƯỢC NÓ ĐỨNG TRÊN CÁI GÌ ═══════════
 *
 * Chủ shop chốt (13/09/2026): mỗi chỉ số phải mang **nguồn · chủ thể · kỳ · mẫu số · độ tin cậy ·
 * luật quy kết**. Không có chứng cứ thì là `UNKNOWN`.
 *
 * ─── VÌ SAO SÁU THỨ ĐÓ, KHÔNG PHẢI MỘT CON SỐ ───
 *
 * "Chị Lan đạt 92%" là một câu không dùng để quyết định gì được. Sáu thứ kia trả lời sáu câu mà
 * người đọc luôn hỏi tiếp, và nếu màn hình không trả lời thì họ sẽ TỰ ĐOÁN:
 *
 *   nguồn       — 92% này đọc từ chứng từ nào? (tin được hay không)
 *   chủ thể     — của một NGƯỜI hay của cả PHÒNG? (quy về ai)
 *   kỳ          — trong khoảng nào? (so được với kỳ khác không)
 *   mẫu số      — 92% trên 2 quan sát hay trên 200? (92% trên 2 là 23/25, vô nghĩa)
 *   độ tin cậy  — nối người bằng khoá tài khoản hay bằng tên gõ tay? (có nhầm người không)
 *   luật quy kết— phần nào của con số này KHÔNG do người đó quyết?
 *
 * ─── ĐỘ TIN CẬY LÀ HÀM, KHÔNG PHẢI CẢM TÍNH ───
 *
 * Ai cũng gật gù với chữ "độ tin cậy" cho tới lúc phải điền nó. Nếu để người viết code tự chấm
 * thì nó thành nhãn trang trí. Nên nó được TÍNH từ ba thứ đo được: cỡ mẫu, cách nối người với
 * dòng dữ liệu, và việc kết quả có do bên ngoài đồng quyết định hay không.
 */

/** Cách một dòng dữ liệu được nối về một con người — quyết định khả năng nhầm người. */
export type PersonLinkage =
  /** Khoá ngoại `users.id`. Không nhầm được. */
  | "USER_ID"
  /** Cột email. Khớp được, nhưng người đổi email thì mất dấu dữ liệu cũ. */
  | "EMAIL"
  /** Ô CHỮ gõ tay (`cs_cases.assignee`). Trùng tên, viết tắt, sai chính tả đều làm lệch. */
  | "FREE_TEXT";

export type MetricConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export const CONFIDENCE_LABEL: Record<MetricConfidence, string> = {
  HIGH: "Tin được",
  MEDIUM: "Tạm tin",
  LOW: "Yếu",
  UNKNOWN: "Chưa đo được",
};

export const CONFIDENCE_TONE: Record<MetricConfidence, string> = {
  HIGH: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  MEDIUM: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOW: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  UNKNOWN: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/**
 * Dưới ngần này quan sát thì một tỷ lệ không nói lên điều gì về con người — nó nói về may rủi.
 * Con số 5 / 20 là NGƯỠNG KHAI BÁO, không phải kết quả thống kê: shop chưa chạy đủ lâu để tính
 * được khoảng tin cậy thật. Đổi ở đây, không hard-code nơi khác.
 */
export const SAMPLE_FLOOR = { low: 5, medium: 20 } as const;

/**
 * ĐỦ MẪU ĐỂ XẾP HẠNG CHƯA.
 *
 * Tách riêng khỏi `confidence` vì hai câu hỏi khác nhau: một con số có thể tin được (đọc từ
 * chứng từ, nối bằng khoá) mà vẫn KHÔNG đủ để nói "người A giỏi hơn người B". Xếp hạng trên
 * mẫu bé là cách nhanh nhất để một thẻ điểm mất hết uy tín.
 */
export function rankable(sample: number) {
  return sample >= SAMPLE_FLOOR.medium;
}

export function metricConfidence(input: { value: number | null; sample: number; linkage: PersonLinkage; shared: boolean }): MetricConfidence {
  // Không có quan sát nào ⇒ CHƯA BIẾT. Không bao giờ là 0, không bao giờ là "kém".
  if (input.value === null || input.sample <= 0) return "UNKNOWN";
  if (input.sample < SAMPLE_FLOOR.low) return "LOW";
  // Nối bằng tên gõ tay thì dù mẫu lớn cũng không vượt quá "yếu": sai người thì số đúng vẫn vô nghĩa.
  if (input.linkage === "FREE_TEXT") return "LOW";
  if (input.sample < SAMPLE_FLOOR.medium) return "MEDIUM";
  // Kết quả do bên ngoài đồng quyết định thì trần là "tạm tin" — đọc làm bối cảnh, không phải điểm chấm người.
  if (input.shared) return "MEDIUM";
  if (input.linkage === "EMAIL") return "MEDIUM";
  return "HIGH";
}

export const LINKAGE_NOTE: Record<PersonLinkage, string> = {
  USER_ID: "Nối bằng khoá tài khoản — không nhầm người được.",
  EMAIL: "Nối bằng email; dòng ghi bằng email cũ của họ sẽ không được tính.",
  FREE_TEXT: "Nối bằng TÊN GÕ TAY — trùng tên hoặc viết tắt là lệch, nên con số chỉ để tham khảo.",
};

/**
 * PHIÊN BẢN CÔNG THỨC.
 *
 * Tăng số này khi CÁCH TÍNH một chỉ số đổi (đổi mẫu số, đổi nguồn, đổi ngưỡng). Ảnh chụp đã ghi
 * KHÔNG được tính lại — chúng giữ nguyên số cũ kèm phiên bản cũ, nên khi một xu hướng gãy khúc thì
 * đọc được ngay là "đổi thật" hay "đổi công thức". Không tăng số thì hai thứ đó trông giống hệt nhau.
 */
export const METRIC_DEFINITION_VERSION = 1;

/** Khoá kỳ đọc được cho con người: `2026-W37` (tuần ISO) hoặc `2026-09` (tháng). */
export function periodKey(kind: "WEEKLY" | "MONTHLY", d: Date): string {
  if (kind === "MONTHLY") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  // Tuần ISO: thứ Năm của tuần quyết định năm, nên tuần cuối tháng 12 không rơi nhầm sang năm sau.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const dauNam = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const tuan = Math.ceil(((t.getTime() - dauNam.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(tuan).padStart(2, "0")}`;
}

/** Mốc đầu / cuối của kỳ chứa `d`. Tuần bắt đầu thứ Hai (UTC) — khớp với cách shop chốt tuần. */
export function periodRange(kind: "WEEKLY" | "MONTHLY", d: Date): { from: Date; to: Date } {
  if (kind === "MONTHLY") {
    const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1);
    return { from, to };
  }
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const lui = (t.getUTCDay() || 7) - 1;
  const from = new Date(t.getTime() - lui * 86_400_000);
  return { from, to: new Date(from.getTime() + 7 * 86_400_000 - 1) };
}
