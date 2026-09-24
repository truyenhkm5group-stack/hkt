import { Rocket } from "lucide-react";
import { ScaleCellActions } from "@/app/(dashboard)/marketing/creatives/scale-actions";
import { VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { CREATIVE_VERDICT_LABEL, SCALE_DRAFT_STATUS_LABEL, SCALE_KINDS, SCALE_KIND_LABEL, type ScaleDraftStatus, type ScaleKind } from "@/lib/constants/creative-loop";
import { formatDate, formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { adsManagerCampaignUrl, scaleOverview, type ScaleDraftCell } from "@/lib/queries/creative-scale";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KHỐI "SCALE MẪU THẮNG" (tab Đang chạy) ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5g. Mỗi hàng một mẫu THẮNG / HỨA HẸN; hai ô = hai loại chiến dịch
 * (mua qua tin nhắn · khách hàng tiềm năng). Trong ô: trạng thái nháp + nút đúng bước kế tiếp. Nháp đã
 * dựng có link Ads Manager để người mở xem / sửa / xoá tay. Bảng vừa ~1.150px: ba cột chữ, hai cột ô.
 *
 * Màu chỉ cho trạng thái có hệ quả tiền: ĐANG CHẠY (tiền đang chảy) và LỖI (có thể có bản sao mồ côi).
 */

const STATUS_TONE: Partial<Record<ScaleDraftStatus, string>> = {
  ACTIVE: "bg-success/15 text-success",
  FAILED: "bg-destructive/10 text-destructive",
};

function Cell({ cell, kind, variantId, adAccountId, template, canWrite }: { cell: ScaleDraftCell | undefined; kind: ScaleKind; variantId: string; adAccountId: string; template: string; canWrite: boolean }) {
  if (!cell) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <div className="space-y-1">
      <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold", STATUS_TONE[cell.status] ?? "bg-muted text-muted-foreground")}>{SCALE_DRAFT_STATUS_LABEL[cell.status]}</span>
      {cell.dailyBudgetVnd !== null ? (
        <p className="text-[11px] text-muted-foreground">
          {formatVND(cell.dailyBudgetVnd)}/ngày · ngân sách ở cấp {cell.budgetLevel === "CAMPAIGN" ? "chiến dịch" : cell.budgetLevel === "ADSET" ? "nhóm" : "—"}
        </p>
      ) : null}
      {cell.fbCampaignId ? (
        <p className="text-[11px]">
          <a className="text-primary underline-offset-2 hover:underline" href={adsManagerCampaignUrl(adAccountId, cell.fbCampaignId)} target="_blank" rel="noreferrer">
            Mở trên Ads Manager
          </a>
          <span className="text-muted-foreground"> · {cell.fbCampaignId}</span>
        </p>
      ) : null}
      {cell.approvedAt ? (
        <p className="text-[11px] text-muted-foreground">
          Duyệt: {cell.approvedByName || "—"} · {vnShortStamp(cell.approvedAt)}
        </p>
      ) : cell.draftedAt ? (
        <p className="text-[11px] text-muted-foreground">
          Dựng: {cell.draftedByName || "—"} · {vnShortStamp(cell.draftedAt)}
        </p>
      ) : null}
      {cell.error ? (
        <p className="line-clamp-3 text-[11px] text-destructive" title={cell.error}>
          {cell.error}
        </p>
      ) : null}
      {canWrite ? <ScaleCellActions draftId={cell.id} variantId={variantId} kind={kind} kindLabel={SCALE_KIND_LABEL[kind]} status={cell.status} copyAttempted={cell.copyAttempted} templateMissing={!template} /> : null}
    </div>
  );
}

export async function ScalePanel({ canWrite }: { canWrite: boolean }) {
  const db = await getDb();
  const o = await scaleOverview(db, new Date());
  const thieuMau = SCALE_KINDS.filter((k) => !o.templates[k]);

  return (
    <SectionCard
      title="Scale mẫu thắng"
      description={`Mẫu THẮNG / HỨA HẸN ⇒ máy đề nghị. Người bấm "Dựng nháp" ⇒ máy sao chép chiến dịch MẪU, thay bài bằng mẫu thắng, đặt ${formatVND(o.dailyBudgetVnd)}/ngày — bản sao luôn TẮT. Bật khi người "Duyệt chạy".`}
      hint={
        <>
          Máy KHÔNG tạo chiến dịch từ số không: chỉ SAO CHÉP đúng hai chiến dịch mẫu do người dựng (khai ở tab Cấu hình), mỗi chiến dịch đúng một nhóm + một mẩu. Đối
          tượng, mục tiêu, biểu mẫu chép NGUYÊN. Trần: {formatVND(o.perCampaignCapVnd)}/ngày một chiến dịch · tổng các chiến dịch scale đang bật {formatVND(o.activeCapVnd)}/ngày (đề
          xuất, chờ chủ shop chốt). Dựng hỏng giữa chừng thì bản sao vẫn TẮT và ô ghi rõ id để xoá tay. Đặc tả: <code>docs/creative-loop.md</code> §5g.
        </>
      }
      padded={false}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2 text-[12px] text-muted-foreground">
        <span>
          Đang bật: <b className="numeric text-foreground">{formatVND(o.activeTotalVnd)}</b> / {formatVND(o.activeCapVnd)} mỗi ngày
        </span>
        {SCALE_KINDS.map((k) => (
          <span key={k}>
            Mẫu “{SCALE_KIND_LABEL[k]}”: {o.templates[k] ? <code>{o.templates[k]}</code> : <b className="text-destructive">chưa khai</b>}
          </span>
        ))}
      </div>
      {thieuMau.length === SCALE_KINDS.length && o.rows.length === 0 ? (
        <div className="p-5">
          <EmptyState icon={Rocket} title="Chưa khai chiến dịch mẫu scale" description="Dựng hai chiến dịch mẫu trên Ads Manager (mỗi chiến dịch đúng một nhóm + một mẩu, đang tắt) rồi khai id ở tab Cấu hình." />
        </div>
      ) : o.rows.length === 0 ? (
        <div className="p-5">
          <EmptyState icon={Rocket} title="Chưa có mẫu nào đủ điều kiện scale" description="Mẫu vào đây khi lượt chấm kết luận THẮNG hoặc HỨA HẸN. Máy chỉ đề nghị — không gọi Facebook cho tới khi người bấm." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[12.5px]">
            <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Mẫu</th>
                <th className="px-2 py-2 text-right font-medium">Chi · tin nhắn</th>
                <th className="px-2 py-2 text-right font-medium">Đơn chốt · giao/hoàn</th>
                {SCALE_KINDS.map((k) => (
                  <th key={k} className="w-[260px] px-3 py-2 font-medium">
                    {SCALE_KIND_LABEL[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {o.rows.map((r) => (
                <tr key={r.variantId} className="border-b border-hairline align-top last:border-b-0">
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <VariantImage imageId={r.imageId} available={r.imageAvailable} alt={r.headline || `Mẫu #${r.slot}`} className="size-12 shrink-0 rounded" iconClassName="size-4" />
                      <div className="min-w-0 max-w-[240px]">
                        <p className="truncate font-medium" title={r.headline}>
                          #{r.slot} {r.headline || <span className="italic text-muted-foreground">không tiêu đề</span>}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          Lô {formatDate(r.batchDay)} · {CREATIVE_VERDICT_LABEL[r.verdict]}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">{r.productName ?? r.productId ?? "—"}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="numeric whitespace-nowrap text-right leading-tight">
                      <div className="font-medium">{formatVND(r.metrics?.spendVnd ?? null)}</div>
                      <div className="text-[11px] text-muted-foreground">{formatNumber(r.metrics?.messages ?? null)} tin</div>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="numeric whitespace-nowrap text-right leading-tight" title="Đơn chốt mang ad_id của mẩu test · giao thành công / hoàn theo ORDER_OUTCOME">
                      <div className="font-medium">{formatNumber(r.metrics?.bookedOrders ?? null)}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatNumber(r.metrics?.deliveredOrders ?? null)} / {formatNumber(r.metrics?.returnedOrders ?? null)}
                      </div>
                    </div>
                  </td>
                  {SCALE_KINDS.map((k) => (
                    <td key={k} className="px-3 py-2">
                      <Cell cell={r.cells[k]} kind={k} variantId={r.variantId} adAccountId={o.adAccountId} template={o.templates[k]} canWrite={canWrite} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
