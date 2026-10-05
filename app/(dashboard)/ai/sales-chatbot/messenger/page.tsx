import Link from "next/link";
import { cookies } from "next/headers";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { MESSENGER_PAGES_COOKIE, messengerRedirectUris, openPendingPages } from "@/lib/integrations/messenger/connect";
import { messengerVerifyToken } from "@/lib/integrations/messenger/graph";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { messengerView } from "@/lib/sales-chatbot/messenger";
import { DisconnectButton, PagePicker } from "./messenger-panel";

export const metadata = { title: "Messenger trực tiếp" };

const ERROR_TEXT: Record<string, string> = {
  quyen: "Cần quyền Cài đặt của cửa hàng để kết nối page.",
  app: "Nền tảng chưa cấu hình app Facebook — báo người vận hành.",
  huy: "Bạn đã huỷ ở bước cấp quyền của Facebook.",
  state: "Phiên kết nối hết hạn hoặc không khớp — bấm «Kết nối Facebook Page» lại.",
  khongpage: "Tài khoản Facebook này không quản lý page nào có quyền nhắn tin. Đăng nhập đúng tài khoản quản trị page.",
};

/**
 * MESSENGER TRỰC TIẾP (0207 · lib/sales-chatbot/messenger.ts) — nối fanpage với bot KHÔNG cần Pancake: một nút cấp quyền của
 * Facebook, chọn page, xong. Người vận hành nền tảng (tổ chức nhà) thấy thêm URL webhook + mã xác minh để khai ở app Meta.
 */
export default async function MessengerSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const manage = can(user, "settings:manage");
  const view = await messengerView();
  const pending = manage && user.organization && one("chon") ? await openPendingPages((await cookies()).get(MESSENGER_PAGES_COOKIE)?.value, user.organization.code, user.id) : null;
  const operator = platformOperatorDenial(user) === null;
  const error = one("loi") ? (one("loi") === "fb" ? one("msg") || "Facebook từ chối." : (ERROR_TEXT[one("loi")] ?? "Kết nối chưa xong.")) : null;
  const connected = view.status === "ACTIVE" && view.page;
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="AI · Chatbot bán hàng" title="Messenger trực tiếp" description="Bot trả lời tin nhắn fanpage và Instagram — không cần Pancake" />
      {error ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">{error}</p> : null}
      {one("ok") ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">Đã nối page — nhắn thử một tin vào page để thấy bot trả lời.</p> : null}

      {view.mutedByPancake ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200" data-testid="messenger-muted-by-pancake">
          Page này cũng đang nhận tin qua Pancake. Mỗi page chỉ nhận tin qua MỘT đường để khách không nhận hai câu trả lời — nên bot đang trả lời qua Pancake, đường Messenger trực tiếp tạm nhường. Muốn dùng đường trực tiếp: gỡ «Fanpage qua Pancake» ở Cài đặt → Kết nối.
        </p>
      ) : null}
      <SectionCard title="Page đang nối">
        {!view.appReady ? (
          <p className="text-sm text-muted-foreground">Nền tảng chưa cấu hình app Facebook (FACEBOOK_LOGIN_APP_ID / SECRET) — người vận hành cần khai trước.</p>
        ) : connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="messenger-connected">
            <p className="text-sm">
              <span className="font-semibold">{view.page!.name}</span> <span className="text-xs text-muted-foreground">(Page ID {view.page!.id})</span> — bot nhận và trả lời tin nhắn qua Messenger.
              {view.instagram ? (
                <span className="mt-1 block" data-testid="messenger-instagram">
                  Instagram <span className="font-semibold">@{view.instagram.username || view.instagram.id}</span> — bot trả lời cả tin nhắn Instagram (DM).
                </span>
              ) : (
                <span className="mt-1 block text-xs text-muted-foreground">Page chưa gắn tài khoản Instagram doanh nghiệp — gắn trong Meta Business Suite rồi bấm «Đổi page» để nối cả Instagram.</span>
              )}
            </p>
            {manage ? (
              <div className="flex items-center gap-2">
                <a href="/api/connect/messenger/start" className="text-sm text-primary underline underline-offset-2">
                  Đổi page
                </a>
                <DisconnectButton />
              </div>
            ) : null}
          </div>
        ) : manage ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Đăng nhập Facebook bằng tài khoản QUẢN TRỊ page, cho phép quyền nhắn tin, chọn page. Token page được mã hoá trong ERP; có thể gỡ bất cứ lúc nào.
            </p>
            <a href="/api/connect/messenger/start" className="inline-flex h-9 items-center rounded-md bg-[#1877F2] px-4 text-sm font-semibold text-white hover:opacity-90" data-testid="messenger-connect">
              Kết nối Facebook Page
            </a>
            {view.status && view.status !== "ACTIVE" && view.page ? <p className="text-xs text-amber-700 dark:text-amber-400">Page {view.page.name} đã lưu nhưng chưa bật — bấm kết nối lại.</p> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Cần quản trị cửa hàng (quyền Cài đặt) kết nối.</p>
        )}
        {pending && pending.length ? <PagePicker pages={pending.map((p) => ({ id: p.id, name: p.name }))} /> : null}
      </SectionCard>

      <SectionCard title="Lưu ý">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Bot dùng chung cấu hình, sản phẩm, câu mẫu, follow-up của <Link href="/ai/sales-chatbot" className="text-primary underline">Chatbot bán hàng</Link>.</li>
          <li>Nhân viên trả lời trong Hộp thư Meta Business Suite ⇒ bot tự nhường 30 phút cho hội thoại đó.</li>
          <li>Không dùng cùng lúc với «Fanpage qua Pancake» cho CÙNG một page — khách sẽ nhận hai câu trả lời.</li>
          <li>Khách bình luận dưới bài viết ⇒ bot trả lời bằng TIN RIÊNG (không công khai). Page nối trước 05/10/2026: bấm «Đổi page» một lần để bật.</li>
        </ul>
      </SectionCard>

      {operator ? (
        <SectionCard title="Người vận hành nền tảng — khai webhook ở app Meta (một lần cho mọi cửa hàng)">
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Callback URL</dt>
            <dd>
              <code className="break-all text-xs">{`${env.appUrl}/api/webhooks/messenger`}</code>
            </dd>
            <dt className="text-muted-foreground">Verify token</dt>
            <dd>
              <code className="break-all text-xs" data-testid="messenger-verify-token">
                {messengerVerifyToken()}
              </code>
            </dd>
            <dt className="text-muted-foreground">Trường đăng ký</dt>
            <dd className="text-xs">Page: messages · messaging_postbacks · message_echoes · feed — Instagram: messages · messaging_postbacks</dd>
            <dt className="text-muted-foreground">OAuth redirect</dt>
            <dd className="space-y-1">
              {/* Một đường cho MỖI gốc phần mềm — khách Chốt Đơn bấm kết nối từ app.chotdontudong.com. */}
              {messengerRedirectUris().map((u) => (
                <code key={u} className="block break-all text-xs">
                  {u}
                </code>
              ))}
            </dd>
          </dl>
        </SectionCard>
      ) : null}
    </div>
  );
}
