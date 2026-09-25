import { cache } from "react";
import Link from "next/link";
import { ExternalLink, Plus } from "lucide-react";
import { SuggestedTransition } from "@/app/(dashboard)/models/[id]/suggestion-transition";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { ADS_ACTION_HINT, ADS_ACTION_TONE, isConclusive } from "@/lib/constants/ads-decision";
import { CREATIVE_VERDICT_LABEL, CREATIVE_VERDICTS } from "@/lib/constants/creative-loop";
import { SAMPLE_STATUS_LABEL, TOPIC_STATUS_LABEL } from "@/lib/constants/production-os";
import {
  countText,
  deriveModelSuggestions,
  loadSource,
  MODEL_360_BLOCK_ACCESS,
  MODEL_360_PENDING_SOURCES,
  moneyText,
  pctText,
  ratioText,
  redactSignalReasons,
  sourceFailedText,
  type Loaded,
  type Model360Block,
  type ModelSuggestion,
} from "@/lib/constants/model-360";
import type { ModelState } from "@/lib/constants/model-lifecycle";
import { winnerFollowUp } from "@/lib/constants/early-topic";
import { MODEL_SIGNAL_HINT, MODEL_SIGNAL_LABEL, MODEL_SIGNAL_TONE, SIGNAL_SOURCE_LABEL, SOURCE_VOTE_LABEL } from "@/lib/constants/model-signal";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { getModelAdsSummary, getModelCreativeSummary, NO_VERDICT } from "@/lib/queries/model-ads";
import { getModelEconomics, type EconomicsUnit, type EconomicsValue } from "@/lib/queries/model-economics";
import { getModelInventoryDecisions, getModelOrderOutcome } from "@/lib/queries/model-360";
import { getModelSignal } from "@/lib/queries/model-signal";
import { getModelProductionSummary } from "@/lib/queries/model-production";
import { getModelReturnDispositions } from "@/lib/queries/model-returns";
import { getModelStockStates } from "@/lib/queries/model-stock";
import { mergeStockFeedbackSuggestions } from "@/lib/constants/stock-feedback";
import { getStockFeedbackForProduct } from "@/lib/queries/stock-feedback";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CÁC KHỐI CỦA TRANG MODEL 360 (Company OS · A2) ═══════════
 *
 * Mỗi khối là một Server Component BẤT ĐỒNG BỘ đứng sau ranh giới `Suspense` riêng (page.tsx): một nguồn
 * chậm không giữ cả trang. Mỗi khối đọc nguồn của nó qua `loadSource` — nguồn ném lỗi thì khối in
 * "Không đọc được nguồn …", KHÔNG làm sập trang và KHÔNG giả vờ là "chưa có dữ liệu".
 *
 * Không khối nào có công thức: mọi con số là của hàm đọc của miền chủ (B · D · F · bảng quyết định /ads).
 * CHƯA BIẾT in "—" (luật 42). Không tô màu / xếp hạng ở chỗ nguồn nói chưa kết luận được (luật 44).
 * Chữ giải thích nằm trong ⓘ; màn hình còn lại là số.
 */

export type BlockCtx = {
  modelId: string;
  productId: string | null;
  productName: string | null;
  declaredState: ModelState | null;
  range: Period;
  /** `period=…&from=…&to=…` để link sang màn hình chủ giữ đúng kỳ. */
  periodQuery: string;
  allowed: Record<Model360Block, boolean>;
  canWrite: boolean;
  /** `production:write` — nút "Tạo topic sản xuất". */
  canCreateTopic: boolean;
};

/** Tín hiệu đọc MỘT lần cho mỗi lượt dựng trang (đầu trang + khối tín hiệu + khối đề xuất). */
const signalOnce = cache((modelId: string, range: Period) => loadSource("tín hiệu mẫu", () => getModelSignal(modelId, range)));

/**
 * Tóm tắt sản xuất (Agent C) đọc MỘT lần cho mỗi lượt dựng trang — khối Đề xuất và ô đổi trạng thái
 * (lượt chuyển tiếp sau khi khai THẮNG — Agent T) dùng chung. Người gọi tự kiểm quyền khối.
 */
export const productionOnce = cache((modelId: string) => loadSource("sản xuất (getModelProductionSummary)", () => getModelProductionSummary(modelId)));

// ─────────────────────────── MẢNH GIAO DIỆN DÙNG CHUNG ───────────────────────────

function Stat({ label, value, hint, sub }: { label: string; value: React.ReactNode; hint?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {hint ? <InfoHint>{hint}</InfoHint> : null}
      </p>
      <p className="numeric text-[15px] font-bold leading-5">{value}</p>
      {sub ? <p className="truncate text-[10.5px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function StatGrid({ children, cols = 4 }: { children: React.ReactNode; cols?: 3 | 4 }) {
  return <div className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-hairline", cols === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3")}>{children}</div>;
}

function HomeLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {label} <ExternalLink className="size-3" />
    </Link>
  );
}

