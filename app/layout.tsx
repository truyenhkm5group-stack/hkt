import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Phông chữ của giao diện Bento. `next/font` tải tệp phông LÚC BUILD và phục vụ từ chính máy chủ
 * ERP — trình duyệt của nhân viên không gọi tới Google Fonts, nên không thêm dịch vụ ngoài nào lúc
 * chạy. Bộ chữ `vietnamese` bắt buộc: thiếu nó thì dấu tiếng Việt rơi về phông hệ thống giữa chữ.
 */
const sans = Plus_Jakarta_Sans({ subsets: ["latin", "vietnamese"], variable: "--font-jakarta", display: "swap" });

export const metadata: Metadata = {
  title: { default: "VNXcommerce ERP", template: "%s · VNXcommerce ERP" },
  description: "Hệ thống quản trị nội bộ VNXcommerce cho shop thời trang bán hàng online — đồng bộ Pancake POS & Viettel Post.",
  icons: { icon: "/icon.svg" },
};

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
