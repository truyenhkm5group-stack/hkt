import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, Banknote, BellRing, Boxes, CircleDollarSign, Megaphone, PackageCheck, ShoppingBag, TrendingUp, Truck } from "lucide-react";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { TopActions } from "@/app/(dashboard)/top-actions";
import { BusinessBriefSection } from "@/app/(dashboard)/business-brief";
import { DataFreshnessStrip } from "@/app/(dashboard)/data-freshness";
import { PageHeader } from "@/components/page-header";
import { SourceBadge } from "@/components/status-badge";
import { SyncButton } from "@/components/sync-button";
import { SectionCard } from "@/components/ui-bits";
import { Skeleton } from "@/components/ui/skeleton";
import { ORDER_STAGE_LABEL, ORDER_STAGE_ORDER } from "@/lib/constants/pancake";
import { integrationStatus } from "@/lib/env";
import { formatNumber, formatVND, pct } from "@/lib/format";
import { getDashboardData } from "@/lib/queries/dashboard";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Tổng quan" };

function change(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("dashboard:view");
  const params = await searchParams;
  const period = resolvePeriod(params, "30d");
  const data = await getDashboardData(period);
  const status = integrationStatus();
  // GTC dùng CHUNG định nghĩa với báo cáo Tỷ lệ giao thành công (giao TC ÷ đơn đã kết thúc).
  // Trước đây chia cho TỔNG đơn nên Tổng quan luôn báo tỷ lệ thấp hơn báo cáo cho cùng một kỳ.
  const successRate = data.kpi.successRate;
  const margin = data.finance.netRevenue ? (data.finance.estimatedProfit / data.finance.netRevenue) * 100 : 0;
  const maxStage = Math.max(1, ...ORDER_STAGE_ORDER.map((s) => data.byStage[s]?.count ?? 0));
  const maxChannel = Math.max(1, ...data.channels.map((c) => c.revenue));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Trung tâm điều hành"
        title="Tổng quan kinh doanh"
        description={`Đơn hàng, dòng tiền và vận hành · ${period.label.toLowerCase()} · ${formatNumber(data.orderTotal)} đơn trong hệ thống`}
        actions={
          <>
            <PeriodFilter defaultKey="30d" />
            <SyncButton job="pancake-orders" label="Đồng bộ ngay" variant="default" />
          </>
        }
      />

      {!status.pancake ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">Chưa kết nối Pancake POS</p>
            <p className="text-muted-foreground">Thêm PANCAKE_API_KEY và PANCAKE_SHOP_ID vào file .env rồi khởi động lại. Xem hướng dẫn tại trang Kết nối dữ liệu.</p>
          </div>
        </div>
      ) : data.orderTotal === 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Chưa có đơn hàng nào trong ERP</p>
            <p className="text-muted-foreground">Chạy đồng bộ lịch sử lần đầu để kéo toàn bộ đơn từ Pancake POS (có thể mất vài phút tuỳ số lượng đơn).</p>
          </div>
          <SyncButton job="pancake-all" label="Đồng bộ toàn bộ Pancake" variant="default" params={{ backfill: "1" }} />
        </div>
      ) : null}

      {/*
        BUỒNG LÁI RA QUYẾT ĐỊNH.
        Ba con số tiền được tách rõ bằng chính NHÃN, vì trước đây cả ba đều được gọi là "doanh thu":
        LÊN ĐƠN (khách chốt) → GIAO THÀNH CÔNG (tới tay khách) → THỰC NHẬN (đã vào tài khoản).
        Mỗi thẻ bấm được và mở đúng TẬP ĐƠN đã sinh ra con số đó.
      */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Link href={`/orders?period=${period.key}`} className="block">
          <MetricCard
            label="① Doanh thu LÊN ĐƠN"
            value={formatVND(data.money.booked, { compact: true })}
            change={change(data.kpi.revenue, data.previous?.revenue)}
            note={`${formatNumber(data.kpi.orders)} đơn đã xác nhận · TB ${formatVND(data.kpi.aov, { compact: true })}/đơn`}
            hint="Tiền khách chốt lúc lên đơn — chưa nói gì về việc giao được hay thu được tiền. Bấm thẻ để mở đúng tập đơn."
            icon={ShoppingBag}
            tone="blue"
          />
        </Link>
        <Link href={`/reports/returns?period=${period.key}`} className="block">
          <MetricCard
            label="② Doanh thu GIAO THÀNH CÔNG"
            value={formatVND(data.money.delivered, { compact: true })}
            change={change(data.kpi.successRevenue, data.previous?.successRevenue)}
            note={`${formatNumber(data.kpi.successOrders)} đơn tới tay khách · GTC ${successRate === null ? "—" : `${successRate.toFixed(1)}%`}${data.kpi.unknownOrders ? ` · ${formatNumber(data.kpi.unknownOrders)} chưa có chứng từ` : ""}`}
            hint="Kết luận theo chứng từ Viettel Post, rồi tới tiền COD thực thu; không suy từ trạng thái Pancake. GTC tính trên đơn đã kết thúc. Đơn chưa có chứng từ là CHƯA BIẾT, không tính vào mẫu số."
            icon={PackageCheck}
            tone="green"
          />
        </Link>
        <Link href={`/reports?tab=truth&period=${period.key}`} className="block">
          <MetricCard
            label="③ TIỀN THỰC NHẬN"
            value={formatVND(data.money.cashReceived, { compact: true })}
            note="Bảng kê Viettel Post + khách chuyển trước"
            hint="Tiền đã vào tài khoản có chứng từ. KHÁC hẳn hai con số bên trái: chênh lệch là tiền Viettel Post còn giữ và đơn chưa kết thúc."
            icon={Banknote}
            tone="green"
          />
        </Link>
        <Link href={`/cod?cod=COLLECTED,RECONCILED&period=${period.key}`} className="block">
          <MetricCard
            label="Viettel Post còn giữ"
            value={formatVND(data.money.codOutstanding, { compact: true })}
            note={`${formatNumber(data.money.codOutstandingCount)} đơn giao thành công chưa có trên bảng kê`}
            hint="Đơn giao thành công mà chưa dòng bảng kê nào nhắc tới — tiền cần đòi Viettel Post. Bấm thẻ để mở danh sách."
            icon={Truck}
            tone="amber"
          />
        </Link>
        <Link href={`/reports?tab=truth&period=${period.key}`} className="block">
          <MetricCard
            label="Lợi nhuận góp"
            value={formatVND(data.money.contribution, { compact: true })}
            note="Trước chi phí vận hành"
            hint="Doanh thu giao thành công − giá vốn − cước − phí hoàn − quảng cáo. Chưa trừ chi phí vận hành cố định."
            icon={CircleDollarSign}
            tone={data.money.contribution >= 0 ? "primary" : "rose"}
          />
        </Link>
        <Link href={`/reports?tab=truth&period=${period.key}`} className="block">
          <MetricCard
            label="Lợi nhuận ước tính"
            value={formatVND(data.finance.estimatedProfit, { compact: true })}
            note={`Biên ${margin.toFixed(1)}% trên doanh thu giao thành công`}
            hint="Ước tính THEO ĐƠN trong kỳ, đã trừ chi phí vận hành phân bổ theo kỳ. KHÔNG phải tiền trong tài khoản — phần lớn còn nằm ở Viettel Post."
            icon={TrendingUp}
            tone={data.finance.estimatedProfit >= 0 ? "primary" : "rose"}
          />
        </Link>
        <Link href="/alerts" className="block">
          <MetricCard
            label="Việc cần xử lý"
            value={formatNumber(data.attention.newOrders + data.attention.failedDelivery + data.attention.staleShipments)}
            note={`${formatNumber(data.attention.newOrders)} đơn mới · ${formatNumber(data.attention.failedDelivery)} giao thất bại / đang hoàn · ${formatNumber(data.attention.staleShipments)} treo lâu`}
            icon={BellRing}
            tone="amber"
          />
        </Link>
        {/* HAI TỶ LỆ QUẢNG CÁO — mẫu số khác nhau có chủ đích, không thay thế cho nhau:
            một bên là số khách chốt, một bên là số hàng thật sự tới tay khách. */}
        <Link href={`/ads?period=${period.key}`} className="block">
          <MetricCard
            label="QC / Doanh số POS"
            value={data.money.adsOverBooked === null ? "—" : `${data.money.adsOverBooked.toFixed(1)}%`}
            note={`${formatVND(data.finance.adSpend, { compact: true })} chi quảng cáo / doanh thu lên đơn`}
            hint="Mẫu số là doanh thu LÊN ĐƠN, chưa trừ đơn hoàn — đây là tỷ lệ lạc quan nhất, dùng để so với ngưỡng chốt đơn của marketer."
            icon={Megaphone}
            tone="slate"
          />
        </Link>
        <Link href={`/ads?period=${period.key}`} className="block">
          <MetricCard
            label="QC / DT giao thành công"
            value={data.money.adsOverDelivered === null ? "—" : `${data.money.adsOverDelivered.toFixed(1)}%`}
            note="Chi quảng cáo / doanh thu đã tới tay khách"
            hint="Kỳ đang chạy luôn cao bất thường: tiền quảng cáo tiêu ngay, còn hàng 1–2 tuần sau mới giao xong. Đọc tỷ lệ này cho kỳ đã khép."
            icon={Megaphone}
            tone={data.money.adsOverDelivered !== null && data.money.adsOverDelivered > 40 ? "rose" : "slate"}
          />
        </Link>
        <Link href="/data-quality" className="block">
          <MetricCard
            label="Dữ liệu sai nghiêm trọng"
            value={formatNumber(data.dataIssues.critical)}
            note={
              data.dataIssues.critical
                ? `${formatNumber(data.dataIssues.firing)}/${formatNumber(data.dataIssues.ruleCount)} luật đối soát đang có vi phạm`
                : `${formatNumber(data.dataIssues.ruleCount)} luật đối soát đều sạch`
            }
            hint="Vi phạm nghiêm trọng nghĩa là số liệu trên trang này có thể chưa đúng. Bấm thẻ để xem luật nào và sửa ở đâu."
            icon={AlertTriangle}
            tone={data.dataIssues.critical ? "rose" : "slate"}
          />
        </Link>
      </section>

      {/*
        HAI KHỐI DƯỚI ĐÂY CHẢY VỀ SAU, KHÔNG CHẶN CÁC THẺ TIỀN Ở TRÊN.
        "Tóm tắt & rủi ro" và "Việc cần làm hôm nay" kéo theo hàng đợi việc và kế hoạch tồn kho —
        nặng hơn hẳn phần còn lại của trang và KHÔNG phải thứ chủ shop nhìn đầu tiên. Bọc trong
        Suspense thì ba con số tiền hiện ngay, hai khối này điền vào sau cùng khung xương của chính
        chúng. Trước đây cả trang phải đợi khối chậm nhất.
      */}
      {/* Độ tươi đứng TRƯỚC mọi con số: biết số cũ hay mới là điều kiện để đọc số. */}
      <Suspense fallback={<Skeleton className="h-9 rounded-xl" />}>
        <DataFreshnessStrip />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-32 rounded-xl" />}>
        <BusinessBriefSection period={period} />
      </Suspense>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
        <SectionCard title="Doanh thu theo ngày" description="Doanh thu lên đơn so với doanh thu đơn đã giao thành công" actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{period.label}</span>}>
          <RevenueChart data={data.daily} />
        </SectionCard>
        <SectionCard
          title="Việc cần làm hôm nay"
          description="Xếp theo cùng công thức ưu tiên của toàn ERP"
          hint="Trước đây ô này liệt kê các NHÓM việc kèm số đếm; đọc xong vẫn phải mở từng trang để biết bắt đầu từ đâu. Nay hiện đúng những việc cụ thể đứng đầu hàng đợi, kèm vì sao gấp, bao nhiêu tiền đang treo, ai đang cầm và đã trễ hạn chưa."
          actions={<Link href="/alerts" className="text-xs font-semibold text-primary hover:underline">Hàng đợi việc</Link>}
          padded={false}
        >
          <Suspense fallback={<div className="space-y-2 p-5">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>}>
            <TopActions />
          </Suspense>
          {/* Số đếm theo nhóm giữ lại ở dạng gọn: nó trả lời "tình hình chung thế nào", còn danh
              sách trên trả lời "bắt đầu từ đâu". Hai câu hỏi khác nhau. */}
          <div className="border-t px-5 py-2.5 text-[11px] text-muted-foreground">
            {formatNumber(data.attention.newOrders)} đơn mới · {formatNumber(data.attention.failedDelivery)} giao thất bại/đang hoàn ·{" "}
            {formatNumber(data.attention.staleShipments)} treo lâu · {formatVND(data.attention.codWaiting.amount, { compact: true })} COD chờ về ·{" "}
            {data.attention.lowStock === null ? "đang tính" : formatNumber(data.attention.lowStock)} mẫu mã cần sản xuất gấp
          </div>
        </SectionCard>
      </section>

      {/*
        BA KHỐI, KHÔNG PHẢI NĂM. Trước đây trang còn "Vận đơn & COD" (bản chép của tháp Giao vận và
        của trang Đối soát COD) và "Đơn hàng mới nhất" (bản chép 8 cột của trang Đơn hàng). Cùng số
        ở hai nơi là hai chỗ để lệch, và ba truy vấn nữa mỗi lần mở trang chủ. Mỗi khối chỉ còn ở
        NHÀ của nó: vận đơn ở /shipments, COD ở /cod, đơn mới ở /orders.
      */}
      <section className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        <SectionCard title="Luồng đơn hàng" description="Số đơn theo giai đoạn trong kỳ (theo trạng thái Pancake)">
          <div className="space-y-2.5">
            {ORDER_STAGE_ORDER.filter((s) => s !== "DELETED" || (data.byStage[s]?.count ?? 0) > 0).map((stage) => {
              const row = data.byStage[stage] ?? { count: 0, revenue: 0 };
              return (
                <Link key={stage} href={`/orders?stage=${stage}&period=${period.key}${period.key === "custom" ? `&from=${period.fromKey}&to=${period.toKey}` : ""}`} className="group flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate text-xs font-medium text-muted-foreground group-hover:text-foreground">{ORDER_STAGE_LABEL[stage]}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/80 transition-all" style={{ width: `${Math.max(row.count ? 2 : 0, (row.count / maxStage) * 100)}%` }} />
                  </div>
                  <span className="numeric w-12 shrink-0 text-right text-xs font-semibold">{formatNumber(row.count)}</span>
                  <span className="numeric hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:block">{formatVND(row.revenue, { compact: true })}</span>
                </Link>
              );
            })}
          </div>
        </SectionCard>
        <SectionCard title="Hiệu quả theo kênh bán" description="Doanh thu lên đơn theo nguồn (không tính đơn huỷ)">
          {data.channels.length ? (
            <div className="space-y-4">
              {data.channels.slice(0, 6).map((channel, index) => (
                <div key={channel.source}>
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                    <SourceBadge source={channel.source} />
                    <span className="numeric font-bold">{formatVND(channel.revenue)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full rounded-full ${["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"][index % 5]}`} style={{ width: `${Math.max(3, (channel.revenue / maxChannel) * 100)}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                    <span>{formatNumber(channel.orders)} đơn</span>
                    <span>
                      {formatNumber(channel.success)} giao thành công · {pct(channel.success, channel.orders).toFixed(0)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Chưa có dữ liệu.</p>
          )}
        </SectionCard>
        <SectionCard title="Sản phẩm bán chạy" description="Theo số lượng bán trong kỳ" actions={<Link href="/products" className="text-xs font-semibold text-primary hover:underline">Xem kho</Link>}>
          {data.topProducts.length ? (
            <ul className="divide-y">
              {data.topProducts.map((p, i) => (
                <li key={`${p.variantId ?? p.sku}-${i}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-bold text-muted-foreground">{i + 1}</span>
                  {p.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
                  ) : (
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Boxes className="size-4" /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{p.productName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.sku || "—"}
                      {p.successRate === null ? " · chưa có đơn kết thúc" : ` · GTC ${p.successRate}%`}
                      {p.daysOfCover === null ? "" : ` · còn ${p.daysOfCover} ngày hàng`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="numeric text-sm font-bold">{formatNumber(p.deliveredQty)} sp giao TC</p>
                    <p className="numeric text-xs text-muted-foreground">{formatVND(p.deliveredRevenue, { compact: true })}</p>
                    {p.returnedQty ? <p className="numeric text-[11px] text-destructive">{formatNumber(p.returnedQty)} sp hoàn</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Chưa có dữ liệu bán hàng trong kỳ.</p>
          )}
        </SectionCard>
      </section>

    </div>
  );
}
