import Link from "next/link";
import { notFound } from "next/navigation";
import { TopicStatusBadge } from "@/app/(dashboard)/production/_components/badges";
import { ModelDesk } from "@/app/(dashboard)/production/_components/model-desk";
import { TopicMessageForm, TopicStatusControl } from "@/app/(dashboard)/production/topics/[id]/topic-controls";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { describeTopicOpenContext } from "@/lib/constants/early-topic";
import { MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL } from "@/lib/constants/model-lifecycle";
import { MODEL_SIGNAL_LABEL } from "@/lib/constants/model-signal";
import { EMPTY_REQUIREMENTS, TOPIC_MESSAGE_KIND_LABEL, type TopicEvidenceSnapshot, type TopicMessageKind, type TopicRequirements } from "@/lib/constants/production-os";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getTopicDetail, listSupplierOptions } from "@/lib/queries/production-os";

export const metadata = { title: "Topic sản xuất" };

/**
 * Trang một topic: yêu cầu · ảnh chụp chứng cứ lúc mở · luồng trao đổi (append-only) · trạng thái · và bàn
 * sản xuất của MẪU (giá thành, mẫu, bản duyệt). Mọi nút ghi đi qua server action của miền sản xuất.
 */
export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("planning:view");
  const { id } = await params;
  const [d, suppliers] = await Promise.all([getTopicDetail(id), listSupplierOptions()]);
  if (!d) notFound();
  const canWrite = can(user, "production:write");
  const canApprove = can(user, "production:approve");
  const req: TopicRequirements = { ...EMPTY_REQUIREMENTS, ...(d.topic.requirements as Partial<TopicRequirements>) };
  const ev = d.topic.evidenceSnapshot as Partial<TopicEvidenceSnapshot>;
  // Bối cảnh lúc mở (Agent T): topic mở SỚM (mẫu chưa thắng — luồng song song) hay không. Ảnh chụp cũ
  // không mang bối cảnh ⇒ không nhãn, không đoán.
  const openCtx = describeTopicOpenContext(ev);
  const hasCtx = openCtx !== null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất · Topic"
        title={d.topic.title}
        description={`${d.model ? `${d.model.code}${d.model.name ? ` · ${d.model.name}` : ""}` : "—"} · mở bởi ${d.topic.createdBy || "—"} · ${formatDateTime(d.topic.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <TopicStatusBadge status={d.topic.status} />
            {openCtx?.early ? (
              <span
                className="rounded-md bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950/60 dark:text-sky-300"
                title="Topic mở khi mẫu CHƯA thắng (quy tắc chủ shop 25/09/2026): xưởng báo giá, làm mẫu song song với test quảng cáo. Vòng đời mẫu không đổi khi topic mở — khai THẮNG vẫn là việc của người."
              >
                {openCtx.label}
              </span>
            ) : null}
            {d.model ? (
              <Link href={`/models/${d.model.id}`} className="text-sm text-primary hover:underline">
                Trang mẫu
              </Link>
            ) : null}
            <Link href="/production" className="text-sm text-primary hover:underline">
              Danh sách
            </Link>
          </div>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <SectionCard title="Yêu cầu hỏi xưởng">
            <DescriptionList
              columns={3}
              items={[
                { label: "Xưởng", value: d.topic.supplierName ?? "—" },
                { label: "Chất liệu", value: req.material || "—" },
                { label: "Phụ liệu", value: req.trims || "—" },
                { label: "Màu", value: req.colors.length ? req.colors.join(", ") : "—" },
                { label: "Size", value: req.sizes.length ? req.sizes.join(", ") : "—" },
                { label: "Giá mục tiêu", value: req.targetPrice === null ? "—" : `${formatVND(req.targetPrice)}/sp` },
                { label: "Số lượng dự kiến", value: req.expectedQty === null ? "—" : formatNumber(req.expectedQty) },
                { label: "Hạn cần hàng", value: req.deadline ? formatDate(req.deadline) : "—" },
                { label: "Phương án đã chốt", value: d.topic.selectedOption || "—" },
                { label: "Ghi chú thiết kế", value: req.designNotes || "—", span: true },
              ]}
            />
          </SectionCard>

          <SectionCard title={`Trao đổi (${formatNumber(d.messages.length)})`} hint="Chỉ thêm, không sửa, không xoá — lịch sử bàn giá là chứng cứ khi xưởng giao khác lời hứa.">
            <ol className="space-y-3">
              {d.messages.map((m) => (
                <li key={m.id} className="rounded-lg border p-2.5 text-sm">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground">{TOPIC_MESSAGE_KIND_LABEL[m.kind as TopicMessageKind] ?? m.kind}</span>
                    <span>{m.authorUserId ? m.authorName || "—" : "Máy"}</span>
                    <span>{formatDateTime(m.createdAt)}</span>
                    {m.quotedUnitPrice !== null ? <span className="font-semibold text-foreground">Báo giá {formatVND(m.quotedUnitPrice)}/sp</span> : null}
                  </div>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  {m.attachments.length ? (
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      {m.attachments.map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                          {u.length > 50 ? `${u.slice(0, 50)}…` : u}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            {canWrite ? <div className="mt-3"><TopicMessageForm topicId={d.topic.id} /></div> : null}
          </SectionCard>

          <ModelDesk
            desk={d}
            modelId={d.topic.modelId}
            topicId={d.topic.id}
            productId={d.model?.productId ?? null}
            suppliers={suppliers}
            canWrite={canWrite}
            canApprove={canApprove}
            canAssumptions={can(user, "reports:assumptions")}
          />
        </div>

        <div className="space-y-5">
          {canWrite ? (
            <SectionCard title="Trạng thái topic">
              <TopicStatusControl topicId={d.topic.id} status={d.topic.status} />
            </SectionCard>
          ) : null}
          <SectionCard title="Ảnh chụp lúc mở topic" hint={ev.basis ?? "—"}>
            <DescriptionList
              columns={1}
              items={[
                { label: "Chụp lúc", value: ev.capturedAt ? formatDateTime(ev.capturedAt) : "—" },
                { label: "Đơn lên 30 ngày", value: formatNumber(ev.orders30d ?? null) },
                { label: "Đơn lên từ trước tới nay", value: formatNumber(ev.ordersTotal ?? null) },
                { label: "Chi quảng cáo 30 ngày", value: formatVND(ev.adSpend30d ?? null) },
                ...(hasCtx
                  ? [
                      { label: "Tín hiệu mẫu lúc mở", value: ev.signalAtOpen ? MODEL_SIGNAL_LABEL[ev.signalAtOpen.signal] : (ev.signalErrorAtOpen ?? "—") },
                      { label: "Vòng đời lúc mở", value: ev.lifecycleAtOpen ? MODEL_STATE_LABELS[ev.lifecycleAtOpen] : MODEL_STATE_UNDECLARED_LABEL },
                    ]
                  : [{ label: "Bối cảnh lúc mở", value: "— (topic mở trước khi ERP chụp tín hiệu mẫu)" }]),
              ]}
            />
            <p className="mt-2 text-xs text-muted-foreground">Đây là ẢNH CHỤP, không cập nhật theo ngày — số hôm nay xem ở trang mẫu.</p>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
