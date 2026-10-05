"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, Loader2, MessageCircle, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { quickConnectFanpageAction, quickEnableBotAction } from "@/lib/actions/go-live";
import { COMPANY } from "@/lib/constants/company";
import type { GoLiveView } from "@/lib/onboarding/go-live";
import type { GoLivePath } from "@/lib/onboarding/go-live-shared";
import { cn } from "@/lib/utils";

const CHOICES: { key: GoLivePath; title: string; hint: string }[] = [
  { key: "DIRECT", title: "Nối thẳng Facebook", hint: "Tôi không dùng phần mềm chat nào — tin tới tức thì · khuyên dùng" },
  { key: "PANCAKE", title: "Tôi dùng Pancake", hint: "Giữ Pancake · không tốn thêm slot Pancake" },
  { key: "OTHER", title: "Tôi dùng phần mềm khác", hint: "Xem các cách nối đang có" },
];

/**
 * Ô «Vào việc ngay» của trang Bắt đầu — KHÔNG BẮT BUỘC PANCAKE (`lib/onboarding/go-live-shared.ts`):
 *  (1) nối kênh bán hàng theo cách shop đang quản lý tin nhắn — nối thẳng Facebook (khuyên dùng) · Pancake · phần mềm khác;
 *  (2) nhận tin khách đầu tiên — Pancake KHÔNG cần webhook (ERP đọc tin qua API, webhook tốn 2 slot Pancake nên chỉ là tuỳ
 *      chọn «nâng cao» cho ai muốn tin tới tức thì);
 *  (3) bật chatbot bằng MỘT nút.
 * Mỗi bước tự hiện «xong» khi dữ liệu thật đã có — không có ô bấm cho xong.
 */
