/**
 * Hằng số hiển thị của OKR — TÁCH KHỎI `lib/queries/okr.ts` một cách bắt buộc.
 *
 * AGENTS.md mục 2: client component KHÔNG được import `lib/queries/*` (ngoài `import type`). Tệp
 * truy vấn kéo theo `getDb`, và một hằng số vô hại đi nhờ nó sẽ lôi cả trình điều khiển CSDL vào
 * gói trình duyệt. Nhãn và danh sách trạng thái thì cả hai phía đều cần — nên chúng ở đây.
 */

export const OKR_LEVELS = ["COMPANY", "DEPARTMENT", "INDIVIDUAL"] as const;
export type OkrLevel = (typeof OKR_LEVELS)[number];

export const OKR_LEVEL_LABEL: Record<OkrLevel, string> = {
  COMPANY: "Công ty",
  DEPARTMENT: "Phòng ban",
  INDIVIDUAL: "Cá nhân",
};

export const OKR_STATUSES = ["DRAFT", "ACTIVE", "CLOSED", "CANCELLED"] as const;
export type OkrStatus = (typeof OKR_STATUSES)[number];

export const OKR_STATUS_LABEL: Record<OkrStatus, string> = { DRAFT: "Nháp", ACTIVE: "Đang chạy", CLOSED: "Đã chốt", CANCELLED: "Huỷ" };

export const KR_CONFIDENCES = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"] as const;
export type KrConfidence = (typeof KR_CONFIDENCES)[number];

export const KR_CONFIDENCE_LABEL: Record<KrConfidence, string> = {
  ON_TRACK: "Đúng hướng",
  AT_RISK: "Có rủi ro",
  OFF_TRACK: "Chệch hướng",
  UNKNOWN: "Chưa chấm",
};

export const KR_CONFIDENCE_TONE: Record<KrConfidence, string> = {
  ON_TRACK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  AT_RISK: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  OFF_TRACK: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};
