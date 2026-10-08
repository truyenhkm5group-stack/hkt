import Link from "next/link";
import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { CUSTOMER_HEALTH_LABEL, CUSTOMER_HEALTH_LEVELS, CUSTOMER_HEALTH_MEANING, CUSTOMER_HEALTH_THRESHOLDS, HEALTH_REASONS, IDENTITY_INDEX_SINCE, type CustomerHealthLevel } from "@/lib/constants/customer-health";
import { formatNumber, NOT_APPLICABLE_TEXT, vnShortStamp } from "@/lib/format";
import { USAGE_ALERT_LABEL } from "@/lib/pricing/versions";
import { ACTIVITY_KIND_LABEL, AI_STATE_LABEL, ageText, dayText, type CustomerHealth, type HealthGap, type HealthReason, type WorkspaceFacts } from "@/lib/saas/customer-health";
import { cn } from "@/lib/utils";

/**
 * Mảnh giao diện của SỨC KHOẺ KHÁCH — dùng chung cho danh sách `/platform/customers` và khối tóm tắt ở trang một khách.
 * Thành phần máy chủ (không "use client"): chỉ in chữ + liên kết; ⓘ dùng `InfoHint` có sẵn. «—» = chưa biết, «N/A» = không áp
 * dụng (luật 42) — không ô nào in 0 thay cho chưa biết.
 */

const LEVEL_TONE: Record<CustomerHealthLevel, string> = {
  CRITICAL: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  NEEDS_ATTENTION: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  // Chưa đủ dữ liệu: KHÔNG tô xanh — xám, cùng nhóm với «chưa biết».
  UNKNOWN: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  HEALTHY: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  INACTIVE: "border-dashed border-hairline bg-transparent text-muted-foreground",
};

const LEVEL_DOT: Record<CustomerHealthLevel, string> = { CRITICAL: "bg-rose-500", NEEDS_ATTENTION: "bg-amber-500", UNKNOWN: "bg-slate-400", HEALTHY: "bg-emerald-500", INACTIVE: "bg-transparent ring-1 ring-muted-foreground/40" };

export function HealthPill({ level, className }: { level: CustomerHealthLevel; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[11px] font-semibold", LEVEL_TONE[level], className)}>
      <span className={cn("size-1.5 rounded-full", LEVEL_DOT[level])} aria-hidden />
      {CUSTOMER_HEALTH_LABEL[level]}
    </span>
  );
}

/** Câu ngắn in trong ô: phần trước dấu «—» đầu tiên (câu đầy đủ ở `title`). */
function shortText(text: string): string {
  const i = text.indexOf(" — ");
  return i > 0 ? text.slice(0, i) : text;
}

/** Lý do (tối đa `max` dòng, phần còn lại gộp «+n») + chỗ chưa đo thu thành «⚠ n chưa đo» (rê chuột xem). */
export function HealthReasonList({ reasons, gaps, max = 2 }: { reasons: readonly HealthReason[]; gaps: readonly HealthGap[]; max?: number }) {
  const shown = reasons.slice(0, max);
  const rest = reasons.slice(max);
  return (
    <div className="mt-0.5 space-y-0.5 text-[11.5px] leading-snug">
      {shown.map((r, i) => (
        <p key={i} title={r.text} className={cn("line-clamp-2", r.level === "CRITICAL" ? "text-rose-700 dark:text-rose-400" : "text-amber-800 dark:text-amber-300")}>
          <b>{HEALTH_REASONS[r.code].label}</b>: {shortText(r.text)}
        </p>
      ))}
      {rest.length ? (
        <p className="text-muted-foreground" title={rest.map((r) => r.text).join("\n")}>
          +{rest.length} lý do khác
        </p>
      ) : null}
      {gaps.length ? (
        <p className="text-muted-foreground" title={gaps.map((g) => g.text).join("\n")}>
          ⚠ {gaps.length} tín hiệu chưa đo
        </p>
      ) : null}
    </div>
  );
}

