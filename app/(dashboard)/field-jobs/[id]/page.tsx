import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DeleteFieldJobPhotoButton,
  FieldJobActions,
  FieldJobPhotoUpload,
  FieldJobQuoteForm,
  FieldJobReceiptForm,
  FieldJobRevisitForm,
  VoidFieldJobReceiptButton,
} from "@/components/field-jobs/field-job-forms";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { FIELD_JOB_PAY_METHOD_LABEL, FIELD_JOB_PHOTO_PHASE_LABEL, FIELD_JOB_STATUS_LABEL, fieldJobLinesEditable, type FieldJobPhotoPhase } from "@/lib/constants/field-jobs";
import { formatDateTime, formatVND, todayVN } from "@/lib/format";
import { fieldJobDetail, fieldJobFormOptions } from "@/lib/queries/field-jobs";

export const metadata = { title: "Phiếu công việc" };

/** Một phiếu công việc: báo giá, bước kế tiếp, ảnh trước / sau, thu tiền, nghiệm thu, bảo hành dịch vụ (0200). */
export default async function FieldJobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("field_jobs:view");
  const { id } = await params;
  const today = todayVN();
  const job = await fieldJobDetail(id, today);
  if (!job) notFound();
  const canWrite = can(user, "field_jobs:write");
  const techs = canWrite ? (await fieldJobFormOptions()).techs : [];
  const editable = canWrite && fieldJobLinesEditable(job.status);
  const showDay = (d: string) => d.split("-").reverse().join("/");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phiếu công việc"
        actions={
          <Link href="/field-jobs" className="text-sm text-muted-foreground hover:underline">
            ← Danh sách phiếu
          </Link>
        }
        title={`${job.code} · ${job.title}`}
        description={`${FIELD_JOB_STATUS_LABEL[job.status]} · ${job.customerName}${job.customerPhone ? ` · ${job.customerPhone}` : ""}`}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title="Thông tin" className="lg:col-span-2">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Khách</dt>
            <dd>
              <Link href={`/customers/${job.customerId}`} className="hover:underline">
                {job.customerName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Địa chỉ</dt>
            <dd>{job.address || "—"}</dd>
            {job.description ? (
              <>
                <dt className="text-muted-foreground">Mô tả</dt>
                <dd>{job.description}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Thợ · giờ hẹn</dt>
            <dd>{job.scheduledStart ? `${job.assigneeName ?? "—"} · ${formatDateTime(job.scheduledStart)} → ${formatDateTime(job.scheduledEnd)}` : "Chưa hẹn"}</dd>
            {job.acceptedAt ? (
              <>
                <dt className="text-muted-foreground">Khách đồng ý</dt>
                <dd>
                  {formatDateTime(job.acceptedAt)}
                  {job.acceptedNote ? ` · ${job.acceptedNote}` : ""}
                </dd>
              </>
            ) : null}
            {job.completedAt ? (
              <>
                <dt className="text-muted-foreground">Nghiệm thu</dt>
                <dd>
                  {formatDateTime(job.completedAt)} · khách ký: <b>{job.signedByName}</b>
                  {job.completionNote ? ` · ${job.completionNote}` : ""}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Bảo hành dịch vụ</dt>
            <dd>
              {job.warrantyMonths === null
                ? "Không bảo hành"
                : job.warrantyUntil
                  ? `${job.warrantyMonths} tháng · tới ${showDay(job.warrantyUntil)} · ${job.inWarranty ? "còn bảo hành" : "hết bảo hành"}`
                  : `${job.warrantyMonths} tháng — tính từ ngày nghiệm thu`}
            </dd>
            {job.cancelReason ? (
              <>
                <dt className="text-muted-foreground">Lý do huỷ</dt>
                <dd>{job.cancelReason}</dd>
              </>
            ) : null}
            {job.parent ? (
              <>
                <dt className="text-muted-foreground">Bảo hành cho</dt>
                <dd>
                  <Link href={`/field-jobs/${job.parent.id}`} className="hover:underline">
                    {job.parent.code}
                  </Link>
                </dd>
              </>
            ) : null}
            {job.revisits.length ? (
              <>
                <dt className="text-muted-foreground">Lượt bảo hành</dt>
                <dd>
                  {job.revisits.map((r, i) => (
                    <span key={r.id}>
                      {i ? ", " : ""}
                      <Link href={`/field-jobs/${r.id}`} className="hover:underline">
                        {r.code}
                      </Link>{" "}
                      ({FIELD_JOB_STATUS_LABEL[r.status]})
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          {canWrite ? (
            <div className="mt-3 border-t pt-3">
              <FieldJobActions job={{ id: job.id, status: job.status, assigneeUserId: job.assigneeUserId }} techs={techs} />
              {job.status === "DONE" ? <FieldJobRevisitForm jobId={job.id} /> : null}
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Tiền">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm" data-field-job-money>
            <dt className="text-muted-foreground">Báo giá</dt>
            <dd className="text-right font-medium">{formatVND(job.total)}</dd>
            <dt className="text-muted-foreground">Đã thu</dt>
            <dd className="text-right">{formatVND(job.paid)}</dd>
            <dt className="text-muted-foreground">Còn phải thu</dt>
            <dd className="text-right font-medium">{formatVND(job.due)}</dd>
          </dl>
          {job.receipts.length ? (
            <ul className="mt-3 divide-y text-xs">
              {job.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-1 py-1">
                  <span className={r.status === "VOIDED" ? "text-muted-foreground line-through" : ""}>
                    {formatDateTime(r.paidAt)} · {formatVND(r.amount)} · {FIELD_JOB_PAY_METHOD_LABEL[r.method]}
                    {r.note ? ` · ${r.note}` : ""} · {r.createdByName}
                  </span>
                  {r.status === "VOIDED" ? <span className="text-muted-foreground">huỷ: {r.voidReason}</span> : canWrite ? <VoidFieldJobReceiptButton jobId={job.id} receiptId={r.id} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {canWrite && job.status !== "CANCELLED" && job.total !== null && (job.due ?? 0) > 0 ? (
            <div className="mt-3 border-t pt-3">
              <FieldJobReceiptForm jobId={job.id} due={job.due} />
            </div>
          ) : null}
        </SectionCard>
      </div>

      <SectionCard title="Báo giá" description={editable ? "Sửa được tới trước khi nghiệm thu — phát sinh tại nhà khách ghi thêm dòng." : undefined}>
        {editable ? (
          <FieldJobQuoteForm jobId={job.id} initial={{ title: job.title, address: job.address, description: job.description, warrantyMonths: job.warrantyMonths, lines: job.lines }} />
        ) : job.lines.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Nội dung</th>
                <th className="py-1 pr-3 text-right">SL</th>
                <th className="py-1 pr-3 text-right">Đơn giá</th>
                <th className="py-1 text-right">Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              {job.lines.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-1 pr-3">{l.description}</td>
                  <td className="py-1 pr-3 text-right">{l.quantity}</td>
                  <td className="py-1 pr-3 text-right">{formatVND(l.unitPrice)}</td>
                  <td className="py-1 text-right">{formatVND(l.quantity * l.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có dòng báo giá.</p>
        )}
      </SectionCard>

      <SectionCard title="Ảnh trước / sau" description="Ảnh thu nhỏ ngay trên máy trước khi gửi.">
        {(["BEFORE", "AFTER"] as FieldJobPhotoPhase[]).map((phase) => {
          const list = job.photos.filter((p) => p.phase === phase);
          return (
            <div key={phase} className="mb-3 space-y-1">
              <div className="text-xs text-muted-foreground">
                {FIELD_JOB_PHOTO_PHASE_LABEL[phase]} · {list.length}
              </div>
              {list.length ? (
                <div className="flex flex-wrap gap-2" data-field-job-photos={phase}>
                  {list.map((p) => (
                    <figure key={p.id} className="space-y-0.5">
                      <a href={`/api/field-jobs/photos/${p.id}`} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL, đòi phiên; không qua bộ tối ưu ảnh */}
                        <img src={`/api/field-jobs/photos/${p.id}`} alt={FIELD_JOB_PHOTO_PHASE_LABEL[phase]} className="h-28 w-28 rounded-md border object-cover" />
                      </a>
                      {canWrite ? <DeleteFieldJobPhotoButton jobId={job.id} photoId={p.id} /> : null}
                    </figure>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {canWrite && job.status !== "CANCELLED" ? <FieldJobPhotoUpload jobId={job.id} /> : null}
      </SectionCard>
    </div>
  );
}
