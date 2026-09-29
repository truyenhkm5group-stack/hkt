"use server";

import { requirePermission } from "@/lib/auth/session";
import type { SecretsSelfTestReport } from "@/lib/connectors/types";
import { runSecretsSelfTest } from "@/lib/platform/secrets-self-test";

/**
 * «Tự kiểm khoá bí mật» ở `/platform` → khung Cổng mở bán A. Vỏ mỏng: đọc phiên (`platform:operate`) → lõi
 * `lib/platform/secrets-self-test.ts` (kiểm lại tổ chức nhà, chạy trong bộ nhớ, một dòng nhật ký nền tảng). Không nhận
 * đối số nào từ trình duyệt; không ghi CSDL nghiệp vụ nên không `revalidatePath`.
 */
export async function secretsSelfTestAction(): Promise<(SecretsSelfTestReport & { audited: boolean }) | { error: string }> {
  const user = await requirePermission("platform:operate");
  return runSecretsSelfTest(user);
}
