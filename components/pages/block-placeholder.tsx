import { Ban, CircleAlert, PlugZap, SearchX, Settings2 } from "lucide-react";
import type { BlockIssue } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CHỖ GIỮ AN TOÀN CỦA MỘT KHỐI (Phase 4 · G8, G9) ═══════════
 *
 * Khối không dựng được (thiếu quyền, module tắt, cấu hình hỏng, dữ liệu lỗi) hiện Ô NÀY thay vì làm hỏng cả
 * trang. Người xem thường chỉ thấy MỘT câu nói điều gì xảy ra; người có `metadata:manage` thấy thêm mã lỗi
 * `BlockIssue` để sửa cấu hình. KHÔNG BAO GIỜ in stack trace hay câu lỗi thô của CSDL — chúng lộ cấu trúc bảng
 * và không giúp người xem làm gì.
 */

const COPY: Record<BlockIssue["code"], { title: string; icon: typeof Ban }> = {
  FORBIDDEN: { title: "Bạn không có quyền xem khối này", icon: Ban },
  MODULE_DISABLED: { title: "Module của khối này chưa bật cho tổ chức", icon: PlugZap },
  NOT_FOUND: { title: "Không tìm thấy dữ liệu cho khối này", icon: SearchX },
  INVALID_CONFIG: { title: "Khối chưa được cấu hình đúng", icon: Settings2 },
  DATA_ERROR: { title: "Không tải được dữ liệu của khối này", icon: CircleAlert },
};

export function blockIssueTitle(code: BlockIssue["code"]): string {
  return COPY[code]?.title ?? COPY.DATA_ERROR.title;
}

export function BlockPlaceholder({ title, issue, diagnose, className }: { title?: string; issue: Pick<BlockIssue, "code" | "message"> & { blockId?: string }; diagnose: boolean; className?: string }) {
  const copy = COPY[issue.code] ?? COPY.DATA_ERROR;
  const Icon = copy.icon;
  return (
    <div role="status" data-block-issue={issue.code} className={cn("flex h-full min-h-[120px] flex-col justify-center gap-1.5 rounded-2xl border border-dashed bg-surface-sunken/40 p-5 text-sm", className)}>
      {title ? <p className="text-[13px] font-semibold text-muted-foreground">{title}</p> : null}
      <p className="flex items-center gap-2 font-medium">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {copy.title}
      </p>
      {diagnose ? (
        <p className="break-words font-mono text-[11.5px] text-muted-foreground">
          {issue.code}
          {issue.blockId ? ` · ${issue.blockId}` : ""} — {issue.message}
        </p>
      ) : null}
    </div>
  );
}
