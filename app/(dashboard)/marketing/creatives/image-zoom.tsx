"use client";

import { useState } from "react";
import { Download, ExternalLink, ZoomIn } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * ẢNH BẤM ĐỂ PHÓNG TO (chủ shop 27/09/2026: "sau khi tạo ảnh xong, cho thêm tính năng ấn vào ảnh để zoom to"). Ô nhỏ giữ
 * nguyên cách cắt khung như cũ; bấm ⇒ khung xem lớn hiện TOÀN ẢNH (không cắt), kèm "Mở ảnh gốc" / "Tải về". Nút bấm chặn
 * sự kiện lan ra ngoài để thẻ chứa ảnh (vd ô chọn) không nhận nhầm cú bấm.
 */
export function ZoomableImg({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="group relative block size-full cursor-zoom-in"
        aria-label={`Phóng to ảnh: ${alt}`}
        title="Bấm để phóng to"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="size-full object-cover" loading="lazy" />
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-background/90 p-1 opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <ZoomIn className="size-3.5" />
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[96vh] w-auto max-w-[96vw] flex-col items-center gap-2 border-0 bg-black/95 p-2 sm:max-w-[96vw]">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="max-h-[86vh] max-w-[92vw] object-contain" />
          <div className="flex items-center gap-3 text-[12px] text-white/80">
            <span className="max-w-[60vw] truncate">{alt}</span>
            <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-white">
              <ExternalLink className="size-3.5" /> Mở ảnh gốc
            </a>
            <a href={src} download className="inline-flex items-center gap-1 hover:text-white">
              <Download className="size-3.5" /> Tải về
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
