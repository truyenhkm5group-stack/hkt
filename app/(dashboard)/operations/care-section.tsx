import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import { getCareEffectiveness } from "@/lib/queries/care-effectiveness";

/**
 * ───────────── CHĂM SÓC CÓ CỨU ĐƯỢC ĐƠN KHÔNG ─────────────
 *
 * Khối này CỐ Ý hiện ngay cả khi chưa đo được gì: "chưa đủ dữ liệu" là một câu trả lời thật, và nó
 * nói cho người vận hành biết phải làm gì để có câu trả lời (ghi nhận việc chăm). Ẩn đi thì câu hỏi
 * biến mất luôn.
 */
export async function CareEffectivenessSection() {
  const e = await getCareEffectiveness();
  const ty = (r: number | null) => (r === null ? "chưa đủ mẫu" : `${Math.round(r * 100)}%`);

  return (
    <SectionCard
      title="E · Chăm sóc có cứu được đơn không"
      description={e.since ? `Đo từ ${e.since.toLocaleDateString("vi-VN")} — ngày ghi nhận chăm sóc đầu tiên.` : "Chưa bắt đầu đo được."}
      hint="Cohort: kiện có sự kiện GIAO HỤT kể từ mốc bắt đầu đo, chia hai nhóm theo việc CÓ ghi nhận chăm sóc sau lần hụt đó hay không. Mẫu số là đơn ĐÃ NGÃ NGŨ — đơn còn đang chạy chưa nói được gì. Cố ý KHÔNG dựng lại quá khứ: dữ liệu cũ không biết ai đã gọi."
    >
      {!e.since ? (
        <p className="text-[12.5px] leading-snug text-muted-foreground">{e.note}</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {[e.cared, e.notCared].map((a) => (
              <div key={a.label} className="rounded-xl border p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{a.label}</div>
                <div className="numeric mt-0.5 text-lg font-bold">{ty(a.rescueRate)}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  {formatNumber(a.delivered)} giao được / {formatNumber(a.delivered + a.returned)} đã ngã ngũ
                  {a.pending > 0 ? ` · ${formatNumber(a.pending)} còn đang chạy` : ""}
                </div>
                <div className="text-[11.5px] text-muted-foreground">COD đã về: {formatVND(a.recoveredCod)}</div>
              </div>
            ))}
          </div>

          {e.measurable && e.gapPoints !== null ? (
            <p className="mt-3 text-[13px]">
              Nhóm có người chăm cao hơn <b className="numeric">{e.gapPoints.toFixed(1)} điểm phần trăm</b>.
            </p>
          ) : (
            <p className="mt-3 text-[12.5px] leading-snug text-muted-foreground">{e.note}</p>
          )}

          {/* Cảnh báo thiên lệch đứng CẠNH con số, không nằm trong tài liệu: người đọc số là người cần biết. */}
          <p className="mt-2 border-t pt-2 text-[11.5px] leading-snug text-muted-foreground">{e.caveat}</p>
        </>
      )}
    </SectionCard>
  );
}
