import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ShortcutState } from "@/lib/constants/production-shortcuts";

/**
 * Nút của một LỐI TẮT (Company OS · Agent SC). Bật ⇒ đường dẫn tới màn hình có sẵn đã điền sẵn. Tắt ⇒
 * KHÔNG tắt im lặng: nút xám + câu lý do ngay cạnh (và đường tới thứ đã có, nếu lý do là "đã có rồi").
 */
export function ShortcutAction({ state, label, icon, size = "sm", variant = "default" }: { state: ShortcutState; label: string; icon?: ReactNode; size?: "sm" | "xs"; variant?: "default" | "outline" }) {
  if (state.enabled && state.href) {
    return (
      <Button asChild size={size} variant={variant}>
        <Link href={state.href}>
          {icon}
          {label}
        </Link>
      </Button>
    );
  }
  const reason = state.enabled ? null : state.reason;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size={size} variant="outline" disabled title={reason ?? undefined}>
        {icon}
        {label}
      </Button>
      {reason ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
      {!state.enabled && state.href ? (
        <Link href={state.href} className="text-xs font-medium text-primary hover:underline">
          {state.hrefLabel ?? "Mở"}
        </Link>
      ) : null}
    </span>
  );
}
