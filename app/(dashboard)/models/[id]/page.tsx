import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Shirt } from "lucide-react";
import { OwnerControl, TransitionControl } from "@/app/(dashboard)/models/[id]/model-controls";
import { ModelStateBadge, ObservedStageBadge } from "@/app/(dashboard)/models/state-badge";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { can, requirePermission } from "@/lib/auth/session";
import { DESIGN_STATUS_LABEL, type DesignStatus } from "@/lib/constants/creative-loop";
import { DOMAIN_ACTOR_KIND_LABEL } from "@/lib/constants/domain-events";
import { MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL, MODEL_TIMELINE_DIMENSION_LABEL, MODEL_TIMELINE_DIMENSION_TONE, observeModelStage } from "@/lib/constants/model-lifecycle";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getModel, getModelEvidence, getModelStateHistory, getModelTimeline, listModelOwnerOptions } from "@/lib/queries/models";
import { cn } from "@/lib/utils";

export const metadata = { title: "Vòng đời mẫu" };

/** Ô chứng cứ: `null` = CHƯA BIẾT ⇒ "—", không in 0 (AGENTS.md mục 42). */
function soHoacGach(n: number | null, fmt: (x: number) => string = formatNumber) {
  return n === null ? "—" : fmt(n);
}

/**
 * ═══════════ TRANG MỘT MẪU (khung Model 360 — Company OS · Agent A) ═══════════
 *
 * Đầu trang: mã · tên · ảnh · trạng thái KHAI · giai đoạn QUAN SÁT (ước tính, kèm lý do) · người phụ trách ·
 * nút chuyển trạng thái. Rồi lịch sử vòng đời và dòng thời gian (sự kiện của sổ ∪ phép chiếu các nhật ký
 * có sẵn). Các khối Creative · Ads · Tồn · Lợi nhuận đầy đủ do Agent A2 ráp ở Wave 2 từ hàm đọc của B/D/F.
 */
export default async function ModelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("models:view");
  const canWrite = can(user, "models:write");
  const { id } = await params;
  const model = await getModel(id);
  if (!model) notFound();

  const [evidence, history, timeline, owners] = await Promise.all([getModelEvidence(model), getModelStateHistory(model.id), getModelTimeline(model.id), canWrite ? listModelOwnerOptions() : Promise.resolve([])]);
  const observed = observeModelStage(evidence);
  const image = model.product?.image ?? null;
  const ownerOptions = model.ownerUserId && !owners.some((o) => o.id === model.ownerUserId) ? [{ id: model.ownerUserId, name: model.ownerName ?? "Tài khoản đã khoá" }, ...owners] : owners;
  const designLabel = model.design ? (DESIGN_STATUS_LABEL[model.design.status as DesignStatus] ?? model.design.status) : null;

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
          </span>
        }
        description={model.stateChangedAt ? `Trạng thái khai từ ${formatDateTime(model.stateChangedAt)}` : "Chưa ai khai trạng thái vòng đời cho mẫu này"}
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
            <ObservedStageBadge state={observed.stage} />
            {observed.reasons.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {observed.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            {observed.stage && model.state && observed.stage !== model.state ? (
              <p className="text-xs">
                Khác với trạng thái khai ({MODEL_STATE_LABELS[model.state]}) — người phụ trách xem lại xem lời khai hay chứng cứ đang cũ.
              </p>
            ) : null}
            <DescriptionList
              columns={2}
              items={[
                { label: "Thiết kế", value: designLabel ?? "—" },
                { label: "Chi QC 30 ngày", value: soHoacGach(evidence.adSpend30d, (x) => formatVND(x)) },
                { label: "Đơn lên 30 ngày", value: soHoacGach(evidence.orders30d) },
                { label: "Đơn lên từ trước tới nay", value: soHoacGach(evidence.ordersTotal) },
                { label: "Lệnh SX nháp / đã gửi", value: evidence.draftProductionOrders === null ? "—" : `${formatNumber(evidence.draftProductionOrders)} / ${formatNumber(evidence.sentProductionOrders ?? 0)}` },
                { label: "Tồn thực tế (sổ kho)", value: evidence.stockKnown === false ? "Chưa có phiếu nhập" : soHoacGach(evidence.stockOnHand) },
              ]}
            />
            {!model.product ? <p className="text-[11px] text-muted-foreground">Mẫu chưa có sản phẩm Pancake nên không có đơn, chi QC hay tồn để đọc — các ô ấy là &ldquo;—&rdquo; (chưa biết), không phải 0.</p> : null}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Lịch sử vòng đời" description={history.length ? `${formatNumber(history.length)} lượt khai` : undefined}>
        {history.length ? (
          <ol className="space-y-2 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 border-b pb-2 last:border-0">
                <span className="text-xs text-muted-foreground">{formatDateTime(h.occurredAt)}</span>
                <span>
                  {h.from ? MODEL_STATE_LABELS[h.from] : MODEL_STATE_UNDECLARED_LABEL} → <b>{MODEL_STATE_LABELS[h.to]}</b>
                </span>
                <span className="text-xs text-muted-foreground">
                  {h.actorKind === "USER" ? h.actorName || "người dùng" : `${DOMAIN_ACTOR_KIND_LABEL[h.actorKind] ?? h.actorKind}${h.actorName ? ` · ${h.actorName}` : ""}`}
                </span>
                {h.reason ? <span className="w-full text-xs">Lý do: {h.reason}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có lượt khai nào — trạng thái đang là &ldquo;{MODEL_STATE_UNDECLARED_LABEL}&rdquo;.</p>
        )}
      </SectionCard>

      <SectionCard title="Dòng thời gian" hint="Mốc “Vòng đời” là sự kiện ghi trong sổ mẫu. Các chiều khác là PHÉP CHIẾU đọc thẳng từ nhật ký của miền chủ (lệnh sản xuất, phiếu nhập kho, đơn Pancake, thiết kế) — không chép sang sổ sự kiện.">
        {timeline.length ? (
          <ol className="relative space-y-0 border-l pl-4">
            {timeline.slice(0, 60).map((e, i) => (
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
            {timeline.length > 60 ? <li className="text-xs text-muted-foreground">… và {formatNumber(timeline.length - 60)} mốc cũ hơn</li> : null}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có mốc nào.</p>
        )}
      </SectionCard>
    </div>
  );
}