function Failed({ l }: { l: Extract<Loaded<unknown>, { ok: false }> }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-rose-700 dark:text-rose-300">
      {sourceFailedText(l)}
      <InfoHint>{l.error}</InfoHint>
    </p>
  );
}

function NoProduct({ what }: { what: string }) {
  return <p className="text-sm text-muted-foreground">— Mẫu chưa có sản phẩm Pancake nên không có {what} để đọc (chưa biết, không phải 0).</p>;
}

/** Khối người xem không có quyền của màn hình chủ: nói rõ cần quyền gì, không in số nào. */
export function DeniedBlock({ title, block }: { title: string; block: Model360Block }) {
  const a = MODEL_360_BLOCK_ACCESS[block];
  return (
    <SectionCard title={title}>
      <p className="text-sm text-muted-foreground">
        Cần quyền <code className="text-xs">{a.permission}</code> (màn hình {a.home}) để xem khối này.
      </p>
    </SectionCard>
  );
}

// ─────────────────────────── TÍN HIỆU MẪU ───────────────────────────

/** Nhãn tín hiệu ở đầu trang. */
export async function SignalBadge({ ctx }: { ctx: BlockCtx }) {
  const l = await signalOnce(ctx.modelId, ctx.range);
  if (!l.ok || !l.data) return <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">Tín hiệu: —</span>;
  const s = l.data.signal;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold", MODEL_SIGNAL_TONE[s])} title={MODEL_SIGNAL_HINT[s]}>
      Tín hiệu: {MODEL_SIGNAL_LABEL[s]}
      {l.data.conflicts.length ? <span className="font-normal">· ⚡{l.data.conflicts.length}</span> : null}
    </span>
  );
}

