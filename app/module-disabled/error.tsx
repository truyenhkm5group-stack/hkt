"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Ranh giới lỗi của `/module-disabled` — trang ĐỨNG NGOÀI nhóm `(dashboard)` nên không có `error.tsx` của nhóm ấy che. Không có
 * tệp này thì một lỗi ngoài dự kiến ở đây (đọc phiên, đọc module…) rơi lên lỗi gốc của Next bằng tiếng Anh, đúng lúc người dùng
 * vừa bị chặn và đang cần một câu giải thích.
 *
 * Câu chung cho MỌI tổ chức (ranh giới lỗi là thành phần client, không đọc được phiên): không chữ kỹ thuật, không câu lỗi gốc —
 * chỉ mã lỗi để báo hỗ trợ. Lối ra là `<a>` TẢI CẢ TRANG, không `<Link>` / `router.push`: điều hướng client từ trang ngoài nhóm vào
 * `(dashboard)` dựng layout trong một lượt RSC — với người vỏ Chốt Đơn, `/` bị chính layout chặn ⇒ vòng trang trắng
 * (lib/saas/shell-landing.ts). Tải cả trang thì máy chủ tự đưa người vỏ về trang nhà của vỏ.
 */
export default function ModuleDisabledError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" />
      </span>
      <div>
        <h1 className="text-lg font-bold">Chưa mở được trang này</h1>
        <p className="mt-1 text-sm text-muted-foreground">Trang giải thích vì sao chức năng chưa mở được đang gặp lỗi. Thử tải lại; nếu vẫn lỗi, quay về trang chính.</p>
        {error.digest ? <p className="mt-1 font-mono text-[11px] text-muted-foreground">Mã lỗi: {error.digest}</p> : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Tải lại trang
        </Button>
        <Button asChild size="sm">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- cố ý tải cả trang (xem chú thích đầu tệp) */}
          <a href="/">Về trang chính</a>
        </Button>
      </div>
    </main>
  );
}
