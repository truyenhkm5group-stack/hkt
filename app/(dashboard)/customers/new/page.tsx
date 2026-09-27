import { notFound } from "next/navigation";
import { CustomerCreateForm } from "@/app/(dashboard)/customers/new/customer-create-form";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import { listFields } from "@/lib/metadata/fields";
import { getPublishedForm } from "@/lib/metadata/forms";
import { canEditField } from "@/lib/metadata/values";
import { userPickOptions } from "@/lib/queries/users";
import { CUSTOMER_CREATE_FORM, customerCreateGate } from "@/lib/records/customer-create";

export const metadata = { title: "Tạo khách hàng" };

/**
 * Tạo khách bằng form `create` đã xuất bản. Trang KHÔNG TỒN TẠI (404) khi tổ chức đang bật
 * `connector_pancake` hoặc người xem thiếu `customers:write` — cùng một cổng với server action
 * (`customerCreateGate`), để nút, trang và lượt ghi không nói ba điều khác nhau.
 */
export default async function NewCustomerPage() {
  const user = await requirePermission("customers:view");
  const gate = await customerCreateGate(user);
  if (!gate.allowed) notFound();
  const [form, fields] = await Promise.all([getPublishedForm("customer", CUSTOMER_CREATE_FORM), listFields("customer")]);
  const obj = objectDef("customer")!;
  const users = fields.custom.some((f) => f.type === "user") ? await userPickOptions() : undefined;
  // Tệp gắn vào MỘT bản ghi — chưa có bản ghi thì chưa tải được; ô tệp chỉ đọc ở form tạo.
  const customEditable = fields.custom.filter((f) => f.type !== "file" && canEditField(user, obj, f)).map((f) => f.key);
  const customLockedReason = Object.fromEntries(fields.custom.filter((f) => f.type === "file").map((f) => [f.key, "Tải tệp ở trang khách sau khi tạo"]));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader eyebrow="Khách hàng" title="Tạo khách hàng" description={form.isDefault ? "Form mặc định" : `Form phiên bản ${form.version}`} />
      <SectionCard>
        <CustomerCreateForm schema={form.schema} system={fields.system} custom={fields.custom} users={users} customEditable={customEditable} customLockedReason={customLockedReason} />
      </SectionCard>
    </div>
  );
}
