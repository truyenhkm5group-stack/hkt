"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ChatTestButton } from "@/app/(dashboard)/marketing/creatives/chat-test";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addManualAdAction, removeManualAdAction } from "@/lib/actions/chatbot-ad-test";

/**
 * Quảng cáo DỰNG TAY trên Trình quản lý quảng cáo Facebook (không qua Thư viện Media): dán ID quảng cáo + chọn fanpage ⇒
 * mở đúng khung Chat test (bảng kiểm page & bot, ảnh từng màu TẢI LÊN, giá & chất vải, chat thử, bật cho khách thật).
 */
export function ManualAdForm({ pages, prefillAdId = "" }: { pages: { id: string; name: string; inBot: boolean }[]; prefillAdId?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adId, setAdId] = useState(prefillAdId);
  const [label, setLabel] = useState("");
  const [pageId, setPageId] = useState(pages.find((p) => p.inBot)?.id ?? "");
  const [opened, setOpened] = useState<string | null>(null);

  const submit = () =>
    start(async () => {
      const r = await addManualAdAction({ adId: adId.trim(), pageId, label });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã thêm quảng cáo — điền ảnh từng màu, giá và chất vải rồi chat thử.");
      setOpened(r.campKey);
      setAdId("");
      setLabel("");
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">ID quảng cáo (Trình quản lý quảng cáo → cột ID)</span>
          <Input className="h-8 font-mono" inputMode="numeric" value={adId} placeholder="120247872389140225" onChange={(e) => setAdId(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Tên gọi (vd tên camp trên Facebook)</span>
          <Input className="h-8" value={label} maxLength={200} placeholder="TEST_Đầm da báo_01/10" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Fanpage chạy quảng cáo</span>
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">— chọn fanpage —</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.inBot ? "" : " (bot chưa có token)"}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <Button size="sm" disabled={pending || !adId || !pageId || !label.trim()} onClick={submit}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Thêm &amp; mở Chat test
          </Button>
        </div>
      </div>
      {!pages.length ? <p className="text-xs text-amber-700 dark:text-amber-400">Không đọc được danh sách fanpage (bot chat hoặc Pancake chưa kết nối) — kiểm trang Bot chat bán hàng.</p> : null}
      {opened ? <ChatTestButton key={opened} campKey={opened} defaultOpen /> : null}
    </div>
  );
}

export function RemoveManualAdButton({ adId }: { adId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (!window.confirm("Bỏ quảng cáo này khỏi danh sách? Bot sẽ thôi dùng bot riêng của nó.")) return;
        start(async () => {
          const r = await removeManualAdAction(adId);
          if ("error" in r) toast.error(r.error);
          else toast.success(r.message);
          router.refresh();
        });
      }}
    >
      <Trash2 className="size-4" />
      Bỏ
    </Button>
  );
}
