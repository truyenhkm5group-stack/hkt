import Link from "next/link";
import { VtpImportForm } from "@/app/(dashboard)/import-vtp/import-form";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { codReconciliation, statementCoverage } from "@/lib/queries/cod-reconciliation";

export const metadata = { title: "Nhập dữ liệu Viettel Post" };

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

export default async function ImportVtpPage() {
  await requirePermission("cod:write");
  const [coverage, recon] = await Promise.all([statementCoverage(), codReconciliation(ALL)]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Dữ liệu gốc"
        title="Nhập dữ liệu Viettel Post"
        description="Một chỗ duy nhất để nạp hai loại tệp tải từ Viettel Post. Đây là nguồn dữ liệu gốc cho trạng thái giao hàng và tiền COD của mọi báo cáo."
      />

      <SectionCard title="Nạp tệp" description="Chọn cả hai loại tệp cùng lúc — ERP tự nhận loại từng tệp.">
        <VtpImportForm />
      </SectionCard>

      <SectionCard
        title="Cần nhập thêm gì"
        description="Suy từ dữ liệu thật trong ERP, không suy từ lịch trả tiền của Viettel Post."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Tiền đã thu chưa có chứng từ</p>
            <p className="numeric mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400">{formatVND(recon.unproven.amount)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{formatNumber(recon.unproven.count)} vận đơn — cần chi tiết bảng kê của giai đoạn tương ứng.</p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">ERP có dữ liệu vận đơn từ</p>
            <p className="numeric mt-1 text-2xl font-bold">{coverage.firstShipmentDate ? formatDate(coverage.firstShipmentDate) : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Bảng kê của giai đoạn trước ngày này sẽ không ghép được vận đơn nào — nạp Danh sách vận đơn của giai đoạn đó trước.
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Đã nhập</p>
            <p className="numeric mt-1 text-2xl font-bold">{formatNumber(coverage.batches)} đợt tiền về</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {coverage.firstBatch && coverage.lastBatch ? `${formatDate(coverage.firstBatch)} → ${formatDate(coverage.lastBatch)}` : "chưa có đợt nào"}
            </p>
          </div>
        </div>

        {coverage.gaps.length ? (
          <div className="mt-4 overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Cần xuất bảng kê từ ngày</th>
                  <th className="p-2 font-medium">Đến ngày</th>
                  <th className="p-2 text-right font-medium">Vận đơn</th>
                  <th className="p-2 text-right font-medium">Tiền đang treo</th>
                </tr>
              </thead>
              <tbody>
                {coverage.gaps.map((g) => (
                  <tr key={`${g.from}-${g.to}`} className="border-t">
                    <td className="numeric p-2 font-medium">{formatDate(g.from)}</td>
                    <td className="numeric p-2 font-medium">{formatDate(g.to)}</td>
                    <td className="numeric p-2 text-right">{formatNumber(g.shipments)}</td>
                    <td className="numeric p-2 text-right font-semibold text-amber-600 dark:text-amber-400">{formatVND(g.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Không còn khoảng ngày nào thiếu bảng kê.</p>
        )}
      </SectionCard>

      <SectionCard title="ERP tin nguồn nào" description="Khi các nguồn nói khác nhau về cùng một việc.">
        <ol className="space-y-2 text-sm">
          <li>
            <strong>Viettel Post (tệp tải về)</strong> — nguồn gốc cho <em>trạng thái giao hàng</em> và <em>tiền COD</em>.
            Nếu Pancake hoặc POS nói khác về cùng một việc thì <strong>chỉ tính theo Viettel Post</strong>.
          </li>
          <li>
            <strong>POS (Poscake)</strong> — nguồn gốc cho đơn mới và đơn đã xác nhận.
          </li>
          <li>
            <strong>Pancake</strong> — nguồn gốc cho hội thoại, lịch sử mua của khách, đánh giá khách rủi ro.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">
          Tiền chỉ được coi là đã thu khi có số THỰC THU; COD khai báo trên đơn không bao giờ được tính là tiền.
          Xem dòng tiền đầy đủ ở <Link className="text-primary underline underline-offset-2" href="/cod">Đối soát COD</Link>.
        </p>
      </SectionCard>
    </div>
  );
}
