/**
 * Khai báo / cập nhật nhân sự & cơ chế lương từ JSON (dùng khi triển khai lần đầu).
 *   npm run seed:employees -- '[{"name":"Trần Anh Quân","shortName":"Quân TA","aliases":["QA4"],"accountIds":["968797992379957"],"percentTotal":35}]'
 * Ghép theo shortName (không phân biệt hoa thường): trùng thì cập nhật, không thì thêm mới.
 */
import "dotenv/config";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { reapplyAdsMapping } from "@/lib/integrations/facebook/mapping";
import { listEmployees } from "@/lib/queries/payroll";
import { setSettingJson } from "@/lib/settings";

async function main() {
  const input = JSON.parse(process.argv[2] ?? "[]") as Partial<Employee>[];
  if (!Array.isArray(input) || !input.length) throw new Error("Truyền một mảng JSON nhân sự");
  const list = await listEmployees();
  for (const e of input) {
    if (!e.name) throw new Error("Thiếu name");
    const key = (e.shortName ?? e.name).toLowerCase();
    const existing = list.find((x) => (x.shortName || x.name).toLowerCase() === key);
    const merged: Employee = {
      id: existing?.id ?? crypto.randomUUID(),
      name: e.name,
      shortName: e.shortName ?? existing?.shortName ?? e.name,
      department: e.department ?? existing?.department ?? "Marketing",
      aliases: e.aliases ?? existing?.aliases ?? [],
      accountIds: e.accountIds ?? existing?.accountIds ?? [],
      fixed: e.fixed ?? existing?.fixed ?? 0,
      percentTotal: e.percentTotal ?? existing?.percentTotal ?? 0,
      percentPersonal: e.percentPersonal ?? existing?.percentPersonal ?? 0,
      percentRevenue: e.percentRevenue ?? existing?.percentRevenue ?? 0,
      active: e.active ?? existing?.active ?? true,
      note: e.note ?? existing?.note ?? "",
    };
    if (existing) list.splice(list.indexOf(existing), 1, merged);
    else list.push(merged);
    console.log(`${existing ? "Cập nhật" : "Thêm"}: ${merged.name} (${merged.shortName}) · bí danh ${merged.aliases.join(", ") || "—"} · TK ${merged.accountIds.join(", ") || "—"} · ${merged.percentTotal}% LN tổng · ${merged.percentPersonal}% LN cá nhân`);
  }
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list });
  const r = await reapplyAdsMapping();
  console.log(`Áp lại ghép marketer: ${r.campaigns} chiến dịch, ${r.changed} dòng thay đổi`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
