import type { Metadata } from "next";
import { ForgotForm } from "@/app/forgot/forgot-form";
import { COMPANY } from "@/lib/constants/company";
import { readPhoneOtpSetting } from "@/lib/onboarding/phone-otp";
import { hostBrand } from "@/lib/platform/host-brand";
import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { listOrganizations } from "@/lib/platform/organizations";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Quên mật khẩu" }, robots: { index: false, follow: false } };

/**
 * `/forgot` — QUÊN MẬT KHẨU TỰ PHỤC VỤ (PUB-07, ngoài nhóm dashboard, không cần phiên).
 *
 * Cùng cách chọn thương hiệu và ô «Mã cửa hàng» với `/login`: tên miền con của một tổ chức GẮN CỨNG tổ chức (không ô mã); trang
 * chung chỉ hiện ô mã khi nền tảng có hơn một tổ chức đang chạy (chỉ ĐẾM, không liệt kê). Lõi: lib/users/forgot-password.ts.
 * Trang chỉ đọc công tắc OTP (công khai — trang đăng ký cũng lộ nó) để viết đúng câu giới thiệu; không tra tài khoản nào.
 */
export default async function ForgotPasswordPage() {
  const host = await hostOrganization();
  if (host.slug && !host.org) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-xl font-semibold">Không tìm thấy ERP</h1>
          <p className="text-sm text-muted-foreground">{HOST_NOT_FOUND_MESSAGE}</p>
        </div>
      </div>
    );
  }
  const showOrgField = host.org ? false : (await listOrganizations()).filter((o) => o.status === "ACTIVE").length > 1;
  const brand = host.org ? "vnx" : await hostBrand();
  const otp = await readPhoneOtpSetting();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8 sm:p-6">
      <ForgotForm
        brand={brand}
        orgName={host.org?.name ?? null}
        showOrgField={showOrgField}
        otpOn={otp.enabled && Boolean(otp.templateId)}
        support={host.org ? null : { zalo: COMPANY.zalo, zaloHref: COMPANY.zaloHref }}
      />
    </main>
  );
}
