"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquarePlus, MoreHorizontal, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { addCareNote, setCareOwner, setCareStatus } from "@/lib/actions/care-workbench";
import { CARE_STATUS_LABEL, type CareStatus } from "@/lib/constants/care";

/**
 * ═══════════ "TẤT CẢ VẬN ĐƠN" CŨNG LÀ BÀN LÀM VIỆC ═══════════
 *
 * Trước bản này tab "Tất cả vận đơn" chỉ đọc: muốn ghi một câu hay nhận một kiện thì phải sang tab
 * Cần care — mà kiện đang tìm có thể KHÔNG nằm trong điều kiện care, nên nó không có ở đó. Kết quả
 * là người dùng mở chi tiết từng kiện một, hoặc ghi ra giấy.
 *
 * ─── DÙNG LẠI ĐÚNG CỬA GHI CŨ ───
 *
 * Ba thao tác ở đây gọi CHÍNH `setCareOwner` / `setCareStatus` / `addCareNote` mà bàn care dùng.
 * Không có đường ghi thứ hai: bảng chuyển trạng thái, nhật ký case, ảnh chụp bối cảnh, quyền — tất
 * cả đã nằm trong `lib/care/service.ts` và phải tiếp tục là nơi duy nhất giữ chúng.
 *
 * ─── NGƯỜI TẠO ≠ NGƯỜI CHỊU TRÁCH NHIỆM ───
 *
 * Hàng đợi care sinh case tự động. Việc máy phát hiện ra một kiện KHÔNG có nghĩa máy chịu trách
 * nhiệm xử lý nó — nên "Nhận việc" ghi ĐÚNG người đang bấm vào ô chủ, và ô chủ trống nghĩa là
 * chưa ai nhận, không phải "hệ thống đang giữ".
 */
export function CareRowActions({
  shipmentId,
  tracking,
  staff,
  canManage,
}: {
  shipmentId: string;
  tracking: string;
  staff: { id: string; name: string }[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  /*
    Trạng thái phản hồi NGAY TẠI DÒNG, không `router.refresh()`.

    Tải lại cả trang sau mỗi lần bấm sẽ kéo lại toàn bộ danh sách vài trăm dòng, mất vị trí cuộn và
    mất bộ lọc đang mở — với người xử lý hàng chục kiện liên tiếp thì đó là khác biệt giữa dùng được
    và không.
  */
  const [nhan, setNhan] = useState<string | null>(null);
  const [trangThai, setTrangThai] = useState<CareStatus | null>(null);

  const chay = (fn: () => Promise<{ error?: string } | unknown>, ok: string, sau?: () => void) =>
    start(async () => {
      const r = (await fn()) as { error?: string };
      if (r && typeof r === "object" && "error" in r && r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(ok);
      sau?.();
    });

  const doiTrangThai = (status: CareStatus) =>
    chay(() => setCareStatus({ shipmentIds: [shipmentId], status, note: "" }), `${tracking}: ${CARE_STATUS_LABEL[status]}`, () => setTrangThai(status));

  return (
    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      {trangThai ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium">{CARE_STATUS_LABEL[trangThai]}</span> : null}
      {nhan ? <span className="max-w-[70px] truncate text-[10.5px] text-muted-foreground">{nhan}</span> : null}

      <Button variant="ghost" size="icon" className="size-6" title="Thêm ghi chú" disabled={pending} onClick={() => setNoteOpen(true)}>
        <MessageSquarePlus className="size-3.5" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-6" disabled={pending} aria-label={`Thao tác cho ${tracking}`}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{tracking}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => doiTrangThai("IN_PROGRESS")}>Đang xử lý</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => doiTrangThai("WAITING_CUSTOMER")}>Chờ khách</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => doiTrangThai("WAITING_CARRIER")}>Chờ ĐVVC</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => doiTrangThai("WAITING_REDELIVERY")}>Chờ phát lại</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => doiTrangThai("RESOLVED")}>Hoàn thành</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Giao cho</DropdownMenuLabel>
          {staff.slice(0, 8).map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => chay(() => setCareOwner({ shipmentIds: [shipmentId], ownerId: p.id }), `${tracking}: giao cho ${p.name}`, () => setNhan(p.name))}
            >
              <UserPlus className="size-3.5" /> {p.name}
            </DropdownMenuItem>
          ))}
          {!canManage ? (
            /*
              CHỈ ĐỌC MỚI LÀ ĐIỀU CẦN NÓI. Thao tác care chỉ cần `shipments:view`; thao tác gửi yêu
              cầu sang ĐVVC mới cần `shipments:manage`. Nút gửi ĐVVC KHÔNG được dựng ở đây — xem
              `lib/care/carrier-capabilities.ts`: tài khoản VTP hiện tại không đọc được vận đơn do
              Pancake tạo, nên mọi lệnh gửi đi đều trả về lỗi quyền. Bàn care có đường đi đúng cho
              việc đó (có sổ `carrier_action_requests`, có chặn theo năng lực); dựng thêm một nút ở
              đây sẽ là nút bấm-không-chạy.
            */
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Gửi yêu cầu sang ĐVVC: cần quyền thao tác vận đơn</DropdownMenuLabel>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Ghi chú cho {tracking}</DialogTitle>
            <DialogDescription>Ghi lại việc vừa làm: đã gọi, khách hẹn, đã nhắn ĐVVC… Ghi chú vào nhật ký case, không sửa trạng thái vận đơn.</DialogDescription>
          </DialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} placeholder="Đã gọi, khách hẹn giao lại chiều mai" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteOpen(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || note.trim().length < 1}
              onClick={() =>
                chay(() => addCareNote({ shipmentId, note, kind: "OTHER" }), "Đã ghi chú", () => {
                  setNote("");
                  setNoteOpen(false);
                })
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu ghi chú
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
