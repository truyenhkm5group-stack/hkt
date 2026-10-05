import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDate, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { loadAiSalesPerformance, type AiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { AI_SALES_METRICS, AI_SALES_MIN_SAMPLE, type FunnelRow } from "@/lib/sales-chatbot/performance-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { HumanCostForm } from "./human-cost-form";
import { ExperimentBlock } from "./experiment-block";
import { loadExperimentReport } from "@/lib/sales-chatbot/experiment-report";
import { loadBasketStats } from "@/lib/sales-chatbot/basket";
import { drillHref } from "@/lib/sales-chatbot/experiment-shared";
import { loadOrderAttribution } from "@/lib/sales-chatbot/attribution";
import { ORDER_ATTRIBUTIONS, ORDER_ATTRIBUTION_LABEL } from "@/lib/sales-chatbot/attribution-shared";
import { loadLostReasons } from "@/lib/sales-chatbot/lost-reasons";
import { inboxPages } from "@/lib/sales-chatbot/inbox";

export const metadata = { title: "Hiệu quả AI bán hàng" };

const PERIODS = [7, 30, 90] as const;
const pctOf = (v: number | null) => (v === null ? null : v * 100);
const seconds = (ms: number | null) => (ms === null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)} giây` : `${(ms / 60_000).toFixed(1)} phút`);

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function FunnelCells({ row }: { row: FunnelRow }) {
  const cell = (n: number) => (
    <td className="py-1.5 pr-3 text-right tabular-nums">
      {formatNumber(n)}
      {row.conversations > 0 && n !== row.conversations ? <span className="ml-1 text-[11px] text-muted-foreground">{formatPercent((n / row.conversations) * 100, 0)}</span> : null}
    </td>
  );
  return (
    <>
      <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(row.conversations)}</td>
      {cell(row.quoted)}
      {cell(row.identified)}
      {cell(row.drafted)}
      {cell(row.confirmed)}
    </>
  );
}

/**
 * HIỆU QUẢ AI BÁN HÀNG (docs/productization/MIGRATION_PLAN.md M4) — phễu theo hội thoại, AI tự làm vs AI rồi chuyển người,
 * thời gian trả lời, lý do chuyển người, upsell, đơn bot chốt theo kết cục GIAO THẬT (ORDER_OUTCOME), chi phí AI / đơn giao
 * thành công. Số đọc từ sổ sự kiện `sales_conversation_events` — trước ngày bật sổ là CHƯA ĐO.
 */
export default async function AiSalesPerformancePage({ searchParams }: { searchParams: Promise<{ days?: string; pg?: string }> }) {
  const user = await requirePermission("ai_sales:view");
  const manage = can(user, SALES_CHATBOT_MANAGE);
  const sp = await searchParams;
  const days = PERIODS.find((d) => String(d) === sp.days) ?? 30;
  // NHIỀU PAGE: page là một CHIỀU lọc trên cùng công thức — «mọi page» và «một page» đọc cùng các hàm dưới đây.
  const pages = await inboxPages();
  const pageId = pages.some((p) => p.id === sp.pg) ? (sp.pg as string) : null;
  const pgQ = pageId ? `&pg=${encodeURIComponent(pageId)}` : "";
  const r: AiSalesPerformance = await loadAiSalesPerformance(user.organization?.code ?? "", { days, withMoney: manage, pageId });
  const experiment = await loadExperimentReport();
  const basket = await loadBasketStats({ days, pageId });
  const attr = await loadOrderAttribution({ days, pageId });
  const lost = await loadLostReasons({ days, pageId });
  const t = r.cohorts.total;
  const coveragePct = r.coverage.conversationsActive > 0 ? (r.coverage.conversationsWithEvents / r.coverage.conversationsActive) * 100 : null;
  const unavailable = AI_SALES_METRICS.filter((m) => m.availability === "UNAVAILABLE");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Hiệu quả AI bán hàng"
        description={`${days} ngày gần nhất · ${user.organization?.name ?? ""}${pageId ? ` · ${pages.find((p) => p.id === pageId)?.name ?? pageId}` : pages.length > 1 ? ` · ${pages.length} page` : ""}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Số đọc từ SỔ SỰ KIỆN của bot: mỗi tin khách, câu trả lời, báo giá, SĐT, đơn nháp / chốt, chuyển người đều có mốc. Trước ngày bật sổ là CHƯA ĐO — không phải 0.</p>
            <p>«AI bán được» là đơn GIAO THÀNH CÔNG theo kết cục đơn chung của ERP, không phải «bot chốt». Đơn còn đang giao in riêng.</p>
            <p>«AI rồi chuyển người» là những hội thoại KHÓ hơn (bot chuyển vì khách sỉ, khiếu nại, ngoài chính sách…) — tỷ lệ của nhóm đó thấp hơn không có nghĩa nhân viên làm kém.</p>
            <p>Tỷ lệ / trung vị cần ít nhất {AI_SALES_MIN_SAMPLE} quan sát; ít hơn thì để trống.</p>
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {PERIODS.map((d) => (
              <Link key={d} href={`/ai/sales-chatbot/performance?days=${d}${pgQ}`} className={`inline-flex h-8 items-center rounded-md border px-3 text-sm ${d === days ? "bg-muted font-semibold" : "hover:bg-muted"}`}>
                {d} ngày
              </Link>
            ))}
            {pages.length > 1 ? (
              <form method="get" action="/ai/sales-chatbot/performance" className="flex items-center gap-1 sm:ml-2" data-testid="ai-perf-page-filter">
                <input type="hidden" name="days" value={days} />
                <select name="pg" defaultValue={pageId ?? ""} className="h-8 max-w-[11rem] rounded-md border bg-background px-1 text-sm" aria-label="Page">
                  <option value="">Mọi page</option>
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="h-8 rounded-md border px-2 text-sm hover:bg-muted">
                  Xem
                </button>
              </form>
            ) : null}
            <Link href="/ai/sales-chatbot/quality" className="ml-2 inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">
              Rà lỗi AI
            </Link>
            <Link href="/ai/sales-chatbot" className="ml-2 inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">
              ← Chatbot
            </Link>
          </div>
        }
      />

      {r.measuredSince === null ? (
        <SectionCard title="Chưa có số đo">
          <p className="text-sm text-muted-foreground" data-testid="ai-perf-empty">
            Sổ sự kiện còn trống: bot chưa trả lời khách nào kể từ khi bật đo lường. Số sẽ hiện sau tin khách đầu tiên.
          </p>
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="ai-perf-stats">
            <Stat label="hội thoại có khách nhắn" value={formatNumber(t.conversations)} sub={`đo từ ${formatDate(r.measuredSince)}`} />
            <Stat label="AI tự chốt (không chuyển người)" value={formatPercent(pctOf(r.rates.aiResolution), 1)} sub={`${formatNumber(r.cohorts.aiOnly.confirmed)} hội thoại`} />
            <Stat label="chuyển người" value={formatPercent(pctOf(r.rates.handoff), 1)} />
            <Stat label="khách để lại SĐT" value={formatPercent(pctOf(r.rates.leadCapture), 1)} />
            <Stat label="trả lời trung vị · p90" value={`${seconds(r.response.medianMs)} · ${seconds(r.response.p90Ms)}`} sub={`${formatNumber(r.response.samples)} lượt`} />
            <Stat label="độ phủ của sổ" value={formatPercent(coveragePct, 0)} sub={`${formatNumber(r.coverage.conversationsWithEvents)}/${formatNumber(r.coverage.conversationsActive)} hội thoại`} />
          </div>

          <SectionCard title="Phễu theo hội thoại" hint={<p className="text-xs leading-5">Mỗi hội thoại một dòng đếm; một hội thoại đi tới bước nào thì tính ở bước đó. Hai nhóm cộng lại bằng dòng Tổng.</p>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="ai-perf-funnel">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Nhóm</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Hội thoại</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Đã báo giá</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Để lại SĐT</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Bot lên đơn nháp</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Chốt</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="py-1.5 pr-3">
                      <Link href={drillHref({ days, cohort: "AI_ONLY" })} className="underline-offset-2 hover:underline">
                        AI tự xử lý
                      </Link>
                    </td>
                    <FunnelCells row={r.cohorts.aiOnly} />
                  </tr>
                  <tr className="border-b">
                    <td className="py-1.5 pr-3">
                      <Link href={drillHref({ days, cohort: "AI_THEN_HUMAN" })} className="underline-offset-2 hover:underline">
                        AI rồi chuyển người
                      </Link>
                    </td>
                    <FunnelCells row={r.cohorts.aiThenHuman} />
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-1.5 pr-3">
                      <Link href={drillHref({ days })} className="underline-offset-2 hover:underline">
                        Tổng
                      </Link>
                    </td>
                    <FunnelCells row={t} />
                  </tr>
                </tbody>
              </table>
            </div>
          </SectionCard>

          {experiment ? <ExperimentBlock report={experiment} days={days} /> : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Đơn bot chốt — kết cục giao thật" hint={<p className="text-xs leading-5">Kết cục theo ORDER_OUTCOME của ERP (phiếu giao ký nhận / chứng từ hãng vận chuyển). «Giao thành công» chỉ tính trên đơn ĐÃ ngã ngũ.</p>}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="ai-perf-orders">
                <Stat label="đơn bot chốt" value={formatNumber(r.orders.confirmed)} sub={formatVND(r.orders.confirmedValueVnd)} />
                <Stat label="giao thành công" value={formatNumber(r.orders.delivered)} sub={formatVND(r.orders.deliveredRevenueVnd)} />
                <Stat label="tỷ lệ giao thành công" value={formatPercent(pctOf(r.orders.deliveryRate), 1)} sub={`trên ${formatNumber(r.orders.settled)} đơn đã ngã ngũ`} />
                <Stat label="hoàn" value={formatNumber(r.orders.returned)} />
                <Stat label="huỷ" value={formatNumber(r.orders.cancelled)} />
                <Stat label="đang giao / chưa rõ" value={formatNumber(r.orders.pending)} />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Đơn AI ghi hộ nhân viên (nhân viên chốt, AI đọc hội thoại và ghi): <b>{formatNumber(r.orderSync.orders)}</b> đơn · {formatVND(r.orderSync.valueVnd)} — không tính vào «bot chốt».
              </p>
            </SectionCard>

            <SectionCard title="Chuyển người & mua thêm">
              <div className="space-y-3">
                <table className="w-full text-sm" data-testid="ai-perf-handoff">
                  <tbody>
                    {r.handoffReasons.length === 0 ? (
                      <tr>
                        <td className="py-1 text-muted-foreground">Chưa có lượt chuyển người trong kỳ.</td>
                      </tr>
                    ) : (
                      r.handoffReasons.map((h) => (
                        <tr key={h.code} className="border-b last:border-0">
                          <td className="py-1 pr-3">
                            <Link href={drillHref({ days, reason: h.code })} className="underline-offset-2 hover:underline">
                              {h.label}
                            </Link>
                          </td>
                          <td className="py-1 text-right tabular-nums">{formatNumber(h.count)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                <div className="grid grid-cols-3 gap-2" data-testid="ai-perf-upsell">
                  <Stat label="lời mời mua thêm" value={r.upsell.offered ? formatNumber(r.upsell.offered) : "chưa đo"} sub={r.upsell.offered ? undefined : "cần câu mẫu UPSELL"} />
                  <Stat label="khách nhận" value={formatPercent(pctOf(r.upsell.attachRate), 0)} sub={`${formatNumber(r.upsell.accepted)} nhận · ${formatNumber(r.upsell.declined)} không`} />
                  <Stat label="tiền mua thêm" value={formatVND(r.upsell.offered ? r.upsell.revenueVnd : null)} />
                </div>
                <div className="grid grid-cols-3 gap-2" data-testid="ai-perf-basket" title="Đơn bot chốt trong kỳ (trừ đơn huỷ, trừ hàng tặng). Giá trị đọc từ dòng hàng, không phải tiền thực thu. «Đã giao» = ORDER_OUTCOME giao thành công; đơn chưa ngã ngũ không tính vào đó.">
                  <Stat label="món / đơn bot chốt" value={basket.booked.itemsPerOrder === null ? "—" : basket.booked.itemsPerOrder.toFixed(1)} sub={`${formatNumber(basket.booked.orders)} đơn`} />
                  <Stat label="đơn có ≥ 2 sản phẩm (bán chéo)" value={formatPercent(pctOf(basket.booked.multiProductRate), 0)} sub={`${formatNumber(basket.booked.multiProductOrders)} đơn · ${formatNumber(basket.delivered.multiProductOrders)} đã giao`} />
                  <Stat label="giá trị bán chéo đã giao" value={formatVND(basket.delivered.orders ? basket.delivered.crossSellValueVnd : null)} sub={`đơn chốt: ${formatVND(basket.booked.orders ? basket.booked.crossSellValueVnd : null)}`} />
                </div>
              </div>
            </SectionCard>
          </div>

          <SectionCard
            title="Đơn theo người làm ra"
            hint={
              <div className="space-y-1.5 text-xs leading-5">
                <p>Mỗi đơn chốt trong hội thoại mang ĐÚNG MỘT nhãn. «AI tự bán»: bot chốt, không ai chạm vào trước lúc chốt. «AI góp công»: có người chạm vào và bot đã báo giá / lên nháp / mời mua thêm / lấy được SĐT trước lúc lên đơn. «Người bán»: bot không làm việc bán hàng nào — một câu chào không tính.</p>
                <p>Ba nhãn không cộng gộp. Đơn ngoài hội thoại (lên tay trên POS) không thuộc bảng này. Doanh thu = đơn GIAO THÀNH CÔNG theo kết cục đơn chung của ERP.</p>
              </div>
            }
          >
            <div className="grid gap-2 sm:grid-cols-3" data-testid="ai-perf-attribution">
              {ORDER_ATTRIBUTIONS.map((k) => (
                <Stat key={k} label={ORDER_ATTRIBUTION_LABEL[k]} value={formatVND(attr.table[k].deliveredRevenueVnd)} sub={`${formatNumber(attr.table[k].delivered)}/${formatNumber(attr.table[k].orders)} đơn đã giao · đặt ${formatVND(attr.table[k].valueVnd)}`} />
              ))}
            </div>
            {attr.table.unattributed ? <p className="mt-2 text-xs text-muted-foreground">{formatNumber(attr.table.unattributed)} đơn chưa quy kết được (thiếu sự kiện lên / chốt đơn trong sổ) — không tính là «người bán».</p> : null}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="ai-perf-followup">
              <Stat label="hội thoại bot nhắc lại" value={formatNumber(attr.followup.conversations)} />
              <Stat label="khách trả lời sau lời nhắc" value={formatPercent(pctOf(attr.followup.replyRate), 0)} sub={`${formatNumber(attr.followup.replied)} hội thoại`} />
              <Stat label="đơn follow-up thu hồi" value={formatNumber(attr.followup.recoveredOrders)} sub={`đặt ${formatVND(attr.followup.recoveredValueVnd)}`} />
              <Stat label="doanh thu thu hồi đã giao" value={formatVND(attr.followup.recoveredDeliveredRevenueVnd)} sub={`${formatNumber(attr.followup.recoveredDelivered)} đơn đã giao`} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2" data-testid="ai-perf-economics">
              <Stat label="giá trị đơn bot chốt trung bình" value={formatVND(r.economics.aovVnd)} />
              <Stat label="doanh thu đã giao / hội thoại" value={formatVND(r.economics.deliveredRevenuePerConversationVnd)} sub={`${formatNumber(t.conversations)} hội thoại`} />
            </div>
          </SectionCard>

          <SectionCard
            title="Vì sao khách không mua"
            description={`${formatNumber(lost.lost)} hội thoại không mua · ${formatNumber(lost.ordered)} có đơn · ${formatNumber(lost.open)} chưa ngã ngũ (khách nhắn trong 24 giờ qua)`}
            hint={
              <div className="space-y-1.5 text-xs leading-5">
                <p>Khách TỪ CHỐI RÕ: lý do đọc từ câu bot ghi lại, xếp nhóm bằng từ khoá (không khớp ⇒ «lý do khác»). Khách IM quá 24 giờ (bot không còn được nhắn): nhóm «im lặng» là SUY RA, không phải lời khách.</p>
                <p>«Chuyển người, ERP không thấy đơn» không có nghĩa là mất khách — nhân viên có thể đã bán trên kênh khác. Bấm một dòng để đọc lại đúng các hội thoại đó.</p>
              </div>
            }
          >
            {lost.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có hội thoại nào ngã ngũ mà không mua trong kỳ.</p>
            ) : (
              <table className="w-full text-sm" data-testid="ai-perf-lost">
                <tbody>
                  {lost.rows.map((row) => (
                    <tr key={row.code} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        <Link href={drillHref({ days, lost: row.code })} className="underline-offset-2 hover:underline">
                          {row.label}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(row.count)}</td>
                      <td className="w-14 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{formatPercent(pctOf(row.share), 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          {r.cost ? (
            <SectionCard
              title="Chi phí AI & ROI"
              hint={
                <div className="space-y-1.5 text-xs leading-5">
                  <p>Chi phí = token thật × bảng giá model × tỷ giá {formatNumber(r.cost.rateVndPerUsd)} ₫/USD — ƯỚC TÍNH. Khung thử và lượt AI ghi đơn hộ nhân viên KHÔNG chia vào đơn của bot.</p>
                  <p>«Tiết kiệm nhân sự» chỉ có khi chủ shop khai chi phí một hội thoại do người làm — luôn là ước tính, không cộng vào doanh thu.</p>
                </div>
              }
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="ai-perf-cost">
                <Stat label="chi phí AI bán hàng (ước tính)" value={formatVND(r.cost.sellingVnd)} sub={r.cost.unknownCost ? `cận dưới · ${formatNumber(r.cost.unknownCost)} lượt chưa định giá` : `${formatNumber(r.cost.turns)} lượt`} />
                <Stat label="AI / đơn bot chốt" value={formatVND(r.cost.perConfirmedOrderVnd)} />
                <Stat label="AI / đơn giao thành công" value={formatVND(r.cost.perDeliveredOrderVnd)} />
                <Stat label="AI / hội thoại" value={formatVND(r.economics.aiCostPerConversationVnd)} sub={r.economics.costIsLowerBound ? "cận dưới" : undefined} />
                <Stat label="doanh thu đã giao ÷ chi phí AI" value={r.economics.revenuePerAiCost === null ? "—" : `${formatNumber(Math.round(r.economics.revenuePerAiCost))} lần`} sub={r.economics.costIsLowerBound ? "chi phí là cận dưới ⇒ tỷ lệ là cận trên" : undefined} />
                <Stat label="AI ghi đơn hộ nhân viên" value={formatVND(r.cost.orderSyncVnd)} />
                <Stat label="khung thử" value={formatVND(r.cost.testVnd)} />
                <Stat label="tiết kiệm nhân sự (ước tính)" value={formatVND(r.human?.estimatedSavingVnd ?? null)} sub={r.human?.humanCostPerConversationVnd ? `${formatNumber(r.cohorts.aiOnly.conversations)} hội thoại × ${formatVND(r.human.humanCostPerConversationVnd)}` : "chưa khai chi phí người"} />
              </div>
              <HumanCostForm current={r.human?.humanCostPerConversationVnd ?? null} reason={r.human?.reason ?? null} setBy={r.human?.setBy ?? null} at={r.human?.at ?? null} />
            </SectionCard>
          ) : null}
        </>
      )}

      <SectionCard title="Chưa đo được" hint={<p className="text-xs leading-5">Chỉ số chủ shop sẽ muốn có nhưng dữ liệu chưa cho phép. Không thay bằng một con số gần đúng.</p>}>
        <ul className="space-y-1.5 text-sm" data-testid="ai-perf-unavailable">
          {unavailable.map((m) => (
            <li key={m.key}>
              <b>{m.label}</b> — <span className="text-muted-foreground">{m.missingWhat}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
