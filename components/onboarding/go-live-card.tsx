"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, Loader2, MessageCircle, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { quickConnectFanpageAction, quickEnableBotAction } from "@/lib/actions/go-live";
import type { GoLiveView } from "@/lib/onboarding/go-live";

/**
 * Ô «Vào việc ngay» của trang Bắt đầu: (1) kết nối fanpage qua Pancake bằng MỘT nút, (2) dán URL webhook vào Pancake,
 * (3) bật chatbot bằng MỘT nút. Mỗi bước tự hiện «xong» khi dữ liệu thật đã có — không có ô bấm cho xong.
 */
export function GoLiveCard({ view }: { view: GoLiveView }) {
  const [pageId, setPageId] = useState(view.fanpage?.pageId ?? "");
  const [token, setToken] = useState("");
  const [pending, start] = useTransition();
  const connected = view.fanpage?.status === "ACTIVE";
  const received = (view.fanpage?.counts.done ?? 0) + (view.fanpage?.counts.pending ?? 0) + (view.fanpage?.counts.skipped ?? 0);
  const webhook = view.fanpage?.webhookUrl ?? null;

  const connect = () =>
    start(async () => {
      const r = await quickConnectFanpageAction({ pageId, pageAccessToken: token });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        setToken("");
      }
    });
  const enable = () =>
    start(async () => {
      const r = await quickEnableBotAction();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <div className="space-y-5" data-go-live>
      {/* 1. Kết nối fanpage */}
      <div className="space-y-2" data-go-live-step="fanpage">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {connected ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Plug className="size-4 text-muted-foreground" />}
          1. Kết nối fanpage (qua Pancake)
        </p>
        {connected ? (
          <p className="text-xs text-muted-foreground">Đã kết nối page {view.fanpage?.pageId}.</p>
        ) : view.canConnect ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Trong Pancake: Cài đặt page → Công cụ → chép Page ID và Page access token rồi dán vào đây.</p>
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor="gl-page">Page ID</Label>
                <Input id="gl-page" value={pageId} onChange={(e) => setPageId(e.target.value)} maxLength={40} placeholder="1234567890" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gl-token">Page access token</Label>
                <Input id="gl-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} maxLength={600} autoComplete="off" />
              </div>
              <Button type="button" onClick={connect} disabled={pending || !pageId.trim() || !token.trim()} data-go-live-connect>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Kết nối
              </Button>
            </div>
            {view.fanpage?.status === "FAILED" ? <p className="text-xs text-destructive">Lần kiểm tra trước chưa đạt — kiểm lại Page ID / token rồi bấm Kết nối.</p> : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Cần quản trị cửa hàng kết nối (quyền Cài đặt).</p>
        )}
      </div>

      {/* 2. Webhook */}
      <div className="space-y-2" data-go-live-step="webhook">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {received > 0 ? <CheckCircle2 className="size-4 text-emerald-600" /> : <MessageCircle className="size-4 text-muted-foreground" />}
          2. Dán URL webhook vào Pancake
        </p>
        {received > 0 ? (
          <p className="text-xs text-muted-foreground">ERP đã nhận {received.toLocaleString("vi-VN")} tin từ fanpage — webhook chạy rồi.</p>
        ) : connected && webhook ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Trong Pancake: Cài đặt page → Webhook → bật sự kiện tin nhắn (messaging) → dán URL này → Lưu. Giữ kín URL: ai có nó gửi được tin giả vào bot.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px]" title={webhook}>
                {webhook}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(webhook).then(() => toast.success("Đã chép URL webhook"))}>
                <Copy className="size-3.5" /> Chép
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Dán xong, nhắn thử một tin vào fanpage — bước này tự đánh dấu xong khi ERP nhận được tin.</p>
          </div>
        ) : connected ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">Máy chủ chưa có khoá bí mật nền tảng — chưa dựng được URL webhook. Báo người vận hành nền tảng.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Làm sau bước 1.</p>
        )}
      </div>

      {/* 3. Bật chatbot */}
      <div className="space-y-2" data-go-live-step="bot">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {view.bot.enabled ? <CheckCircle2 className="size-4 text-emerald-600" /> : <MessageCircle className="size-4 text-muted-foreground" />}
          3. Bật chatbot trả lời khách
        </p>
        {view.bot.enabled ? (
          <p className="text-xs text-muted-foreground">
            Chatbot đang bật.{" "}
            <Link href="/ai/sales-chatbot" className="text-primary hover:underline">
              Chỉnh giọng điệu, phí ship, câu mẫu…
            </Link>
          </p>
        ) : !view.canBot ? (
          <p className="text-xs text-muted-foreground">Cần quản trị cửa hàng bật (quyền cấu hình chatbot).</p>
        ) : view.bot.usesPlatformAi && !view.bot.aiReady ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {view.bot.aiReason}{" "}
            <Link href="/ai/sales-chatbot" className="underline">
              Mở cấu hình chatbot
            </Link>
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={enable} disabled={pending} data-go-live-bot>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Bật chatbot
            </Button>
            <span className="text-xs text-muted-foreground">
              {view.bot.usesPlatformAi ? "Dùng AI có sẵn trong gói — không cần khoá riêng." : "Dùng khoá AI riêng của shop."} Bot đọc giá / tồn từ sản phẩm trong ERP — nên{" "}
              <Link href="/products/import" className="text-primary hover:underline">
                nhập sản phẩm
              </Link>{" "}
              trước.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