export async function SignalBlock({ ctx }: { ctx: BlockCtx }) {
  const l = await signalOnce(ctx.modelId, ctx.range);
  const hint = (
    <>
      Phép GỘP các phán quyết đã có — quyết định quảng cáo (/ads), phân loại sáu chiều của từng mẫu mã, phán quyết creative, trạng thái thiết kế — theo một bảng cố định trong{" "}
      <code>lib/constants/model-signal.ts</code>. Không ngưỡng mới. Thiếu một nguồn thị trường thì không bao giờ là THẮNG; hai nguồn nói ngược nhau thì lấy phía thận trọng và nêu xung đột. Tồn kho chỉ là bối cảnh. Tín hiệu là ƯỚC TÍNH, không ghi vào trạng thái khai.
    </>
  );
  if (!l.ok) {
    return (
      <SectionCard title="Tín hiệu mẫu" hint={hint}>
        <Failed l={l} />
      </SectionCard>
    );
  }
  const r = l.data;
  if (!r) return null;
  const reasons = redactSignalReasons(r.reasons, (b) => ctx.allowed[b]);
  return (
    <SectionCard
      title="Tín hiệu mẫu"
      hint={hint}
      description={`${r.periodLabel} · ${r.decidedBy === "MARKET" ? "quyết bởi số thị trường" : r.decidedBy === "TESTING" ? "quyết bởi vòng thử" : "chưa nguồn nào kết luận"}`}
      actions={<DataWarnings items={r.conflicts} label={r.conflicts.length ? `⚡ ${r.conflicts.length} xung đột` : undefined} />}
    >
      <div className="space-y-3">
        <span className={cn("inline-flex rounded-md px-2.5 py-1 text-sm font-bold", MODEL_SIGNAL_TONE[r.signal])}>{MODEL_SIGNAL_LABEL[r.signal]}</span>
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-medium">Nguồn</th>
              <th className="py-1 pr-2 font-medium">Phán quyết</th>
              <th className="py-1 font-medium">Lá phiếu</th>
            </tr>
          </thead>
          <tbody>
            {reasons.map((x) => (
              <tr key={x.source} className="border-t align-top">
                <td className="py-1.5 pr-2 whitespace-nowrap">{SIGNAL_SOURCE_LABEL[x.source]}</td>
                <td className="py-1.5 pr-2">
                  <span className="inline-flex items-center gap-1">
                    {x.verdict}
                    <InfoHint>{x.detail}</InfoHint>
                  </span>
                </td>
                <td className="py-1.5 text-muted-foreground">{SOURCE_VOTE_LABEL[x.vote]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── ĐỀ XUẤT ───────────────────────────

export async function SuggestionsBlock({ ctx }: { ctx: BlockCtx }) {
  const pid = ctx.productId;
  const [sig, ads, inv, prod, stock] = await Promise.all([
    signalOnce(ctx.modelId, ctx.range),
    pid && ctx.allowed.ADS ? loadSource("quảng cáo", () => getModelAdsSummary(pid, ctx.range)) : Promise.resolve(null),
    pid && ctx.allowed.INVENTORY ? loadSource("quyết định tồn", () => getModelInventoryDecisions(pid)) : Promise.resolve(null),
    ctx.allowed.PRODUCTION ? productionOnce(ctx.modelId) : Promise.resolve(null),
    // Vòng phản hồi tồn → creative / quảng cáo (Agent X): gác quyền quyết định tồn; phần quảng cáo chỉ đọc khi được xem quảng cáo.
    pid && ctx.allowed.INVENTORY ? loadSource("phản hồi tồn → creative / quảng cáo", () => getStockFeedbackForProduct(pid, ctx.allowed.ADS)) : Promise.resolve(null),
  ]);
  const failed = [sig, ads, inv, prod, stock].filter((x): x is Extract<Loaded<unknown>, { ok: false }> => !!x && !x.ok);
  const stockNotes = stock && stock.ok ? [...stock.data.insufficient.map((x) => `Chưa kết luận (dữ liệu chưa đủ): ${x}`), ...stock.data.notes] : [];
  const base: ModelSuggestion[] = deriveModelSuggestions({
    modelId: ctx.modelId,
    declaredState: ctx.declaredState,
    signal: sig.ok && sig.data ? { signal: sig.data.signal, summary: sig.data.summary } : null,
    ads:
      ads && ads.ok
        ? { status: ads.data.status, action: ads.data.decision?.action ?? null, reason: ads.data.decision?.reason ?? "", spend: ads.data.spend, cpo: ads.data.cpo, profitAfterAds: ads.data.profitAfterAds }
        : null,
    inventory: inv && inv.ok ? { rows: inv.data.rows, dataGate: inv.data.dataGate.state } : null,
    creativeHref: pid ? `/marketing/creatives?tab=thu-vien&mau=${encodeURIComponent(pid)}` : null,
    periodQuery: ctx.periodQuery,
    production: prod && prod.ok && prod.data ? { openTopics: prod.data.openTopics, winnerFollowUp: winnerFollowUp(prod.data) } : null,
    canCreateTopic: ctx.canCreateTopic,
  });
  const list: ModelSuggestion[] = stock && stock.ok ? mergeStockFeedbackSuggestions(base, stock.data.recommendations) : base;
  return (
    <SectionCard
      title="Đề xuất"
      hint="Chỉ dựng từ quyết định ĐÃ CÓ: bảng quyết định quảng cáo (Tăng ngân sách / Cắt), bộ máy quyết định tồn (đặt thêm — số đã trừ hàng đặt xưởng; chôn vốn / nên xả), tín hiệu mẫu THẮNG khi vòng đời chưa tới bước trao đổi sản xuất; tín hiệu TRIỂN VỌNG ⇒ mở topic sản xuất SỚM, chạy song song với test quảng cáo, vòng đời không đổi (quy tắc chủ shop 25/09/2026); mẫu đã khai THẮNG mà sản xuất đi trước ⇒ chuyển vòng đời tới đúng chỗ sản xuất đang đứng. Vòng phản hồi tồn → creative / quảng cáo: tồn chậm ⇒ làm creative mới / đẩy qua khách cũ; quảng cáo đề nghị tăng mà sắp hết hàng ⇒ đừng tăng. Không có quyết định thì không có đề xuất. Mọi đề xuất là để NGƯỜI bấm — không có gì tự áp."
      actions={
        failed.length || stockNotes.length ? (
          <span className="flex items-center gap-2">
            {failed.length ? <DataWarnings tone="danger" items={failed.map((f) => `${sourceFailedText(f)}: ${f.error}`)} /> : null}
            {stockNotes.length ? <DataWarnings items={stockNotes} /> : null}
          </span>
        ) : null
      }
    >
      {list.length ? (
        <ul className="space-y-3">
          {list.map((s) => (
            <li key={s.key} className="space-y-1 border-b pb-3 last:border-0 last:pb-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                {s.what}
                <InfoHint>{s.why}</InfoHint>
                {s.caveat ? <DataWarnings items={[s.caveat]} label="⚠ chỉ tham khảo" /> : null}
              </p>
              <p className="numeric text-xs text-muted-foreground">{s.data}</p>
              <div className="flex flex-wrap items-center gap-3">
                {s.links.map((lnk) => (
                  <HomeLink key={lnk.href} href={lnk.href} label={lnk.label} />
                ))}
                {s.transition ? ctx.canWrite ? <SuggestedTransition modelId={ctx.modelId} to={s.transition.to} reason={s.transition.reason} /> : <span className="text-[11px] text-muted-foreground">Cần quyền “Vòng đời mẫu: khai &amp; đồng bộ” để chuyển.</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Không có đề xuất — chưa bộ máy nào đưa ra quyết định cần làm cho mẫu này{ctx.allowed.ADS && ctx.allowed.INVENTORY ? "" : " (trong phạm vi quyền của bạn)"}.</p>
      )}
    </SectionCard>
  );
}

// ─────────────────────────── QUẢNG CÁO & CREATIVE ───────────────────────────

export async function AdsCreativeBlock({ ctx }: { ctx: BlockCtx }) {
  const pid = ctx.productId;
  const title = "Creative & quảng cáo";
  if (!pid) {
    return (
      <SectionCard title={title}>
        <NoProduct what="quảng cáo hay creative" />
      </SectionCard>
    );
  }
  const [ads, cr] = await Promise.all([
    ctx.allowed.ADS ? loadSource("quảng cáo (/ads)", () => getModelAdsSummary(pid, ctx.range)) : Promise.resolve(null),
    ctx.allowed.CREATIVE ? loadSource("creative", () => getModelCreativeSummary(pid)) : Promise.resolve(null),
  ]);

  return (
    <SectionCard
      title={title}
      description={ctx.range.label}
      hint="Quảng cáo: NGUYÊN dòng chiều mã hàng của bảng quyết định /ads (Agent B · getModelAdsSummary). Creative: phán quyết đã chụp của vòng creative. Không số nào tính lại ở đây."
      actions={<HomeLink href={`/ads?dim=product${ctx.periodQuery ? `&${ctx.periodQuery}` : ""}`} label="/ads" />}
    >
      <div className="space-y-4">
        {/* ── Quảng cáo ── */}
        {ads === null ? (
          <p className="text-xs text-muted-foreground">Cần quyền <code>expenses:view</code> để xem số quảng cáo.</p>
        ) : !ads.ok ? (
          <Failed l={ads} />
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-muted-foreground">Quyết định:</span>
              {ads.data.decision ? (
                <span className={cn("inline-flex items-center gap-1 font-semibold", ads.data.status === "OK" && isConclusive(ads.data.decision.action) ? ADS_ACTION_TONE[ads.data.decision.action] : "text-muted-foreground")}>
                  {ads.data.decision.label}
                  <InfoHint>
                    {ads.data.decision.reason} — {ADS_ACTION_HINT[ads.data.decision.action]}
                  </InfoHint>
                </span>
              ) : (
                <span className="text-muted-foreground">— (không có dòng của mã trong kỳ)</span>
              )}
              {ads.data.decision?.basis === "PROJECTED" ? <span className="rounded bg-muted px-1 text-[10px]">theo tạm tính</span> : null}
              <DataWarnings
                items={[
                  ads.data.status === "SPEND_UNMAPPED" ? "Mã có đơn nhưng CHƯA TỪNG ghép chiến dịch nào — chi, CPO, ROAS, lợi nhuận là CHƯA BIẾT (—), không phải 0. Hành động của bảng quyết định đứng trên chi 0 ₫ nên không tô màu." : null,
                  ads.data.attribution.orderCoveragePct !== null ? `Độ phủ quy kết đơn → quảng cáo của cả bảng: ${formatPercent(ads.data.attribution.orderCoveragePct)}` : "Độ phủ quy kết: chưa đo được",
                ]}
              />
            </div>
            <StatGrid>
              <Stat label="Chi quảng cáo" value={moneyText(ads.data.spend)} />
              <Stat label="Đơn chốt" value={countText(ads.data.orders)} hint={ads.data.attribution.basis} />
              <Stat label="CPO" value={moneyText(ads.data.cpo)} />
              <Stat label="ROAS lên đơn · giao" value={`${ratioText(ads.data.bookedRoas)} · ${ratioText(ads.data.deliveredRoas)}`} />
              <Stat label="LN góp sau QC" value={moneyText(ads.data.profitAfterAds)} sub="Thực đạt" />
              <Stat label="LN góp sau QC" value={moneyText(ads.data.projectedProfitAfterAds)} sub="Tạm tính (ước tính)" />
              <Stat label="Đơn đã giao" value={countText(ads.data.deliveredOrders)} />
              <Stat label="Chi ở hạt mẩu" value={pctText(ads.data.attribution.spendAtAdGrainPct)} hint="Phần chi của kỳ (cả bảng) đã có số ở hạt mẩu quảng cáo." />
            </StatGrid>
          </div>
        )}

        {/* ── Creative ── */}
        {cr === null ? (
          <p className="text-xs text-muted-foreground">Cần quyền <code>ideas:view</code> để xem creative.</p>
        ) : !cr.ok ? (
          <Failed l={cr} />
        ) : cr.data.total === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có creative nào của vòng creative quảng bá mã này (0 creative).</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">{formatNumber(cr.data.total)} creative:</span>
              {[...CREATIVE_VERDICTS, NO_VERDICT].map((k) =>
                cr.data.byVerdict[k] ? (
                  <span key={k} className="rounded border px-1.5 py-0.5">
                    {k === NO_VERDICT ? "Chưa phán" : CREATIVE_VERDICT_LABEL[k]} {formatNumber(cr.data.byVerdict[k])}
                  </span>
                ) : null,
              )}
            </div>
            <StatGrid cols={3}>
              <Stat label="Đơn quy về creative" value={countText(cr.data.attributedOrders)} sub={`${formatNumber(cr.data.ordersViaPost)} qua bài viết`} />
              <Stat label="Chi creative" value={moneyText(cr.data.spendVnd)} sub={cr.data.spendUnknownVariants ? `${cr.data.spendUnknownVariants} mẩu chưa biết chi` : undefined} />
              <Stat label="Chi / đơn" value={moneyText(cr.data.cpoVnd)} />
            </StatGrid>
            <div className="flex flex-wrap items-center gap-3">
              {cr.data.latestWinner ? <HomeLink href={cr.data.latestWinner.href} label={`Mẫu thắng gần nhất: ${cr.data.latestWinner.headline || "(không tiêu đề)"}`} /> : null}
              <HomeLink href={cr.data.links.library} label="Thư viện creative của mẫu" />
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── ĐƠN / GIAO / HOÀN ───────────────────────────

export async function OrdersBlock({ ctx }: { ctx: BlockCtx }) {
  const pid = ctx.productId;
  const title = "Đơn · giao · hoàn";
  if (!ctx.allowed.ORDERS) return <DeniedBlock title={title} block="ORDERS" />;
  if (!pid) {
    return (
      <SectionCard title={title}>
        <NoProduct what="đơn hàng" />
      </SectionCard>
    );
  }
  const l = await loadSource("kết quả đơn (bảng quyết định /ads)", () => getModelOrderOutcome(pid, ctx.range));
  const q = encodeURIComponent(ctx.productName ?? "");
  return (
    <SectionCard
      title={title}
      description={ctx.range.label}
      hint="Mọi số đơn đếm theo ORDER_OUTCOME (không theo trạng thái Pancake) trên quần thể đơn đã chốt, theo ngày lên đơn — cùng dòng chiều mã hàng mà khối quảng cáo và kinh tế đọc. 'Chưa rời kho' / 'Đang trên đường' tách bằng chứng từ ĐVVC (mốc lấy hàng). Hoàn gồm cả 'không thành công theo luật tiền'."
      actions={<HomeLink href={`/products/performance?q=${q}${ctx.periodQuery ? `&${ctx.periodQuery}` : ""}`} label="Hiệu quả mẫu mã" />}
    >
      {!l.ok ? (
        <Failed l={l} />
      ) : (
        <div className="space-y-2">
          {l.data.status === "NO_ORDERS" ? <p className="text-xs text-muted-foreground">Không có đơn đã chốt nào chứa mã trong kỳ — các ô đếm là 0 thật; tỷ lệ là — (chưa có đơn kết thúc).</p> : null}
          <StatGrid>
            <Stat label="Đơn chốt" value={countText(l.data.booked)} />
            <Stat label="Chưa rời kho" value={countText(l.data.notShipped)} />
            <Stat label="Đang trên đường" value={countText(l.data.inTransit)} />
            <Stat label="Giao thành công" value={countText(l.data.delivered)} />
            <Stat label="Hoàn" value={countText(l.data.returned)} />
            <Stat label="Tỷ lệ GTC" value={pctText(l.data.successRate)} hint="Trên đơn ĐÃ kết thúc (giao + hoàn). Đơn đang đi không ở mẫu số." />
            <Stat label="DT giao thành công" value={moneyText(l.data.deliveredRevenue)} />
            <Stat label="Tiền đã về (chứng từ)" value={moneyText(l.data.cashReceived)} />
          </StatGrid>
        </div>
      )}
    </SectionCard>
  );
}

// ─────────────────────────── TỒN KHO ───────────────────────────

export async function StockBlock({ ctx }: { ctx: BlockCtx }) {
  const pid = ctx.productId;
  const title = "Tồn kho";
  if (!ctx.allowed.STOCK) return <DeniedBlock title={title} block="STOCK" />;
  if (!pid) {
    return (
      <SectionCard title={title}>
        <NoProduct what="mẫu mã hay phiếu kho" />
      </SectionCard>
    );
  }
  const l = await loadSource("trạng thái tồn (getModelStockStates)", () => getModelStockStates(pid));
  const pendingStock = MODEL_360_PENDING_SOURCES.filter((p) => p.block === "STOCK");
  return (
    <SectionCard
      title={title}
      description="hiện tại — không theo kỳ"
      hint="Sổ kho (luật 10): tồn thực tế = tổng phiếu kho − đã xuất qua ĐVVC; khả dụng = tồn − đã chốt chưa xuất. Mẫu mã chưa có phiếu nhập ⇒ tồn CHƯA BIẾT. 'Đang hoàn' GỒM CẢ kiện đã về chờ kiểm — 'chờ kiểm' là phần tách của nó, không cộng hai số. Hàng hoàn chỉ vào tồn khi kho lập phiếu tái nhập."
      actions={<HomeLink href={`/products/${pid}`} label="Trang kho của sản phẩm" />}
    >
      {!l.ok ? (
        <Failed l={l} />
      ) : l.data.variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sản phẩm chưa có mẫu mã nào — tồn chưa biết (—).</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {formatNumber(l.data.coverage.stockKnownVariants)}/{formatNumber(l.data.coverage.variants)} mẫu mã đã biết tồn
            </span>
            <DataWarnings
              items={[
                l.data.totals.negativeVariants ? `${l.data.totals.negativeVariants} mẫu mã âm sổ (${formatNumber(l.data.totals.negativeQty)}) — không cộng vào tổng, cần kiểm kê` : null,
                l.data.basis.pendingQc === "ITEM_QTY_LOWER_BOUND" ? `Chờ kiểm là CẬN DƯỚI: ${l.data.basis.pendingQcUnattributedParcels} kiện toàn shop chưa ghép được món` : null,
                l.data.basis.pendingQcTruncated ? "Danh sách chờ kiểm bị cắt ở trần đọc — số chờ kiểm có thể thiếu" : null,
                l.data.basis.inProductionUnsplitUnits ? `${formatNumber(l.data.basis.inProductionUnsplitUnits)} sp trong lô xưởng đang mở chưa chia màu/size — không cộng vào mẫu mã nào` : null,
                l.data.basis.inProductionUnmappedUnitsShopWide ? `${formatNumber(l.data.basis.inProductionUnmappedUnitsShopWide)} sp lệnh SX toàn shop không khớp màu/size` : null,
                ...pendingStock.map((p) => `Chưa nối: ${p.what} — hàm ${p.fn} đang xây ở gói của Agent ${p.owner}.`),
              ]}
            />
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Mẫu mã</th>
                  <th className="px-2 py-1.5 text-right font-medium">Tồn thực tế</th>
                  <th className="px-2 py-1.5 text-right font-medium">Khả dụng</th>
                  <th className="px-2 py-1.5 text-right font-medium">Đã chốt</th>
                  <th className="px-2 py-1.5 text-right font-medium">Đang SX</th>
                  <th className="px-2 py-1.5 text-right font-medium">Đang hoàn · chờ kiểm</th>
                  <th className="px-2 py-1.5 text-right font-medium">Hỏng</th>
                </tr>
              </thead>
              <tbody className="numeric">
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-2 py-1.5">Tổng mẫu</td>
                  <td className="px-2 py-1.5 text-right">{countText(l.data.totals.actualStock)}</td>
                  <td className="px-2 py-1.5 text-right">{countText(l.data.totals.available)}</td>
                  <td className="px-2 py-1.5 text-right">{countText(l.data.totals.reserved)}</td>
                  <td className="px-2 py-1.5 text-right">{countText(l.data.totals.inProduction)}</td>
                  <td className="px-2 py-1.5 text-right">
                    {countText(l.data.totals.returning)} · {countText(l.data.totals.pendingQc)}
                  </td>
                  <td className="px-2 py-1.5 text-right">{countText(l.data.totals.damaged)}</td>
                </tr>
                {l.data.variants.slice(0, 40).map((v) => (
                  <tr key={v.variantId} className={cn("border-t", v.removed && "text-muted-foreground")}>
                    <td className="max-w-[220px] truncate px-2 py-1.5">{[v.color, v.size].filter(Boolean).join(" / ") || v.sku || v.variantId}</td>
                    <td className="px-2 py-1.5 text-right">{v.stockKnown ? countText(v.actualStock) : <span className="text-muted-foreground">Chưa có phiếu nhập</span>}</td>
                    <td className="px-2 py-1.5 text-right">{countText(v.available)}</td>
                    <td className="px-2 py-1.5 text-right">{countText(v.reserved)}</td>
                    <td className="px-2 py-1.5 text-right">{countText(v.inProduction)}</td>
                    <td className="px-2 py-1.5 text-right">
                      {countText(v.returning)} · {countText(v.pendingQc)}
                    </td>
                    <td className="px-2 py-1.5 text-right">{countText(v.damaged)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {l.data.variants.length > 40 ? <p className="text-[11px] text-muted-foreground">… và {formatNumber(l.data.variants.length - 40)} mẫu mã khác — xem trang kho của sản phẩm.</p> : null}
        </div>
      )}
    </SectionCard>
  );
}

// ─────────────────────────── KINH TẾ ───────────────────────────

function econText(unit: EconomicsUnit, v: number | null): string {
  if (unit === "VND") return formatVND(v === null ? null : Math.round(v));
  if (unit === "COUNT") return formatNumber(v);
  return pctText(v);
}

function EconCell({ unit, c }: { unit: EconomicsUnit; c: EconomicsValue | null }) {
  if (!c) return <span className="text-muted-foreground">N/A</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {econText(unit, c.value)}
      <InfoHint align="end">
        <span className="block text-[11px]">
          <b>{c.label}</b> · nguồn <code>{c.source}</code>
          {c.note ? <span className="mt-1 block">{c.note}</span> : null}
        </span>
      </InfoHint>
    </span>
  );
}

export async function EconomicsBlock({ ctx }: { ctx: BlockCtx }) {
  const pid = ctx.productId;
  const title = "Kinh tế: ước tính vs thực đạt";
  if (!ctx.allowed.ECONOMICS) return <DeniedBlock title={title} block="ECONOMICS" />;
  if (!pid) {
    return (
      <SectionCard title={title}>
        <NoProduct what="doanh thu hay chi phí" />
      </SectionCard>
    );
  }
  // Chi QC chưa ghép chiến dịch ⇒ `getModelEconomics` tự trả `null` (—) cho mọi ô đứng trên số chi, kèm
  // câu giải thích trong ⓘ của từng ô — cùng cờ `spendMapped` của khối quảng cáo.
  const l = await loadSource("kinh tế theo mẫu (getModelEconomics)", () => getModelEconomics(pid, ctx.range));
  return (
    <SectionCard
      title={title}
      description={ctx.range.label}
      hint={
        l.ok ? (
          <span className="block space-y-1">
            {l.data.notes.map((n) => (
              <span key={n} className="block">
                {n}
              </span>
            ))}
            <span className="block">{l.data.cogsBasis.note}</span>
          </span>
        ) : (
          "Agent F · getModelEconomics"
        )
      }
      actions={<HomeLink href={`/reports?tab=nominal${ctx.periodQuery ? `&${ctx.periodQuery}` : ""}`} label="Lợi nhuận danh nghĩa" />}
      padded={false}
    >
      {!l.ok ? (
        <div className="p-5">
          <Failed l={l} />
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Chỉ số</th>
              <th className="px-3 py-1.5 text-right font-medium">Ước tính</th>
              <th className="px-3 py-1.5 text-right font-medium">Thực đạt</th>
              <th className="px-3 py-1.5 text-right font-medium">Tạm tính</th>
            </tr>
          </thead>
          <tbody className="numeric">
            {l.data.lines.map((ln) => (
              <tr key={ln.key} className="border-t">
                <td className="px-3 py-1.5">{ln.label}</td>
                <td className="px-3 py-1.5 text-right">
                  <EconCell unit={ln.unit} c={ln.estimated} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <EconCell unit={ln.unit} c={ln.realized} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <EconCell unit={ln.unit} c={ln.projected} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

// ─────────────────────────── SẢN XUẤT ───────────────────────────

/**
 * Khối Sản xuất đọc `getModelProductionSummary(modelId)` của Agent C (topic · giá thành chốt · mẫu thử mới
 * nhất · bản thiết kế đã duyệt · lệnh SX đang mở với số đặt / số đã nhận qua phiếu nối). Không công thức ở
 * đây. "Tạo topic sản xuất" chỉ hiện với `production:write`, và chỉ dẫn tới biểu mẫu — người bấm tạo.
 */
export async function ProductionBlock({ ctx }: { ctx: BlockCtx }) {
  const title = "Sản xuất";
  if (!ctx.allowed.PRODUCTION) return <DeniedBlock title={title} block="PRODUCTION" />;
  const l = await loadSource("sản xuất (getModelProductionSummary)", () => getModelProductionSummary(ctx.modelId));
  const pending = MODEL_360_PENDING_SOURCES.filter((p) => p.block === "PRODUCTION");
  const taoTopic = ctx.canCreateTopic ? (
    <Button asChild size="sm" variant="outline" className="h-7">
      <Link href={`/production/topics/new?model=${encodeURIComponent(ctx.modelId)}`}>
        <Plus className="size-3.5" /> Tạo topic sản xuất
      </Link>
    </Button>
  ) : null;
  return (
    <SectionCard
      title={title}
      actions={
        <>
          {taoTopic}
          <HomeLink href={`/production/models/${encodeURIComponent(ctx.modelId)}`} label="Bàn sản xuất của mẫu" />
        </>
      }
      hint="Agent C · getModelProductionSummary: topic hỏi giá xưởng, giá thành đã chốt (tổng lưu lúc chốt), mẫu thử mới nhất, bản thiết kế đã duyệt, lệnh sản xuất đang mở (nháp / đã gửi) của sản phẩm."
    >
      {!l.ok ? (
        <Failed l={l} />
      ) : !l.data ? (
        <p className="text-sm text-muted-foreground">— Không đọc được mẫu ở sổ sản xuất.</p>
      ) : (
        <div className="space-y-2">
          <StatGrid cols={3}>
            <Stat label="Topic đang mở · tổng" value={`${countText(l.data.openTopics)} · ${countText(l.data.topics.length)}`} />
            <Stat
              label="Giá thành đã chốt"
              value={l.data.finalCosting ? moneyText(l.data.finalCosting.totalUnitCost) : "—"}
              sub={
                l.data.finalCosting
                  ? `bản ${l.data.finalCosting.version}${l.data.draftCostings ? ` · ${l.data.draftCostings} bản nháp` : ""}`
                  : l.data.draftCostings
                    ? `${l.data.draftCostings} bản nháp, chưa chốt`
                    : "chưa có bảng giá thành"
              }
            />
            <Stat
              label="Mẫu thử mới nhất"
              value={l.data.latestSample ? `Bản ${l.data.latestSample.version}` : "—"}
              sub={l.data.latestSample ? `${SAMPLE_STATUS_LABEL[l.data.latestSample.status] ?? l.data.latestSample.status}${l.data.latestSample.supplierName ? ` · ${l.data.latestSample.supplierName}` : ""}` : "chưa có mẫu thử"}
            />
          </StatGrid>
          <p className="text-xs text-muted-foreground">
            Thiết kế đã duyệt:{" "}
            {l.data.approvedDesign ? `bản ${l.data.approvedDesign.version} · ${formatDateTime(l.data.approvedDesign.approvedAt)}${l.data.approvedDesign.approvedBy ? ` · ${l.data.approvedDesign.approvedBy}` : ""}` : "—"}
          </p>
          {l.data.topics.length ? (
            <ul className="space-y-1 text-xs">
              {l.data.topics.slice(0, 5).map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/production/topics/${encodeURIComponent(t.id)}`} className="font-medium underline-offset-2 hover:underline">
                    {t.title || "(không tiêu đề)"}
                  </Link>
                  <span className="text-muted-foreground">
                    {TOPIC_STATUS_LABEL[t.status] ?? t.status} · {formatDateTime(t.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {l.data.productId === null ? (
            <p className="text-[11px] text-muted-foreground">Mẫu chưa có sản phẩm Pancake — chưa đặt được lệnh sản xuất nào (khác với &ldquo;có sản phẩm, không lệnh mở&rdquo;).</p>
          ) : l.data.openOrders.length ? (
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">Lệnh SX đang mở</th>
                  <th className="py-1 pr-2 text-right font-medium">Đặt</th>
                  <th className="py-1 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Đã nhận <InfoHint align="end">{l.data.basis.received}</InfoHint>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="numeric">
                {l.data.openOrders.map((o) => (
                  <tr key={o.id} className="border-t">
                    <td className="py-1 pr-2">
                      {o.code} <span className="text-muted-foreground">· {o.status === "SENT" ? "đã gửi xưởng" : "nháp"}</span>
                    </td>
                    <td className="py-1 pr-2 text-right">{countText(o.plannedQty)}</td>
                    <td className="py-1 text-right">{countText(o.receivedViaLinkedReceipts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-muted-foreground">Không có lệnh sản xuất đang mở (0).</p>
          )}
          {pending.map((p) => (
            <p key={p.fn} className="text-[11px] text-muted-foreground">
              Chưa nối — {p.what} (Agent {p.owner}, <code>{p.fn}</code>).
            </p>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─────────────────────────── KẾT CỤC HÀNG HOÀN ───────────────────────────

/**
 * Khối Kết cục hàng hoàn đọc `getModelReturnDispositions(productId)` của Agent E. Mỗi ô `null` = CHƯA BIẾT
 * (kiện kiểm cả kiện không chia được theo mẫu) — in "—", không in 0. Giá trị huỷ là ƯỚC TÍNH và không nằm
 * trong báo cáo lợi nhuận nào.
 */
export async function ReturnsDispositionBlock({ ctx }: { ctx: BlockCtx }) {
  const title = "Kết cục hàng hoàn";
  if (!ctx.allowed.RETURNS) return <DeniedBlock title={title} block="RETURNS" />;
  const pid = ctx.productId;
  if (!pid) {
    return (
      <SectionCard title={title}>
        <NoProduct what="hàng hoàn" />
      </SectionCard>
    );
  }
  const l = await loadSource("kết cục hàng hoàn (getModelReturnDispositions)", () => getModelReturnDispositions(pid));
  return (
    <SectionCard
      title={title}
      description="hiện tại — không theo kỳ"
      hint="Agent E · getModelReturnDispositions: hàng hoàn KHÔNG tái nhập ngay sau trạm kiểm đi tới đâu — chờ quyết, đang sửa / giặt, sửa xong nhập lại, huỷ, trả xưởng. Giá trị huỷ là ƯỚC TÍNH theo giá vốn lúc huỷ, không vào báo cáo lợi nhuận."
      actions={<HomeLink href={MODEL_360_BLOCK_ACCESS.RETURNS.home} label="Kiểm đếm hàng hoàn" />}
    >
      {!l.ok ? (
        <Failed l={l} />
      ) : (
        <div className="space-y-2">
          <DataWarnings
            items={[
              l.data.basis.parcelLevelSubjects
                ? `${l.data.basis.parcelLevelSubjects} kiện hoàn kiểm CẢ KIỆN có hàng không bán được và có mẫu này trong đơn — không chia được theo mẫu, nên các ô số món là — (chưa biết).`
                : null,
              l.data.writeOffValueUnknownQty ? `${formatNumber(l.data.writeOffValueUnknownQty)} món huỷ chưa biết giá vốn — tổng giá trị huỷ là —; phần đã biết ${formatVND(l.data.writeOffValueKnownPart)}.` : null,
            ]}
          />
          <StatGrid cols={3}>
            <Stat label="Chờ quyết" value={countText(l.data.pendingQty)} />
            <Stat label="Đang sửa / giặt" value={countText(l.data.reworkQty)} />
            <Stat label="Sửa xong · nhập lại" value={countText(l.data.restockedAfterReworkQty)} />
            <Stat label="Đã huỷ" value={countText(l.data.writtenOffQty)} sub={`giá trị ước tính ${moneyText(l.data.writeOffValueEstimate)}`} />
            <Stat label="Trả xưởng" value={countText(l.data.returnedToSupplierQty)} />
            <Stat label="Món còn mở" value={countText(l.data.openSubjects)} sub={`${formatNumber(l.data.basis.itemSubjects)} món đã qua trạm kiểm`} />
          </StatGrid>
        </div>
      )}
    </SectionCard>
  );
}
