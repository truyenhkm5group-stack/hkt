import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Lightbulb, Shirt } from "lucide-react";
import {
  AdsCreativeBlock,
  EconomicsBlock,
  OrdersBlock,
  ProductionBlock,
  SignalBadge,
  SignalBlock,
  StockBlock,
  SuggestionsBlock,
  type BlockCtx,
} from "@/app/(dashboard)/models/[id]/blocks";
import { OwnerControl, TransitionControl } from "@/app/(dashboard)/models/[id]/model-controls";
import { ModelStateBadge, ObservedStageBadge } from "@/app/(dashboard)/models/state-badge";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { InfoHint } from "@/components/info-hint";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { decideScope } from "@/lib/auth/scope-guard";
import { can, requirePermission, type SessionUser } from "@/lib/auth/session";
import { DESIGN_STATUS_LABEL, type DesignStatus } from "@/lib/constants/creative-loop";
import { DOMAIN_ACTOR_KIND_LABEL } from "@/lib/constants/domain-events";
import { loadSource, MODEL_360_BLOCK_ACCESS, mergeTimelines, type Model360Block } from "@/lib/constants/model-360";
import { MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL, MODEL_TIMELINE_DIMENSION_LABEL, MODEL_TIMELINE_DIMENSION_TONE, observeModelStage } from "@/lib/constants/model-lifecycle";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getModelLinkedIdeas, ideaTimelineEntries } from "@/lib/queries/model-360";
import { getModel, getModelEvidence, getModelStateHistory, getModelTimeline, listModelOwnerOptions } from "@/lib/queries/models";
import { resolvePeriod, type Period, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Vòng đời mẫu" };

/** Ô chứng cứ: `null` = CHƯA BIẾT ⇒ "—", không in 0 (AGENTS.md mục 42). */
function soHoacGach(n: number | null, fmt: (x: number) => string = formatNumber) {
  return n === null ? "—" : fmt(n);
}

/** Link sang màn hình chủ giữ đúng kỳ đang xem. */
function periodQueryOf(p: Period): string {
  if (p.key === "custom" && p.fromKey && p.toKey) return `period=custom&from=${p.fromKey}&to=${p.toKey}`;
  return `period=${p.key}`;
}

/**
 * Người xem có được đọc nguồn của một khối không: ĐÚNG quyền của màn hình chủ nguồn ấy, và phạm vi dữ
 * liệu không phải "từ chối" (cùng cổng mà màn hình chủ áp — `requireResource`). Trang 360 không được là
 * cửa sau đọc lợi nhuận / chi quảng cáo cho người chỉ có "Vòng đời mẫu: xem".
 */
async function blockAllowed(user: SessionUser, block: Model360Block): Promise<boolean> {
  const a = MODEL_360_BLOCK_ACCESS[block];
  if (!can(user, a.permission)) return false;
  if (!a.resource) return true;
  const d = await decideScope(a.resource, user, a.permission);
  return d.allow !== "NONE";
}

function BlockSkeleton({ h = "h-48" }: { h?: string }) {
  return <Skeleton className={cn(h, "rounded-2xl")} />;
}

/**
 * ═══════════ MODEL 360 — MỘT MẪU, CẢ VÒNG ĐỜI (Company OS · Agent A → A2) ═══════════
 *
 * Đầu trang (A): mã · tên · ảnh · trạng thái KHAI · tín hiệu mẫu (A2) · ý tưởng đã nối (A2). Rồi các khối,
 * MỖI KHỐI một ranh giới `Suspense` và đọc nguồn qua `loadSource` (blocks.tsx): Tín hiệu · Đề xuất ·
 * Creative & quảng cáo · Đơn/giao/hoàn · Tồn kho · Kinh tế · Sản xuất · lịch sử · dòng thời gian.
 * Trang KHÔNG có công thức nào — mọi số là của hàm đọc của miền chủ (B · D · F · bảng quyết định /ads).
 * Kỳ đọc từ URL (`period` / `from` / `to`, bộ lọc nuqs), mặc định 30 ngày; mọi nguồn theo kỳ có khoá đệm chứa kỳ.
 */
export default async function ModelDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("models:view");
  const canWrite = can(user, "models:write");
  const [{ id }, raw] = await Promise.all([params, searchParams]);
  const model = await getModel(id);
  if (!model) notFound();
  const range = resolvePeriod(raw, "30d");

  const blocks = Object.keys(MODEL_360_BLOCK_ACCESS) as Model360Block[];
  const [evidence, history, timeline, owners, ideas, allowList] = await Promise.all([
    getModelEvidence(model),
    getModelStateHistory(model.id),
    getModelTimeline(model.id),
    canWrite ? listModelOwnerOptions() : Promise.resolve([]),
    loadSource("ý tưởng đã nối", () => getModelLinkedIdeas(model.id)),
    Promise.all(blocks.map((b) => blockAllowed(user, b))),
  ]);
  const allowed = Object.fromEntries(blocks.map((b, i) => [b, allowList[i]])) as Record<Model360Block, boolean>;
  const observed = observeModelStage(evidence);
  const image = model.product?.image ?? null;
  const ownerOptions = model.ownerUserId && !owners.some((o) => o.id === model.ownerUserId) ? [{ id: model.ownerUserId, name: model.ownerName ?? "Tài khoản đã khoá" }, ...owners] : owners;
  const designLabel = model.design ? (DESIGN_STATUS_LABEL[model.design.status as DesignStatus] ?? model.design.status) : null;
  const linkedIdeas = ideas.ok ? ideas.data : [];
  const fullTimeline = mergeTimelines(timeline, ideaTimelineEntries(linkedIdeas));

  const ctx: BlockCtx = {
    modelId: model.id,
    productId: model.product?.id ?? null,
    productName: model.product?.name ?? null,
    declaredState: model.state,
    range,
    periodQuery: periodQueryOf(range),
    allowed,
    canWrite,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Vòng đời mẫu · ${model.registeredBy === "USER" ? "người đăng ký" : "máy đồng bộ"}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" className="size-12 rounded-lg border object-cover" />
            ) : (
              <span className="flex size-12 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
                <Shirt className="size-5" />
              </span>
            )}
            <span className="font-mono">{model.code}</span>
            <span className="text-base font-normal text-muted-foreground">{model.name || model.product?.name || ""}</span>
            <ModelStateBadge state={model.state} />
            <Suspense fallback={<Skeleton className="h-5 w-28 rounded-md" />}>
              <SignalBadge ctx={ctx} />
            </Suspense>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{model.stateChangedAt ? `Trạng thái khai từ ${formatDateTime(model.stateChangedAt)}` : "Chưa ai khai trạng thái vòng đời cho mẫu này"}</span>
            {linkedIdeas.length ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Lightbulb className="size-3.5" />
                {linkedIdeas.slice(0, 3).map((x) => (
                  <Link key={x.id} href={`/ideas/${x.id}`} className="underline-offset-2 hover:underline">
                    {x.title}
                  </Link>
                ))}
                {linkedIdeas.length > 3 ? <span>+{linkedIdeas.length - 3}</span> : null}
              </span>
            ) : null}
            {!ideas.ok ? <span className="text-rose-700 dark:text-rose-300">Không đọc được nguồn ý tưởng</span> : null}
          </span>
        }
        actions={
          <>
            {model.product ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/products/${model.product.id}`}>
                  <ExternalLink className="size-4" /> Trang kho của sản phẩm
                </Link>
              </Button>
            ) : null}
            {model.design ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/marketing/creatives?tab=thiet-ke">
                  <ExternalLink className="size-4" /> Thiết kế {model.design.code}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Kỳ của các khối theo thời gian:</span>
        <PeriodFilter defaultKey="30d" />
        <InfoHint>Kỳ áp cho tín hiệu mẫu, quảng cáo, đơn/giao/hoàn và kinh tế (lọc theo ngày lên đơn / ngày chi). Tồn kho, creative, quyết định tồn và sản xuất là số HIỆN TẠI, không theo kỳ.</InfoHint>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Trạng thái khai" hint="Điều NGƯỜI nói về mẫu. Bước tiếp theo trong sơ đồ vòng đời không cần lý do; lùi bước, nhảy cóc hay khai lần đầu thì bắt buộc lý do. Mỗi lượt đổi là một dòng lịch sử không sửa được.">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              Hiện tại: <ModelStateBadge state={model.state} />
            </div>
            {canWrite ? <TransitionControl modelId={model.id} state={model.state} /> : <p className="text-xs text-muted-foreground">Cần quyền &ldquo;Vòng đời mẫu: khai &amp; đồng bộ&rdquo; để đổi trạng thái.</p>}
            <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
              <span>Người phụ trách:</span>
              {canWrite ? <OwnerControl modelId={model.id} ownerUserId={model.ownerUserId} options={ownerOptions} /> : <span className={model.ownerName ? "" : "text-muted-foreground"}>{model.ownerName ?? "—"}</span>}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Giai đoạn máy quan sát" hint="Máy đọc chứng cứ ở các miền có sẵn và ĐOÁN mẫu đang ở đâu. Đây là ƯỚC TÍNH — nó không bao giờ được ghi thành trạng thái khai. Chứng cứ mâu thuẫn thì mọi lý do đều được liệt kê.">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ObservedStageBadge state={observed.stage} />
              {observed.reasons.length ? <InfoHint>{observed.reasons.join(" · ")}</InfoHint> : null}
            </div>
            {observed.stage && model.state && observed.stage !== model.state ? <p className="text-xs">Khác với trạng thái khai ({MODEL_STATE_LABELS[model.state]}) — người phụ trách xem lại xem lời khai hay chứng cứ đang cũ.</p> : null}
            <DescriptionList
              columns={2}
              items={[
                { label: "Thiết kế", value: designLabel ?? "—" },
                { label: "Chi QC 30 ngày", value: allowed.ADS ? soHoacGach(evidence.adSpend30d, (x) => formatVND(x)) : "Cần quyền xem quảng cáo" },
                { label: "Đơn lên 30 ngày", value: soHoacGach(evidence.orders30d) },
                { label: "Tồn thực tế (sổ kho)", value: evidence.stockKnown === false ? "Chưa có phiếu nhập" : soHoacGach(evidence.stockOnHand) },
              ]}
            />
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<BlockSkeleton />}>
          <SignalBlock ctx={ctx} />
        </Suspense>
        <Suspense fallback={<BlockSkeleton />}>
          <SuggestionsBlock ctx={ctx} />
        </Suspense>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<BlockSkeleton h="h-64" />}>
          <AdsCreativeBlock ctx={ctx} />
        </Suspense>
        <Suspense fallback={<BlockSkeleton h="h-64" />}>
          <OrdersBlock ctx={ctx} />
        </Suspense>
      </div>

      <Suspense fallback={<BlockSkeleton h="h-56" />}>
        <StockBlock ctx={ctx} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<BlockSkeleton h="h-80" />}>
          <EconomicsBlock ctx={ctx} />
        </Suspense>
        <div className="space-y-4">
          <ProductionBlock ctx={ctx} draftOrders={evidence.draftProductionOrders} sentOrders={evidence.sentProductionOrders} />
          <SectionCard title="Lịch sử vòng đời" description={history.length ? `${formatNumber(history.length)} lượt khai` : undefined}>
            {history.length ? (
              <ol className="space-y-2 text-sm">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 border-b pb-2 last:border-0">
                    <span className="text-xs text-muted-foreground">{formatDateTime(h.occurredAt)}</span>
                    <span>
                      {h.from ? MODEL_STATE_LABELS[h.from] : MODEL_STATE_UNDECLARED_LABEL} → <b>{MODEL_STATE_LABELS[h.to]}</b>
                    </span>
                    <span className="text-xs text-muted-foreground">{h.actorKind === "USER" ? h.actorName || "người dùng" : `${DOMAIN_ACTOR_KIND_LABEL[h.actorKind] ?? h.actorKind}${h.actorName ? ` · ${h.actorName}` : ""}`}</span>
                    {h.reason ? <span className="w-full text-xs">Lý do: {h.reason}</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">Chưa có lượt khai nào — trạng thái đang là &ldquo;{MODEL_STATE_UNDECLARED_LABEL}&rdquo;.</p>
            )}
          </SectionCard>
        </div>
      </div>

      <SectionCard title="Dòng thời gian" hint="Mốc “Vòng đời” là sự kiện ghi trong sổ mẫu. Các chiều khác là PHÉP CHIẾU đọc thẳng từ nhật ký của miền chủ (lệnh sản xuất, phiếu nhập kho, đơn Pancake, thiết kế, ý tưởng marketing) — không chép sang sổ sự kiện.">
        {fullTimeline.length ? (
          <ol className="relative space-y-0 border-l pl-4">
            {fullTimeline.slice(0, 60).map((e, i) => (
              <li key={e.id} className="relative pb-3 last:pb-0">
                <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-background", i === 0 ? "bg-primary" : "bg-muted-foreground/50")} />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", MODEL_TIMELINE_DIMENSION_TONE[e.dimension])}>{MODEL_TIMELINE_DIMENSION_LABEL[e.dimension]}</span>
                  <span className="text-sm font-semibold">{e.title}</span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(e.at)}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {e.detail}
                  <span className="ml-1.5 rounded bg-muted px-1 text-[10px]">
                    {e.source}
                    {e.basis === "PROJECTED" ? " · chiếu từ nhật ký gốc" : ""}
                  </span>
                </p>
              </li>
            ))}
            {fullTimeline.length > 60 ? <li className="text-xs text-muted-foreground">… và {formatNumber(fullTimeline.length - 60)} mốc cũ hơn</li> : null}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có mốc nào.</p>
        )}
      </SectionCard>
    </div>
  );
}
