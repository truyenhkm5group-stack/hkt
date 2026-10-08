import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand";
import { COMPANY, PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { hostBrand } from "@/lib/platform/host-brand";
import type { SiteBrand } from "@/lib/platform/site-host";

/** Tên thương hiệu in trên tiêu đề tab của văn bản pháp lý — theo host đang mở (`chotdontudong.com` ⇒ Chốt Đơn Tự Động). */
export function legalBrandName(brand: SiteBrand): string {
  return brand === "chotdon" ? "Chốt Đơn Tự Động" : "VNXcommerce";
}

/**
 * Khung chung của văn bản pháp lý công khai (`/chinh-sach-bao-mat`, `/dieu-khoan-su-dung`): đầu trang, tiêu đề + phiên
 * bản, chân trang dẫn chéo hai văn bản. Trang tĩnh: không đọc CSDL, không cần phiên.
 *
 * Mở từ `chotdontudong.com` thì đầu trang mang logo Chốt Đơn Tự Động và một dòng nói rõ đây là sản phẩm của cùng pháp
 * nhân, chạy trên cùng nền tảng — để người đọc không thấy mình bị đưa sang một công ty khác. NỘI DUNG văn bản (có số
 * phiên bản) không đổi theo host: sửa câu chữ của văn bản là việc của phiên bản mới, không phải của giao diện.
 *
 * Logo dẫn về `/` bằng `<a>` (tải cả trang), không `<Link>`: trang nằm ngoài nhóm `(dashboard)` và người đã đăng nhập vỏ Chốt
 * Đơn mở được nó — điều hướng phía client tới `/` lặp trang trắng như #671 (xem `app/not-found.tsx`).
 */
export async function LegalPage({
  title,
  version,
  effective,
  intro,
  children,
}: {
  title: string;
  version: string;
  effective: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  const brand = await hostBrand();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- cố ý tải cả trang (xem chú thích đầu tệp) */}
          <a href="/" aria-label={`${legalBrandName(brand)} — trang chủ`}>
            <BrandLockup wordmarkClassName="text-base" brand={brand} />
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
          <p className="text-sm text-muted-foreground">
            Phiên bản {version} · Hiệu lực từ {effective}
          </p>
          <div className="text-[15px] leading-7">{intro}</div>
          {brand === "chotdon" ? (
            <p className="rounded-lg border border-border/70 bg-muted/40 px-4 py-3 text-sm leading-6 text-muted-foreground">
              <strong className="text-foreground">Chốt Đơn Tự Động</strong> (chotdontudong.com) là sản phẩm trợ lý AI bán hàng của {COMPANY.name},
              chạy trên nền tảng VNXcommerce. Văn bản dưới đây áp dụng cho Chốt Đơn Tự Động.
            </p>
          ) : null}
        </div>
        {children}
      </main>
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <span>
            © {new Date().getFullYear()} {COMPANY.name} · MST {COMPANY.taxCode}
          </span>
          <a href={TERMS_OF_SERVICE.path} className="hover:text-foreground">
            Điều khoản sử dụng
          </a>
          <a href={PRIVACY_POLICY.path} className="hover:text-foreground">
            Chính sách quyền riêng tư
          </a>
        </div>
      </footer>
    </div>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-[15px] leading-7 text-foreground/90">{children}</div>
    </section>
  );
}

export function LegalTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const supportMail = (
  <a href={`mailto:${COMPANY.email}`} className="font-medium text-primary underline">
    {COMPANY.email}
  </a>
);
