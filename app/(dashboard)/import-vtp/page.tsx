import Link from "next/link";
import { VtpImportForm } from "@/app/(dashboard)/import-vtp/import-form";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { orderListCoverage } from "@/lib/queries/shipments";

export const metadata = { title: "Bổ sung danh sách vận đơn" };

export default async function ImportVtpPage() {
  await requirePermission("cod:write");
  const listCoverage = await orderListCoverage();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Dữ liệu gốc"
        title="Bổ sung danh sách vận đơn"
        description="Chỉ dùng để vá trạng thái giao hàng còn thiếu."
        hint={<>Tiền COD <b>không</b> nhập ở đây nữa: bảng kê đối soát thanh toán Viettel Post gửi về hòm thư của shop được đẩy thẳng vào ERP và tự đối soát, xem ở trang Đối soát COD. Trang này còn lại một việc: nạp tệp <b>Danh sách vận đơn</b> xuất từ trang Quản lý vận đơn của Viettel Post cho những giai đoạn ERP chưa có trạng thái hoặc chưa có mã vận đơn — tệp này Viettel Post không gửi qua email và API đối tác cũng không thấy được vận đơn do Pancake tạo.</>}
      />

      <SectionCard title="Nạp tệp" description="ERP tự nhận loại từng tệp" hint="Chọn nhiều tệp cùng lúc. ERP nhận loại theo NỘI DUNG tệp chứ không theo tên. Nạp lại cùng một tệp không làm số liệu nhân đôi: dòng cũ hơn bị bỏ qua, dòng trùng không ghi lại. Nếu lỡ chọn cả tệp bảng kê COD thì vẫn nhận được, nhưng bảng kê đã tự về qua email nên không cần nạp tay.">
        <VtpImportForm />
      </SectionCard>

      <SectionCard
        title="Cần xuất Danh sách vận đơn cho khoảng ngày nào"
        description="Khoảng ngày cần xuất danh sách vận đơn"
        hint="Tệp danh sách vận đơn mang TRẠNG THÁI GIAO HÀNG, khác bảng kê mang tiền. Không có luồng tự động nào cho tệp này: Viettel Post không gửi qua email, còn API partner không thấy được vận đơn do Pancake tạo. Gom các ngày cách nhau tối đa 3 ngày thành một khoảng để xuất một tệp."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Chưa có trạng thái từ Viettel Post</p>
            <p className="numeric mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400">{formatNumber(listCoverage.totalNoStatus)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Vận đơn chưa kết thúc, trạng thái hiện tại chỉ suy từ Pancake.</p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Chưa có mã vận đơn</p>
            <p className="numeric mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400">{formatNumber(listCoverage.totalNoCode)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Đơn tạo thẳng trên web Viettel Post — ERP ghép mã theo SĐT người nhận khi nạp tệp.</p>
          </div>
        </div>

        {listCoverage.ranges.length ? (
          <div className="mt-4 overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Xuất danh sách vận đơn từ ngày</th>
                  <th className="p-2 font-medium">Đến ngày</th>
                  <th className="p-2 text-right font-medium">Thiếu trạng thái</th>
                  <th className="p-2 text-right font-medium">Thiếu mã vận đơn</th>
                  <th className="p-2 text-right font-medium">COD khai báo</th>
                </tr>
              </thead>
              <tbody>
                {listCoverage.ranges.map((r) => (
                  <tr key={`${r.from}-${r.to}`} className="border-t">
                    <td className="numeric p-2 font-medium">{formatDate(r.from)}</td>
                    <td className="numeric p-2 font-medium">{formatDate(r.to)}</td>
                    <td className="numeric p-2 text-right">{r.noStatus ? formatNumber(r.noStatus) : <span className="text-muted-foreground">—</span>}</td>
                    <td className="numeric p-2 text-right">{r.noCode ? formatNumber(r.noCode) : <span className="text-muted-foreground">—</span>}</td>
                    <td className="numeric p-2 text-right">{formatVND(r.cod)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Mọi vận đơn đều đã có mã và trạng thái từ Viettel Post.</p>
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
