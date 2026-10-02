import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listPriceLists } from "@/lib/queries/price-lists";

export const metadata = { title: "Bảng giá sỉ" };

/** BẢNG GIÁ SỈ (0188) — giá theo nhóm khách + bậc số lượng. Áp ở form đơn tạo tay và chatbot (khi chủ shop bật). */
export default async function PriceListsPage() {
  const user = await requirePermission("products:view");
  const lists = await listPriceLists();
  const canEdit = can(user, "products:write");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản phẩm"
        title="Bảng giá sỉ"
        description={`${lists.filter((l) => l.active).length} bảng đang dùng`}
        hint="Gán bảng cho khách ở trang khách hàng (Điều khoản bán). Khách chưa gán bảng dùng bảng «mặc định» (nếu có), rồi tới giá lẻ. Trong một bảng, bậc «mua từ» lớn nhất mà vẫn ≤ số lượng của dòng đơn thắng."
        actions={
          canEdit ? (
            <Button asChild size="sm">
              <Link href="/products/price-lists/new">Tạo bảng giá</Link>
            </Button>
          ) : null
        }
      />
      <SectionCard padded={false}>
        {lists.length === 0 ? (
          <EmptyState title="Chưa có bảng giá nào" description="Mọi đơn đang dùng giá lẻ của mẫu mã. Tạo bảng giá cho đại lý / khách sỉ để đơn của họ tự lấy đúng giá." />
        ) : (
          <table className="w-full text-sm" data-price-lists>
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Bảng giá</th>
                <th className="px-4 py-2 text-right">Mẫu mã</th>
                <th className="px-4 py-2 text-right">Bậc</th>
                <th className="px-4 py-2 text-right">Khách đang gán</th>
                <th className="px-4 py-2">Sửa lần cuối</th>
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr key={l.id} className="border-t border-hairline">
                  <td className="px-4 py-2">
                    <Link href={`/products/price-lists/${l.id}`} className="font-medium hover:underline">
                      {l.name}
                    </Link>
                    {l.isDefault ? <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">mặc định</span> : null}
                    {!l.active ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">ngừng dùng</span> : null}
                    {l.note ? <div className="text-xs text-muted-foreground">{l.note}</div> : null}
                  </td>
                  <td className="numeric px-4 py-2 text-right">{l.variants}</td>
                  <td className="numeric px-4 py-2 text-right">{l.tiers}</td>
                  <td className="numeric px-4 py-2 text-right">{l.customers}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(l.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
