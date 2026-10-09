"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * MÀN HÌNH LỖI CỦA DASHBOARD — cho MỌI người dùng, kể cả khách Chốt Đơn không rành kỹ thuật.
 *
 * Trước 08/10/2026 nó in nguyên `error.message` kèm «kiểm tra DATABASE_URL và xem log server»: câu cho người cài máy chủ, không
 * phải cho người bán hàng, và một câu lỗi gốc (tên bảng, tên cột, câu SQL, đường dẫn tệp) là thông tin nội bộ không được rò ra
 * ngoài (Commercial Sweep C1 #11). Nay ba câu — có chuyện gì · ảnh hưởng gì · làm gì tiếp — và chỉ MÃ THAM CHIẾU (`digest`) để
 * đội hỗ trợ tra log; nội dung lỗi vẫn vào console / log máy chủ như cũ.
 *
 * Dòng «Có lỗi khi tải trang» là ERROR_MARKER của lá chắn smoke (scripts/smoke.ts) — đổi chữ phải đổi cả hai nơi
 * (tests/smoke-coverage.test.ts khoá). Lối ra «Về trang chính» là thẻ `<a>` tải CẢ TRANG, không điều hướng phía client: trạng
 * thái lỗi của bộ định tuyến có thể chính là thứ làm trang hỏng (bài học vòng trắng #671 / #686), và `/` tự đưa mỗi người về
 * đúng trang nhà của họ.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-10 text-center" data-testid="dashboard-error">
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" aria-hidden />
      </span>
      <div className="max-w-md space-y-1">
        <h2 className="text-lg font-bold">Có lỗi khi tải trang</h2>
        <p className="text-sm text-muted-foreground">Trang này chưa hiện được. Dữ liệu đã lưu trước đó vẫn an toàn.</p>
        <p className="text-sm text-muted-foreground">Bấm «Thử lại»; nếu vẫn lỗi, về trang chính rồi mở lại sau một phút. Lỗi kéo dài thì nhắn hỗ trợ kèm mã tham chiếu bên dưới.</p>
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
    </div>
  );
}
