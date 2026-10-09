import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { CUSTOMER_AI_INCIDENT_LABEL, customerFacing, customerSalesHealth } from "@/lib/saas/visibility";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { formatDateTime, formatNumber, formatPercent, formatTimeAgo, formatVND } from "@/lib/format";
import { loadAiSalesSlo, readSalesHealthSnapshot, readSalesHealthState, salesHealthDrilldown } from "@/lib/sales-chatbot/health";
import { evaluateSalesHealth, STATUS_DOT, STATUS_LABEL, type HealthLevel } from "@/lib/sales-chatbot/health-shared";
import { findMissedConversations, MISSED_CLASS_LABEL, type MissedClass } from "@/lib/sales-chatbot/recovery";

export const metadata = { title: "AI bán hàng — sống hay chết" };
export const dynamic = "force-dynamic";

const LEVEL_DOT: Record<HealthLevel, string> = { OK: "🟢", WARNING: "🟡", CRITICAL: "🔴", UNKNOWN: "⚪" };
const DRILL_LABEL = { PENDING: "Đang chờ", SEND_FAILED: "Gửi lỗi", AI_DOWN: "AI hỏng → chuyển người" } as const;
const CUSTOMER_DRILL_LABEL = { ...DRILL_LABEL, AI_DOWN: "AI gặp sự cố → chuyển người" } as const;

/**
 * COCKPIT AI BÁN HÀNG (chủ shop yêu cầu sau sự cố P0 06/10/2026): nhìn một lần biết AI đang sống hay chết. Đo TRỰC TIẾP lúc
 * mở trang (cùng hàm job `sales-health` dùng) — không đọc số cũ; dòng «lần kiểm tự động cuối» cho biết job giám sát còn chạy.
 * Giá trị đơn là DANH NGHĨA lúc chốt, không phải doanh thu theo ORDER_OUTCOME.
 *
 * Hai lớp che (chủ shop 07/10/2026, lib/saas/visibility.ts): (1) phần CHẨN ĐOÁN (từng kiểm, kênh, nhà cung cấp AI) cần
 * `ai_sales:manage` — CS / người xem chỉ thấy trạng thái tổng, các ô kinh doanh và danh sách khách đang chờ; (2) workspace
 * KHÁCH không bao giờ thấy phần nhà cung cấp AI (số lượt OK / lỗi, lớp lỗi, câu lỗi gốc) — chỉ «AI đang hoạt động / gặp sự
 * cố, đội ngũ đã được báo».
 */
