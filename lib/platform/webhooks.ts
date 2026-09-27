import { getHomeOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ WEBHOOK THUỘC TỔ CHỨC NÀO — KHAI, KHÔNG NGẦM ĐỊNH ═══════════
 *
 * Hợp đồng: shared-contracts.md mục 8 · audit ISO-07. Webhook không có phiên, nên không có chứng
 * cứ nào tự nói "gói tin này của ai". Trước nền tảng câu trả lời ngầm là "của CSDL mặc định"; nay
 * mỗi nhà cung cấp phải KHAI cách phân giải trong bảng dưới, và route bọc TOÀN BỘ phần xử lý (kể
 * cả việc sau phản hồi) trong `withOrganization(mã đã phân giải)`.
 *
 * Phase 1: bí mật webhook là MỘT giá trị môi trường cho cả tiến trình — tức là bí mật của tổ chức
 * nhà — nên mọi nhà cung cấp là `HOME_ONLY`. Phase 1.x thêm cách phân giải theo bí mật trong
 * đường dẫn (`secret_hash → tổ chức`); bí mật không khớp tổ chức nào thì 401, KHÔNG rơi về nhà.
 */

export type WebhookProvider = "PANCAKE" | "VIETTELPOST" | "VTP_STATEMENT" | "SEPAY";

export type WebhookBinding = { mode: "HOME_ONLY"; reason: string };

export const WEBHOOK_BINDINGS: Readonly<Record<WebhookProvider, WebhookBinding>> = {
  PANCAKE: { mode: "HOME_ONLY", reason: "Bí mật trong đường dẫn so với PANCAKE_WEBHOOK_SECRET — một giá trị môi trường, của tổ chức nhà." },
  VIETTELPOST: { mode: "HOME_ONLY", reason: "Gói Viettel Post không mang mã khách; bí mật duy nhất là VIETTELPOST_WEBHOOK_SECRET của tổ chức nhà." },
  VTP_STATEMENT: { mode: "HOME_ONLY", reason: "Kịch bản Gmail của hộp thư tổ chức nhà, dùng chung VIETTELPOST_WEBHOOK_SECRET." },
  SEPAY: { mode: "HOME_ONLY", reason: "Chữ ký HMAC bằng SEPAY_WEBHOOK_SECRET — một giá trị môi trường, của tổ chức nhà." },
};

/** Mã tổ chức mà gói tin của `provider` thuộc về. Nhà cung cấp chưa khai ⇒ NÉM, không đoán. */
export async function resolveWebhookOrganization(provider: WebhookProvider): Promise<string> {
  const binding = WEBHOOK_BINDINGS[provider];
  if (!binding) throw new Error(`Webhook "${provider}" chưa khai cách phân giải tổ chức trong WEBHOOK_BINDINGS.`);
  switch (binding.mode) {
    case "HOME_ONLY":
      return (await getHomeOrganization()).code;
  }
}
