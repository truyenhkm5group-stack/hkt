import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { getPlanUsage } from "@/lib/entitlements/check";
import { cn } from "@/lib/utils";

export const metadata = { title: "Gói & hạn mức" };

function fmt(n: number, kind: string): string {
  return kind === "storageMb" ? n.toLocaleString("vi-VN", { maximumFractionDigits: 1 }) : n.toLocaleString("vi-VN");
}

/**
 * GÓI & HẠN MỨC (Phase 10 · §5) — mức dùng ĐẾM TƯƠI từ CSDL tổ chức của người xem. "—" = CHƯA ĐO ĐƯỢC (loại chưa có
 * bộ đếm, luật 42), không phải 0; "Không giới hạn" = gói khai `null`.
 */
export default async function PlanPage() {
  const user = await requirePermission("settings:manage");
  const usage = await getPlanUsage(user.organization?.code);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Gói & hạn mức"
        description={usage.plan ? `Gói «${usage.plan.name}»${usage.isHome ? " — tổ chức nhà, không giới hạn" : ""}` : "Không đọc được gói"}
        hint="Hạn mức kiểm ở đúng chỗ tạo: người dùng, trang tuỳ biến, luật tự động, tải tệp. Vượt thì thao tác đó báo lỗi rõ ràng, không có gì bị xoá. Nâng gói là việc của người vận hành nền tảng."
      />
      {!usage.plan ? (
        <EmptyState title="Không đọc được gói dịch vụ" description="Bảng gói của nền tảng chưa có hoặc gói của tổ chức không tồn tại — báo người vận hành nền tảng." />
      ) : (
        <SectionCard title="Mức dùng" description={usage.plan.fellBack ? "Gói khai trên tổ chức không có trong bảng — đang áp hạn mức của gói Dùng thử." : (usage.plan.description ?? undefined)} padded={false}>
          <table className="w-full text-sm" data-plan-usage>
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Hạng mục</th>
                <th className="px-4 py-2 text-right">Đang dùng</th>
                <th className="px-4 py-2 text-right">Hạn mức</th>
                <th className="px-4 py-2">Đếm từ</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => {
                const over = r.used !== null && r.limit !== null && r.used >= r.limit;
                return (
                  <tr key={r.kind} className="border-t border-hairline" data-kind={r.kind}>
                    <td className="px-4 py-2">{r.label}</td>
                    <td className={cn("numeric px-4 py-2 text-right", over && "font-semibold text-destructive")}>{r.used === null ? "—" : fmt(r.used, r.kind)}</td>
                    <td className="numeric px-4 py-2 text-right">{r.limit === null ? (r.undeclared ? "Chưa khai" : "Không giới hạn") : `${fmt(r.limit, r.kind)} ${r.unit}`}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.note ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SectionCard>
      )}
    </div>
  );
}
