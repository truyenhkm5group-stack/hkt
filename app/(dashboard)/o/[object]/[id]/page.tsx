import Link from "next/link";
import { notFound } from "next/navigation";
import { History, Link2 } from "lucide-react";
import { GateMessage } from "@/components/objects/gate-message";
import { ObjectIcon } from "@/components/objects/object-icon";
import { DeleteRecordButton, RecordEditForm } from "@/components/objects/record-form";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requireResource } from "@/lib/auth/scope-guard";
import { formatDateTime } from "@/lib/format";
import { canEditField } from "@/lib/metadata/values";
import { loadRecordDetailPage } from "@/lib/objects/record-detail";

export const metadata = { title: "Chi tiết bản ghi" };

/**
 * CHI TIẾT BẢN GHI tuỳ biến (Phase 6 · mục 5) = form `edit` ĐÃ XUẤT BẢN (Phase 2) + danh sách QUAN HỆ NGƯỢC (bản ghi
 * trỏ tới bản ghi này — một-nhiều) + dòng thời gian (nhật ký + sự kiện miền). Bản ghi không có / ngoài phạm vi / của tổ
 * chức khác ⇒ 404 cùng một kiểu (không cho dò id). Người chỉ có quyền xem thấy form ở chế độ chỉ đọc.
 */
export default async function ObjectRecordPage({ params }: { params: Promise<{ object: string; id: string }> }) {
  const { object, id } = await params;
  const { user, decision } = await requireResource("CUSTOM_RECORDS", "records:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Chi tiết bản ghi" reason={decision.reason} fix={decision.fix} />;
  // Mọi dữ liệu của trang trong MỘT lượt đọc (một phạm vi metadata) — lib/objects/record-detail.ts.
  const loaded = await loadRecordDetailPage(object, id, user);
  if (!loaded.ok) {
    if (loaded.failure) return <GateMessage failure={loaded.failure} title="Chi tiết bản ghi" />;
    notFound();
  }
  const { def, detail: r, form, fields, users, relationOptions, reverse, timeline, fileNames } = loaded.data;
  const rec = r.record;
  // Chỉ field người xem ĐƯỢC xem đi xuống trình duyệt (dịch vụ đã lọc giá trị; định nghĩa cũng lọc theo cùng luật).
  const visibleKeys = new Set(r.customFields.map((f) => f.key));
  const custom = fields.custom.filter((f) => visibleKeys.has(f.key));
  // Nhãn đích quan hệ đã lưu (người xem xem được) đứng đầu danh sách chọn — ô không bao giờ in trống một giá trị đã có.
  const options: Record<string, { id: string; label: string }[]> = { ...relationOptions };
  for (const [fieldKey, labels] of Object.entries(r.relationLabels)) {
    const known = new Set((options[fieldKey] ?? []).map((o) => o.id));
    options[fieldKey] = [...Object.entries(labels).filter(([rid]) => !known.has(rid)).map(([rid, label]) => ({ id: rid, label })), ...(options[fieldKey] ?? [])];
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={def.labelPlural}
        title={
          <span className="flex items-center gap-2">
            <ObjectIcon icon={r.object.icon} className="size-6 text-primary" />
            {rec.title}
          </span>
        }
        description={`${rec.ownerName ? `Phụ trách: ${rec.ownerName} · ` : ""}tạo ${formatDateTime(rec.createdAt)} · sửa ${formatDateTime(rec.updatedAt)} · phiên bản ${rec.version}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/o/${def.key}`} className="text-xs font-semibold text-primary hover:underline">
              ← {def.labelPlural}
            </Link>
            {r.canWrite ? <DeleteRecordButton objectKey={def.key} recordId={rec.id} title={rec.title} /> : null}
          </div>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.9fr)]">
        <SectionCard title="Thông tin" description={form.isDefault ? "Form mặc định" : `Form phiên bản ${form.version}`}>
          <RecordEditForm
            objectKey={def.key}
            recordId={rec.id}
            version={rec.version}
            schema={form.schema}
            system={fields.system}
            custom={custom}
            values={{ system: { title: rec.title, owner: rec.ownerId, created_at: rec.createdAt, updated_at: rec.updatedAt }, custom: rec.values }}
            users={users}
            relationOptions={options}
            customEditable={custom.filter((f) => canEditField(user, def, f)).map((f) => f.key)}
            fileNames={fileNames}
            canWrite={r.canWrite}
          />
        </SectionCard>
        <div className="space-y-5">
          <SectionCard title="Liên kết tới bản ghi này" hint="Bản ghi của đối tượng khác có field liên kết trỏ tới đây (chiều ngược — một-nhiều). Chỉ hiện bản ghi bạn xem được.">
            {reverse.length === 0 ? (
              <EmptyState icon={Link2} title="Chưa có liên kết nào" className="p-6" />
            ) : (
              <div className="space-y-3">
                {reverse.map((g) => (
                  <div key={`${g.objectKey}.${g.fieldKey}`}>
                    <p className="text-xs font-semibold text-muted-foreground">
                      {g.objectLabel} · {g.fieldLabel} ({g.records.length}
                      {g.truncated ? "+" : ""})
                    </p>
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {g.records.map((x) => (
                        <li key={x.id}>{x.href ? <Link href={x.href} className="hover:text-primary hover:underline">{x.title}</Link> : x.title}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          <SectionCard title="Dòng thời gian" hint="Nhật ký ghi + sự kiện miền của bản ghi. Mốc chạm tới field bạn không được xem không hiện.">
            {timeline.length === 0 ? (
              <EmptyState icon={History} title="Chưa có mốc nào" className="p-6" />
            ) : (
              <ol className="space-y-2 text-sm">
                {timeline.map((e) => (
                  <li key={e.id} className="border-l-2 border-hairline pl-3">
                    <div className="font-medium">{e.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(e.at)}
                      {e.source ? ` · ${e.source}` : ""}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
