import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { DATA_EXPORT_KINDS, dataExportModule, type DataExportKind } from "@/lib/constants/data-export";
import { buildTenantExport } from "@/lib/exports/tenant-data";
import { canUseModule } from "@/lib/platform/capabilities";

export const dynamic = "force-dynamic";

/**
 * Tải CSV một loại dữ liệu của CHÍNH tổ chức trong phiên (docs/platform/data-export.md). Quyền `settings:manage` — tệp
 * mang tên / SĐT / địa chỉ khách. Module của loại đang tắt ⇒ 403. Mỗi lượt tải ghi nhật ký (ai tải gì, bao nhiêu dòng).
 * Lượt ĐỌC nên vẫn chạy khi gói quá hạn (chế độ chỉ xem).
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const guard = await apiGuard("settings:manage", { format: "text", forbiddenMessage: "Chỉ quản trị tổ chức (settings:manage) xuất được dữ liệu." });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  // Hỏi lại TƯỜNG MINH (tests/access-control.test.ts đọc câu này): tệp mang tên / SĐT / địa chỉ khách.
  if (!can(user, "settings:manage")) return new Response("Chỉ quản trị tổ chức xuất được dữ liệu", { status: 403 });
  const { kind } = await ctx.params;
  if (!(DATA_EXPORT_KINDS as readonly string[]).includes(kind)) return new Response("Không có loại dữ liệu này", { status: 404 });
  const k = kind as DataExportKind;
  if (!(await canUseModule(dataExportModule(k)))) return new Response("Module của loại dữ liệu này đang tắt", { status: 403 });
  const out = await buildTenantExport(k);
  await audit({ userId: user.id, userEmail: user.email, action: "DATA_EXPORT", entity: "DATA_EXPORT", entityId: k, after: { rows: out.rows, truncated: out.truncated }, reason: "Xuất dữ liệu của tổ chức" });
  const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  return new Response(out.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${k}-${user.organization?.code ?? "erp"}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
