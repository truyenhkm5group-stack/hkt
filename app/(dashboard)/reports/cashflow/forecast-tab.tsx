import { AlertTriangle, Banknote, Boxes, TrendingDown } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/format";
import { getCashflow } from "@/lib/queries/cashflow";
import { cn } from "@/lib/utils";

/**
 * DỰ PHÓNG DÒNG TIỀN — nội dung nguyên bản của trang Dòng tiền, nay là MỘT tab.
 *
 * Tách ra vì nó là một CƠ SỞ ĐO riêng: đây là phần CHƯA XẢY RA, suy từ nhịp chi thực tế và tiền
 * COD đang chờ, không có chứng từ nào. Đứng cạnh báo cáo tiền thật trên cùng một màn hình thì hai
 * loại số trông như nhau, và một con số ước lượng bị đọc như một con số chứng từ.
 *
 * Công thức và các giới hạn giữ NGUYÊN — xem `lib/queries/cashflow.ts`. Tab này chỉ đổi chỗ đặt.
 */
export async function ForecastTab() {
  const r = await getCashflow();
  const w = r.workingCapital;
  const worst = r.buckets.reduce((min, b) => (b.net < min.net ? b : min), r.buckets[0]);

  return (
    <div className="space-y-5">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Viettel Post đang giữ"
        value={<Money value={w.codReceivable} />}
        note={`${formatNumber(w.codReceivableCount)} đơn đã giao chưa thấy chứng từ tiền`}
        icon={Banknote}
        tone={w.codReceivable > 0 ? "amber" : "slate"}
      />
      <MetricCard
        label="Trong đó quá hạn"
        value={<Money value={w.codOverdue} />}
        hint="Đã quá kỳ đối soát thông thường — nhiều khả năng phải đi đòi"
        icon={AlertTriangle}
        tone={w.codOverdue > 0 ? "rose" : "slate"}
      />
      <MetricCard label="Vốn nằm trong hàng tồn" value={<Money value={w.inventoryValue} />} hint="Theo giá nhập; mẫu chưa có giá nhập không tính vào" icon={Boxes} tone="slate" />
      <MetricCard
        label="Kỳ căng nhất"
        value={<Money value={worst.net} />}
        note={worst.label}
        hint="Dòng tiền ròng thấp nhất trong ba kỳ"
        icon={TrendingDown}
        tone={worst.net < 0 ? "rose" : "green"}
      />
    </section>

    <SectionCard
      title="Dự phóng dòng tiền"
      description={<DataWarnings items={r.limitations} label={`${r.limitations.length} điều ERP không biết`} />}
      hint={`Tiền vào trừ tiền ra, theo nhịp chi thực tế. Tiền vào = COD của đơn ĐÃ GIAO chưa thấy chứng từ, rải đều tới kỳ đối soát ${r.basis.codSettlementDays} ngày. Tiền ra = nhịp chi quảng cáo 14 ngày gần nhất (${r.basis.adsPerDay.toLocaleString("vi-VN")}đ/ngày) + nhịp chi vận hành 60 ngày gần nhất (${r.basis.opexPerDay.toLocaleString("vi-VN")}đ/ngày) + tiền hàng phải trả xưởng. CỐ Ý không dự phóng tiền từ đơn chưa giao.`}
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Kỳ</TableHead>
              <TableHead className="text-right">COD dự kiến về</TableHead>
              <TableHead className="text-right">Chi quảng cáo</TableHead>
              <TableHead className="text-right">Chi vận hành</TableHead>
              <TableHead className="text-right">Tiền hàng xưởng</TableHead>
              <TableHead className="text-right">Dòng tiền ròng</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.buckets.map((b) => (
              <TableRow key={b.days}>
                <TableCell className="font-medium">{b.label}</TableCell>
                <TableCell className="text-right"><Money value={b.codExpected} /></TableCell>
                <TableCell className="text-right"><Money value={-b.adsPlanned} /></TableCell>
                <TableCell className="text-right"><Money value={-b.opexPlanned} /></TableCell>
                <TableCell className="text-right">{b.productionDue ? <Money value={-b.productionDue} /> : "—"}</TableCell>
                <TableCell className={cn("text-right font-semibold", b.net < 0 && "text-rose-600 dark:text-rose-400")}>
                  <Money value={b.net} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>

    <SectionCard title="Vốn lưu động" hint="Tiền đang nằm ở đâu ngoài tài khoản" padded={false}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Khoản</TableHead>
              <TableHead className="text-right">Giá trị</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-1">
                  COD chờ về
                  <InfoHint>Hàng đã tới tay khách, tiền còn ở Viettel Post</InfoHint>
                </span>
              </TableCell>
              <TableCell className="text-right"><Money value={w.codReceivable} /></TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-1">
                  Vốn trong hàng tồn
                  <InfoHint>Đã trả tiền xưởng, chưa bán được</InfoHint>
                </span>
              </TableCell>
              <TableCell className="text-right"><Money value={w.inventoryValue} /></TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-1">
                  Đã cam kết với xưởng
                  <InfoHint>Đơn sản xuất đã gửi, chưa nhận hàng — sẽ phải trả</InfoHint>
                </span>
              </TableCell>
              <TableCell className="text-right"><Money value={w.productionCommitted} /></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </SectionCard>
    </div>
  );
}
