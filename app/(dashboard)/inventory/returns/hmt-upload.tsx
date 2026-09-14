"use client";

import { useState, useTransition } from "react";
import { FileUp, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { deleteHmtWorkbook, uploadHmtWorkbook } from "@/lib/actions/hmt-returns";
import { formatDateTime, formatNumber } from "@/lib/format";

/**
 * ═══════════ SỔ GIẤY ĐI VÀO ERP BẰNG CHÍNH ERP ═══════════
 *
 * Trước ô này, để đối soát sổ hàng hoàn với ERP thì tệp Excel phải tới được máy chủ — và ba đường
 * từng thử đều hỏng theo cách riêng:
 *
 *  · `scp` cần khoá SSH mà máy chủ shop không có, và bắt người vận hành mở terminal cho một việc
 *    hàng tuần là cách chắc chắn nhất để việc đó không bao giờ được làm;
 *  · đường dẫn tải công khai là "dữ liệu khách hàng nằm trên Internet";
 *  · đưa tệp vào kho mã thì kho mã này PUBLIC.
 *
 * Ô này là đường thứ tư và là đường ERP ĐÃ CÓ SẴN cho bảng kê Viettel Post: người đã đăng nhập kéo
 * tệp vào màn hình của chính họ, tệp đi qua HTTPS bằng phiên của họ.
 *
 * MÁY CHỦ tính băm, MÁY CHỦ kiểm tệp. Trình duyệt chỉ chuyển byte — nó không nói tệp này là tệp gì.
 */
export function HmtUpload({ current }: { current: { filename: string; sha256: string; bytes: number; uploadedBy: string; uploadedAt: Date; lastUsedAt: Date | null } | null }) {
  const [pending, start] = useTransition();
  const [ten, setTen] = useState("");
  const router = useRouter();

  const onFile = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    setTen(file.name);
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const base64 = btoa(binary);
    start(async () => {
      const r = await uploadHmtWorkbook({ filename: file.name, base64 });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      // "Đã có rồi" KHÔNG phải lỗi: người dùng tải lại vì không chắc lần trước đã ăn chưa.
      toast.success(r.reused ? `Bản này đã có sẵn trên máy chủ (SHA-256 ${r.sha256.slice(0, 12)}…)` : `Đã nhận ${formatNumber(r.bytes)} byte · SHA-256 ${r.sha256.slice(0, 12)}…`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <Label htmlFor="hmt-file" className="flex items-center gap-1.5 text-xs font-semibold">
        <FileUp className="size-3.5" /> Sổ hàng hoàn viết tay (.xlsx)
      </Label>
      <Input id="hmt-file" type="file" accept=".xlsx" disabled={pending} onChange={(e) => void onFile(e.target.files)} />
      <p className="text-[11px] text-muted-foreground">
        Tệp nằm lại trong CSDL của chính ERP, không đi qua đường dẫn công khai nào. Máy chủ tự tính mã băm và tự kiểm tra
        đúng ba sheet trước khi nhận — tệp sai bị từ chối ngay tại đây.
      </p>
      {pending ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Đang nhận {ten}…
        </p>
      ) : null}
      {current ? (
        <div className="rounded bg-muted/50 px-2 py-1.5 text-[11px]">
          <div className="flex items-center gap-1 font-medium text-foreground">
            <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> {current.filename}
          </div>
          <div className="numeric text-muted-foreground">
            {formatNumber(current.bytes)} byte · SHA-256 {current.sha256}
          </div>
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>
              {current.uploadedBy || "—"} tải lên {formatDateTime(current.uploadedAt)} ·{" "}
              {/* "Chưa đối soát" là một trạng thái phải đọc được: nó nói còn một việc phải làm. */}
              {current.lastUsedAt ? `đã đối soát ${formatDateTime(current.lastUsedAt)}` : "CHƯA đối soát lần nào"}
            </span>
            {/*
              XOÁ TỆP KHỎI MÁY CHỦ SAU KHI ĐỐI SOÁT XONG.

              Bảng tính mang tên và địa chỉ khách hàng, nên phải có đường gỡ nó đi — giữ mãi một
              tệp không còn ai dùng là giữ một rủi ro không đổi lấy gì. Chứng cứ của lượt đối soát
              KHÔNG đi theo: `hmt_return_reconciliation` giữ băm, sheet, số dòng và mã vận đơn.

              Nút chỉ hiện khi bản này ĐÃ được đối soát: xoá một tệp vừa tải lên mà chưa chạy lượt
              nào là làm mất công người vừa tải.
            */}
            {current.lastUsedAt ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
                disabled={pending}
                title="Xoá tệp khỏi máy chủ — chứng cứ của lượt đối soát vẫn còn nguyên"
                onClick={() =>
                  start(async () => {
                    const r = await deleteHmtWorkbook(current.sha256);
                    if ("error" in r) toast.error(r.error);
                    else {
                      toast.success("Đã xoá tệp khỏi máy chủ · chứng cứ đối soát vẫn còn");
                      router.refresh();
                    }
                  })
                }
              >
                <Trash2 className="size-3" /> Xoá tệp
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Chưa có bản nào trên máy chủ.</p>
      )}
    </div>
  );
}
