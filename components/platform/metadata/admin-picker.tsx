import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Ô chọn dạng viên thuốc cho bốn màn hình quản trị metadata: đối tượng, rồi form / danh sách / trạng
 * thái của đối tượng đó. Là LIÊN KẾT (trạng thái nằm trên URL) — tải lại hay gửi đường dẫn cho người
 * khác vẫn mở đúng chỗ đang cấu hình.
 */
export function AdminPicker({ label, items, current }: { label: string; items: { key: string; label: string; href: string }[]; current: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-medium text-muted-foreground">{label}</span>
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          aria-current={it.key === current ? "page" : undefined}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[12.5px] transition-colors",
            it.key === current ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-muted",
          )}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}

/** Dòng «Đang xuất bản: phiên bản N · lúc · bởi ai» + cờ nháp lệch — dùng chung cho form và danh sách. */
export function PublishLine({ version, isDefault, publishedAt, publishedBy, draftDiffers }: { version: number; isDefault: boolean; publishedAt: string | null; publishedBy: string | null; draftDiffers: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {isDefault || version === 0 ? (
        <span className="text-muted-foreground">Chưa xuất bản lần nào — người dùng đang thấy bản MẶC ĐỊNH của hệ thống.</span>
      ) : (
        <span className="text-muted-foreground">
          Đang xuất bản: <b className="text-foreground">phiên bản {version}</b>
          {publishedAt ? ` · ${publishedAt}` : ""}
          {publishedBy ? ` · bởi ${publishedBy}` : ""}
        </span>
      )}
      {draftDiffers ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Nháp khác bản đã xuất bản</span> : null}
    </div>
  );
}
