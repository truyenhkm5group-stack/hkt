import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { CHANNELS_RETURN_COOKIE, CHANNELS_RETURN_PARAM, CHANNELS_ROUTE, CONNECT_RESULT_PARAMS } from "@/lib/channels/overview-shared";
import { ClearChannelsReturn } from "../../channels/clear-return-cookie";
import { env } from "@/lib/env";
import { loadPendingPages, messengerRedirectUris } from "@/lib/integrations/messenger/connect";
import { DISCOVERY_REASONS, MESSENGER_REQUIRED_PERMISSIONS, WEBHOOK_STATES, messengerApp, messengerVerifyToken, type DiscoveryDiagnostic, type DiscoveryReason, type PageWebhookCheck, type WebhookState } from "@/lib/integrations/messenger/graph";
import { DISCOVERY_GUIDE, GUIDE_ACTOR_LABEL, PERMISSION_STATUS_LABEL, WEBHOOK_GUIDE, appRoleText, classifyMetaConnectError, configPermissionAudit, loginConfigMode, permissionTable, webhookRow, type Guide } from "@/lib/integrations/messenger/permission-guide";
import { getSettingJson } from "@/lib/settings";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { messengerView } from "@/lib/sales-chatbot/messenger";
import { loadPageOverrides } from "@/lib/sales-chatbot/page-config";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { DisconnectButton, PageManager, PagePicker } from "./messenger-panel";
import { WebhookCheckPanel } from "./webhook-check";

export const metadata = { title: "Messenger trực tiếp" };

const ERROR_TEXT: Record<string, string> = {
  quyen: "Cần quyền Cài đặt của cửa hàng để kết nối page.",
  app: "Nền tảng chưa cấu hình app Facebook — báo người vận hành.",
  huy: "Bạn đã huỷ ở bước cấp quyền của Facebook.",
  state: "Phiên kết nối hết hạn hoặc không khớp — bấm «Kết nối Facebook Page» lại.",
  khongpage: "Chưa nối được page nào — xem «Chẩn đoán lần kết nối gần nhất» bên dưới.",
};

type StoredDiagnostic = Partial<DiscoveryDiagnostic> & { at?: string; by?: string };
type StoredWebhookCheck = { at?: string; pages?: (PageWebhookCheck & { name?: string })[] };

