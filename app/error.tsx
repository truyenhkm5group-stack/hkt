"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * MÀN HÌNH LỖI GỐC — cho trang NGOÀI dashboard (đăng nhập · đăng ký · kích hoạt · chat công khai · bảng giá). Trước đây không
 * có: lỗi ở đó ra màn trắng mặc định của Next bằng tiếng Anh (Commercial Sweep C1 #11). Cùng ba câu với màn hình lỗi dashboard,
 * không in nội dung lỗi (chỉ mã tham chiếu), tên sản phẩm KHÔNG ghi cứng vì thành phần client không biết host; lối ra là `<a>`
 * tải cả trang.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center" data-testid="root-error">
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" aria-hidden />
      </span>
      <div className="max-w-md space-y-1">
        <h1 className="text-lg font-bold">Có lỗi khi tải trang</h1>
        <p className="text-sm text-muted-foreground">Trang này chưa hiện được. Bấm «Thử lại»; nếu vẫn lỗi, về trang chính rồi mở lại sau một phút.</p>
        {error.digest ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Mã tham chiếu: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset} variant="outline">
          <RotateCcw className="size-4" /> Thử lại
        </Button>
        <Button asChild>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- cố ý tải cả trang (xem chú thích đầu tệp) */}
          <a href="/">Về trang chính</a>
        </Button>
      </div>
    </main>
  );
}
