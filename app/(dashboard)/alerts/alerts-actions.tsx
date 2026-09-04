"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RefreshCw, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { markNotificationsRead, resolveNotification, runAlertsNow, saveAlertConfig, sendTestLark, sendTestTelegram } from "@/lib/actions/alerts";
import type { AlertConfig } from "@/lib/constants/alerts";

export function RunAlertsButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await runAlertsNow();
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(`Đã quét: ${r.created} mới · ${r.resolved} tự đóng · ${r.open} đang mở${r.telegramError ? ` · Telegram lỗi: ${r.telegramError}` : ""}${r.larkError ? ` · Lark lỗi: ${r.larkError}` : ""}`);
            router.refresh();
          }
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Quét ngay
    </Button>
  );
}

export function MarkAllReadButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markNotificationsRead([]);
          router.refresh();
        })
      }
    >
      <Check className="size-4" /> Đã đọc hết
    </Button>
  );
}

export function ResolveButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await resolveNotification(id);
          if ("error" in r) toast.error(r.error);
          else router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Đã xử lý
    </Button>
  );
}

/** Cấu hình cảnh báo & Telegram (Quản trị) */
export function AlertConfigForm({ config, hasToken, hasLarkSecret }: { config: AlertConfig; hasToken: boolean; hasLarkSecret?: boolean }) {
  const [form, setForm] = useState({ ...config, telegramBotToken: "", larkSecret: "" });
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const save = () =>
    startTransition(async () => {
      const r = await saveAlertConfig({ ...form, telegramBotToken: form.telegramBotToken || config.telegramBotToken, larkSecret: form.larkSecret || config.larkSecret });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu cấu hình cảnh báo");
        router.refresh();
      }
    });
  const test = () =>
    startTransition(async () => {
      const r = await sendTestTelegram();
      if ("error" in r) toast.error(`Telegram: ${r.error}`);
      else toast.success("Đã gửi tin thử lên Telegram");
    });
  const testLark = () =>
    startTransition(async () => {
      const r = await sendTestLark();
      if ("error" in r) toast.error(`Lark: ${r.error}`);
      else toast.success("Đã gửi tin thử vào nhóm Lark");
    });
  const toggle = (key: keyof AlertConfig["enabled"], v: boolean) => setForm({ ...form, enabled: { ...form.enabled, [key]: v } });

  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label>Lark Suite · Webhook Custom Bot của nhóm vận đơn</Label>
          <Input value={form.larkWebhookUrl} onChange={(e) => setForm({ ...form, larkWebhookUrl: e.target.value })} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/xxxxxxxx" />
          <p className="text-[11px] text-muted-foreground">Trong Lark: mở nhóm → Settings → Bots → Add Bot → Custom Bot → sao chép Webhook URL. Nếu bật “Signature verification” thì dán khoá ở ô bên dưới.</p>
        </div>
        <div className="space-y-1">
          <Label>Lark · Signature secret (tuỳ chọn)</Label>
          <Input type="password" value={form.larkSecret} onChange={(e) => setForm({ ...form, larkSecret: e.target.value })} placeholder={hasLarkSecret ? "Đã lưu — nhập để thay" : "Để trống nếu không bật ký"} />
        </div>
        <div className="space-y-1">
          <Label>Telegram Bot Token</Label>
          <Input type="password" value={form.telegramBotToken} onChange={(e) => setForm({ ...form, telegramBotToken: e.target.value })} placeholder={hasToken ? "Đã lưu — nhập để thay" : "123456:ABC… (tạo bot qua @BotFather)"} />
        </div>
        <div className="space-y-1">
          <Label>Chat ID nhóm / người nhận</Label>
          <Input value={form.telegramChatId} onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })} placeholder="-1001234567890 (thêm bot vào nhóm, lấy ID qua @userinfobot)" />
        </div>
        <div className="space-y-1">
          <Label>Đơn chờ xử lý quá (giờ)</Label>
          <Input type="number" min={1} value={form.pendingHours} onChange={(e) => setForm({ ...form, pendingHours: Number(e.target.value) || 24 })} />
        </div>
        <div className="space-y-1">
          <Label>Vận đơn treo không cập nhật quá (ngày)</Label>
          <Input type="number" min={1} value={form.staleDays} onChange={(e) => setForm({ ...form, staleDays: Number(e.target.value) || 4 })} />
        </div>
        <div className="space-y-1">
          <Label>Chỉ xét đơn phát sinh trong (ngày)</Label>
          <Input type="number" min={1} value={form.lookbackDays} onChange={(e) => setForm({ ...form, lookbackDays: Number(e.target.value) || 14 })} />
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <Checkbox checked={form.enabled.failed} onCheckedChange={(v) => toggle("failed", v === true)} /> Giao thất bại · chờ phát lại
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={form.enabled.pending} onCheckedChange={(v) => toggle("pending", v === true)} /> Đơn chờ xử lý quá hạn
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={form.enabled.stale} onCheckedChange={(v) => toggle("stale", v === true)} /> Vận đơn treo lâu
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={form.enabled.returning} onCheckedChange={(v) => toggle("returning", v === true)} /> Đang chuyển hoàn
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={form.enabled.cs} onCheckedChange={(v) => toggle("cs", v === true)} /> Case CSKH mới (đổi size / màu, sai địa chỉ / SĐT, trả hàng)
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={form.enabled.stock} onCheckedChange={(v) => toggle("stock", v === true)} /> Thiếu hàng cần sản xuất (hết / hết trước khi SX xong)
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={testLark} disabled={pending}>
          <Send className="size-4" /> Gửi thử Lark
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={test} disabled={pending}>
          <Send className="size-4" /> Gửi thử Telegram
        </Button>
        <span className="text-xs text-muted-foreground">Cảnh báo quét mỗi 10 phút và ngay sau webhook Pancake / Viettel Post; mỗi vấn đề chỉ báo một lần, tự đóng khi đơn đã được xử lý.</span>
      </div>
    </div>
  );
}