const isReason = (x: string): x is DiscoveryReason => (DISCOVERY_REASONS as readonly string[]).includes(x);
const isWebhookState = (x: unknown): x is WebhookState => typeof x === "string" && (WEBHOOK_STATES as readonly string[]).includes(x);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const fmtAt = (iso: string | undefined | null) => (iso ? new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** Hướng xử lý của MỘT lý do: ai làm + các bước. */
function GuideBlock({ guide }: { guide: Guide }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{GUIDE_ACTOR_LABEL[guide.actor]}:</p>
      <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
        {guide.steps.map((st) => (
          <li key={st}>{st}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Chẩn đoán lần kết nối gần nhất (`messenger.lastConnectDiagnostic`, callback ghi): DANH SÁCH quyền đã cấp / bị bỏ chọn / còn
 * thiếu, vai trò của người bấm trong app, số page Meta trả — kèm hướng xử lý của lý do. Không token nào được lưu ở đây.
 */
function DiagnosticCard({ d, reason }: { d: StoredDiagnostic; reason: DiscoveryReason | null }) {
  const granted = d.granted === null || d.granted === undefined ? null : strs(d.granted);
  const declined = strs(d.declined);
  const missing = strs(d.missing);
  const table = permissionTable({ granted, declined }, MESSENGER_REQUIRED_PERMISSIONS);
  const role = appRoleText(d.appRole ?? null);
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "—");
  return (
    <SectionCard title="Chẩn đoán lần kết nối gần nhất" description={`Lúc ${fmtAt(d.at)} — đọc từ Facebook ngay sau hộp thoại cấp quyền.`}>
      <div className="space-y-3 text-sm" data-testid="messenger-diagnostic" data-reason={reason ?? "OK"}>
        {reason ? <p className="font-semibold text-rose-700 dark:text-rose-300">{DISCOVERY_GUIDE[reason].title}</p> : <p className="text-emerald-700 dark:text-emerald-400">Đủ quyền, có page nhắn tin được.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Quyền bắt buộc</th>
                <th className="py-1 pr-2 font-medium">Trạng thái</th>
                <th className="py-1 font-medium">Vì sao cần</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {table.map((r) => (
                <tr key={r.permission} data-testid="messenger-permission-row" data-status={r.status}>
                  <td className="py-1 pr-2 font-mono">{r.permission}</td>
                  <td className={r.status === "GRANTED" ? "py-1 pr-2 text-emerald-700 dark:text-emerald-400" : r.status === "UNKNOWN" ? "py-1 pr-2 text-muted-foreground" : "py-1 pr-2 font-medium text-destructive"}>{PERMISSION_STATUS_LABEL[r.status]}</td>
                  <td className="py-1 text-muted-foreground">{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-1 text-xs sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">Quyền Facebook đã cấp</dt>
          <dd className="break-words font-mono" data-testid="messenger-granted">
            {granted === null ? "không đọc được" : list(granted)}
          </dd>
          <dt className="text-muted-foreground">Quyền bị bỏ chọn</dt>
          <dd className="break-words font-mono" data-testid="messenger-declined">
            {list(declined)}
          </dd>
          <dt className="text-muted-foreground">Quyền bắt buộc còn thiếu</dt>
          <dd className="break-words font-mono" data-testid="messenger-missing">
            {list(missing)}
          </dd>
          {role ? (
            <>
              <dt className="text-muted-foreground">Vai trò trong app Meta</dt>
              <dd>{role}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Page Facebook trả về</dt>
          <dd>
            {d.accountsSeen ?? 0} page{d.viaBusiness ? ` (${d.viaBusiness} qua Business Portfolio)` : ""} · nhắn tin được: {d.eligible ?? 0}
          </dd>
        </dl>
        {reason ? <GuideBlock guide={DISCOVERY_GUIDE[reason]} /> : null}
      </div>
    </SectionCard>
  );
}

/**
 * MESSENGER TRỰC TIẾP (0207 · lib/sales-chatbot/messenger.ts) — nối fanpage với bot KHÔNG cần Pancake: một nút cấp quyền của
 * Facebook, chọn page, xong. Người vận hành nền tảng (tổ chức nhà) thấy thêm URL webhook + mã xác minh để khai ở app Meta.
 */
export default async function MessengerSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  // Lượt «Kết nối Facebook» bắt đầu từ màn Kênh kết nối ⇒ callback (không đổi) về đây, chuyển tiếp nguyên kết quả sang màn đó.
  // Cờ đi bằng tham số khi qua callback (callback đã xoá cookie); cookie còn sống chỉ khi lượt dừng trước callback (lỗi ở route
  // start) hoặc bỏ dở — trang này gỡ nó ngay (ClearChannelsReturn) để lượt sau không bị chuyển nhầm.
  const returnCookie = (await cookies()).get(CHANNELS_RETURN_COOKIE)?.value === "1";
  if ((one(CHANNELS_RETURN_PARAM) === "1" || returnCookie) && (one("chon") || one("ok") || one("loi"))) {
    const q = new URLSearchParams(CONNECT_RESULT_PARAMS.filter((k) => one(k)).map((k) => [k, one(k)]));
    redirect(`${CHANNELS_ROUTE}?${q}`);
  }
  const manage = can(user, "settings:manage");
  const view = await messengerView();
  const canConfig = can(user, SALES_CHATBOT_MANAGE);
  const overrides = canConfig ? await loadPageOverrides() : {};
  const pending = manage && user.organization && one("chon") ? await loadPendingPages(user.organization.code, user.id) : null;
  const operator = platformOperatorDenial(user) === null;
  const lydo = one("lydo");
  const reasonQ = isReason(lydo) ? lydo : null;
  const ct = one("ct").slice(0, 300);
  // Câu gốc của Meta (`msg`) chỉ cho người vận hành; người khác thấy câu đã ánh xạ (lỗi cấu hình đăng nhập ⇒ việc của nền tảng).
  const loginMode = loginConfigMode(env.oauth.facebookMessengerLoginConfigId);
  const metaErr = one("loi") === "fb" || one("loi") === "meta" ? classifyMetaConnectError(one("loi") === "meta" ? { errorCode: one("ma"), errorReason: one("ly") } : { message: one("msg") || "Facebook từ chối." }, { configId: loginMode.mode === "CONFIG" ? loginMode.configId : null, appId: messengerApp()?.appId ?? null }) : null;
  const error = one("loi")
    ? one("loi") === "fb" || one("loi") === "meta"
      ? metaErr
        ? `${metaErr.customer.title} — ${metaErr.customer.action}`
        : "Facebook chưa cho kết nối lúc này."
      : one("loi") === "khongpage" && reasonQ
        ? `${DISCOVERY_GUIDE[reasonQ].title}${ct ? ` — ${ct}` : ""}. Xem hướng xử lý bên dưới.`
        : (ERROR_TEXT[one("loi")] ?? "Kết nối chưa xong.")
    : null;
  // Chẩn đoán đã lưu (callback ghi) là nguồn của DANH SÁCH quyền; lý do trên query string thắng cho dòng tiêu đề nếu có.
  const stored = manage ? await getSettingJson<StoredDiagnostic | null>("messenger.lastConnectDiagnostic", null) : null;
  const storedReason = stored && typeof stored.reason === "string" && isReason(stored.reason) ? stored.reason : null;
  const diagReason = reasonQ ?? storedReason;
  const showDiag = Boolean(stored && (diagReason || one("loi") === "khongpage"));
  const configAudit = configPermissionAudit(stored && Array.isArray(stored.granted) ? strs(stored.granted) : null, loginMode, MESSENGER_REQUIRED_PERMISSIONS);
  const operatorErrorLines = operator ? [...(metaErr ? [metaErr.operator] : []), ...(one("loi") ? configAudit.operator : [])] : [];
  const webhookParam = one("webhook");
  const webhookQ = isWebhookState(webhookParam) && webhookParam !== "OK" ? webhookParam : null;
  const whStored = manage ? await getSettingJson<StoredWebhookCheck | null>("messenger.lastWebhookCheck", null) : null;
  const activePages = view.pages.filter((p) => p.status === "ACTIVE");
  const connected = activePages.length > 0;
  const activeIds = new Set(activePages.filter((p) => p.kind === "PAGE").map((p) => p.id));
  const whRows = (Array.isArray(whStored?.pages) ? whStored.pages : [])
    .filter((c) => c && typeof c.pageId === "string" && activeIds.has(c.pageId) && isWebhookState(c.state))
    .map((c) => webhookRow({ pageId: c.pageId, state: c.state, missingFields: strs(c.missingFields), token: c.token ?? { state: "UNKNOWN", expiresAt: null, why: null }, detail: typeof c.detail === "string" ? c.detail : null }, typeof c.name === "string" ? c.name : c.pageId));
  return (
    <div className="space-y-5">
      {returnCookie ? <ClearChannelsReturn /> : null}
      <PageHeader eyebrow="AI · Chatbot bán hàng" title="Messenger trực tiếp" description="Bot trả lời tin nhắn fanpage và Instagram — không cần Pancake" />
      {error ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">{error}</p> : null}
      {operatorErrorLines.length ? (
        <ul className="space-y-0.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="messenger-operator-error">
          {operatorErrorLines.map((t) => (
            <li key={t} className="break-words">
              Người vận hành: {t}
            </li>
          ))}
        </ul>
      ) : null}
      {one("ok") ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">Đã nối page — nhắn thử một tin vào page để thấy bot trả lời.</p> : null}
      {webhookQ ? (
        <div className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200" data-testid="messenger-webhook-warning">
          <p className="font-medium">Page đã lưu nhưng chưa nhận tin được: {WEBHOOK_GUIDE[webhookQ].title.toLowerCase()}.</p>
          <GuideBlock guide={WEBHOOK_GUIDE[webhookQ]} />
        </div>
      ) : null}
      {showDiag && stored ? <DiagnosticCard d={stored} reason={diagReason} /> : reasonQ ? <GuideBlock guide={DISCOVERY_GUIDE[reasonQ]} /> : null}

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

      {connected && manage ? (
        <SectionCard title="Webhook theo page" description="Page đã lưu trong ERP chưa chắc đang gửi tin về: Meta có thể gỡ đăng ký sau đó. «Kiểm tra lại» chỉ đọc ở Facebook, không đổi gì.">
          <WebhookCheckPanel initial={whRows} initialAt={whRows.length ? (whStored?.at ?? null) : null} manage={manage} actorLabel={GUIDE_ACTOR_LABEL} />
        </SectionCard>
      ) : null}

      <SectionCard title="Lưu ý">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Xem MỌI Page của cửa hàng (Facebook trực tiếp, qua Pancake, Zalo) cùng sức khoẻ ở{" "}
            <Link href={CHANNELS_ROUTE} className="text-primary underline" data-testid="messenger-channels-link">
              Kênh kết nối
            </Link>
            .
          </li>
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
