import Link from "next/link";
import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { CUSTOMER_HEALTH_LABEL, CUSTOMER_HEALTH_LEVELS, CUSTOMER_HEALTH_MEANING, CUSTOMER_HEALTH_THRESHOLDS, HEALTH_REASONS, IDENTITY_INDEX_SINCE, USAGE_SNAPSHOT_EVERY_HOURS, type CustomerHealthLevel } from "@/lib/constants/customer-health";
import { formatNumber, NOT_APPLICABLE_TEXT, vnShortStamp } from "@/lib/format";
import { USAGE_ALERT_LABEL, type UsageAlertLevel } from "@/lib/pricing/versions";
import { ACTIVITY_KIND_LABEL, AI_CHANNEL_LABEL, AI_STATE_LABEL, ageText, dayText, type CustomerHealth, type HealthGap, type HealthReason, type WorkspaceFacts } from "@/lib/saas/customer-health";
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

/**
 * Lý do — MỘT dòng mỗi lý do: «nhãn · bằng chứng gọn» (câu đầy đủ khi rê chuột), tối đa `max` dòng, phần còn lại gộp «+n» — và chỗ
 * chưa đo thu thành «⚠ n tín hiệu chưa đo» (rê chuột xem từng chỗ).
 */
export function HealthReasonList({ reasons, gaps, max = 3 }: { reasons: readonly HealthReason[]; gaps: readonly HealthGap[]; max?: number }) {
  const shown = reasons.slice(0, max);
  const rest = reasons.slice(max);
  return (
    <div className="mt-0.5 space-y-px text-[11.5px] leading-snug">
      {shown.map((r, i) => (
        <p key={i} title={r.text} className={cn("truncate", r.level === "CRITICAL" ? "text-rose-700 dark:text-rose-400" : "text-amber-800 dark:text-amber-300")}>
          <b>{HEALTH_REASONS[r.code].label}</b> · {r.short}
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
          <p className="text-muted-foreground">Mức = lý do NẶNG NHẤT (không cộng điểm). Ngưỡng là mặc định kỹ thuật — chủ shop đổi được.</p>
        </div>
      </InfoHint>
    </div>
  );
}

const T = CUSTOMER_HEALTH_THRESHOLDS;

/** ⓘ của bảng: mỗi cột đọc gì + ngưỡng đang dùng — chữ thường cho người vận hành (nguồn kỹ thuật ở bảng khai, không in ra đây). */
export function HealthColumnsHint() {
  return (
    <div className="max-w-md space-y-1.5 text-xs leading-5">
      <p>Mọi cột đọc dữ liệu chung của nền tảng trong MỘT lượt — trang không mở dữ liệu riêng của khách nào. Xem sâu: «Sức khoẻ · module · kết nối» của từng workspace.</p>
      <p>
        <b>Đăng nhập</b>: lần đăng nhập bằng email (nền tảng ghi từ {dayText(IDENTITY_INDEX_SINCE)}). Quá {T.loginStaleDays} ngày ⇒ mọi phiên đã hết hạn. <b>Hoạt động</b>: mốc gần nhất giữa đăng nhập, lượt AI trả lời thành công, ngày có tin khách.
      </p>
      <p>
        <b>Kênh</b>: «N page bật» = fanpage đang bật ở lần chụp sổ dùng gần nhất («kết nối cũ» = page nối qua kết nối đơn cũ, chưa đếm được — không phải 0) · dòng dưới = khách AI kỳ này theo kênh (FB · Zalo · Web). Zalo OA / web chat chỉ thấy qua khách AI.
      </p>
      <p>
        <b>AI</b>: lượt AI trả lời khách trong 24 giờ (không gồm lượt đọc hội thoại để ghi đơn hộ). Đang lỗi = ≥ {T.aiFailBurst} lượt lỗi / bị chặn trong {T.aiFailWindowMinutes} phút và chưa lượt trả lời nào thành công sau đó (mức chủ shop chốt 06/10). Bot im = một ngày ≥ {T.aiSilentMinCustomerMessagesPerDay} tin khách mà bot không gửi tin nào.
      </p>
      <p>
        <b>Đơn AI</b>: đơn AI đã tạo theo ngày — không phải kết quả giao hàng · «ghi hộ lỗi» = lượt AI đọc hội thoại để ghi đơn hộ bị lỗi (lượt sau đọc lại; lỗi lưu đơn không nằm ở đây). <b>Khách AI / gói</b>: khách AI của kỳ HIỆN TẠI so với phần gồm của gói.
      </p>
      <p className="text-muted-foreground">Sổ dùng chụp khoảng {USAGE_SNAPSHOT_EVERY_HOURS} giờ một lần; quá {T.usageLedgerFreshHours} giờ chưa chụp là «sổ cũ» ⇒ chưa đủ dữ liệu, không kết luận.</p>
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
const nOrDash = (n: number | null) => (n === null ? "—" : formatNumber(n));
const naCell = (sub?: string) => <Two top={<span className="text-muted-foreground">{NOT_APPLICABLE_TEXT}</span>} sub={sub} />;

/** Hai tầng: đăng nhập cuối · hoạt động cuối có chứng cứ (loại + tuổi). Số người đã đăng nhập ở `title`. */
export function LoginCell({ f, now }: { f: WorkspaceFacts; now: Date }) {
  const top = f.lastLoginAt ? ago(now, f.lastLoginAt) : f.identities === null ? "—" : "chưa đăng nhập";
  const act = f.lastActivity;
  // Hoạt động cuối chính là lần đăng nhập ⇒ dòng dưới nói số người, không nhắc lại mốc.
  const sub = act && act.kind !== "LOGIN" ? `${ACTIVITY_KIND_LABEL[act.kind]} ${act.at ? ageText(now, act.at) : act.day ? dayText(act.day) : "—"}` : act ? `${nOrDash(f.identities)} người` : "chưa hoạt động";
  const title = [`${nOrDash(f.identities)} người đã đăng nhập bằng email`, f.lastLoginAt ? `Đăng nhập cuối ${vnShortStamp(f.lastLoginAt)}` : null, act?.at ? `Hoạt động cuối: ${ACTIVITY_KIND_LABEL[act.kind]} ${vnShortStamp(act.at)}` : act?.day ? `Hoạt động cuối: tin khách ngày ${dayText(act.day)}` : null].filter(Boolean).join("\n");
  return <Two top={top} sub={sub} title={title} />;
}

/** Nhãn kênh gọn trong ô (tên đầy đủ — `AI_CHANNEL_LABEL` — ở `title`). */
const CHANNEL_SHORT: Record<string, string> = { FANPAGE: "FB", ZALO: "Zalo", WEB: "Web" };

/**
 * Hai tầng: page Messenger đang bật (sổ dùng) · khách AI của kỳ theo kênh (Fanpage · Zalo · Web). «kết nối cũ» = chỉ có kết nối
 * đơn (Pancake / Messenger trước 0220) — chưa đếm được page, KHÔNG phải 0.
 */
export function ChannelCell({ f }: { f: WorkspaceFacts }) {
  if (!f.ai.applies) return naCell("không thuê AI");
  const fan = f.fanpagesActive;
  const top = fan === null ? (f.ledgerCapturedAt ? "kết nối cũ" : "—") : `${formatNumber(fan)} page bật`;
  const ch = f.aiCustomerChannels;
  const list = (labels: Record<string, string>) => (ch === null ? null : ch.length ? ch.map((c) => `${labels[c.channel] ?? c.channel} ${formatNumber(c.customers)}`).join(" · ") : "0 khách AI");
  const byChannel = list(CHANNEL_SHORT);
  const title = [
    `Page Messenger nối thẳng với nền tảng: ${nOrDash(f.messengerPages)}`,
    f.ledgerCapturedAt ? `Page / kết nối kênh bán đang bật (sổ dùng ${vnShortStamp(f.ledgerCapturedAt)}): ${fan === null ? "chưa đếm được — kết nối đơn cũ (Pancake)" : formatNumber(fan)}` : "Sổ dùng chưa chụp workspace này — page đang bật chưa biết",
    `Khách AI kỳ này theo kênh: ${list(AI_CHANNEL_LABEL) ?? "— (đồng hồ khách AI chưa đo workspace này)"}`,
  ].join("\n");
  return <Two top={top} sub={byChannel ?? "khách AI —"} title={title} className={cn(fan === 0 ? "text-amber-800 dark:text-amber-300" : undefined)} />;
}

/** Hai tầng: trạng thái AI · lượt trả lời thành công 24 giờ — lỗi trả lời (+ chặn) 24 giờ, hoặc lần trả lời thành công cuối. */
export function AiCell({ f, now }: { f: WorkspaceFacts; now: Date }) {
  if (!f.ai.applies) return naCell("không thuê AI");
  const a = f.ai;
  const top = `${AI_STATE_LABEL[a.state]}${a.ok24h === null ? "" : ` · ${formatNumber(a.ok24h)} lượt`}`;
  // 0 lỗi + 0 chặn ⇒ dòng dưới nói lần trả lời thành công cuối; có lỗi ⇒ số lỗi (lần trả lời cuối ở `title`).
  const bad = (a.chatErrors24h ?? 0) + (a.blocked24h ?? 0) > 0;
  const sub = a.chatErrors24h === null ? "lỗi —" : bad ? `lỗi ${formatNumber(a.chatErrors24h)}${a.blocked24h ? ` · chặn ${formatNumber(a.blocked24h)}` : ""}` : a.lastOkAt ? `trả lời ${ageText(now, a.lastOkAt)} trước` : "chưa trả lời ai";
  const title = [
    `Lượt AI trả lời thành công 24 giờ: ${nOrDash(a.ok24h)}`,
    `Lỗi trả lời 24 giờ: ${nOrDash(a.chatErrors24h)} · bị chặn vì hạn mức: ${nOrDash(a.blocked24h)}`,
    a.lastOkAt ? `Trả lời thành công cuối ${vnShortStamp(a.lastOkAt)}` : null,
    a.lastErrorAt ? `Hỏng cuối ${vnShortStamp(a.lastErrorAt)}` : null,
    a.activatedAt ? `Kích hoạt (AI trả lời khách thật đầu tiên) ${vnShortStamp(a.activatedAt)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return <Two top={top} sub={sub} className={cn(bad || a.state === "OFF" ? "text-amber-800 dark:text-amber-300" : undefined)} title={title} />;
}

/**
 * Hai tầng: đơn AI ĐÃ TẠO gần nhất (ngày) · số đơn của cửa sổ, hoặc số lượt AI ghi đơn hộ bị lỗi 24 giờ khi có. Không phải kết quả
 * giao hàng; lỗi lưu đơn không nằm ở đây.
 */
export function OrderCell({ f }: { f: WorkspaceFacts }) {
  if (!f.ai.applies) return naCell();
  const o = f.orders;
  const top = o.lastAiOrderDay ? `đơn AI ${dayText(o.lastAiOrderDay)}` : o.aiOrders7d === null ? "—" : "chưa có đơn AI";
  const sub = o.syncErrors24h ? `ghi hộ lỗi ${formatNumber(o.syncErrors24h)}` : o.aiOrders7d === null ? "—" : `${formatNumber(o.aiOrders7d)} đơn / ${T.activityWindowDays} ngày`;
  const title = [
    `Đơn AI đã tạo gần nhất: ${o.lastAiOrderDay ? dayText(o.lastAiOrderDay) : `không có trong ${T.usageLookbackDays} ngày sổ dùng`}`,
    `Đơn AI ${T.activityWindowDays} ngày: ${nOrDash(o.aiOrders7d)}`,
    `Lượt AI đọc hội thoại để ghi đơn hộ bị lỗi 24 giờ: ${nOrDash(o.syncErrors24h)} (lượt sau đọc lại; lỗi lưu đơn không nằm ở đây)`,
    o.firstAiOrderAt ? `Đơn AI đầu tiên ${vnShortStamp(o.firstAiOrderAt)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return <Two top={top} sub={sub} className={cn(o.syncErrors24h ? "text-amber-800 dark:text-amber-300" : undefined)} title={title} />;
}

/** Nhãn gọn của mức cảnh báo dùng (nhãn đầy đủ ở `title`). */
const USAGE_SHORT: Record<UsageAlertLevel, string> = { OK: "trong gói", NOTIFY: "sắp hết", OVERAGE: "vượt", STRONG: "vượt nhiều", REVIEW: "rà soát", NOT_INCLUDED: "gói không gồm", UNLIMITED: "không giới hạn", UNDECLARED: "gói chưa khai", UNKNOWN: "chưa đo" };

/** Hai tầng: khách AI kỳ hiện tại / phần gồm · (%) mức cảnh báo. Hội thoại mới của cùng kỳ ở `title`. */
export function UsageCell({ f }: { f: WorkspaceFacts }) {
  const u = f.usage;
  const conv = `Hội thoại mới kỳ này: ${nOrDash(u.conversations)}`;
  if (!f.ai.applies) return <Two top={<span className="text-muted-foreground">{NOT_APPLICABLE_TEXT}</span>} sub="không thuê AI" title={conv} />;
  const used = u.aiCustomers === null ? "—" : `${u.coverage === "PARTIAL" ? "≥" : ""}${formatNumber(u.aiCustomers)}`;
  const of = u.included === null ? "/∞" : u.included === undefined ? "" : `/${formatNumber(u.included)}`;
  const warn = u.level === "NOTIFY" || u.level === "OVERAGE" || u.level === "STRONG" || u.level === "REVIEW" || u.level === "NOT_INCLUDED";
  const sub = u.level ? `${u.pct !== null ? `${u.pct}% · ` : ""}${USAGE_SHORT[u.level]}` : u.coverage === "NOT_MEASURED" || u.coverage === null ? "chưa đo" : "—";
  const title = [
    `Khách AI kỳ này: ${used}${of}${u.pct !== null ? ` (${u.pct}%)` : ""}`,
    u.level ? `Mức: ${USAGE_ALERT_LABEL[u.level]}` : null,
    u.coverage === "PARTIAL" ? "Đồng hồ khách AI đo chưa trọn kỳ — số là cận dưới" : null,
    conv,
    `Tin khách ${T.activityWindowDays} ngày: ${nOrDash(u.customerMessages7d)} · tin bot: ${nOrDash(u.botMessages7d)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return <Two top={`${used}${of}`} sub={sub} className={cn(warn ? "text-amber-800 dark:text-amber-300" : undefined)} title={title} />;
}

// ─────────────────────────── Khối tóm tắt ở trang một khách ───────────────────────────

/** «10/2026» từ kỳ `YYYY-MM-01`. */
const periodText = (periodMonth: string) => `${periodMonth.slice(5, 7)}/${periodMonth.slice(0, 4)}`;

/**
 * Một khối: mức + mọi lý do + chỗ chưa đo + dòng sự việc của từng workspace (cùng hàm phân loại với danh sách). Sức khoẻ là của
 * HIỆN TẠI (`now`, khách AI kỳ `periodMonth`) — không theo kỳ tiền đang xem.
 */
export function CustomerHealthPanel({ health, now, periodMonth }: { health: CustomerHealth; now: Date; periodMonth: string }) {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          Sức khoẻ <HealthPill level={health.level} />
        </span>
      }
      hint={<HealthColumnsHint />}
      description={`đọc lúc ${vnShortStamp(now)} · khách AI kỳ ${periodText(periodMonth)} · mức = lý do nặng nhất`}
    >
      {health.reasons.length === 0 && health.gaps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{health.level === "INACTIVE" ? (health.inactiveReason ?? CUSTOMER_HEALTH_MEANING.INACTIVE) : "Không lý do nào chạm ngưỡng, mọi tín hiệu áp dụng đều đọc được."}</p>
      ) : null}
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
                {w.level === "INACTIVE" && w.inactiveReason ? <p className="mt-0.5 text-[11px] text-muted-foreground">{w.inactiveReason}</p> : null}
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">Kênh · khách AI</p>
                <ChannelCell f={w.facts} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">AI · 24 giờ</p>
                <AiCell f={w.facts} now={now} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">Đơn AI</p>
                <OrderCell f={w.facts} />
              </div>
              <div className="rounded-lg border border-hairline px-2 py-1.5">
                <p className="text-[11px] text-muted-foreground">Khách AI / gói</p>
                <UsageCell f={w.facts} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
