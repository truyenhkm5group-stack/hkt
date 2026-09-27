import { Badge } from "@/components/ui/badge";
import { VIDEO_JOB_KIND_LABEL, VIDEO_JOB_STATUS_LABEL, VIDEO_VARIANT_STATUS_LABEL, type VideoJobKind, type VideoJobStatus, type VideoVariantStatus } from "@/lib/constants/video-scale";
import { formatDateTime } from "@/lib/format";
import type { JobRowView, VariantCard } from "@/lib/queries/video-scale";
import { KickQueueButton, RemakeVariantButton, RetryJobButton } from "./small-actions";

const ERROR_KIND_LABEL: Record<string, string> = {
  TRANSIENT: "lỗi tạm thời",
  PERMANENT: "bị từ chối",
  AMBIGUOUS: "không rõ đã tạo chưa",
  TIMEOUT: "quá giờ",
  BLOCKED: "thiếu điều kiện",
};

function JobTable({ jobs, canEdit, canSpend }: { jobs: JobRowView[]; canEdit: boolean; canSpend: boolean }) {
  if (!jobs.length) return <p className="text-[13px] text-muted-foreground">Không có việc nào.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[720px] text-[12.5px]">
        <thead className="bg-muted/50 text-left">
          <tr>
            <th className="px-2 py-1.5">Việc</th>
            <th className="px-2 py-1.5">Mã</th>
            <th className="px-2 py-1.5">Trạng thái</th>
            <th className="px-2 py-1.5 text-right">Lần thử</th>
            <th className="px-2 py-1.5 text-right">Chi (USD)</th>
            <th className="px-2 py-1.5">Lượt kế / cập nhật</th>
            <th className="px-2 py-1.5">Lỗi</th>
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const running = j.lockedUntil !== null && j.lockedUntil > new Date();
            const retryable = canEdit && (j.status === "FAILED" || j.status === "BLOCKED") && (j.errorKind !== "AMBIGUOUS" || canSpend);
            return (
              <tr key={j.id} className="border-t align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {VIDEO_JOB_KIND_LABEL[j.kind as VideoJobKind] ?? j.kind}
                  {j.sceneIndex !== null ? ` · cảnh ${j.sceneIndex + 1}` : ""}
                  {j.isTest ? <Badge variant="destructive" className="ml-1">THỬ</Badge> : null}
                </td>
                <td className="px-2 py-1.5">{j.productName ?? "—"}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{running ? "Đang chạy" : (VIDEO_JOB_STATUS_LABEL[j.status as VideoJobStatus] ?? j.status)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums" title="Ước tính theo bảng giá công bố">
                  {j.costUsd === null ? "—" : j.costUsd.toFixed(2)}
                  {j.reservedUsd !== null && j.costUsd === null ? <span className="block text-[11px] text-muted-foreground">giữ {j.reservedUsd.toFixed(2)}</span> : null}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">{formatDateTime(["QUEUED", "WAITING", "BLOCKED"].includes(j.status) ? j.nextRunAt : j.updatedAt)}</td>
                <td className="px-2 py-1.5 max-w-[22rem]">
                  {j.error ? (
                    <span className="text-[12px]">
                      {j.errorKind ? <b>{ERROR_KIND_LABEL[j.errorKind] ?? j.errorKind}: </b> : null}
                      {j.error}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 text-right">{retryable ? <RetryJobButton jobId={j.id} ambiguous={j.errorKind === "AMBIGUOUS"} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Tab "Hàng đợi render": việc đang chạy / bị chặn, biến thể đang sản xuất hoặc hỏng, việc đã kết thúc gần đây. */
export function QueuePanel({ active, recent, variants, canEdit, canSpend }: { active: JobRowView[]; recent: JobRowView[]; variants: VariantCard[]; canEdit: boolean; canSpend: boolean }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted-foreground">Việc chạy sau mỗi cú bấm (tối đa 15 phút) và theo lượt của bộ lập lịch nếu đã bật VIDEO_SCALE_EVERY_MINUTES. Tải lại trang để xem tiến độ.</p>
        {canEdit ? <KickQueueButton /> : null}
      </div>
      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Đang chạy / chờ / bị chặn ({active.length})</h2>
        <JobTable jobs={active} canEdit={canEdit} canSpend={canSpend} />
      </section>
      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Biến thể đang sản xuất / hỏng</h2>
        {variants.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Không có.</p>
        ) : (
          <ul className="space-y-1.5 text-[13px]">
            {variants.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
                <span className="font-medium">
                  {v.productName} #{v.seq}
                </span>
                <Badge variant={v.status === "FAILED" || v.status === "QC_FAILED" ? "destructive" : "secondary"}>{VIDEO_VARIANT_STATUS_LABEL[v.status as VideoVariantStatus] ?? v.status}</Badge>
                <span className="text-muted-foreground">{v.script.hook}</span>
                {v.error ? <span className="basis-full text-[12px] text-destructive">{v.error}</span> : null}
                {canSpend && (v.status === "FAILED" || v.status === "QC_FAILED") ? <RemakeVariantButton variantId={v.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Đã kết thúc gần đây</h2>
        <JobTable jobs={recent} canEdit={canEdit} canSpend={canSpend} />
      </section>
    </div>
  );
}
