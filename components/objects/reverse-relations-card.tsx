import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import type { SessionUser } from "@/lib/auth/session";
import { reverseRelations } from "@/lib/objects/records";

/**
 * ═══════════ BẢN GHI TUỲ BIẾN TRỎ TỚI MỘT BẢN GHI HỆ THỐNG (Phase 6 · chiều ngược của quan hệ) — SERVER COMPONENT ═══════════
 *
 * Đặt trên trang chi tiết CŨ (khách hàng, sản phẩm, đơn hàng): liệt kê bản ghi của đối tượng tuỳ biến có field liên kết
 * trỏ tới bản ghi đang xem (vd Hợp đồng bảo trì → khách). Nơi đặt đã kiểm người xem xem được bản ghi đích (cổng của
 * trang cũ); `reverseRelations` chỉ trả nhóm của đối tượng người xem mở được (module + khoá xem), field người xem được
 * xem, và bản ghi nguồn trong PHẠM VI người xem. Không có gì xem được ⇒ KHÔNG vẽ gì (không khung rỗng).
 */
export async function ReverseRelationsCard({ objectKey, recordId, user }: { objectKey: string; recordId: string; user: SessionUser }) {
  const groups = await reverseRelations(objectKey, recordId, user);
  if (groups.length === 0) return null;
  return (
    <SectionCard title="Bản ghi liên kết" hint="Bản ghi của đối tượng tuỳ biến có field liên kết trỏ tới đây. Chỉ hiện bản ghi bạn xem được.">
      <div className="space-y-3">
        {groups.map((g) => (
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
    </SectionCard>
  );
}
