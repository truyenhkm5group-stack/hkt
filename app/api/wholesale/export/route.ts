import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { apiGuard } from "@/lib/auth/api-guard";
import { decideScope } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { csvDocument } from "@/lib/constants/data-export";
import { exportWholesaleLeads } from "@/lib/queries/wholesale-export";

export const dynamic = "force-dynamic";

/**
 * Xuất CSV các lead khách sỉ ĐÃ CHỌN (`?ids=a,b,c`, tối đa 2.000). Quyền `wholesale:assign` (người quản lý giao việc —
 * tệp mang SĐT doanh nghiệp) và đúng phạm vi dữ liệu của người tải. Mỗi lượt tải vào nhật ký. Nội dung xuất
 * — CHỈ dữ liệu của tổ chức + Place ID + link Google Maps (điều khoản Google cấm xuất nội dung Google ra ngoài dịch vụ).
 */
export async function GET(request: NextRequest) {
  const guard = await apiGuard("wholesale:assign", { format: "text", forbiddenMessage: "Cần quyền giao lead (wholesale:assign) để xuất danh sách." });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "wholesale:assign")) return new Response("Cần quyền giao lead (wholesale:assign)", { status: 403 });
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return new Response(`${decision.reason} ${decision.fix}`, { status: 403 });
  const ids = (request.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9-]{8,64}$/.test(s))
    .slice(0, 2000);
  if (!ids.length) return new Response("Chưa chọn lead nào", { status: 400 });
  const { header, rows } = await exportWholesaleLeads(ids, decision);
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_EXPORT", entity: "WHOLESALE_LEAD", entityId: ids.slice(0, 5).join(","), after: { rows: rows.length }, reason: "Xuất lead khách sỉ" });
  const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  return new Response(csvDocument(header, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="khach-si-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
