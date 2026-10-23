import Link from "next/link";
import { notFound } from "next/navigation";
import { LandedCostCell } from "@/components/sourcing/landed-cost-view";
import { TiersText } from "@/components/sourcing/offer-bits";
import { CancelTrialForm, MarkOrderedForm, MarkReceivedForm } from "@/components/sourcing/trial-forms";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { MODEL_SIGNAL_LABEL } from "@/lib/constants/model-signal";
import { SOURCING_PLATFORM_LABEL } from "@/lib/constants/sourcing";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getSourcingTrial } from "@/lib/queries/sourcing-trials";
import { canCancelTrial, TRIAL_STATE_LABEL } from "@/lib/sourcing/trial";

export const metadata = { title: "Yêu cầu mua thử" };

/**
 * MỘT YÊU CẦU MUA THỬ (SRC-5a): ẢNH CHỤP lúc xin (bất biến), trạng thái duyệt (đọc từ lõi duyệt — duyệt / từ chối ở /approvals),
 * các bước NGƯỜI đã làm ngoài ERP (đã đặt · đã về · huỷ, mang tên người bấm) và vòng phản hồi bằng số thật.
 */
export default async function SourcingTrialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission("sourcing:view");
  const canWrite = can(user, "sourcing:write");
  const d = await getSourcingTrial(id);
  if (d && "unavailable" in d) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Tìm hàng nguồn" title="Yêu cầu mua thử" />
        <p className="text-sm text-amber-700 dark:text-amber-300">CSDL của tổ chức chưa áp migration 0258 (lưu mẫu / mua thử).</p>
      </div>
    );
  }
  if (!d) notFound();
  const s = d.snapshot;
  const isRequester = d.requestedBy === user.id;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tìm hàng nguồn · mua thử"
        title={`${d.model.modelCode} · ${s?.offer.titleVi ?? d.model.modelName}`}
        description={`${TRIAL_STATE_LABEL[d.state]} · ${formatNumber(d.totalQty)} cái`}
        actions={
          <Link className="text-sm text-primary underline" href={`/sourcing/offers/${d.offerId}`}>
            ← Mẫu nguồn
          </Link>
        }
      />

      <SectionCard title="Ảnh chụp lúc xin" description="Bất biến — không tính lại khi tham số giá về, bậc giá hay cân nặng đổi sau đó. Người duyệt duyệt đúng con số này.">
        {s ? (
          <div className="space-y-4 text-sm" data-trial-snapshot>
            <DescriptionList
              columns={3}
              items={[
                { label: "Chụp lúc", value: formatDateTime(s.capturedAt) },
                { label: "Nguồn", value: `${SOURCING_PLATFORM_LABEL[s.offer.platform]} · ${s.offer.offerId ?? "không có mã"}` },
                { label: "Lần chụp giá dùng", value: s.priceCapturedAt ? formatDateTime(s.priceCapturedAt) : "chưa chụp giá" },
                { label: "Bậc giá", value: <TiersText tiers={s.tiers} /> },
                { label: "MOQ", value: s.moq ?? "—" },
                { label: "Cân nặng / cái", value: s.weightG === null ? "chưa khai" : `${formatNumber(s.weightG)} g` },
                { label: "Tỷ giá lúc xin", value: s.landedConfig.cnyToVnd === null ? "chưa khai" : `${formatNumber(s.landedConfig.cnyToVnd)} ₫ / 1 CNY${s.landedConfig.fxAsOf ? ` (áp ${s.landedConfig.fxAsOf})` : ""}` },
              ]}
            />
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Giá về Việt Nam ước tính / cái khi mua {formatNumber(s.totalQty)}</div>
              <LandedCostCell value={s.landed} />
            </div>
            {d.quantities ? (
              <table className="w-full max-w-lg text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Màu</th>
                    <th className="py-1 pr-3 font-medium">Cỡ</th>
                    <th className="py-1 font-medium">Số lượng</th>
                  </tr>
                </thead>
                <tbody>
                  {d.quantities.map((l, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1 pr-3">{l.color || "—"}</td>
                      <td className="py-1 pr-3">{l.size || "—"}</td>
                      <td className="py-1 tabular-nums">{formatNumber(l.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-amber-700 dark:text-amber-300">Dòng số lượng hỏng.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-300">Ảnh chụp hỏng — không đọc được.</p>
        )}
      </SectionCard>

      <SectionCard title="Duyệt" description="Duyệt / từ chối ở trang Duyệt (quyền «duyệt yêu cầu») — người xin không tự duyệt được.">
        <div className="space-y-3 text-sm">
          {d.approval ? (
            <p>
              Lời duyệt: <strong>{TRIAL_STATE_LABEL[d.state]}</strong>
              {d.approval.decidedByEmail ? ` · ${d.approval.decidedByEmail}` : ""}
              {d.approval.decidedAt ? ` · ${formatDateTime(d.approval.decidedAt)}` : ""}
              {d.approval.note ? ` — ${d.approval.note}` : ""}.{" "}
              <Link className="text-primary underline" href="/approvals">
                Mở trang Duyệt
              </Link>
            </p>
          ) : (
            <p className="text-amber-700 dark:text-amber-300">Không thấy lời duyệt gắn với yêu cầu này.</p>
          )}
          {canWrite && d.state === "APPROVED" ? (
            isRequester ? (
              <MarkOrderedForm trialId={d.id} />
            ) : (
              <p className="text-muted-foreground">Đã duyệt — chỉ người xin ({d.requestedByName ?? "—"}) đánh dấu «đã đặt» được, vì lời duyệt gắn với người xin.</p>
            )
          ) : null}
          {canWrite && d.state === "ORDERED" ? <MarkReceivedForm trialId={d.id} /> : null}
          {canWrite && canCancelTrial(d.state) ? (
            <div className="border-t pt-3">
              <CancelTrialForm trialId={d.id} />
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Diễn tiến" description="Mỗi bước do NGƯỜI bấm, mang tên tài khoản. ERP không đặt hàng, không thanh toán, không liên hệ nhà cung cấp.">
        <ul className="space-y-1 text-sm" data-trial-timeline>
          <li>
            Xin: {d.requestedByName ?? "—"} · {formatDateTime(d.requestedAt)}
          </li>
          {d.orderedAt ? (
            <li>
              Đã đặt (ngoài ERP): {d.orderedByName ?? "—"} · {formatDateTime(d.orderedAt)}
              {d.orderNote ? ` — ${d.orderNote}` : ""}
            </li>
          ) : null}
          {d.receivedAt ? (
            <li>
              Hàng đã về: {d.receivedByName ?? "—"} · {formatDateTime(d.receivedAt)}
              {d.receiptId ? ` · phiếu nhập ${d.receiptId}` : " · chưa gắn phiếu nhập"}
              {d.receiveNote ? ` — ${d.receiveNote}` : ""}
            </li>
          ) : null}
          {d.cancelledAt ? (
            <li>
              Huỷ: {d.cancelledByName ?? "—"} · {formatDateTime(d.cancelledAt)} — {d.cancelReason}
            </li>
          ) : null}
        </ul>
      </SectionCard>

      <SectionCard title="Vòng phản hồi" description="Chỉ số thật: tín hiệu bán của mẫu khi đã có mã chính thức, và giá nhập thật từ phiếu nhập so với ước tính lúc xin.">
        <div className="space-y-2 text-sm" data-trial-feedback>
          <p>
            Mẫu: <Link className="text-primary underline" href={`/models/${d.model.modelId}`}>{d.model.modelCode}</Link>{" "}
            {d.feedback.signal ? (
              <>
                — tín hiệu <strong>{MODEL_SIGNAL_LABEL[d.feedback.signal.signal]}</strong> ({d.feedback.signal.periodLabel}): {d.feedback.signal.summary}
              </>
            ) : (
              <span className="text-muted-foreground">— {d.feedback.signalNote}</span>
            )}
          </p>
          <p>
            Giá nhập thật / cái:{" "}
            {d.feedback.realCost?.unitVnd != null ? (
              <>
                <strong>{formatVND(d.feedback.realCost.unitVnd)}</strong> (từ {formatNumber(d.feedback.realCost.pricedQty)} cái có giá
                {d.feedback.realCost.unpricedQty ? `, ${formatNumber(d.feedback.realCost.unpricedQty)} cái chưa có giá — không tính vào` : ""})
              </>
            ) : (
              <span className="text-muted-foreground">{d.feedback.realCostNote ?? "—"}</span>
            )}
          </p>
          <p>
            Chênh so với ước tính lúc xin:{" "}
            {d.feedback.diffVnd === null ? <span className="text-muted-foreground">chưa đo được</span> : <strong>{`${d.feedback.diffVnd > 0 ? "+" : ""}${formatVND(d.feedback.diffVnd)} / cái`}</strong>}
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
