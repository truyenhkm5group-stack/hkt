import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { DepartmentsPanel, RecurrencePanel } from "@/app/(dashboard)/work/settings/panels";
import { requirePermission } from "@/lib/auth/session";
import { getDb, schema } from "@/db";
import { assignableMembers, listDepartmentMembers, listDepartments } from "@/lib/queries/work";
import { asc } from "drizzle-orm";

export const metadata = { title: "Cấu hình công việc" };

/**
 * Cấu hình phòng ban và việc định kỳ. Đặt trong tab thứ sáu của `/work` thay vì một mục sidebar
 * riêng: đây là màn hình mở vài lần một quý, không phải màn hình làm việc hằng ngày.
 */
export default async function WorkSettingsPage() {
  await requirePermission("work:admin");
  const db = await getDb();
  const [departments, members, recurrences] = await Promise.all([
    listDepartments(true),
    assignableMembers(),
    db.select().from(schema.workRecurrences).orderBy(asc(schema.workRecurrences.title)),
  ]);
  const membersByDept = await Promise.all(departments.map(async (d) => ({ id: d.id, members: await listDepartmentMembers(d.id) })));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title="Cấu hình"
        description="Phòng ban, trưởng phòng, thành viên và việc lặp theo lịch."
        hint="Phòng ban quyết định việc nào hiện ở hàng đợi của ai. Một người có thể ở nhiều phòng — ở shop nhỏ chuyện đó là bình thường. Xoá thành viên chỉ NGỪNG HOẠT ĐỘNG chứ không xoá dòng, vì lịch sử “ai từng ở phòng nào” là căn cứ của báo cáo kỳ đã chốt."
      />

      <SectionCard title="Phòng ban" description="Trưởng phòng thấy toàn bộ việc của phòng; thành viên thấy việc của mình." padded={false}>
        <DepartmentsPanel
          departments={departments.map((d) => ({ ...d, members: membersByDept.find((m) => m.id === d.id)?.members ?? [] }))}
          people={members.map((m) => ({ id: m.id, name: m.name }))}
        />
      </SectionCard>

      <SectionCard
        title="Việc định kỳ"
        description="Đối soát hằng ngày, review quảng cáo, kiểm kê, chốt công — việc lặp theo lịch, sinh tự động."
        hint="Bốn nhịp cố định thay cho ô nhập cron: một chuỗi cron gõ sai sẽ im lặng không sinh việc nào và không ai phát hiện. Việc hằng tháng chỉ chọn được ngày 1–28 vì ngày 29–31 không tồn tại ở mọi tháng."
        padded={false}
      >
        <RecurrencePanel
          rows={recurrences.map((r) => ({
            id: r.id,
            title: r.title,
            cadence: r.cadence,
            cadenceDay: r.cadenceDay,
            hourOfDay: r.hourOfDay,
            dueInHours: r.dueInHours,
            active: r.active,
            departmentId: r.departmentId,
            assigneeId: r.assigneeId,
            lastGeneratedKey: r.lastGeneratedKey,
          }))}
          departments={departments.map((d) => ({ id: d.id, code: d.code, name: d.name }))}
          people={members.map((m) => ({ id: m.id, name: m.name }))}
        />
      </SectionCard>
    </div>
  );
}
