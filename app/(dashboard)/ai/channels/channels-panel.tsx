"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { pickMessengerPagesAction, setMessengerPagesAiAction } from "@/lib/actions/messenger";
import {
  CHANNEL_HEALTH_LABEL,
  CHANNEL_OWNER_LABEL,
  CHANNEL_PLATFORM_LABEL,
  CHANNELS_RETURN_COOKIE,
  CHANNELS_RETURN_TTL_SEC,
  CHANNELS_ROUTE,
  aiControlOf,
  channelHealth,
  connectionLabel,
  customerSafeMessage,
  initialOf,
  lastSyncOf,
  pageAvatarUrl,
  sortChannelRows,
  type ChannelHealthLevel,
  type WebhookFact,
} from "@/lib/channels/overview-shared";
import type { ChannelRowView } from "@/lib/channels/overview";
import type { CustomerIssue } from "@/lib/integrations/messenger/permission-guide";
import { CUSTOMER_WEBHOOK_TEXT } from "@/lib/integrations/messenger/permission-guide";
import type { WebhookState } from "@/lib/integrations/messenger/graph";
import { vnShortStamp } from "@/lib/format";
import { DIRECT_CONNECT_SOON_LABEL } from "@/lib/channels/direct-connect-shared";
import { cn } from "@/lib/utils";
import { recheckMessengerWebhooksAction } from "../sales-chatbot/messenger/actions";

const CONNECT_START = "/api/connect/messenger/start";

type Outcome = { kind: "ERROR"; issue: CustomerIssue } | { kind: "PICK" } | { kind: "OK"; webhook: WebhookState | null } | null;

const TONE: Record<ChannelHealthLevel, string> = {
  READY: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900",
  NEEDS_ACTION: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-900",
  DISCONNECTED: "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:ring-rose-900",
};

/** Bắt đầu lượt «Kết nối Facebook» từ màn này: đánh dấu để trang Messenger chuyển kết quả callback về đây, rồi đi ĐÚNG route start. */
function startConnect() {
  document.cookie = `${CHANNELS_RETURN_COOKIE}=1; path=/; max-age=${CHANNELS_RETURN_TTL_SEC}; samesite=lax`;
  window.location.href = CONNECT_START;
}

/**
 * Cổng nối thẳng Facebook (lib/channels/direct-connect-shared.ts): máy chủ quyết, panel chỉ đọc. Đóng ⇒ nút chính thành ô tắt
 * «Nối thẳng Facebook — sắp mở», nút «Kết nối lại» không vẽ — KHÔNG phần tử nào gọi `startConnect` (/api/connect/messenger/start).
 */
const DirectConnectContext = createContext(false);

function ConnectButton({ appReady, label = "Kết nối Facebook", variant = "brand" }: { appReady: boolean; label?: string; variant?: "brand" | "outline" }) {
  const directConnect = useContext(DirectConnectContext);
  if (!appReady) return null;
  if (!directConnect) {
    return variant === "brand" ? (
      <span aria-disabled="true" className="inline-flex h-9 cursor-not-allowed items-center rounded-md border border-dashed px-4 text-sm font-medium text-muted-foreground" data-testid="channels-connect-soon">
        {DIRECT_CONNECT_SOON_LABEL}
      </span>
    ) : null;
  }
  return variant === "brand" ? (
    <button type="button" onClick={startConnect} className="inline-flex h-9 items-center rounded-md bg-[#1877F2] px-4 text-sm font-semibold text-white hover:opacity-90" data-testid="channels-connect">
      {label}
    </button>
  ) : (
    <Button type="button" size="sm" variant="outline" className="h-8" onClick={startConnect}>
      {label}
    </Button>
  );
}

function Avatar({ row }: { row: ChannelRowView }) {
  const url = pageAvatarUrl(row);
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element -- ảnh đại diện CÔNG KHAI của page Facebook (không cần quyền); hỏng ⇒ chữ cái đầu
    return <img src={url} alt="" width={40} height={40} loading="lazy" className="size-10 shrink-0 rounded-full border bg-muted object-cover" onError={() => setBroken(true)} />;
  }
  return (
    <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold", row.platform === "ZALO" ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200" : row.platform === "INSTAGRAM" ? "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200" : "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200")}>
      {initialOf(row.name)}
    </span>
  );
}

