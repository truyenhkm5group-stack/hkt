import { CostSheets, type CostSheetView } from "@/app/(dashboard)/production/_components/cost-sheets";
import { SamplesPanel, type SampleView } from "@/app/(dashboard)/production/_components/samples-panel";
import { SectionCard } from "@/components/ui-bits";
import { type CostSheetStatus, type SampleStatus } from "@/lib/constants/production-os";
import { formatDateTime, formatVND } from "@/lib/format";
import type { getModelProductionDesk } from "@/lib/queries/production-os";

type Desk = Awaited<ReturnType<typeof getModelProductionDesk>>;

type DesignSpec = {
  sample?: { version?: number; supplierName?: string | null; notes?: string };
  topic?: { title?: string; selectedOption?: string | null } | null;
  costSheet?: { version?: number; totalUnitCost?: number } | null;
  costSheetNote?: string | null;
};

/**
 * Bàn sản xuất của MỘT mẫu: giá thành (phiên bản) · mẫu (phiên bản + duyệt) · bản thiết kế đã duyệt.
 * Dùng chung cho trang topic và trang mẫu — giá thành / mẫu thuộc MẪU, topic chỉ là nơi chúng được bàn.
 */
export function ModelDesk({
  desk,
  modelId,
  topicId,
  productId,
  suppliers,
  canWrite,
  canApprove,
  canAssumptions,
}: {
  desk: Desk;
  modelId: string;
  topicId: string | null;
  productId: string | null;
  suppliers: { id: string; name: string }[];
  canWrite: boolean;
  canApprove: boolean;
  canAssumptions: boolean;
}) {
  const sheets: CostSheetView[] = desk.costSheets.map((s) => ({
    id: s.id,
    version: s.version,
    status: s.status as CostSheetStatus,
    totalUnitCost: s.totalUnitCost,
    notes: s.notes,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    finalizedAt: s.finalizedAt,
    finalizedBy: s.finalizedBy,
    topicId: s.topicId,
    lines: s.lines.map((l) => ({ kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, unitCost: l.unitCost, amount: l.amount })),
  }));
  const samples: SampleView[] = desk.samples.map((s) => ({
    id: s.id,
    version: s.version,
    status: s.status as SampleStatus,
    supplierId: s.supplierId,
    supplierName: s.supplierName,
    costVnd: s.costVnd,
    images: Array.isArray(s.images) ? s.images : [],
    notes: s.notes,
    problems: s.problems,
    requestedChanges: s.requestedChanges,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    submittedAt: s.submittedAt,
    topicId: s.topicId,
    review: s.review ? { decision: s.review.decision, note: s.review.note, reviewerName: s.review.reviewerName, reviewedAt: s.review.reviewedAt } : null,
    design: s.design ? { id: s.design.id, version: s.design.version } : null,
  }));

  return (
    <>
      <SectionCard
        title="Giá thành tạm tính (phiên bản)"
        hint="Mỗi lần xưởng báo lại giá là một phiên bản. Bản đã chốt không sửa được — phiên bản cũ luôn còn để so. Chốt cần quyền duyệt. Giá thành ở đây KHÔNG tự vào báo cáo lợi nhuận: muốn dùng làm giá vốn dự tính thì bấm “Dùng làm giá ước tính” trên bản đã chốt."
      >
        <CostSheets modelId={modelId} topicId={topicId} productId={productId} sheets={sheets} canWrite={canWrite} canApprove={canApprove} canAssumptions={canAssumptions} />
      </SectionCard>

      <SectionCard id="mau" title="Mẫu xưởng làm" hint="Mỗi phiên bản mẫu nhận đúng một phán quyết. Yêu cầu sửa thì ghi mẫu phiên bản tiếp theo; duyệt thì sinh bản thiết kế bất biến cho lệnh sản xuất trỏ vào.">
        <SamplesPanel modelId={modelId} topicId={topicId} samples={samples} suppliers={suppliers} canWrite={canWrite} canApprove={canApprove} />
      </SectionCard>

      <SectionCard title="Bản thiết kế đã duyệt" hint="Ảnh chụp đóng băng lúc duyệt mẫu: trường của mẫu, yêu cầu của topic và bản sao bảng giá thành đã chốt lúc đó. Sửa topic / mẫu / giá thành về sau không đổi bản này.">
        {desk.designVersions.length ? (
          <ul className="divide-y text-sm">
            {desk.designVersions.map((d) => {
              const spec = d.spec as DesignSpec;
              return (
                <li key={d.id} className="py-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono font-semibold">Bản duyệt V{d.version}</span>
                    <span className="text-xs text-muted-foreground">
                      từ mẫu V{spec.sample?.version ?? "—"} · duyệt bởi {d.approvedBy || "—"} · {formatDateTime(d.approvedAt)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Xưởng: {spec.sample?.supplierName ?? "—"} · Giá thành:{" "}
                    {spec.costSheet ? `V${spec.costSheet.version} · ${formatVND(spec.costSheet.totalUnitCost ?? null)}/sp` : (spec.costSheetNote ?? "—")}
                    {spec.topic?.selectedOption ? ` · Phương án: ${spec.topic.selectedOption}` : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có bản thiết kế nào được duyệt — lệnh sản xuất của mẫu này chưa có gì để trỏ vào.</p>
        )}
      </SectionCard>
    </>
  );
}
