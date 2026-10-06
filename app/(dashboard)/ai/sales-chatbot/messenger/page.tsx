import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { loadPendingPages, messengerRedirectUris } from "@/lib/integrations/messenger/connect";
import { messengerVerifyToken } from "@/lib/integrations/messenger/graph";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { messengerView } from "@/lib/sales-chatbot/messenger";
import { loadPageOverrides } from "@/lib/sales-chatbot/page-config";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { DisconnectButton, PageManager, PagePicker } from "./messenger-panel";

export const metadata = { title: "Messenger trực tiếp" };

const ERROR_TEXT: Record<string, string> = {
  quyen: "Cần quyền Cài đặt của cửa hàng để kết nối page.",
  app: "Nền tảng chưa cấu hình app Facebook — báo người vận hành.",
  huy: "Bạn đã huỷ ở bước cấp quyền của Facebook.",
  state: "Phiên kết nối hết hạn hoặc không khớp — bấm «Kết nối Facebook Page» lại.",
  khongpage: "Tài khoản Facebook này không quản lý page nào có quyền nhắn tin. Đăng nhập đúng tài khoản quản trị page.",
};

/**
 * Lý do CỤ THỂ khi OAuth xong mà không nối được page (graph.ts `diagnosePageDiscovery`) — mỗi lý do một việc phải làm. `{ct}` là
 * phần chi tiết máy chủ đọc được từ Meta (tên quyền / tên page / quyền trên page), không có token.
 */
const DISCOVERY_TEXT: Record<string, string> = {
  PERMISSION_DECLINED: "Ở hộp thoại Facebook, quyền {ct} đã bị bỏ chọn. Bấm «Kết nối Facebook Page» lại — Facebook sẽ hỏi lại; giữ nguyên MỌI quyền và tích đủ các page cần nối.",
  PERMISSION_NOT_GRANTED: "Facebook không cấp quyền {ct} cho app (hộp thoại không hề hỏi quyền này). Thường do app Meta còn ở chế độ Development mà tài khoản này không có vai trò trong app, hoặc quyền chưa được duyệt Advanced Access — báo người vận hành kiểm tra app ở Meta Developer → App Review.",
  NO_PAGES: "Facebook trả về 0 page cho tài khoản này dù đã cấp quyền xem page ({ct}). Tài khoản chưa có quyền với page nào — vào Meta Business Suite → Cài đặt → Trang, thêm tài khoản này với quyền Toàn quyền hoặc Nhắn tin, rồi kết nối lại.",
  NO_PAGE_TOKEN: "Facebook thấy {ct} nhưng không cấp cho app quyền trên page nào — thường do ở bước «Chọn trang» chưa tích page, hoặc page chỉ thuộc Business Portfolio mà tài khoản không có quyền trực tiếp. Bấm kết nối lại và tích đủ page.",
  NO_MESSAGING_TASK: "Tài khoản có page nhưng không có quyền Nhắn tin trên page nào: {ct}. Cần quyền Nhắn tin (Messages) hoặc Toàn quyền trên page.",
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
  const canConfig = can(user, SALES_CHATBOT_MANAGE);
  const overrides = canConfig ? await loadPageOverrides() : {};
  const pending = manage && user.organization && one("chon") ? await loadPendingPages(user.organization.code, user.id) : null;
  const operator = platformOperatorDenial(user) === null;
  const lydo = one("lydo");
  const error = one("loi")
    ? one("loi") === "fb"
      ? one("msg") || "Facebook từ chối."
      : one("loi") === "khongpage" && DISCOVERY_TEXT[lydo]
        ? DISCOVERY_TEXT[lydo].replace("{ct}", one("ct").slice(0, 300) || "—")
        : (ERROR_TEXT[one("loi")] ?? "Kết nối chưa xong.")
    : null;
  const activePages = view.pages.filter((p) => p.status === "ACTIVE");
  const connected = activePages.length > 0;
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
      <SectionCard title={connected ? `Page đang nối (${activePages.filter((p) => p.kind === "PAGE").length})` : "Page đang nối"} description="Một lần đăng nhập Facebook nối được nhiều page; mỗi page bật / tạm dừng AI riêng, lỗi của page này không làm dừng page khác.">
        {!view.appReady ? (
          <p className="text-sm text-muted-foreground">Nền tảng chưa cấu hình app Facebook (FACEBOOK_LOGIN_APP_ID / SECRET) — người vận hành cần khai trước.</p>
        ) : (
          <div className="space-y-3">
            {view.pages.length ? <PageManager pages={view.pages} manage={manage} canConfig={canConfig} overrides={overrides} /> : null}
            {manage ? (
              <div className="flex flex-wrap items-center gap-3">
                <a href="/api/connect/messenger/start" className="inline-flex h-9 items-center rounded-md bg-[#1877F2] px-4 text-sm font-semibold text-white hover:opacity-90" data-testid="messenger-connect">
                  {connected ? "Thêm / nối lại page" : "Kết nối Facebook Page"}
                </a>
                {connected ? <DisconnectButton /> : null}
                <span className="text-xs text-muted-foreground">Đăng nhập Facebook bằng tài khoản QUẢN TRỊ page, cho phép quyền nhắn tin, chọn các page. Token page được mã hoá trong ERP; gỡ được bất cứ lúc nào.</span>
              </div>
            ) : connected ? null : (
              <p className="text-sm text-muted-foreground">Cần quản trị cửa hàng (quyền Cài đặt) kết nối.</p>
            )}
          </div>
        )}
        {pending && pending.length ? <PagePicker pages={pending.map((p) => ({ id: p.id, name: p.name }))} connected={activePages.map((p) => p.id)} /> : null}
      </SectionCard>

      <SectionCard title="Lưu ý">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Bot dùng chung cấu hình, sản phẩm, câu mẫu, follow-up của <Link href="/ai/sales-chatbot" className="text-primary underline">Chatbot bán hàng</Link>.</li>
          <li>Nhân viên trả lời trong Hộp thư Meta Business Suite ⇒ bot tự nhường 30 phút cho hội thoại đó.</li>
          <li>Mỗi page chỉ nhận tin qua MỘT đường: page đang chạy qua «Fanpage qua Pancake» không nối thêm ở đây được (và ngược lại) — để khách không nhận hai câu trả lời.</li>
          <li>Khách bình luận dưới bài viết ⇒ bot trả lời bằng TIN RIÊNG (không công khai). Page nối trước 05/10/2026: bấm «Thêm / nối lại page» một lần để bật.</li>
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
