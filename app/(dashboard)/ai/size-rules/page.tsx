import { AlertTriangle, Ruler } from "lucide-react";
import { AssignForm } from "@/app/(dashboard)/ai/size-rules/assign-form";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { sizeRulesBoard } from "@/lib/queries/size-rules";

export const metadata = { title: "Bảng số đo" };

export default async function SizeRulesPage() {
  await requirePermission("ai:view");
  const board = await sizeRulesBoard();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Nhân sự AI"
        title="Bảng số đo"
        description={`${board.charts.length} bảng · ${formatNumber(board.products.length)} mã hàng · ${formatNumber(board.unassigned)} mã chưa gán`}
        hint={
          <>
            <p className="font-semibold">Gán mã hàng cho bảng nào</p>
            <p>
              Máy chỉ gợi ý size khi mã hàng có một bảng số đo. Chưa gán thì nó trả &ldquo;chưa có bảng cho mẫu này&rdquo; và chuyển người —
              đó là hành vi đúng, không phải một chỗ cần vá cho xong: áp bừa bảng của một mẫu khác lên một cơ thể thật là cách chắc chắn
              tạo ra một đơn đổi size.
            </p>
            <p className="mt-2">
              Cột <b>Lệch</b> là phần đáng đọc nhất. Bảng ghi <code>XXL</code> trong khi mẫu mã trong ERP tên <code>2XL</code> thì máy vẫn
              kết luận rất tự tin, rồi bước chốt mẫu mã không tìm thấy — hội thoại chết ở một chỗ khác hẳn.
            </p>
          </>
        }
      />

      {/* ───── Các bảng đang có ───── */}
      <div className="grid gap-3 sm:grid-cols-2">
        {board.charts.map((c) => (
          <Card key={c.version} className="p-4">
            <div className="flex items-start gap-2">
              <Ruler className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="font-semibold">{c.label}</div>
                <div className="text-sm text-muted-foreground">
                  {c.sizes.join(" · ")} — {formatNumber(c.rows)} dòng
                </div>
                <div className="mt-1 text-sm">
                  Cần khách cho biết: <b>{c.dims.join(" và ") || "—"}</b>
                </div>
                <div className="text-sm text-muted-foreground">
                  Đang áp cho {formatNumber(c.assigned)} mã hàng
                </div>
              </div>
            </div>
          </Card>
        ))}
        {board.charts.length === 0 && (
          <Card className="p-4 text-sm text-muted-foreground">
            Chưa nạp bảng số đo nào. Chạy ops <code>ai-staging-size-rules</code> (mặc định chạy thử) để nạp bảng từ kho mã.
          </Card>
        )}
      </div>

      {board.unassigned > 0 && (
        <Card className="border-amber-500/50 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <div className="font-semibold">{formatNumber(board.unassigned)} mã hàng chưa gán bảng nào</div>
              <p className="text-muted-foreground">
                Khách hỏi size ở những mã này đều được chuyển cho người. Chọn bảng ở cột bên phải là xong.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* ───── Gán từng mã ───── */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Mã hàng</th>
                <th className="px-4 py-2">Size đang bán</th>
                <th className="px-4 py-2">Lệch</th>
                <th className="w-64 px-4 py-2">Bảng số đo</th>
              </tr>
            </thead>
            <tbody>
              {board.products.map((p) => (
                <tr key={p.productId} className="border-t border-border align-top">
                  <td className="px-4 py-2">
                    <div className="font-medium">{p.code || "(chưa có mã)"}</div>
                    <div className="max-w-xs truncate text-xs text-muted-foreground">{p.name}</div>
                  </td>
                  <td className="px-4 py-2">{p.variantSizes.join(" · ") || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2 text-xs">
                    {p.sizesNotStocked.length > 0 && (
                      <div className="text-amber-700 dark:text-amber-400">
                        Bảng gợi ý được <b>{p.sizesNotStocked.join(", ")}</b> nhưng không có mẫu mã nào tên đó
                      </div>
                    )}
                    {p.sizesNotCovered.length > 0 && (
                      <div className="text-muted-foreground">
                        Có hàng size <b>{p.sizesNotCovered.join(", ")}</b> mà bảng chưa phủ — khách hợp size đó sẽ được chuyển người
                      </div>
                    )}
                    {p.chartVersion && p.sizesNotStocked.length === 0 && p.sizesNotCovered.length === 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">khớp</span>
                    )}
                    {!p.chartVersion && <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    {p.code ? (
                      <AssignForm productCode={p.code} current={p.chartVersion} charts={board.charts} />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Sản phẩm chưa có mã hàng — đặt mã trên Pancake rồi đồng bộ lại thì mới gán được
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Bảng mới (khác nam / nữ) hiện khai trong kho mã ở <code>scripts/size-rules.json</code> rồi nạp bằng ops. Màn hình này quyết định
        mã nào dùng bảng nào — nó không sửa các con số trong bảng, vì sửa một khoảng số đo là đổi size của mọi mã đang dùng bảng ấy.
      </p>
    </div>
  );
}
