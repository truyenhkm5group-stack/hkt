import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { PublicPricing } from "@/components/pricing/public-pricing";
import { COMPANY, SERVICE_COMMITMENTS } from "@/lib/constants/company";
import { env } from "@/lib/env";
import { hostBrand } from "@/lib/platform/host-brand";
import { brandAppOrigin } from "@/lib/platform/site-host";
import { getPublicPricing } from "@/lib/queries/public-pricing";

/**
 * TRANG GIÁ CÔNG KHAI `/pricing` (0222) — không cần đăng nhập, không đọc dữ liệu khách nào: chỉ gói cước ở `platform_plans`
 * (giá, hạn mức tháng, tính năng in được) và chế độ đăng ký. Mọi số là số người vận hành đặt ở `/platform` — trang không
 * gõ lại số nào. Đọc lỗi ⇒ không in bảng giá (không bao giờ in một giá đoán).
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await hostBrand();
  const name = brand === "chotdon" ? "Chốt Đơn Tự Động" : "VNXcommerce";
  return { title: `Bảng giá — ${name}`, description: "AI chốt đơn 24/7 trên fanpage: gói theo số khách AI mỗi tháng, fanpage và người dùng. Đơn không giới hạn. Trả theo tháng hoặc theo năm, dùng thử miễn phí." };
}

function signupLabel(mode: string | null, trialDays: number | null): string {
  if (mode === "open") return trialDays ? `Dùng thử ${trialDays} ngày miễn phí` : "Dùng thử miễn phí";
  if (mode === "invite") return "Đăng ký bằng mã mời";
  return "Đăng ký";
}

export default async function PricingPage() {
  const brand = await hostBrand();
  const { site, plans, taxNote } = await getPublicPricing();
  // Bản Chốt Đơn dẫn vào PHẦN MỀM của chính nó — cùng cách trang giới thiệu chọn gốc; không xác định được thì giữ gốc ERP.
  const origin =
    brand === "chotdon" ? brandAppOrigin("chotdon", { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL }) : null;
  const base = origin ?? env.appUrl;
  const trialDays = plans.find((p) => p.trialDays)?.trialDays ?? null;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="Về trang chủ">
            <BrandLockup wordmarkClassName="text-base" brand={brand} />
          </Link>
          <a href={`${base}/login`} className="ml-auto text-sm font-medium text-muted-foreground hover:text-foreground">
            Đăng nhập
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pt-10 pb-16 sm:px-6 sm:pt-14">
        <Link href="/" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Trang chủ
        </Link>
        <h1 className="mt-3 text-center text-3xl font-extrabold tracking-tight sm:text-4xl">Bảng giá</h1>
        <p className="mx-auto mt-3 max-w-2xl text-center text-base leading-7 text-muted-foreground">
          AI chốt đơn 24/7 trên fanpage — trả lời khách, tự tạo đơn, nhắn lại khách lưỡng lự. Tính theo số KHÁCH được AI trả lời mỗi tháng — một khách nhắn nhiều lần vẫn là một; đơn không giới hạn, không tính phí theo đơn.
        </p>

        {plans.length === 0 ? (
          <p className="mt-12 text-center text-sm text-muted-foreground">Bảng giá đang được cập nhật — nhắn Zalo {COMPANY.zalo} để được báo giá.</p>
        ) : (
          <div className="mt-8">
            <PublicPricing plans={plans} signupUrl={`${base}/start`} signupLabel={signupLabel(site.signup, trialDays)} upgradeUrl={`${base}/settings/plan`} contactHref={COMPANY.zaloHref} />
            {taxNote ? <p className="mt-4 text-center text-xs text-muted-foreground">{taxNote}</p> : null}
          </div>
        )}

        <section className="mx-auto mt-14 max-w-3xl space-y-4 text-sm leading-6 text-muted-foreground" aria-label="Câu hỏi về giá">
          <div>
            <h2 className="font-semibold text-foreground">Dùng hết hạn mức thì sao?</h2>
            <p>AI KHÔNG bị ngắt. Trang «Gói & thanh toán» luôn hiện bạn đã dùng bao nhiêu khách AI; tới 80% có cảnh báo, quá 100% thì phần vượt tính theo khối 100 khách AI theo đơn giá của gói, quá nhiều thì được gợi ý nâng gói cho rẻ hơn. Hội thoại và số câu trả lời AI chỉ là mức dùng hợp lý (fair-use) — không tính thêm tiền. Số đếm lại từ đầu vào ngày 1 mỗi tháng.</p>
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Thanh toán thế nào?</h2>
            <p>Chuyển khoản theo mã QR phần mềm tạo sẵn — không lưu thẻ, không tự trừ tiền. Lần thanh toán đầu tiên được hoàn 100% nếu yêu cầu trong {SERVICE_COMMITMENTS.firstPaymentRefundDays} ngày.</p>
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Giá đã gồm gì?</h2>
            <p>Giá chưa gồm chi phí bên ngoài như phí vận chuyển hay tiền quảng cáo. Cần hoá đơn VAT thì yêu cầu ngay lúc thanh toán.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
