import { Boxes, PackageCheck, TrendingUp, Undo2 } from "lucide-react";
import Link from "next/link";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { VERDICT_LABEL, VERDICT_RULES, VERDICT_TONE, classifyProduct, type ProductVerdict } from "@/lib/constants/product-verdict";
import { formatNumber, formatPercent } from "@/lib/format";
import { adSpendByProduct, getProductIntelligence } from "@/lib/queries/product-intelligence";
import { ORDER_SOURCE_LABEL, type OrderSourceKey } from "@/lib/queries/order-source";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Hiệu quả mẫu mã" };

const CHANNELS: OrderSourceKey[] = ["FACEBOOK", "LANDING", "OTHER"];

export default async function ProductPerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("reports:returns");
  const raw = await searchParams;
  const params = parseListParams(raw, {
    defaultSort: "deliveredRevenue",
    sortable: [],
    defaultPeriod: "30d",
    filterKeys: ["channel", "color", "size", "verdict"],
  });
  const channel = params.filters.channel?.[0] as OrderSourceKey | undefined;
  const color = params.filters.color?.[0];
  const size = params.filters.size?.[0];
  const verdictFilter = params.filters.verdict?.[0] as ProductVerdict | undefined;

  const [rows, adSpend] = await Promise.all([
    getProductIntelligence({ period: params.period, q: params.q, channel, color, size, limit: 300 }),
    adSpendByProduct(params.period),
  ]);

  const judged = rows.map((row) => ({
    row,
    verdict: classifyProduct({
      deliveredQty: row.deliveredQty,
      successRate: row.successRate,
      returnRate: row.returnRate,
      deliveredRevenue: row.deliveredRevenue,
      contribution: row.contribution,
      adSpend: row.productId ? (adSpend.get(row.productId) ?? null) : null,
      daysOfCover: row.daysOfCover,
      available: row.available,
    }),
  }));

  const visible = verdictFilter ? judged.filter((j) => j.verdict.verdict === verdictFilter) : judged;
  const count = (v: ProductVerdict) => judged.filter((j) => j.verdict.verdict === v).length;
  const colors = [...new Set(rows.map((r) => r.color).filter(Boolean))].sort();
  const sizes = [...new Set(rows.map((r) => r.size).filter(Boolean))].sort();
  const deliveredRevenue = rows.reduce((t, r) => t + r.deliveredRevenue, 0);
  const lostRevenue = rows.reduce((t, r) => t + r.lostRevenue, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản phẩm"
        title="Hiệu quả mẫu mã × màu × size"
        description="Mẫu nào đáng nhân bản, mẫu nào đang lỗ — xét trên sáu chiều, không chỉ số bán."
        hint="'Bán chạy' theo số LÊN ĐƠN là con số đánh lừa: một mẫu bán 100 cái mà hoàn 60 kém hơn hẳn mẫu bán 50 hoàn 5. Nhãn 'Đáng nhân bản' đòi ĐỦ CẢ SÁU chiều — sản lượng, tỷ lệ giao thành công, doanh thu, biên lợi nhuận góp, chi quảng cáo và sức khoẻ tồn kho. Thiếu dữ liệu chiều nào thì KHÔNG phán, vì gắn nhãn bán chạy dựa trên vài chiều rồi để đặt sản xuất hàng nghìn cái là thiệt hại lớn nhất một báo cáo có thể gây ra."
      />

      <DataTableToolbar
        searchPlaceholder="Tìm mã hàng / mẫu mã…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "channel", label: "Kênh", options: CHANNELS.map((c) => ({ value: c, label: ORDER_SOURCE_LABEL[c] })) },
          { key: "verdict", label: "Phân loại", options: (Object.keys(VERDICT_LABEL) as ProductVerdict[]).map((v) => ({ value: v, label: `${VERDICT_LABEL[v]} (${count(v)})` })) },
          ...(colors.length > 1 ? [{ key: "color", label: "Màu", options: colors.map((c) => ({ value: c, label: c })) }] : []),
          ...(sizes.length > 1 ? [{ key: "size", label: "Size", options: sizes.map((s) => ({ value: s, label: s })) }] : []),
        ]}
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Đáng nhân bản" value={formatNumber(count("WINNER"))} note="Đạt đủ cả sáu chiều" icon={TrendingUp} tone={count("WINNER") ? "green" : "slate"} />
        <MetricCard label="Đang lỗ · nên dừng" value={formatNumber(count("LOSER"))} note="Lợi nhuận góp âm" icon={Undo2} tone={count("LOSER") ? "rose" : "slate"} />
        <MetricCard label="Đáng lo" value={formatNumber(count("RISK"))} note="Hoàn cao · giao kém · tồn nằm chết" icon={Boxes} tone={count("RISK") ? "amber" : "slate"} />
        <MetricCard
          label="Chưa đủ căn cứ"
          value={formatNumber(count("INSUFFICIENT_DATA"))}
          note="Thiếu giá vốn / chi quảng cáo / phiếu nhập"
          icon={PackageCheck}
          tone="slate"
        />
      </section>

      <SectionCard
        title={`${formatNumber(visible.length)} mẫu mã`}
        description={`${params.period.label} · doanh thu giao thành công ${Math.round(deliveredRevenue).toLocaleString("vi-VN")}đ · mất vì hoàn ${Math.round(lostRevenue).toLocaleString("vi-VN")}đ`}
        hint={`Ngưỡng phân loại: sản lượng ≥ ${VERDICT_RULES.minDeliveredQty} món · giao thành công ≥ ${VERDICT_RULES.minSuccessRate}% · doanh thu ≥ ${VERDICT_RULES.minDeliveredRevenue.toLocaleString("vi-VN")}đ · biên lợi nhuận góp ≥ ${VERDICT_RULES.minContributionMarginPct}% · chi quảng cáo ≤ ${VERDICT_RULES.maxAdsCostPct}% doanh thu · tồn đủ bán ${VERDICT_RULES.healthyCoverMinDays}–${VERDICT_RULES.healthyCoverMaxDays} ngày. Rê chuột lên nhãn để xem từng chiều.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1100px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mẫu mã</TableHead>
                <TableHead>Màu / Size</TableHead>
                <TableHead className="text-right">Giao TC</TableHead>
                <TableHead className="text-right">GTC</TableHead>
                <TableHead className="text-right">Hoàn</TableHead>
                <TableHead className="text-right">Doanh thu giao TC</TableHead>
                <TableHead className="text-right">Lợi nhuận góp</TableHead>
                <TableHead className="text-right">Khả dụng</TableHead>
                <TableHead className="text-right">Đủ bán</TableHead>
                <TableHead>Phân loại</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                    {judged.length ? "Không có mẫu mã nào khớp bộ lọc đang chọn." : "Chưa có đơn nào trong kỳ."}
                  </TableCell>
                </TableRow>
              ) : (
                visible.map(({ row, verdict }) => (
                  <TableRow key={row.variantId ?? row.sku}>
                    <TableCell className="max-w-[240px] truncate font-medium" title={row.productName}>
                      {row.productId ? (
                        <Link href={`/products/${row.productId}`} className="hover:text-primary hover:underline">
                          {row.productName || row.sku}
                        </Link>
                      ) : (
                        row.productName || row.sku
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {[row.color, row.size].filter(Boolean).join(" · ") || "—"}
                    </TableCell>
                    <TableCell className="numeric text-right">{formatNumber(row.deliveredQty)}</TableCell>
                    <TableCell className="numeric text-right">{row.successRate === null ? "—" : formatPercent(row.successRate)}</TableCell>
                    <TableCell className="numeric text-right">{row.returnRate === null ? "—" : formatPercent(row.returnRate)}</TableCell>
                    <TableCell className="text-right"><Money value={row.deliveredRevenue} /></TableCell>
                    <TableCell className="text-right">
                      {row.contribution === null ? <span title={row.contributionBlockedBy ?? "Chưa tra được giá vốn"}>—</span> : <Money value={row.contribution} />}
                    </TableCell>
                    <TableCell className="numeric text-right">{row.available === null ? <span title="Chưa có phiếu nhập nào">—</span> : formatNumber(row.available)}</TableCell>
                    <TableCell className="numeric text-right">{row.daysOfCover === null ? "—" : `${row.daysOfCover} ngày`}</TableCell>
                    <TableCell>
                      <span
                        className={cn("inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", VERDICT_TONE[verdict.verdict])}
                        title={`${verdict.reason}\n\n${verdict.checks.map((c) => `${c.passed === null ? "?" : c.passed ? "✓" : "✗"} ${c.label}: ${c.detail}`).join("\n")}`}
                      >
                        {VERDICT_LABEL[verdict.verdict]}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="border-t px-5 py-2 text-xs text-muted-foreground">
          Chỉ cột phân loại được tô màu. Mọi cột số để trung tính có chủ ý: tô màu khắp bảng thì không còn chỗ nào nổi bật,
          và mắt sẽ đọc màu thay vì đọc số.
        </p>
      </SectionCard>
    </div>
  );
}
