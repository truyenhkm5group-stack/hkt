import type { Metadata } from "next";
import { LegalPage, legalBrandName } from "@/components/legal/legal-page";
import { PRIVACY_CONTENT } from "@/components/legal/privacy-content";
import { PRIVACY_POLICY } from "@/lib/constants/company";
import { hostBrand } from "@/lib/platform/host-brand";

/**
 * CHÍNH SÁCH QUYỀN RIÊNG TƯ CÔNG KHAI — `vnxcommerce.com/chinh-sach-bao-mat` (lib/platform/site-host.ts::SITE_LEGAL_PATHS).
 *
 * Google (màn hình đồng ý OAuth) và Facebook (chế độ Live của ứng dụng đăng nhập) đòi một link chính sách quyền riêng tư
 * trên tên miền đã khai. Nội dung dựng từ `docs/legal/privacy-policy.md`, điền thông tin pháp nhân do chủ nền tảng cung
 * cấp (03/10/2026). Mỗi câu cam kết phải là điều hệ thống ĐANG làm được (docs/legal/README.md) — sửa hành vi hệ thống thì
 * sửa trang này cùng lúc. Trang tĩnh: không đọc CSDL, không cần phiên.
 *
 * Câu chữ nằm ở `components/legal/privacy-content.tsx` — cùng một cây cho trang và cho băm nội dung của sổ văn bản
 * (`lib/constants/legal-documents.ts`).
 */

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: { absolute: `Chính sách quyền riêng tư — ${legalBrandName(await hostBrand())}` },
    description: "Cách VNXcommerce thu thập, sử dụng, lưu trữ và bảo vệ dữ liệu cá nhân; cách yêu cầu xem, sửa, xoá dữ liệu.",
    robots: { index: true, follow: true },
  };
}

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title={PRIVACY_CONTENT.title} version={PRIVACY_POLICY.version} effective={PRIVACY_POLICY.effective} intro={PRIVACY_CONTENT.intro}>
      {PRIVACY_CONTENT.body}
    </LegalPage>
  );
}