/** Thanh lọc nhanh theo mức: mỗi ô là một liên kết (URL `?muc=`), kèm số khách. */
export function HealthFilterBar({ counts, total, active, hrefOf }: { counts: Record<CustomerHealthLevel, number>; total: number; active: CustomerHealthLevel | null; hrefOf: Record<CustomerHealthLevel | "ALL", string> }) {
  const chip = (key: CustomerHealthLevel | "ALL", label: React.ReactNode, n: number) => {
    const on = key === "ALL" ? active === null : active === key;
    return (
      <Link
        key={key}
        href={hrefOf[key]}
        prefetch={false}
        aria-current={on ? "page" : undefined}
        className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors hover:bg-muted/60", on ? "border-primary bg-primary/5 font-semibold" : "border-hairline bg-card")}
      >
        {label}
        <span className="numeric text-base font-bold">{formatNumber(n)}</span>
      </Link>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Lọc khách theo sức khoẻ">
      {chip("ALL", <span>Tất cả</span>, total)}
      {CUSTOMER_HEALTH_LEVELS.map((l) => chip(l, <HealthPill level={l} />, counts[l]))}
      <InfoHint label="Mức sức khoẻ nghĩa là gì">
        <div className="max-w-sm space-y-1.5 text-xs leading-5">
          {CUSTOMER_HEALTH_LEVELS.map((l) => (
            <p key={l}>
              <b>{CUSTOMER_HEALTH_LABEL[l]}</b> — {CUSTOMER_HEALTH_MEANING[l]}
            </p>
          ))}
          <p className="text-muted-foreground">Mức = lý do NẶNG NHẤT (không cộng điểm). Ngưỡng là mặc định kỹ thuật, khai ở lib/constants/customer-health.ts.</p>
        </div>
      </InfoHint>
    </div>
  );
}

const T = CUSTOMER_HEALTH_THRESHOLDS;

/** ⓘ của bảng: nguồn từng cột + ngưỡng đang dùng. */
export function HealthColumnsHint() {
  return (
    <div className="max-w-md space-y-1.5 text-xs leading-5">
      <p>Mọi cột đọc mặt phẳng điều khiển (CSDL nhà) trong MỘT lượt gom — trang không mở CSDL của khách nào. Chi tiết sâu: «Sức khoẻ · module · kết nối» của từng workspace.</p>
      <p>
        <b>Đăng nhập</b>: chỉ mục platform_identities (ghi từ {dayText(IDENTITY_INDEX_SINCE)}). Quá {T.loginStaleDays} ngày ⇒ mọi phiên đã hết hạn. <b>Hoạt động</b>: mốc gần nhất giữa đăng nhập, lượt AI thành công, ngày có tin khách.
      </p>
      <p>
        <b>Kênh</b>: page Messenger nối thẳng (chỉ mục) · fanpage / kết nối kênh bán đang bật ở lần chụp sổ dùng gần nhất. Pancake nối bằng kết nối đơn cũ đọc ra «—»; Zalo OA / web chat chưa có chỉ mục theo kênh ở CSDL nhà.
      </p>
      <p>
        <b>AI</b>: sổ platform_ai_usage (sales_chatbot). Đang lỗi = ≥ {T.aiFailBurst} lượt lỗi / bị chặn trong {T.aiFailWindowMinutes} phút và chưa lượt nào thành công sau đó (SLO AI bán hàng, chủ shop chốt 06/10). Bot im = một ngày ≥ {T.aiSilentMinCustomerMessages} tin khách mà 0 tin bot.
      </p>
      <p>
        <b>Đơn</b>: đơn AI ĐÃ TẠO theo sổ dùng (ngày) — không phải kết cục giao hàng (ORDER_OUTCOME) · lỗi ghi đơn từ hội thoại theo sổ AI. <b>Dùng / hạn mức</b>: đồng hồ khách AI so với phần gồm của phiên bản giá đã ghim.
      </p>
      <p className="text-muted-foreground">Sổ dùng chụp ké job alerts ~6 giờ một lần; quá {T.usageLedgerFreshHours} giờ là «sổ cũ» ⇒ chưa đủ dữ liệu, không kết luận.</p>
    </div>
  );
}

// ─────────────────────────── Ô của bảng (hai tầng) ───────────────────────────

export function Two({ top, sub, title, className }: { top: React.ReactNode; sub?: React.ReactNode; title?: string; className?: string }) {
  return (
    <div className={className} title={title}>
      <div className="truncate">{top}</div>
      {sub !== undefined && sub !== null ? <div className="truncate text-[11px] leading-tight text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

const ago = (now: Date, at: Date | null) => (at ? `${ageText(now, at)} trước` : "—");

export function LoginCell({ f, now }: { f: WorkspaceFacts; now: Date }) {
  const top = f.lastLoginAt ? ago(now, f.lastLoginAt) : f.identities === null ? "—" : "chưa ai đăng nhập";
  const act = f.lastActivity;
  const sub = act ? `${ACTIVITY_KIND_LABEL[act.kind]} ${act.at ? ago(now, act.at) : act.day ? dayText(act.day) : "—"}` : "chưa có hoạt động";
  return <Two top={top} sub={`${f.identities === null ? "—" : `${formatNumber(f.identities)} người`} · ${sub}`} title={f.lastLoginAt ? `Đăng nhập cuối ${vnShortStamp(f.lastLoginAt)}` : undefined} />;
}

export function ChannelCell({ f }: { f: WorkspaceFacts }) {
  const fan = f.fanpagesActive === null ? "—" : formatNumber(f.fanpagesActive);
  return (
    <Two
      top={`Messenger ${f.messengerPages === null ? "—" : formatNumber(f.messengerPages)}`}
      sub={`fanpage bật ${fan}`}
      title={f.ledgerCapturedAt ? `Fanpage / kết nối kênh bán đang bật ở lần chụp sổ dùng ${vnShortStamp(f.ledgerCapturedAt)}${f.fanpagesActive === null ? " — «—»: kết nối đơn cũ (Pancake) hoặc chưa đếm được" : ""}` : "Sổ dùng chưa chụp workspace này"}
    />
  );
}

export function AiCell({ f, now }: { f: WorkspaceFacts; now: Date }) {
  if (!f.ai.applies) return <Two top={<span className="text-muted-foreground">{NOT_APPLICABLE_TEXT}</span>} sub="không thuê Chốt Đơn" />;
  const a = f.ai;
  const top = `${AI_STATE_LABEL[a.state]}${a.ok24h === null ? "" : ` · ${formatNumber(a.ok24h)} lượt/24h`}`;
  const errs = a.chatErrors24h === null ? "lỗi —" : `lỗi ${formatNumber(a.chatErrors24h)}${a.blocked24h ? ` · chặn ${formatNumber(a.blocked24h)}` : ""}`;
  return <Two top={top} sub={`${errs} · OK ${a.lastOkAt ? ago(now, a.lastOkAt) : "—"}`} className={cn(a.chatErrors24h ? "text-amber-800 dark:text-amber-300" : undefined)} title={a.lastErrorAt ? `Lượt hỏng cuối ${vnShortStamp(a.lastErrorAt)}` : undefined} />;
}

export function OrderCell({ f }: { f: WorkspaceFacts }) {
  if (!f.ai.applies) return <Two top={<span className="text-muted-foreground">{NOT_APPLICABLE_TEXT}</span>} />;
  const o = f.orders;
  const top = o.lastAiOrderDay ? `đơn AI ${dayText(o.lastAiOrderDay)}` : o.aiOrders7d === null ? "—" : `chưa có đơn AI ${T.usageLookbackDays} ngày`;
  const sub = `7 ngày ${o.aiOrders7d === null ? "—" : formatNumber(o.aiOrders7d)}${o.syncErrors24h ? ` · ghi lỗi ${formatNumber(o.syncErrors24h)}` : ""}`;
  return <Two top={top} sub={sub} className={cn(o.syncErrors24h ? "text-amber-800 dark:text-amber-300" : undefined)} />;
}

/** `conversations` = hội thoại mới của KỲ (sổ dùng, cùng số cột «Dùng» cũ); `null` = chưa đo. */
export function UsageCell({ f, conversations }: { f: WorkspaceFacts; conversations?: number | null }) {
  const conv = conversations === undefined ? "" : `hội thoại kỳ ${conversations === null ? "—" : formatNumber(conversations)}`;
  if (!f.ai.applies) return <Two top={<span className="text-muted-foreground">{NOT_APPLICABLE_TEXT}</span>} sub={conv || "đồng hồ khách AI"} />;
  const u = f.usage;
  const used = u.aiCustomers === null ? "—" : `${u.coverage === "PARTIAL" ? "≥ " : ""}${formatNumber(u.aiCustomers)}`;
  const of = u.included === null ? "/∞" : u.included === undefined ? "" : `/${formatNumber(u.included)}`;
  const level = u.level ? `${u.pct !== null ? `${u.pct}% · ` : ""}${USAGE_ALERT_LABEL[u.level]}` : null;
  const warn = u.level === "NOTIFY" || u.level === "OVERAGE" || u.level === "STRONG" || u.level === "REVIEW" || u.level === "NOT_INCLUDED";
  const title = [u.coverage === "PARTIAL" ? "Đồng hồ khách AI đo chưa trọn kỳ — số là cận dưới" : null, level, conv || null, `tin khách 7 ngày ${u.customerMessages7d === null ? "—" : formatNumber(u.customerMessages7d)}`].filter(Boolean).join("\n");
  return <Two top={`khách AI ${used}${of}`} sub={warn && level ? level : conv || level || `tin khách 7 ngày ${u.customerMessages7d === null ? "—" : formatNumber(u.customerMessages7d)}`} className={cn(warn ? "text-amber-800 dark:text-amber-300" : undefined)} title={title} />;
}

// ─────────────────────────── Khối tóm tắt ở trang một khách ───────────────────────────

/** Một khối: mức + mọi lý do + chỗ chưa đo + dòng sự việc của từng workspace (cùng hàm phân loại với danh sách). */
export function CustomerHealthPanel({ health, now }: { health: CustomerHealth; now: Date }) {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          Sức khoẻ <HealthPill level={health.level} />
        </span>
      }
      hint={<HealthColumnsHint />}
      description={`đọc lúc ${vnShortStamp(now)} · mức = lý do nặng nhất`}
    >
      {health.reasons.length === 0 && health.gaps.length === 0 ? <p className="text-sm text-muted-foreground">{health.level === "INACTIVE" ? CUSTOMER_HEALTH_MEANING.INACTIVE : "Không lý do nào chạm ngưỡng, mọi tín hiệu áp dụng đều đọc được."}</p> : null}
      {health.reasons.length ? (
        <ul className="space-y-1 text-sm">
          {health.reasons.map((r, i) => (
            <li key={i} className={r.level === "CRITICAL" ? "text-rose-700 dark:text-rose-400" : "text-amber-800 dark:text-amber-300"}>
              {r.workspace && health.workspaces.length > 1 ? <span className="font-mono text-xs">[{r.workspace}] </span> : null}
              <b>{HEALTH_REASONS[r.code].label}</b>: {r.text}
            </li>
          ))}
        </ul>
      ) : null}
      {health.gaps.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {health.gaps.map((g, i) => (
            <li key={i}>⚠ {g.text}</li>
          ))}
        </ul>
      ) : null}
      {health.workspaces.length ? (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-5">
          {health.workspaces.map((w) => (
            <div key={w.code} className="contents">
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="font-mono text-[11px] text-muted-foreground">{w.code}</p>
                <LoginCell f={w.facts} now={now} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">Kênh</p>
                <ChannelCell f={w.facts} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">AI</p>
                <AiCell f={w.facts} now={now} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">Đơn</p>
                <OrderCell f={w.facts} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">Dùng / hạn mức</p>
                <UsageCell f={w.facts} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
