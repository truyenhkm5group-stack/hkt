import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, Banknote, BellRing, Boxes, CircleDollarSign, Megaphone, PackageCheck, ShoppingBag, TrendingUp, Truck } from "lucide-react";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { FULFILLMENT_BUCKET_HINT, FULFILLMENT_BUCKET_LABEL, FULFILLMENT_BUCKET_ORDER } from "@/lib/constants/fulfillment-bucket";
import { tongRoDayDu } from "@/lib/queries/fulfillment-buckets";
import { StatStrip } from "@/components/stat-tile";
import { TopActions } from "@/app/(dashboard)/top-actions";
import { BusinessBriefSection } from "@/app/(dashboard)/business-brief";
import { DataFreshnessStrip } from "@/app/(dashboard)/data-freshness";
import { PageHeader } from "@/components/page-header";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
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
  const maxFulfillment = Math.max(1, ...FULFILLMENT_BUCKET_ORDER.map((b) => data.fulfillment.counts[b]));
  const buckedCheck = tongRoDayDu(data.fulfillment);
  const maxChannel = Math.max(1, ...data.channels.map((c) => c.revenue));

  return (
    <div className="space-y-5">
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
        <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          <p className="font-semibold">Chưa kết nối Pancake POS</p>
          <InfoHint>Thêm PANCAKE_API_KEY và PANCAKE_SHOP_ID vào file .env rồi khởi động lại. Xem hướng dẫn tại trang Kết nối dữ liệu.</InfoHint>
        </div>
      ) : data.orderTotal === 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5">
            <p className="font-semibold">Chưa có đơn hàng nào trong ERP</p>
            <InfoHint>Chạy đồng bộ lịch sử lần đầu để kéo toàn bộ đơn từ Pancake POS (có thể mất vài phút tuỳ số lượng đơn).</InfoHint>
          </div>
          <SyncButton job="pancake-all" label="Đồng bộ toàn bộ Pancake" variant="default" params={{ backfill: "1" }} />
        </div>
      ) : null}

      {/*
        BUỒNG LÁI RA QUYẾT ĐỊNH — BA BẬC, KHÔNG PHẢI MƯỜI THẺ BẰNG NHAU.

        Ba con số tiền được tách rõ bằng chính NHÃN, vì trước đây cả ba đều được gọi là "doanh thu":
        LÊN ĐƠN (khách chốt) → GIAO THÀNH CÔNG (tới tay khách) → THỰC NHẬN (đã vào tài khoản).
        Mỗi thẻ bấm được và mở đúng TẬP ĐƠN đã sinh ra con số đó.

        Trước đây cả mười chỉ số nằm trên cùng một lưới, cùng một cỡ chữ: mắt không biết đọc từ đâu
        và "dữ liệu sai nghiêm trọng" to ngang "doanh thu". Nay KÍCH THƯỚC nói ra thứ tự quan trọng:
          bậc 1 — dây chuyền tiền, ba con số dẫn dắt cả trang;
          bậc 2 — lợi nhuận và tiền/việc đang treo, thứ cần quyết hôm nay;
          bậc 3 — tỷ lệ theo dõi định kỳ, gom vào một dải mảnh.
        Cùng chừng ấy thông tin, không bỏ con số nào.

        GIAO DIỆN BENTO (24/09/2026): ô ② mang nền MỰC — đó là con số chủ shop hỏi đầu tiên mỗi sáng
        ("hàng tới tay khách được bao nhiêu"), nên nó là ô duy nhất được nhấn trên trang.
      */}
      <section className="grid gap-4 lg:grid-cols-3">
        <MetricCard
          size="lg"
          href={`/orders?period=${period.key}`}
          label="① Doanh thu LÊN ĐƠN"
          value={formatVND(data.money.booked, { compact: true })}
          change={change(data.kpi.revenue, data.previous?.revenue)}
          note={`${formatNumber(data.kpi.orders)} đơn đã xác nhận · TB ${formatVND(data.kpi.aov, { compact: true })}/đơn`}
          hint="Tiền khách chốt lúc lên đơn — chưa nói gì về việc giao được hay thu được tiền. Bấm thẻ để mở đúng tập đơn."
          icon={ShoppingBag}
          tone="blue"
        />
        <MetricCard
          size="lg"
          href={`/reports/returns?period=${period.key}`}
          label="② Doanh thu GIAO THÀNH CÔNG"
          emphasis
          value={formatVND(data.money.delivered, { compact: true })}
          change={change(data.kpi.successRevenue, data.previous?.successRevenue)}
          note={`${formatNumber(data.kpi.successOrders)} đơn tới tay khách · GTC ${successRate === null ? "—" : `${successRate.toFixed(1)}%`}${data.kpi.unknownOrders ? ` · ${formatNumber(data.kpi.unknownOrders)} chưa có chứng từ` : ""}`}
          hint="Kết luận theo chứng từ Viettel Post, rồi tới tiền COD thực thu; không suy từ trạng thái Pancake. GTC tính trên đơn đã kết thúc. Đơn chưa có chứng từ là CHƯA BIẾT, không tính vào mẫu số."
          icon={PackageCheck}
          tone="green"
        />
        <MetricCard
          size="lg"
          href={`/reports?tab=truth&period=${period.key}`}
          label="③ TIỀN THỰC NHẬN"
          value={formatVND(data.money.cashReceived, { compact: true })}
          hint="Bảng kê Viettel Post + khách chuyển trước. Tiền đã vào tài khoản có chứng từ. KHÁC hẳn hai con số bên trái: chênh lệch là tiền Viettel Post còn giữ và đơn chưa kết thúc."
          icon={Banknote}
          tone="green"
        />
      </section>

      {/*
        Ô BENTO LỚN: biểu đồ doanh thu chiếm nửa trái, bốn thẻ bậc 2 xếp 2×2 bên phải. Biểu đồ trả lời
        "xu hướng thế nào", bốn thẻ trả lời "cần quyết gì hôm nay" — đứng cạnh nhau để đọc một lượt.
      */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Doanh thu theo ngày" hint="Doanh thu lên đơn so với doanh thu đơn đã giao thành công" actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{period.label}</span>} className="sm:col-span-2 xl:row-span-2">
          <RevenueChart data={data.daily} className="h-[300px]" />
        </SectionCard>
        <MetricCard
          href={`/reports?tab=truth&period=${period.key}`}
          label="Lợi nhuận ước tính"
          value={formatVND(data.finance.estimatedProfit, { compact: true })}
          note={`Biên ${margin.toFixed(1)}% trên doanh thu giao thành công`}
          hint="Ước tính THEO ĐƠN trong kỳ, đã trừ chi phí vận hành phân bổ theo kỳ. KHÔNG phải tiền trong tài khoản — phần lớn còn nằm ở Viettel Post."
          icon={TrendingUp}
          tone={data.finance.estimatedProfit >= 0 ? "primary" : "rose"}
        />
        <MetricCard
          href={`/reports?tab=truth&period=${period.key}`}
          label="Lợi nhuận góp"
          value={formatVND(data.money.contribution, { compact: true })}
          note="Trước chi phí vận hành"
          hint="Doanh thu giao thành công − giá vốn − cước − phí hoàn − quảng cáo. Chưa trừ chi phí vận hành cố định."
          icon={CircleDollarSign}
          tone={data.money.contribution >= 0 ? "primary" : "rose"}
        />
        <MetricCard
          href={`/cod?cod=COLLECTED,RECONCILED&period=${period.key}`}
          label="Viettel Post còn giữ"
          value={formatVND(data.money.codOutstanding, { compact: true })}
          note={`${formatNumber(data.money.codOutstandingCount)} đơn giao thành công chưa có trên bảng kê`}
          hint="Đơn giao thành công mà chưa dòng bảng kê nào nhắc tới — tiền cần đòi Viettel Post. Bấm thẻ để mở danh sách."
          icon={Truck}
          tone="amber"
        />
        <MetricCard
          href="/alerts"
          label="Việc cần xử lý"
          value={formatNumber(data.attention.newOrders + data.attention.failedDelivery + data.attention.staleShipments)}
          note={`${formatNumber(data.attention.newOrders)} đơn mới · ${formatNumber(data.attention.failedDelivery)} giao thất bại / đang hoàn · ${formatNumber(data.attention.staleShipments)} treo lâu`}
          icon={BellRing}
          tone="amber"
        />
      </section>

      {/* HAI TỶ LỆ QUẢNG CÁO — mẫu số khác nhau có chủ đích, không thay thế cho nhau:
          một bên là số khách chốt, một bên là số hàng thật sự tới tay khách. */}
      <StatStrip
        columns={3}
        items={[
          {
            label: "QC / Doanh số POS",
            value: data.money.adsOverBooked === null ? "—" : `${data.money.adsOverBooked.toFixed(1)}%`,
            note: `${formatVND(data.finance.adSpend, { compact: true })} chi quảng cáo / doanh thu lên đơn`,
            hint: "Mẫu số là doanh thu LÊN ĐƠN, chưa trừ đơn hoàn — đây là tỷ lệ lạc quan nhất, dùng để so với ngưỡng chốt đơn của marketer.",
            icon: Megaphone,
            href: `/ads?period=${period.key}`,
          },
          {
            label: "QC / DT giao thành công",
            value: data.money.adsOverDelivered === null ? "—" : `${data.money.adsOverDelivered.toFixed(1)}%`,
            hint: "Chi quảng cáo / doanh thu đã tới tay khách. Kỳ đang chạy luôn cao bất thường: tiền quảng cáo tiêu ngay, còn hàng 1–2 tuần sau mới giao xong. Đọc tỷ lệ này cho kỳ đã khép.",
            icon: Megaphone,
            tone: data.money.adsOverDelivered !== null && data.money.adsOverDelivered > 40 ? ("rose" as const) : ("default" as const),
            href: `/ads?period=${period.key}`,
          },
          {
            label: "Dữ liệu sai nghiêm trọng",
            value: formatNumber(data.dataIssues.critical),
            note: data.dataIssues.critical
              ? `${formatNumber(data.dataIssues.firing)}/${formatNumber(data.dataIssues.ruleCount)} luật đối soát đang có vi phạm`
              : `${formatNumber(data.dataIssues.ruleCount)} luật đối soát đều sạch`,
            hint: "Vi phạm nghiêm trọng nghĩa là số liệu trên trang này có thể chưa đúng. Bấm ô để xem luật nào và sửa ở đâu.",
            icon: AlertTriangle,
            tone: data.dataIssues.critical ? ("rose" as const) : ("muted" as const),
            href: "/data-quality",
          },
        ]}
      />

      {/*
        HAI KHỐI DƯỚI ĐÂY CHẢY VỀ SAU, KHÔNG CHẶN CÁC THẺ TIỀN Ở TRÊN.
        "Tóm tắt & rủi ro" và "Việc cần làm hôm nay" kéo theo hàng đợi việc và kế hoạch tồn kho —
        nặng hơn hẳn phần còn lại của trang và KHÔNG phải thứ chủ shop nhìn đầu tiên. Bọc trong
        Suspense thì ba con số tiền hiện ngay, hai khối này điền vào sau cùng khung xương của chính
        chúng. Trước đây cả trang phải đợi khối chậm nhất.
      */}
      {/* Độ tươi đứng TRƯỚC mọi con số: biết số cũ hay mới là điều kiện để đọc số. */}
      <Suspense fallback={<Skeleton className="h-9 rounded-2xl" />}>
        <DataFreshnessStrip />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-32 rounded-2xl" />}>
        <BusinessBriefSection period={period} />
      </Suspense>

      {/*
        BỐN KHỐI DƯỚI: lưới 12 cột để mỗi khối rộng đúng bằng nội dung của nó — danh sách việc và
        thanh "hàng đang ở đâu" cần chỗ cho nhãn dài, kênh bán chỉ cần một cột hẹp.
      */}
      <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-12">
        <SectionCard
          className="xl:col-span-7"
          title="Việc cần làm hôm nay"
          hint={
            <>
              <p>Xếp theo cùng công thức ưu tiên của toàn ERP.</p>
              <p className="mt-1.5">Trước đây ô này liệt kê các NHÓM việc kèm số đếm; đọc xong vẫn phải mở từng trang để biết bắt đầu từ đâu. Nay hiện đúng những việc cụ thể đứng đầu hàng đợi, kèm vì sao gấp, bao nhiêu tiền đang treo, ai đang cầm và đã trễ hạn chưa.</p>
            </>
          }
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

        {/*
          BA KHỐI, KHÔNG PHẢI NĂM. Trước đây trang còn "Vận đơn & COD" (bản chép của tháp Giao vận và
          của trang Đối soát COD) và "Đơn hàng mới nhất" (bản chép 8 cột của trang Đơn hàng). Cùng số
          ở hai nơi là hai chỗ để lệch, và ba truy vấn nữa mỗi lần mở trang chủ. Mỗi khối chỉ còn ở
          NHÀ của nó: vận đơn ở /shipments, COD ở /cod, đơn mới ở /orders.
        */}
        {/*
          ═══ HAI KHỐI TRẠNG THÁI, CỐ Ý ĐỨNG CẠNH NHAU ═══

          "Luồng đơn hàng" đếm theo NHÃN PANCAKE — mười ba trạng thái do người bán bấm tay.
          "Hàng đang ở đâu" đếm theo CHỨNG TỪ ĐVVC. Hai khối trả lời hai câu hỏi khác nhau và
          KHÔNG thay thế cho nhau; chênh lệch giữa chúng chính là việc tồn đọng của khâu bàn giao
          (đơn bấm "đã gửi" mà chưa ai lấy, đơn đã tới tay khách mà chưa ai bấm sang "đã nhận").
        */}
        <SectionCard
          className="xl:col-span-5"
          title="Hàng đang ở đâu"
          hint={
            <>
              <p>Theo chứng từ đơn vị vận chuyển — không đọc trạng thái Pancake, không đọc tiền.</p>
              <p className="mt-1.5">
                <b>“Đã gửi”</b> ở đây nghĩa là <b>đơn vị vận chuyển đã cầm được hàng và kiện vẫn đang trên đường tới khách</b>. Nó KHÔNG
                gồm hàng còn trong kho, hàng bưu tá tới mà không lấy được, đơn đã giao tới khách, đơn đang hoàn hay đã hoàn, và đơn đã
                huỷ. Đây là số kiện <b>đang đi ngay lúc này</b>, không phải tổng đã gửi trong kỳ. Căn cứ chỉ là chứng từ của đơn vị vận
                chuyển — trạng thái Pancake, tiền thu hộ và đối soát không tham gia. Bấm một dòng để mở đúng những đơn đã sinh ra con số đó.
              </p>
            </>
          }
          actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{formatNumber(data.fulfillment.total)} đơn</span>}
        >
          <div className="space-y-2.5">
            {FULFILLMENT_BUCKET_ORDER.filter((b) => data.fulfillment.counts[b] > 0).map((bucket) => {
              const so = data.fulfillment.counts[bucket];
              return (
                <Link
                  key={bucket}
                  href={`/orders?fulfillment=${bucket}&period=${period.key}${period.key === "custom" ? `&from=${period.fromKey}&to=${period.toKey}` : ""}`}
                  className="group flex items-center gap-3 text-sm"
                  title={FULFILLMENT_BUCKET_HINT[bucket]}
                >
                  <span className={`w-40 shrink-0 truncate text-xs group-hover:text-foreground ${bucket === "IN_FLIGHT" ? "font-bold text-foreground" : "font-medium text-muted-foreground"}`}>
                    {FULFILLMENT_BUCKET_LABEL[bucket]}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full rounded-full transition-all ${bucket === "IN_FLIGHT" ? "bg-primary" : "bg-primary/40"}`} style={{ width: `${Math.max(so ? 2 : 0, (so / maxFulfillment) * 100)}%` }} />
                  </div>
                  <span className="numeric w-12 shrink-0 text-right text-xs font-semibold">{formatNumber(so)}</span>
                  <span className="numeric hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:block">{formatVND(data.fulfillment.bookedRevenue[bucket], { compact: true })}</span>
                </Link>
              );
            })}
          </div>
          {/*
            TỔNG KIỂM HIỆN RA MÀN HÌNH, KHÔNG GIẤU TRONG LOG.

            Các rổ loại trừ nhau theo cấu trúc nên tổng của chúng phải bằng tổng đơn. Một biểu thức
            `case` thiếu nhánh sẽ trả NULL và con số biến mất mà không lỗi nào phát ra — dòng này là
            chỗ nó lộ ra, trước mặt người đọc chứ không trong một tệp log không ai mở.
          */}
          {!buckedCheck.ok ? (
            <div className="mt-3">
              <DataWarnings
                tone="danger"
                items={[
                  <>
                    {formatNumber(Math.abs(buckedCheck.chenh))} đơn không rổ nào nhận (tổng rổ {formatNumber(buckedCheck.tongRo)} / tổng đơn {formatNumber(data.fulfillment.total)}). Con số bên trên đang thiếu — báo cho người dựng ERP.
                  </>,
                ]}
              />
            </div>
          ) : null}
        </SectionCard>
        <SectionCard
          className="xl:col-span-5"
          title="Luồng đơn hàng"
          hint={
            <>
              <p>Số đơn theo giai đoạn trong kỳ (theo trạng thái Pancake).</p>
              <p className="mt-1.5">Đây là nhãn do NGƯỜI BÁN bấm trên Pancake, không phải kết luận từ chứng từ vận chuyển. “Đã gửi hàng” ở khối này nghĩa là ai đó đã bấm nút — muốn biết gói hàng thật sự đang ở đâu thì đọc khối “Hàng đang ở đâu” bên cạnh.</p>
            </>
          }
        >
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
        <SectionCard className="xl:col-span-3" title="Hiệu quả theo kênh bán" hint="Doanh thu lên đơn theo nguồn (không tính đơn huỷ)">
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
        <SectionCard className="lg:col-span-2 xl:col-span-4" title="Sản phẩm bán chạy" hint="Theo số lượng bán trong kỳ" actions={<Link href="/products" className="text-xs font-semibold text-primary hover:underline">Xem kho</Link>}>
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
