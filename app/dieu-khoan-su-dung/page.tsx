import type { Metadata } from "next";
import { LegalPage, legalBrandName } from "@/components/legal/legal-page";
import { TERMS_CONTENT } from "@/components/legal/terms-content";
import { TERMS_OF_SERVICE } from "@/lib/constants/company";
import { hostBrand } from "@/lib/platform/host-brand";

/**
 * ĐIỀU KHOẢN SỬ DỤNG CÔNG KHAI — `vnxcommerce.com/dieu-khoan-su-dung` (lib/platform/site-host.ts::SITE_LEGAL_PATHS).
 *
 * Dựng từ `docs/legal/terms-of-service.md`. Mọi con số đọc từ hằng số đang chạy (`TRIAL_DAYS`, ân hạn, `SERVICE_COMMITMENTS`)
 * — sửa luật thì trang đổi theo, không có hai nơi nói hai số. Mỗi câu cam kết phải là điều hệ thống ĐANG làm được
 * (docs/legal/README.md): quá hạn chỉ chuyển CHỈ XEM, không tự xoá; không hứa SLA bằng con số.
 *
 * Câu chữ nằm ở `components/legal/terms-content.tsx` — cùng một cây cho trang và cho băm nội dung của sổ văn bản
 * (`lib/constants/legal-documents.ts`).
 */

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: { absolute: `Điều khoản sử dụng — ${legalBrandName(await hostBrand())}` },
    description: "Điều khoản sử dụng phần mềm VNXcommerce: dùng thử, phí và thanh toán, hoàn tiền, dữ liệu, sử dụng hợp lệ, AI, trách nhiệm.",
    robots: { index: true, follow: true },
  };
}

export default function TermsOfServicePage() {
  return (
    <LegalPage title={TERMS_CONTENT.title} version={TERMS_OF_SERVICE.version} effective={TERMS_OF_SERVICE.effective} intro={TERMS_CONTENT.intro}>
      {TERMS_CONTENT.body}
    </LegalPage>
  );
}
