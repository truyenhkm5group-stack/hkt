import Link from "next/link";
import { X } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { CARE_STATUS_LABEL, type CareStatus } from "@/lib/constants/care";
import { CARE_OUTCOME_LABEL, type CareOutcome } from "@/lib/constants/care-outcome";
import { PENDING_DIAGNOSES, PENDING_DIAGNOSIS_HINT, PENDING_DIAGNOSIS_IS_DEFECT, PENDING_DIAGNOSIS_LABEL, type PendingDiagnosis } from "@/lib/care/pending-diagnosis";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { listCareCases, type CareCaseBucket } from "@/lib/queries/care-performance";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const BUCKET_LABEL: Record<CareCaseBucket, string> = {
  FINISHED: "Đã chốt",
  RESCUED_DIRECT: "Cứu trực tiếp",
  RESCUED_EXCHANGE: "Cứu bằng đổi",
  RESCUE_FAILED: "Không cứu được",
  PENDING: "Đang treo",
  UNATTRIBUTED: "Chưa có kết luận (lịch sử)",
};

/**
 * ═══════════ BẤM VÀO CON SỐ THÌ RA ĐÚNG NHỮNG CA ĐÃ SINH RA NÓ ═══════════
 *
 * Số dòng ở đây BẰNG con số trên ô vừa bấm: cùng tập ca, cùng phép quy người, cùng phép phân ô
 * (`listCareCases`). Với ca chưa chốt, mỗi dòng nói ra VÌ SAO nó còn treo — vì "Đang treo" và "Cần
 * care" trả lời hai câu hỏi khác nhau, và câu trả lời nằm ở từng kiện chứ không ở một con số.
 */
export async function RescueCaseList({ period, ownerId, ownerName, bucket, closeHref }: { period: Period; ownerId: string | null; ownerName: string; bucket: CareCaseBucket; closeHref: string }) {
  const { rows, total } = await listCareCases(period, { ownerId, bucket });
  const chuaChot = bucket === "PENDING" || bucket === "UNATTRIBUTED";

  const theoLyDo = new Map<PendingDiagnosis, number>();
  for (const r of rows) if (r.diagnosis) theoLyDo.set(r.diagnosis, (theoLyDo.get(r.diagnosis) ?? 0) + 1);
  const loi = rows.filter((r) => r.diagnosis && PENDING_DIAGNOSIS_IS_DEFECT[r.diagnosis]).length;

  return (
    <SectionCard
      id="ds-ca"
      title={`${BUCKET_LABEL[bucket]} · ${ownerName} · ${formatNumber(total)} ca`}
      description={chuaChot ? "Mỗi dòng là một ĐỢT chăm sóc (một kiện có thể có nhiều đợt). Cột cuối nói vì sao đợt chưa có kết quả." : "Mỗi dòng là một đợt đã có kết cục cuối theo chứng từ Viettel Post."}
      actions={
        <Link href={closeHref} scroll={false} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-3.5" /> Đóng
        </Link>
      }
      padded={false}
    >
      {chuaChot && rows.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-3 py-2 text-[11.5px]">
          {PENDING_DIAGNOSES.filter((d) => theoLyDo.get(d)).map((d) => (
            <span key={d} title={PENDING_DIAGNOSIS_HINT[d]} className={cn(PENDING_DIAGNOSIS_IS_DEFECT[d] ? "text-rose-700 dark:text-rose-400" : "text-muted-foreground")}>
              {PENDING_DIAGNOSIS_LABEL[d]}: <b className="numeric">{formatNumber(theoLyDo.get(d) ?? 0)}</b>
            </span>
          ))}
          {loi ? <span className="w-full text-rose-700 dark:text-rose-400">{formatNumber(loi)} ca lẽ ra đã phải có kết quả — lỗi chốt ca của ERP, không phải việc nhân viên còn nợ.</span> : null}
        </div>
      ) : null}
      {total > rows.length ? <p className="border-b px-3 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">Hiện {formatNumber(rows.length)}/{formatNumber(total)} ca mới nhất.</p> : null}
      <div className={TABLE_SCROLL}>
        <table className="w-full min-w-[900px] text-[12px]">
          <thead className={cn(STICKY_HEAD, "border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground")}>
            <tr>
              <th className="px-2.5 py-2 font-semibold">Vận đơn</th>
              <th className="px-2.5 py-2 font-semibold">Mở ca</th>
              <th className="px-2.5 py-2 font-semibold" title="Trạng thái xử lý của đội — KHÔNG phải kết quả">Ca</th>
              <th className="px-2.5 py-2 font-semibold">Viettel Post đang báo</th>
              <th className="px-2.5 py-2 text-right font-semibold">COD</th>
              <th className="px-2.5 py-2 font-semibold">{chuaChot ? "Vì sao chưa có kết quả" : "Kết cục"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r) => (
                <tr key={r.id} className="border-b align-top last:border-0 hover:bg-accent/30">
                  <td className="px-2.5 py-1.5">
                    <Link href={`/shipments/${r.shipmentId}`} className="font-medium text-primary hover:underline">
                      {r.tracking ?? r.shipmentId}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">
                      đợt {r.episodeNo}
                      {r.latestEpisodeNo > r.episodeNo ? <span className="text-rose-700 dark:text-rose-400"> / đã có đợt {r.latestEpisodeNo}</span> : null}
                    </div>
                  </td>
                  <td className="numeric whitespace-nowrap px-2.5 py-1.5">{formatDateTime(r.openedAt)}</td>
                  <td className="px-2.5 py-1.5">
                    {CARE_STATUS_LABEL[r.careStatus as CareStatus] ?? r.careStatus}
                    <div className="text-[11px] text-muted-foreground">{r.active ? "còn mở" : r.doneAt ? `đóng ${formatDateTime(r.doneAt)}` : "đã đóng"}</div>
                  </td>
                  <td className="px-2.5 py-1.5">
                    {SHIPMENT_STAGE_LABEL[r.stage] ?? r.stage}
                    <div className="text-[11px] text-muted-foreground">
                      {r.vtpStatus !== null ? `${r.vtpStatus} · ` : ""}
                      {r.vtpStatusName ?? "—"}
                      {r.vtpStatusDate ? ` · ${formatDateTime(r.vtpStatusDate)}` : ""}
                    </div>
                  </td>
                  <td className="numeric px-2.5 py-1.5 text-right">{formatVND(r.codAmount)}</td>
                  <td className="px-2.5 py-1.5">
                    {r.diagnosis ? (
                      <span title={PENDING_DIAGNOSIS_HINT[r.diagnosis]} className={cn(PENDING_DIAGNOSIS_IS_DEFECT[r.diagnosis] ? "font-medium text-rose-700 dark:text-rose-400" : "text-foreground")}>
                        {PENDING_DIAGNOSIS_LABEL[r.diagnosis]}
                      </span>
                    ) : (
                      <>
                        {CARE_OUTCOME_LABEL[r.careOutcome as CareOutcome] ?? r.careOutcome ?? "—"}
                        <div className="text-[11px] text-muted-foreground">{formatDateTime(r.outcomeAt)}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">Không có ca nào.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
