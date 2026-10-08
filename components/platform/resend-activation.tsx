"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { StatusPill } from "@/components/saas/console-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resendActivationAction } from "@/lib/actions/saas";
import { formatDateTime } from "@/lib/format";
import type { ActivationState, AdminActivation } from "@/lib/saas/activation";

/** Lý do tối thiểu — trùng `OPERATOR_REASON_MIN` của lõi (lib/saas/console.ts); lõi kiểm lại. */
const MIN_REASON = 5;

const STATE: Record<ActivationState, { label: string; tone: "good" | "bad" | "info" | "muted" }> = {
  ACTIVATED: { label: "Đã kích hoạt", tone: "good" },
  PENDING: { label: "Chưa kích hoạt — liên kết còn hạn", tone: "info" },
  EXPIRED: { label: "Chưa kích hoạt — liên kết đã hết hạn", tone: "bad" },
  NO_LINK: { label: "Chưa kích hoạt — không còn liên kết dùng được", tone: "bad" },
  NO_ADMIN: { label: "Chưa có tài khoản quản trị", tone: "bad" },
  DISABLED: { label: "Tài khoản quản trị đang khoá", tone: "bad" },
  ORG_INACTIVE: { label: "Workspace không hoạt động", tone: "muted" },
  UNKNOWN: { label: "Chưa đọc được", tone: "muted" },
};

function detail(a: AdminActivation): string {
  switch (a.state) {
    case "ACTIVATED":
      return `vào được từ ${formatDateTime(a.activatedAt)}`;
    case "PENDING":
      return `liên kết hết hạn lúc ${formatDateTime(a.linkExpiresAt)}`;
    case "EXPIRED":
      return `hết hạn lúc ${formatDateTime(a.linkExpiresAt)}`;
    case "NO_LINK":
      return a.lastLinkAt ? `liên kết gần nhất (${formatDateTime(a.lastLinkAt)}) đã bị thu hồi` : "chưa phát liên kết nào";
    case "NO_ADMIN":
      return "job cấp phát chưa tạo quản trị — chạy lại job ở khung «Job cấp phát»";
    case "DISABLED":
      return "mở khoá ở trang Người dùng của workspace rồi mới gửi kích hoạt";
    case "ORG_INACTIVE":
      return "workspace đang tạm dừng / lưu trữ";
    case "UNKNOWN":
      return "CSDL workspace chưa đọc được — tải lại trang sau";
  }
}

/**
 * Kích hoạt của quản trị khách trên `/platform/customers/<mã>` (Finish Line 08/10/2026 — PR #680, blocker 5): trạng thái đọc từ dữ liệu THẬT
 * của workspace (lib/saas/activation.ts) + «Gửi lại liên kết kích hoạt» khi quản trị chưa vào được. Nút ghi đi qua hộp xác nhận có
 * lý do (vào nhật ký nền tảng); liên kết mới hiện MỘT lần ở đây — tải lại trang là mất, liên kết cũ chưa dùng đã hết hiệu lực.
 */
export function ResendActivation({ accountCode, activation }: { accountCode: string; activation: AdminActivation | null }) {
  const [issued, setIssued] = useState<{ link: string; email: string; expiresAt: string } | null>(null);
  if (!activation) return null;
  const s = STATE[activation.state];
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-hairline px-3 py-2 text-xs" data-admin-activation={activation.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Quản trị khách</span>
        <span className="break-all text-sm">{activation.email ?? "—"}</span>
        <StatusPill tone={s.tone}>{s.label}</StatusPill>
        <span className="text-muted-foreground">{detail(activation)}</span>
      </div>
      {activation.canResend ? (
        <ConfirmWithReason
          id={`resend-activation-${activation.orgCode}`}
          label="Gửi lại liên kết kích hoạt"
          title={`Tạo liên kết kích hoạt mới cho ${activation.email ?? "quản trị"}?`}
          consequence="Liên kết cũ chưa dùng HẾT hiệu lực ngay. Liên kết mới dùng một lần, hết hạn sau 24 giờ, chỉ hiện MỘT lần ở đây — sao chép rồi gửi riêng cho đúng quản trị (Zalo / Messenger). Có nhật ký nền tảng."
          minReason={MIN_REASON}
          placeholder="Khách báo chưa nhận được / liên kết đã hết hạn"
          run={async (reason) => {
            const r = await resendActivationAction({ orgCode: activation.orgCode, reason }, accountCode);
            if (!("ok" in r)) return r;
            setIssued({ link: r.link, email: r.email, expiresAt: r.expiresAt });
            return { ok: true, message: r.message };
          }}
        />
      ) : null}
      {issued ? (
        <div className="space-y-1.5 rounded-lg border bg-muted/40 p-2" data-activation-link>
          <p className="text-muted-foreground">
            Liên kết cho <b className="text-foreground">{issued.email}</b> — chỉ hiện MỘT lần, hết hạn lúc {formatDateTime(issued.expiresAt)}.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={issued.link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Liên kết kích hoạt" />
            <Button type="button" variant="outline" size="icon" aria-label="Sao chép liên kết" onClick={() => void navigator.clipboard?.writeText(issued.link).then(() => toast.success("Đã sao chép liên kết"))}>
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
