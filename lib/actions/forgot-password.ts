"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { hostBrand } from "@/lib/platform/host-brand";
import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { withBrandHint } from "@/lib/platform/site-host";
import { requestPasswordHelp, verifyPasswordOtp } from "@/lib/users/forgot-password";

/**
 * Vỏ Next của trang công khai `/forgot` («Quên mật khẩu», PUB-07). Lõi (`lib/users/forgot-password.ts`) lo chặn dò, câu trả lời
 * chung, OTP Zalo và yêu cầu hỗ trợ; tệp này chỉ đọc IP (phần Caddy ghi) + tổ chức gắn theo tên miền con, rồi chuyển hướng khi có
 * phiếu đặt lại. Không chọn CSDL nào.
 *
 * `intent`: `send` (gửi mã / gửi yêu cầu) · `support` («Không nhận được mã» ⇒ yêu cầu hỗ trợ) · `verify` (nhập mã).
 */
export type ForgotState =
  | {
      /** Câu chung sau bước 1 (không lộ tài khoản có tồn tại hay không). */
      message?: string;
      /** Hiện ô nhập mã — theo công tắc OTP + nút bấm, không theo tài khoản. */
      otp?: boolean;
      error?: string;
      /** Mã đúng, SĐT có tài khoản ở nhiều cửa hàng ⇒ chọn cửa hàng (gửi lại kèm `pick`). */
      choose?: { code: string; name: string }[];
    }
  | undefined;

export async function forgotPasswordAction(prev: ForgotState, formData: FormData): Promise<ForgotState> {
  // Nút chọn cửa hàng (bước 2, sau khi mã đã đúng) chỉ mang `pick` — nó là một lượt nhập mã.
  const intent = formData.get("pick") ? "verify" : String(formData.get("intent") ?? "send");
  const identifier = String(formData.get("identifier") ?? "");
  const orgCode = String(formData.get("org") ?? "");
  const host = await hostOrganization();
  if (host.slug && !host.org) return { error: HOST_NOT_FOUND_MESSAGE };
  const ctx = { ip: clientIpFrom((await headers()).get("x-forwarded-for")), hostOrgCode: host.org?.code ?? null };

  if (intent === "verify") {
    const r = await verifyPasswordOtp({ identifier, orgCode, code: String(formData.get("code") ?? ""), pick: String(formData.get("pick") ?? "") }, ctx);
    if ("error" in r) return { message: prev?.message, otp: true, error: r.error };
    if ("choose" in r) return { message: prev?.message, otp: true, choose: r.choose };
    redirect(withBrandHint(r.resetPath, await hostBrand()));
  }

  const r = await requestPasswordHelp({ identifier, orgCode, channel: intent === "support" ? "SUPPORT" : "OTP" }, ctx);
  if ("error" in r) return { message: prev?.message, otp: prev?.otp, error: r.error };
  return { message: r.message, otp: r.otp };
}