function IssueBox({ issue, manage, appReady, onRecheck }: { issue: CustomerIssue; manage: boolean; appReady: boolean; onRecheck?: () => void }) {
  const reconnect = manage && issue.who === "SHOP" && /Kết nối (lại|Facebook)/.test(issue.action);
  const recheck = manage && onRecheck && /Kiểm tra lại/.test(issue.action);
  return (
    <div className="mt-2 space-y-1.5 rounded-md bg-muted/60 px-3 py-2 text-sm" data-testid="channels-issue" data-who={issue.who}>
      <p className="font-medium">{issue.title}</p>
      <p className="text-muted-foreground">{issue.who === "SUPPORT" ? "Đội hỗ trợ: " : "Việc cần làm: "}{issue.action}</p>
      {reconnect || recheck ? (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {reconnect ? <ConnectButton appReady={appReady} label="Kết nối lại" variant="outline" /> : null}
          {recheck ? (
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={onRecheck}>
              Kiểm tra lại
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChannelRow({ row, webhook, appReady, manage, operator, extraTechnical, busy, onToggleAi, onRecheck }: { row: ChannelRowView; webhook: WebhookFact | null; appReady: boolean; manage: boolean; operator: boolean; extraTechnical: string | null; busy: boolean; onToggleAi: (row: ChannelRowView, on: boolean) => void; onRecheck: () => void }) {
  const health = channelHealth(row, webhook, appReady);
  const ai = aiControlOf(row);
  const sync = lastSyncOf(row);
  const conn = connectionLabel(row);
  const technical = operator ? [...(row.technical ?? []), ...(extraTechnical ? [extraTechnical] : [])] : [];
  return (
    <li className="px-3 py-3" data-testid="channels-row" data-page={row.pageId} data-health={health.level} data-owner={row.owner ?? "NONE"}>
      <div className="flex items-start gap-3">
        <Avatar row={row} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 break-words text-sm font-semibold">{row.name}</p>
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium ring-1", TONE[health.level])} data-testid="channels-health">
              {CHANNEL_HEALTH_LABEL[health.level]}
            </span>
          </div>
          <p className="break-all text-xs text-muted-foreground">
            {CHANNEL_PLATFORM_LABEL[row.platform]} · {row.platform === "ZALO" ? "OA ID" : row.platform === "INSTAGRAM" ? "ID" : "Page ID"} {row.pageId}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
            <dt className="text-muted-foreground">Kết nối</dt>
            <dd>{conn}</dd>
            <dt className="text-muted-foreground">Nhận tin qua</dt>
            <dd data-testid="channels-owner">{row.owner ? CHANNEL_OWNER_LABEL[row.owner] : "—"}</dd>
            <dt className="text-muted-foreground">Đồng bộ cuối</dt>
            <dd>{sync ? vnShortStamp(sync) : "Chưa nhận tin"}</dd>
            <dt className="text-muted-foreground">AI trả lời</dt>
            <dd>
              {ai.kind === "PAGE" && ai.on !== null ? (
                <label className="inline-flex items-center gap-2">
                  <Switch size="sm" checked={ai.on} disabled={!manage || busy} onCheckedChange={(v) => onToggleAi(row, v)} aria-label={`AI trả lời cho ${row.name}`} data-testid="channels-ai-toggle" />
                  <span>{ai.on ? "Bật" : "Tạm dừng"}</span>
                </label>
              ) : (
                <span className="text-muted-foreground">Theo cấu hình chung</span>
              )}
            </dd>
          </dl>
          {health.issue ? <IssueBox issue={health.issue} manage={manage} appReady={appReady} onRecheck={row.owner === "MESSENGER" ? onRecheck : undefined} /> : null}
          {health.note ? <p className="text-xs text-muted-foreground">{health.note}</p> : null}
          {technical.length ? (
            <details className="text-xs" data-testid="channels-technical">
              <summary className="cursor-pointer text-muted-foreground">Chi tiết kỹ thuật (người vận hành)</summary>
              <ul className="mt-1 space-y-0.5 break-words font-mono text-[11px] text-muted-foreground">
                {technical.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Bước «Chọn Page» sau khi Facebook trả danh sách (danh sách + quyền niêm phong ở máy chủ; client chỉ gửi MÃ page). */
function PagePickStep({ pages, connected, operator, onDone }: { pages: { id: string; name: string }[]; connected: string[]; operator: boolean; onDone: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(pages.filter((p) => !connected.includes(p.id)).map((p) => p.id)));
  const [pending, start] = useTransition();
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? pages.filter((p) => p.name.toLowerCase().includes(k) || p.id.includes(k)) : pages;
  }, [pages, q]);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const submit = () =>
    start(async () => {
      const r = await pickMessengerPagesAction([...picked]);
      if ("error" in r) {
        toast.error(customerSafeMessage(r.error, operator, "Chưa kết nối được Page đã chọn — bấm «Kết nối lại»; nếu vẫn lỗi, liên hệ đội hỗ trợ."));
        return;
      }
      toast.success(customerSafeMessage(r.message, operator, "Đã lưu các Page đã chọn — Page nào chưa kết nối được sẽ hiện «Cần xử lý» hoặc «Mất kết nối» bên dưới."));
      await onDone();
    });
  return (
    <SectionCard title="Chọn các Page cần dùng" description="Tick những Page bạn muốn bot trả lời. ERP lưu Page, đăng ký nhận tin nhắn mới rồi kiểm tra ngay.">
      <div className="space-y-2" data-testid="channels-page-picker">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-9 min-w-0 flex-1 basis-48" placeholder="Tìm Page theo tên hoặc mã" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm Page" />
          <Button type="button" size="sm" variant="outline" className="h-9" onClick={() => setPicked(new Set(pages.map((p) => p.id)))}>
            Chọn tất cả
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-9" onClick={() => setPicked(new Set())}>
            Bỏ chọn
          </Button>
        </div>
        <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
          {shown.map((p) => (
            <li key={p.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                <input type="checkbox" className="size-5" checked={picked.has(p.id)} onChange={() => toggle(p.id)} data-testid="channels-pick" />
                <span className="min-w-0 flex-1 break-words text-sm">
                  {p.name} <span className="text-xs text-muted-foreground">(Page ID {p.id})</span>
                  {connected.includes(p.id) ? <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">đã kết nối — chọn để nối lại</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <Button type="button" className="w-full sm:w-auto" onClick={submit} disabled={pending || picked.size === 0} data-testid="channels-pick-submit">
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Kết nối {picked.size} Page đã chọn
        </Button>
      </div>
    </SectionCard>
  );
}

const STEPS = ["Kết nối Facebook", "Chọn Page", "Đăng ký nhận tin", "Kiểm tra quyền", "Kiểm tra sức khoẻ", "Sẵn sàng"] as const;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex gap-1.5 overflow-x-auto pb-1 text-xs" aria-label="Các bước kết nối" data-testid="channels-steps" data-step={current}>
      {STEPS.map((s, i) => (
        <li key={s} className={cn("flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 ring-1", i < current ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900" : i === current ? "bg-primary text-primary-foreground ring-primary" : "text-muted-foreground ring-border")} aria-current={i === current ? "step" : undefined}>
          <span className="font-semibold">{i + 1}</span> {s}
        </li>
      ))}
    </ol>
  );
}

export function ChannelsPanel({ rows, appReady, botEnabled, manage, operator, directConnect = false, outcome, operatorDetail, operatorNotes = null, pending }: { rows: ChannelRowView[]; appReady: boolean; botEnabled: boolean; manage: boolean; operator: boolean; directConnect?: boolean; outcome: Outcome; operatorDetail: string[] | null; operatorNotes?: string[] | null; pending: { id: string; name: string }[] | null }) {
  const router = useRouter();
  const [checks, setChecks] = useState<Record<string, { fact: WebhookFact; detail: string | null }>>({});
  const [checking, startCheck] = useTransition();
  const [toggling, startToggle] = useTransition();
  const [checkedNote, setCheckedNote] = useState<string | null>(null);

  // Đã quay về từ lượt kết nối ⇒ gỡ cờ chuyển tiếp (lượt sau bắt đầu từ trang Messenger thì về lại trang đó).
  useEffect(() => {
    if (outcome) document.cookie = `${CHANNELS_RETURN_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }, [outcome]);

  const recheck = async () => {
    const r = await recheckMessengerWebhooksAction();
    if ("error" in r) {
      toast.error("Chưa kiểm tra được lúc này — thử lại sau ít phút.");
      return;
    }
    setChecks(Object.fromEntries(r.rows.map((w) => [w.pageId, { fact: { state: w.state, at: r.checkedAt }, detail: w.detail ? `Kiểm tra lúc ${r.checkedAt}: ${w.label} — ${w.detail}` : `Kiểm tra lúc ${r.checkedAt}: ${w.label}` }])));
    setCheckedNote(`Đã kiểm tra ${r.rows.length} Page lúc ${vnShortStamp(r.checkedAt)}${r.truncated ? ` (còn ${r.truncated} Page chưa kiểm — bấm lại)` : ""}.`);
  };
  const onRecheck = () => startCheck(recheck);
  const onToggleAi = (row: ChannelRowView, on: boolean) =>
    startToggle(async () => {
      const r = await setMessengerPagesAiAction([row.pageId], on);
      if ("error" in r) toast.error(customerSafeMessage(r.error, operator, "Chưa đổi được — thử lại sau ít phút."));
      else {
        toast.success(on ? `Đã bật AI cho «${row.name}».` : `Đã tạm dừng AI cho «${row.name}» — nhân viên trả lời.`);
        router.refresh();
      }
    });
  const afterPick = async () => {
    await recheck();
    router.replace(`${CHANNELS_ROUTE}?ok=1`, { scroll: false });
  };

  const live = rows.filter((r) => connectionLabel(r) !== "Đã gỡ");
  const removed = rows.filter((r) => connectionLabel(r) === "Đã gỡ");
  const evaluated = sortChannelRows(live.map((r) => ({ row: r, name: r.name, level: channelHealth(r, checks[r.pageId]?.fact ?? r.webhook, appReady).level })));
  const counts = { READY: 0, NEEDS_ACTION: 0, DISCONNECTED: 0 } as Record<ChannelHealthLevel, number>;
  for (const e of evaluated) counts[e.level] += 1;
  const hasDirect = live.some((r) => r.owner === "MESSENGER");
  const connectedIds = rows.filter((r) => r.direct?.status === "ACTIVE").map((r) => r.pageId);
  const step = outcome?.kind === "PICK" ? 1 : outcome?.kind === "OK" ? (checking ? 4 : evaluated.length && counts.READY === evaluated.length ? 5 : 4) : outcome?.kind === "ERROR" ? 0 : null;

  const rowEl = (r: ChannelRowView) => <ChannelRow key={r.key} row={r} webhook={checks[r.pageId]?.fact ?? r.webhook} appReady={appReady} manage={manage} operator={operator} extraTechnical={checks[r.pageId]?.detail ?? null} busy={toggling} onToggleAi={onToggleAi} onRecheck={onRecheck} />;

  return (
    <DirectConnectContext.Provider value={directConnect}>
    <div className="space-y-4">
      {step !== null ? <Stepper current={step} /> : null}

      {outcome?.kind === "ERROR" ? (
        <div className="space-y-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:bg-rose-950/60 dark:text-rose-100" data-testid="channels-outcome-error">
          <p className="font-semibold">{outcome.issue.title}</p>
          <p>{outcome.issue.who === "SUPPORT" ? "Đội hỗ trợ: " : "Việc cần làm: "}{outcome.issue.action}</p>
          {manage && outcome.issue.who === "SHOP" ? <ConnectButton appReady={appReady} label="Kết nối lại" variant="outline" /> : null}
          {operatorDetail?.length ? (
            <details className="text-xs" data-testid="channels-outcome-technical">
              <summary className="cursor-pointer">Chi tiết kỹ thuật (người vận hành)</summary>
              <ul className="mt-1 space-y-0.5 break-words font-mono text-[11px]">
                {operatorDetail.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {outcome?.kind === "OK" ? (
        <div className="space-y-1 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100" data-testid="channels-outcome-ok">
          <p className="font-semibold">Đã kết nối Page.</p>
          {outcome.webhook ? (
            <p>
              {CUSTOMER_WEBHOOK_TEXT[outcome.webhook as Exclude<WebhookState, "OK">].title} — {CUSTOMER_WEBHOOK_TEXT[outcome.webhook as Exclude<WebhookState, "OK">].action}
            </p>
          ) : (
            <p>Nhắn thử một tin vào Page để thấy bot trả lời.</p>
          )}
        </div>
      ) : null}
      {outcome?.kind === "PICK" && manage ? pending && pending.length ? <PagePickStep pages={pending} connected={connectedIds} operator={operator} onDone={afterPick} /> : <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">Danh sách Page đã hết hạn — bấm «Kết nối Facebook» lại.</p> : null}

      {!botEnabled ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200" data-testid="channels-bot-off">
          Chatbot bán hàng đang tắt ở cấu hình chung — AI chưa trả lời trên Page nào.{" "}
          <Link href="/ai/sales-chatbot" className="font-medium underline">
            Mở Chatbot bán hàng
          </Link>
        </p>
      ) : null}

      <SectionCard
        title={live.length ? `Kênh đang dùng (${live.length})` : "Kênh đang dùng"}
        description={live.length ? `Sẵn sàng ${counts.READY} · Cần xử lý ${counts.NEEDS_ACTION} · Mất kết nối ${counts.DISCONNECTED}` : undefined}
        actions={
          manage ? (
            <div className="flex flex-wrap items-center gap-2">
              {hasDirect ? (
                <Button type="button" size="sm" variant="outline" className="h-9" onClick={onRecheck} disabled={checking} data-testid="channels-recheck">
                  {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Kiểm tra lại
                </Button>
              ) : null}
              <ConnectButton appReady={appReady} label={live.some((r) => r.direct) ? "Thêm / nối lại Page" : "Kết nối Facebook"} />
            </div>
          ) : undefined
        }
        padded={false}
      >
        {checkedNote ? <p className="px-3 pt-2 text-xs text-muted-foreground">{checkedNote}</p> : null}
        {live.length ? (
          <ul className="divide-y" data-testid="channels-list">
            {evaluated.map((e) => rowEl(e.row))}
          </ul>
        ) : (
          <EmptyState
            title="Chưa có kênh nào"
            description={
              manage ? (
                <>
                  {/* Chỉ chỉ đường ĐANG CHẠY trước: nối thẳng Facebook chờ Meta duyệt quyền Page (review #706) — nút bên dưới giữ nguyên. */}
                  Fanpage qua Pancake và Zalo OA:{" "}
                  <Link href="/settings/connections" className="font-medium text-primary hover:underline">
                    nối ở trang Kết nối
                  </Link>
                  . Nối thẳng Facebook (không qua Pancake) sắp mở.
                </>
              ) : (
                "Cần quản trị cửa hàng kết nối Page."
              )
            }
            action={manage ? <ConnectButton appReady={appReady} /> : undefined}
          />
        )}
        {!appReady && manage && live.length ? <p className="px-3 pb-3 text-xs text-muted-foreground">Kết nối Facebook của nền tảng đang được bảo trì — chưa thêm Page mới được; liên hệ đội hỗ trợ nếu kéo dài.</p> : null}
      </SectionCard>

      {removed.length ? (
        <details className="rounded-md border px-3 py-2 text-sm" data-testid="channels-removed">
          <summary className="cursor-pointer text-muted-foreground">Page đã gỡ ({removed.length})</summary>
          <ul className="mt-2 divide-y">{removed.map(rowEl)}</ul>
        </details>
      ) : null}

      {operator && operatorNotes?.length ? (
        <SectionCard title="Người vận hành nền tảng" description="Chỉ tài khoản vận hành nền tảng thấy khối này.">
          <ul className="space-y-1 break-words text-xs" data-testid="channels-operator-notes">
            {operatorNotes.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>Mỗi Page nhận tin qua MỘT đường (Facebook trực tiếp hoặc Pancake) để khách không nhận hai câu trả lời. Bạn không cần bỏ Pancake — Page đang chạy qua Pancake vẫn dùng bình thường.</li>
        <li>
          Fanpage qua Pancake và Zalo OA nối ở{" "}
          <Link href="/settings/connections" className="text-primary underline">
            Cài đặt → Kết nối
          </Link>
          ; cài đặt riêng từng Page Facebook (tên bot, lời chào) ở{" "}
          <Link href="/ai/sales-chatbot/messenger" className="text-primary underline">
            Messenger trực tiếp
          </Link>
          .
        </li>
      </ul>
    </div>
    </DirectConnectContext.Provider>
  );
}
