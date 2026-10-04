"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { disconnectMessengerAction, pickMessengerPageAction } from "@/lib/actions/messenger";

/** Chọn MỘT page trong danh sách vừa cấp quyền (danh sách + token nằm trong cookie mã hoá ở máy chủ; client chỉ gửi mã page). */
export function PagePicker({ pages }: { pages: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const pick = (id: string) =>
    start(async () => {
      const r = await pickMessengerPageAction(id);
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });
  return (
    <div className="mt-4 space-y-2" data-testid="messenger-page-picker">
      <p className="text-sm font-medium">Chọn page cho bot:</p>
      <ul className="divide-y rounded-md border">
        {pages.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-sm">
              {p.name} <span className="text-xs text-muted-foreground">({p.id})</span>
            </span>
            <Button type="button" size="sm" onClick={() => pick(p.id)} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Chọn
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DisconnectButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (!window.confirm("Gỡ Messenger trực tiếp? Bot sẽ thôi trả lời tin nhắn của page qua đường này.")) return;
          const r = await disconnectMessengerAction();
          if ("error" in r) toast.error(r.error);
          else toast.success(r.message);
        })
      }
    >
      Gỡ
    </Button>
  );
}