export function GoLiveCard({ view }: { view: GoLiveView }) {
  const [choice, setChoice] = useState<GoLivePath>(view.path ?? "DIRECT");
  const [pageId, setPageId] = useState(view.fanpage?.pageId ?? "");
  const [token, setToken] = useState("");
  const [pending, start] = useTransition();
  const pancakeOn = view.fanpage?.status === "ACTIVE";
  const anyChannel = view.path !== null;
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
    <div className="space-y-5" data-go-live data-go-live-path={view.path ?? "NONE"}>
      {/* 1. Nối kênh bán hàng */}
      <div className="space-y-2" data-go-live-step="channel">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {anyChannel ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Plug className="size-4 text-muted-foreground" />}
          1. Nối kênh bán hàng
        </p>
        {anyChannel ? (
          <ul className="space-y-1 text-xs text-muted-foreground" data-go-live-connected>
            {view.messenger.connected ? <li>Facebook (nối thẳng): page «{view.messenger.pageName}»{view.messenger.mutedByPancake ? " — đang nhường cho Pancake vì cùng page" : ""}.</li> : null}
            {pancakeOn ? <li>Fanpage qua Pancake: page {view.fanpage?.pageId}.</li> : null}
            {view.zalo.connected ? <li>Zalo OA.</li> : null}
            {view.webChat ? <li>Ô chat trên website.</li> : null}
            <li>
              <Link href="/ai/sales-chatbot" className="text-primary hover:underline">
                Thêm / đổi kênh
              </Link>
            </li>
          </ul>
        ) : !view.canConnect ? (
          <p className="text-xs text-muted-foreground">Cần quản trị cửa hàng nối kênh (quyền Cài đặt).</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Hiện bạn trả lời tin nhắn khách bằng gì?</p>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Cách quản lý tin nhắn">
              {CHOICES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={choice === c.key}
                  onClick={() => setChoice(c.key)}
                  data-go-live-choice={c.key}
                  className={cn("rounded-lg border px-3 py-2 text-left", choice === c.key ? "border-primary bg-primary/5" : "hover:bg-muted")}
                >
                  <span className="block text-sm font-semibold">{c.title}</span>
                  <span className="block text-xs text-muted-foreground">{c.hint}</span>
                </button>
              ))}
            </div>

            {choice === "DIRECT" ? (
              <div className="space-y-2" data-go-live-direct>
                <p className="text-xs text-muted-foreground">Đăng nhập Facebook bằng tài khoản quản trị page → cho phép nhắn tin → chọn page. Không cần phần mềm khác, không cần dán gì. Page có gắn Instagram doanh nghiệp thì bot trả lời cả Instagram.</p>
                {view.messenger.appReady ? (
                  <a href="/api/connect/messenger/start" className="inline-flex h-9 items-center rounded-md bg-[#1877F2] px-4 text-sm font-semibold text-white hover:opacity-90" data-go-live-messenger>
                    Kết nối Facebook Page
                  </a>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">Nền tảng chưa bật nối thẳng Facebook — báo người vận hành, hoặc chọn «Tôi dùng Pancake» nếu bạn có Pancake.</p>
                )}
              </div>
            ) : null}

            {choice === "PANCAKE" ? (
              <div className="space-y-2" data-go-live-pancake>
                <p className="text-xs text-muted-foreground">Trong Pancake: Cài đặt page → Công cụ → chép Page ID và Page access token rồi dán vào đây. Không cần bật Webhook của Pancake (không tốn thêm slot): ERP tự đọc tin mới từ Pancake vài phút một lần.</p>
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
            ) : null}

            {choice === "OTHER" ? (
              <div className="space-y-1.5 text-xs text-muted-foreground" data-go-live-other>
                <p>Bot chưa nối trực tiếp với phần mềm của bạn. Bạn vẫn bắt đầu được ngay bằng một trong các cách:</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>
                    <b>Nối thẳng Facebook</b> cho page — rồi TẮT trả lời tự động của phần mềm kia trên page đó, để khách không nhận hai câu trả lời.
                  </li>
                  <li>
                    <b>Zalo OA</b> hoặc <b>ô chat trên website</b> — ở{" "}
                    <Link href="/ai/sales-chatbot" className="text-primary hover:underline">
                      trang Chatbot bán hàng
                    </Link>
                    .
                  </li>
                </ul>
                <p>
                  Muốn bot nối thẳng với phần mềm bạn đang dùng?{" "}
                  <a href={COMPANY.zaloHref} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    Nhắn Zalo hỗ trợ {COMPANY.zalo}
                  </a>{" "}
                  kèm tên phần mềm.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 2. Nhận tin khách đầu tiên */}
      <div className="space-y-2" data-go-live-step="first-message">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {view.messagesReceived > 0 ? <CheckCircle2 className="size-4 text-emerald-600" /> : <MessageCircle className="size-4 text-muted-foreground" />}
          2. Nhận tin khách đầu tiên
        </p>
        {view.messagesReceived > 0 ? (
          <p className="text-xs text-muted-foreground">Đã nhận {view.messagesReceived.toLocaleString("vi-VN")} tin khách — kênh chạy rồi.</p>
        ) : pancakeOn ? (
          <div className="space-y-1.5" data-go-live-pancake-api>
            <p className="text-xs text-muted-foreground">Không cần làm gì thêm: khi bot bật (bước 3), ERP tự đọc tin mới từ Pancake vài phút một lần — không cần Webhook, không tốn thêm slot Pancake. Nhắn thử một tin vào fanpage; bước này tự xong khi ERP nhận được.</p>
            {webhook ? (
              <details className="text-xs text-muted-foreground" data-go-live-webhook>
                <summary className="cursor-pointer">Nâng cao — muốn tin tới tức thì (Webhook của Pancake, tốn 2 slot thuê bao)</summary>
                <div className="mt-1.5 space-y-1.5">
                  <p>Trong Pancake: Cài đặt page → Webhook → bật sự kiện tin nhắn (messaging) → dán URL này → Lưu. Giữ kín URL: ai có nó gửi được tin giả vào bot.</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px]" title={webhook}>
                      {webhook}
                    </code>
                    <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(webhook).then(() => toast.success("Đã chép URL webhook"))}>
                      <Copy className="size-3.5" /> Chép
                    </Button>
                  </div>
                </div>
              </details>
            ) : null}
          </div>
        ) : anyChannel ? (
          <p className="text-xs text-muted-foreground">Nhắn thử một tin vào kênh vừa nối (từ một tài khoản khác) — bước này tự xong khi bot nhận được.</p>
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
