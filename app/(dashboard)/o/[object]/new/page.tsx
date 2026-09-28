import { GateMessage } from "@/components/objects/gate-message";
import { RecordCreateForm } from "@/components/objects/record-form";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { SectionCard } from "@/components/ui-bits";
import { requireResource } from "@/lib/auth/scope-guard";
import { CUSTOM_RECORD_FORM_CREATE } from "@/lib/metadata/custom-object-def";
import { listFields } from "@/lib/metadata/fields";
import { getPublishedForm } from "@/lib/metadata/forms";
import { canEditField } from "@/lib/metadata/values";
import { recordGate, relationOptionsFor } from "@/lib/objects/records";
import { userPickOptions } from "@/lib/queries/users";

export const metadata = { title: "Tạo bản ghi" };

/**
 * TẠO BẢN GHI bằng form `create` ĐÃ XUẤT BẢN (chưa xuất bản ⇒ form mặc định dựng từ định nghĩa). Cùng cổng với server
 * action (`recordGate` chế độ ghi): module · quyền ghi · phạm vi — nút, trang và lượt ghi không nói ba điều khác nhau.
 */
export default async function NewObjectRecordPage({ params }: { params: Promise<{ object: string }> }) {
  const { object } = await params;
  const { user, decision } = await requireResource("CUSTOM_RECORDS", "records:write");
  if (decision.allow === "NONE") return <ScopeDenied title="Tạo bản ghi" reason={decision.reason} fix={decision.fix} />;
  const gate = await recordGate(object, user, "write");
  if (!gate.ok) return <GateMessage failure={gate} title="Tạo bản ghi" />;
  const def = gate.def;
  const [form, fields] = await Promise.all([getPublishedForm(def.key, CUSTOM_RECORD_FORM_CREATE), listFields(def.key)]);
  // Ô «Người phụ trách» là field hệ thống kiểu người dùng ⇒ luôn cần danh sách tài khoản.
  const [users, relationOptions] = await Promise.all([userPickOptions(), relationOptionsFor(user, fields.custom)]);
  // Tệp gắn vào MỘT bản ghi — chưa có bản ghi thì chưa tải được; ô tệp chỉ đọc ở form tạo.
  const customEditable = fields.custom.filter((f) => f.type !== "file" && canEditField(user, def, f)).map((f) => f.key);
  const customLockedReason = Object.fromEntries(fields.custom.filter((f) => f.type === "file").map((f) => [f.key, "Tải tệp ở trang chi tiết sau khi tạo"]));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader eyebrow={def.labelPlural} title={`Tạo ${def.label.toLocaleLowerCase("vi")}`} description={form.isDefault ? "Form mặc định" : `Form phiên bản ${form.version}`} />
      <SectionCard>
        <RecordCreateForm
          objectKey={def.key}
          label={def.label.toLocaleLowerCase("vi")}
          ownerId={user.id}
          schema={form.schema}
          system={fields.system}
          custom={fields.custom}
          users={users}
          relationOptions={relationOptions}
          customEditable={customEditable}
          customLockedReason={customLockedReason}
        />
      </SectionCard>
    </div>
  );
}