export default async function SalesCockpitPage() {
  const user = await requirePermission("ai_sales:view");
  const customer = customerFacing(user.organization);
  const detail = can(user, SALES_CHATBOT_MANAGE);
  const now = new Date();
  const slo = await loadAiSalesSlo();
  const [snap, stored, drill, missed] = await Promise.all([readSalesHealthSnapshot(now, slo), readSalesHealthState(), salesHealthDrilldown(now), findMissedConversations(new Date(now.getTime() - 86_400_000), now, now)]);
  const missedOrder: MissedClass[] = ["HUMAN_REVIEW", "AI_SAFE_RESUME", "STAFF_HANDLED", "HAS_ORDER"];
  const rawHealth = evaluateSalesHealth(snap, slo);
  const health = customer ? customerSalesHealth(rawHealth) : rawHealth;
  const aiRow = health.checks.find((c) => c.key === "PROVIDER");
  const drillNote = (r: { kind: keyof typeof DRILL_LABEL; note: string | null }) => (r.kind === "AI_DOWN" && (customer || !detail) ? null : r.note);
  const sec = (v: number | null) => (v === null ? "—" : `${Math.round(v)} giây`);
  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: "Tin khách cuối", value: formatTimeAgo(snap.lastCustomerMessageAt), hint: formatDateTime(snap.lastCustomerMessageAt) },
    { label: "Câu AI trả lời cuối", value: formatTimeAgo(snap.lastAiReplyAt), hint: formatDateTime(snap.lastAiReplyAt) },
    { label: "Đơn AI tạo cuối", value: formatTimeAgo(snap.lastAiOrderAt), hint: formatDateTime(snap.lastAiOrderAt) },
    { label: "Đang chờ / đang thử lại", value: `${formatNumber(snap.queue.pending)} / ${formatNumber(snap.queue.retrying)}` },
    { label: "Tin chờ lâu nhất", value: snap.queue.oldestPendingAt ? formatTimeAgo(snap.queue.oldestPendingAt) : "không có", hint: `SLO: cảnh báo ${slo.backlogWarnMinutes} phút · nguy cấp ${slo.backlogCriticalMinutes} phút` },
    ...(customer ? [] : [{ label: "Dead-letter 24 giờ", value: snap.queue.deadLetter === null ? "—" : formatNumber(snap.queue.deadLetter), hint: "tin bot không trả lời được: AI hỏng · gửi hỏng · hết lượt thử" }]),
    { label: "Lỗi 24 giờ", value: formatNumber(snap.errors24h), hint: `gửi lỗi ${snap.queue.failedSend24h} · hội thoại AI hỏng ${snap.queue.failedAiDown24h} · tin bị bỏ sót ${snap.queue.abandoned24h}` },
    { label: "Độ trễ P50 / P95", value: `${sec(snap.latency.p50Seconds)} / ${sec(snap.latency.p95Seconds)}`, hint: `${snap.latency.sample} lượt đo trong 24 giờ · SLO ${slo.replyTargetSeconds} giây` },
    { label: "Hội thoại AI hôm nay", value: formatNumber(snap.today.conversationsAi) },
    { label: "Đơn AI chốt hôm nay", value: formatNumber(snap.today.ordersAi), hint: `+ ${snap.today.ordersSync} đơn máy ghi hộ nhân viên chốt` },
    { label: "Tỷ lệ chốt", value: formatPercent(snap.today.conversionPct), hint: "đơn bot chốt / hội thoại bot trả lời hôm nay" },
    { label: "Giá trị đơn AI hôm nay", value: formatVND(snap.today.orderValueAi), hint: "danh nghĩa lúc chốt — chưa trừ hoàn / huỷ" },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${STATUS_DOT[health.status]} AI bán hàng: ${STATUS_LABEL[health.status]}`}
        description={health.headline}
        hint={customer ? "Đo lúc mở trang." : `Đo lúc mở trang. Lần kiểm tự động cuối: ${stored ? `${formatTimeAgo(stored.checkedAt)} (${STATUS_LABEL[stored.status]})` : "chưa có — job sales-health chưa chạy"}.`}
        actions={<Link href="/ai/sales-chatbot" className="text-sm text-primary underline">Cấu hình chatbot</Link>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card px-3 py-2" title={t.hint}>
            <p className="text-[11px] text-muted-foreground">{t.label}</p>
            <p className="text-base font-semibold tabular-nums">{t.value}</p>
          </div>
        ))}
      </div>

      {customer && aiRow ? (
        <p className={`rounded-xl border px-3 py-2 text-sm font-medium ${aiRow.detail === CUSTOMER_AI_INCIDENT_LABEL ? "border-destructive/40 text-destructive" : ""}`} data-testid="cockpit-ai-state">
          {LEVEL_DOT[aiRow.level]} {aiRow.detail}
        </p>
      ) : null}

      {detail ? (
      <SectionCard title="Từng kiểm" description="Mỗi dòng sửa ở một chỗ khác — xem «cách sửa».">
        <table className="w-full text-sm">
          <tbody>
            {health.checks.map((c) => (
              <tr key={c.key} className="border-b border-hairline last:border-0 align-top">
                <td className="w-8 py-2">{LEVEL_DOT[c.level]}</td>
                <td className="w-48 py-2 font-medium">{c.title}</td>
                <td className="py-2">
                  {c.detail}
                  {c.fix ? <span className="block text-xs text-muted-foreground">Cách sửa: {c.fix}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
      ) : null}

      {detail ? (
      <SectionCard title="Kênh">
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-hairline">
              <td className="w-48 py-2 font-medium">Pancake (fanpage)</td>
              <td className="py-2">{snap.channels.pancake.configured ? `${customer ? "Tin cuối nhận" : "Webhook cuối"} ${formatTimeAgo(snap.channels.pancake.lastWebhookAt)} (ghi mỗi 5 phút)` : "Chưa nối"}</td>
            </tr>
            <tr className="border-b border-hairline">
              <td className="py-2 font-medium">Messenger trực tiếp</td>
              <td className="py-2">
                {snap.channels.messenger.pages ? `${snap.channels.messenger.pages} page · sự kiện cuối ${formatTimeAgo(snap.channels.messenger.lastEventAt)}` : "Chưa nối page nào"}
                {snap.channels.messenger.lastError ? <span className="block text-xs text-destructive">Lỗi {formatTimeAgo(snap.channels.messenger.lastErrorAt)}: {snap.channels.messenger.lastError}</span> : null}
              </td>
            </tr>
            {customer ? null : (
              <tr>
                <td className="py-2 font-medium">Nhà cung cấp AI</td>
                <td className="py-2">
                  Thành công cuối {formatTimeAgo(snap.provider.lastOkAt)} · lỗi cuối {formatTimeAgo(snap.provider.lastErrorAt)} · {slo.providerWindowMinutes} phút qua: {snap.provider.okInWindow} OK / {snap.provider.errorsInWindow} lỗi / {snap.provider.blockedInWindow} bị chặn
                  {snap.provider.lastErrorLabel ? <span className="block text-xs text-muted-foreground">Lớp lỗi gần nhất: {snap.provider.lastErrorLabel}</span> : null}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </SectionCard>
      ) : null}

      <SectionCard
        title={`Hội thoại khách nhắn mà bot chưa trả lời (24 giờ) — ${missed.length}`}
        description="Chỉ đọc, máy không gửi gì. «Cần nhân viên» = khách chờ quá 30 phút: bot không tự nhắn vào hội thoại đã nguội. «Máy tự thử lại» = đừng nhắn tay, khách sẽ nhận hai câu."
      >
        {missed.length ? (
          <div className="space-y-3 text-sm">
            {missedOrder.map((cls) => {
              const rows = missed.filter((m) => m.cls === cls);
              if (!rows.length) return null;
              return (
                <div key={cls}>
                  <p className="font-medium">
                    {MISSED_CLASS_LABEL[cls]} — {rows.length}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {rows.slice(0, 20).map((m) => (
                      <li key={`${m.pageId}-${m.threadId}`} className="flex gap-2">
                        <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(m.lastCustomerAt)}</span>
                        {m.conversationId ? (
                          <Link href={`/ai/sales-chatbot/conversations/${m.conversationId}`} className="text-primary underline">
                            {m.customerName ?? "Mở hội thoại"}
                          </Link>
                        ) : (
                          <span>{m.customerName ?? "—"}</span>
                        )}
                        <span className="max-w-[40ch] truncate text-muted-foreground" title={m.lastText}>
                          {m.lastText}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Mọi tin khách trong 24 giờ đều đã có câu trả lời của bot.</p>
        )}
      </SectionCard>

      <SectionCard title={`Tin lỗi / đang chờ (24 giờ) — ${drill.length}`} description="Bấm để mở hội thoại. Tin «AI hỏng → chuyển người» là khách đang chờ nhân viên gọi lại.">
        {drill.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1">Lúc</th>
                <th className="py-1">Loại</th>
                <th className="py-1">Khách</th>
                <th className="py-1">Tin</th>
                <th className="py-1">Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {drill.map((r, i) => (
                <tr key={`${r.threadId}-${r.at}-${i}`} className="border-t border-hairline align-top">
                  <td className="whitespace-nowrap py-1.5 pr-2">{formatDateTime(r.at)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2">{(customer ? CUSTOMER_DRILL_LABEL : DRILL_LABEL)[r.kind]}</td>
                  <td className="py-1.5 pr-2">{r.conversationId ? <Link href={`/ai/sales-chatbot/conversations/${r.conversationId}`} className="text-primary underline">{r.customerName ?? "Mở hội thoại"}</Link> : (r.customerName ?? "—")}</td>
                  <td className="max-w-[28ch] truncate py-1.5 pr-2" title={r.text}>{r.text}</td>
                  {/* Ghi chú của tin AI hỏng có thể là câu lỗi gốc của nhà cung cấp — khách không thấy; người xem không cấu hình bot cũng không. */}
                  <td className="max-w-[32ch] truncate py-1.5 text-xs text-muted-foreground" title={drillNote(r) ?? ""}>{drillNote(r) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Không có tin lỗi hay tin chờ trong 24 giờ.</p>
        )}
      </SectionCard>
    </div>
  );
}
