import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { hostTabMetadata } from "@/lib/branding/copy";
import { hostBrand } from "@/lib/platform/host-brand";
import { CHOTDON_ASSETS } from "@/lib/platform/site-host";
import { hostOrganization } from "@/lib/platform/host-org";
import "./globals.css";

/**
 * Phông chữ của giao diện Bento — TỰ HOST (app/fonts/, giấy phép OFL nằm cạnh tệp): trình duyệt không gọi Google Fonts, và
 * từ 04/10/2026 cả lúc BUILD cũng không — `next/font/google` hai lần trong một ngày nhận URL lạ từ Google và `next build`
 * chết «next/font … reading '1'», chặn deploy. Bản variable một tệp, trục wght 200–800, đủ mọi chữ có dấu tiếng Việt (kiểm
 * từng ký tự bằng fontTools) — thiếu thì dấu rơi về phông hệ thống giữa chữ.
 */
const sans = localFont({ src: "./fonts/PlusJakartaSans-Variable.woff2", weight: "200 800", variable: "--font-jakarta", display: "swap" });

const HOME_METADATA: Metadata = {
  title: { default: "VNXcommerce ERP", template: "%s · VNXcommerce ERP" },
  description: "Hệ thống quản trị nội bộ VNXcommerce cho shop thời trang bán hàng online — đồng bộ Pancake POS & Viettel Post.",
  /*
    `favicon.ico` nằm ở `public/` (không ở `app/`) và được khai TƯỜNG MINH ở đây: tệp `app/favicon.ico` bị Next chèn vào
    ĐẦU mọi trang, kể cả khi bố cục con khai `icons` riêng — tổ chức không-nhà khi đó vẫn mang biểu tượng của nhà.
    Khai ở đây thì bố cục dashboard của tổ chức khác THAY được cả bộ (lib/branding/copy.ts::orgTabMetadata); tổ chức nhà
    nhận đúng hai thẻ như trước (ico 16×16 rồi svg).
  */
  icons: { icon: [{ url: "/favicon.ico", type: "image/x-icon", sizes: "16x16" }, { url: "/icon.svg" }] },
};

/**
 * Trên tên miền con của một tổ chức (`<slug>.<PLATFORM_BASE_DOMAIN>`), trang NGOÀI dashboard (`/login`, `/chat`, `/join`)
 * không có phiên để bố cục dashboard thay tiêu đề — trước đây chúng mang tên và lời mô tả của tổ chức nhà lên tab trình
 * duyệt của khách. Có host ⇒ tên của tổ chức đó (chỉ tổ chức đã xuất bản), host lạ ⇒ chữ trung tính; miền chính giữ nguyên.
 */
/** Host của «Chốt Đơn Tự Động» (`chotdontudong.com`, `app.chotdontudong.com`) — tên và biểu tượng của sản phẩm AI bán hàng. */
const CHOTDON_METADATA: Metadata = {
  title: { default: "Chốt Đơn Tự Động", template: "%s · Chốt Đơn Tự Động" },
  description: "Nhân viên bán hàng AI trực fanpage 24/7: tư vấn đúng giá, đúng hàng còn và chốt đơn cho shop. Một sản phẩm của VNXcommerce.",
  icons: {
    icon: [
      { url: CHOTDON_ASSETS.favicon, sizes: "48x48" },
      { url: CHOTDON_ASSETS.icon, type: "image/svg+xml" },
    ],
    apple: [{ url: CHOTDON_ASSETS.apple, sizes: "180x180" }],
  },
  manifest: CHOTDON_ASSETS.manifest,
};

export async function generateMetadata(): Promise<Metadata> {
  return hostTabMetadata(await hostOrganization()) ?? ((await hostBrand()) === "chotdon" ? CHOTDON_METADATA : HOME_METADATA);
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3efe8" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1814" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={sans.variable} suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          <NuqsAdapter>{children}</NuqsAdapter>
          <Toaster richColors position="top-right" closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
