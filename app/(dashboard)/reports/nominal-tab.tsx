import {
  Calculator,
  Megaphone,
  PackageCheck,
  Percent,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import {
  AssumptionsForm,
  ReturnRateOverride,
} from "@/app/(dashboard)/reports/assumptions-form";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { CostQualityPanel } from "@/app/(dashboard)/reports/cost-quality-panel";
import { MetricCard } from "@/components/metric-card";
import { MarketerNominalRows } from "./marketer-nominal-rows";
import { Button } from "@/components/ui/button";
import { Money, SectionCard } from "@/components/ui-bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber, formatVND } from "@/lib/format";
import {
  getNominalDailyForProduct,
  getNominalProfitReport,
  type NominalRow,
} from "@/lib/queries/profit-nominal";
import type { Period } from "@/lib/search-params";
import { DEFAULT_PROFIT_ASSUMPTIONS } from "@/lib/constants/profit";
import { PROJECTED_GTC_VERSION } from "@/lib/constants/projected-delivery";
import { TIME_BASES, TIME_BASIS_LABEL, TIME_BASIS_QUESTION, type TimeBasis } from "@/lib/constants/report-time-basis";
import { successTone } from "@/lib/constants/returns";
import { ProjectionConfidence } from "@/app/(dashboard)/reports/projection-confidence";
import { getNominalMarketerBreakdown } from "@/lib/queries/payroll";
import { cn } from "@/lib/utils";

/*
  ═══════════ CHÚ THÍCH PHẢI KHAI ĐÚNG NGUỒN CỦA CHÍNH CON SỐ NÓ ĐỨNG CẠNH ═══════════

  Chú thích cũ ở cột này viết ra từng vế của công thức TRỘN đã bị gỡ:
    "chờ xử lý / phát lại N (×X% thành công) · chưa có kết quả M (×Y% lịch sử)".
  Không vế nào trong đó còn chạy. Tỷ lệ nay đến từ `PROJECTED_GTC_V2`: mỗi đơn chưa có kết cục được
  cân theo xác suất của CHÍNH trạng thái ĐVVC nó đang ở, học từ lịch sử vận đơn thật.

  Và bốn nguồn phải phân biệt được bằng mắt, vì chúng KHÔNG cùng độ tin cậy: một con số chủ shop
  gõ tay, một con số mô hình dựng từ trạng thái thật, một tỷ lệ lịch sử của mã, và một giả định
  chung của shop — gộp cả bốn vào chữ "lịch sử" là xoá đúng thông tin mà người đọc cần.
*/
/**
 * Kiện CHƯA RỜI KHO phải hiện ra ngay cạnh tỷ lệ, chứ không chỉ biến mất khỏi mẫu số.
 *
 * Đo 21/09/2026: Q004 có 40 đơn như vậy trên 167 đơn từng bị tính là "đã gửi". Lặng lẽ bỏ chúng
 * đi thì dòng lại không cộng được lần nữa — chỉ khác chiều. Chúng là VIỆC PHẢI LÀM (đi giục bưu
 * tá), nên cột nhỏ gọi tên chúng.
 */
const choLay = (r: NominalRow) => (r.projection?.awaitingPickup ? ` · ${formatNumber(r.projection.awaitingPickup)} chờ ĐVVC lấy (ngoài tỷ lệ)` : "");

const NHAN_NGUON: Record<NominalRow["returnRateSource"], (r: NominalRow) => string> = {
  override: () => "ghi đè · ước tính theo tỷ lệ",
  projected: (r) => (r.projection ? `${formatNumber(r.projection.eligibleSent)} đơn đã gửi${r.projection.unmodelledActive ? ` · ${formatNumber(r.projection.unmodelledActive)} ngoài ước tính` : ""}${choLay(r)}` : "mô hình"),
  unmeasured: (r) =>
    r.projection
      ? r.projection.eligibleSent === 0
        ? `chưa gửi đơn nào${choLay(r)}`
        : `chưa đo được · ${formatNumber(r.projection.unmodelledActive)}/${formatNumber(r.projection.active)} đang giao ngoài ước tính${choLay(r)}`
      : "chưa đo được",
  history: (r) => `lịch sử ${formatNumber(r.historyFinished)} đơn · ước tính theo tỷ lệ`,
  default: () => "mặc định · ước tính theo tỷ lệ",
};

function moTaUocTinh(r: NominalRow): string {
  const dem = `Đã giao TC ${formatNumber(r.delivered)} · không thành công ${formatNumber(r.returned)} · đang giao ${formatNumber(Math.max(0, r.orders - r.delivered - r.returned))}`;
  if (r.returnRateSource === "override") return `${dem} — tỷ lệ do chủ shop gõ tay, thắng mọi nguồn khác; tiền = Doanh số POS × tỷ lệ (ước tính theo tỷ lệ)`;
  if (r.returnRateSource === "projected" && r.projection)
    return `${dem} — mỗi đơn đang giao cân theo xác suất của chính trạng thái ĐVVC nó đang ở (${PROJECTED_GTC_VERSION}, ${formatNumber(r.projection.eligibleSent)} đơn đã gửi trong kỳ${r.projection.pending ? `, ${formatNumber(r.projection.pending)} chưa gửi cân theo P(chưa rời kho)` : ""}${r.projection.awaitingPickup ? `, ${formatNumber(r.projection.awaitingPickup)} chờ ĐVVC tới lấy — hàng còn trong kho nên KHÔNG ở tử số lẫn mẫu số tỷ lệ` : ""})${r.projection.unmodelledActive ? ` · ${formatNumber(r.projection.unmodelledActive)} đơn ngoài ước tính (${formatVND(r.unmodelledRevenue, { compact: true })})` : ""}`;
  if (r.returnRateSource === "unmeasured" && r.projection?.eligibleSent === 0)
    return `${dem} — CHƯA ĐO ĐƯỢC: mã này chưa có đơn nào rời kho trong kỳ${r.projection.awaitingPickup ? ` (${formatNumber(r.projection.awaitingPickup)} đơn đã có mã vận đơn nhưng ĐVVC chưa cầm hàng)` : ""}. Không có mẫu số thì không có tỷ lệ — “—” KHÔNG phải 0%`;
  if (r.returnRateSource === "unmeasured")
    return `${dem} — CHƯA ĐO ĐƯỢC: phần đang giao ở trạng thái chưa đủ mẫu quá lớn, không lùi về giả định. DT GTC ƯT chỉ gồm phần đã dự báo được; ${formatVND(r.unmodelledRevenue, { compact: true })} doanh số nằm ngoài ước tính`;
  if (r.returnRateSource === "history") return `${dem} — mã không có đơn nào trong cohort mô hình, dùng tỷ lệ hoàn lịch sử của mã (${formatNumber(r.historyFinished)} đơn đã kết thúc); tiền = Doanh số POS × tỷ lệ`;
  return `${dem} — chưa có lịch sử lẫn dự báo cho mã này, dùng giả định chung của shop; tiền = Doanh số POS × tỷ lệ`;
}

/** Ô "TL GTC ƯT" của một dòng: số + nguồn, KHÔNG có prose; `null` in "—" chứ không in 0% hay 100%. */
function OTyLe({ r }: { r: NominalRow }) {
  return (
    <>
      <span className={cn("numeric font-semibold", successTone(r.deliveryRate))}>
        <span title={moTaUocTinh(r)}>{r.deliveryRate === null ? "—" : `${r.deliveryRate.toFixed(1)}%`}</span>
      </span>
      <div className="text-[10.5px] text-muted-foreground">{NHAN_NGUON[r.returnRateSource](r)}</div>
    </>
  );
}

/** Ô tiền có thể CHƯA BIẾT (giá vốn / giá trị hàng nhập thiếu đơn giá): in "—" kèm lý do, không in 0 ₫. */
function TienCoTheChuaBiet({ value, known, reason, className }: { value: number; known: boolean; reason: string; className?: string }) {
  if (!known) return <span className="text-muted-foreground" title={reason}>—</span>;
  return <Money value={value} className={className} />;
}

function Pct({
  value,
  digits = 1,
  tone = true,
}: {
  value: number | null;
  digits?: number;
  tone?: boolean;
}) {
  if (value === null || !Number.isFinite(value))
    return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "numeric",
        tone &&
          (value < 0 ? "text-destructive" : value >= 15 ? "text-success" : ""),
      )}
    >
      {value.toFixed(digits)}%
    </span>
  );
}

export async function NominalTab({
  period,
  productId,
  tabQuery,
  canWrite,
  basis = "ORDERED",
}: {
  period: Period;
  productId: string;
  tabQuery: string;
  canWrite: boolean;
  /** Mốc gán đơn vào kỳ. Mặc định ngày tạo đơn — xem `mocCuaBasis` ở lib/queries/profit-nominal.ts. */
  basis?: TimeBasis;
}) {
  /*
    BẢNG MARKETER CỐ Ý Ở LẠI MỐC NGÀY TẠO ĐƠN.

    Nó ghi đơn cho người phụ trách fanpage TẠI MỐC ĐƠN LÊN; đổi mốc cohort sang ngày gửi là hỏi
    một câu mà cách ghi nhận ấy không trả lời được. Chú thích dưới bảng nói ra điều đó thay vì để
    hai khối trên cùng màn hình lặng lẽ đứng trên hai tập đơn.
  */
  const [report, byMarketer] = await Promise.all([getNominalProfitReport(period, basis), getNominalMarketerBreakdown(period)]);
  const selected = productId
    ? report.rows.find((r) => r.productId === productId)
    : null;
  // Bảng theo ngày tính theo TỶ LỆ (chưa có cohort theo ngày); mã chưa đo được thì dùng tỷ lệ lịch sử
  // của mã và NÓI RÕ ở tiêu đề — không lặng lẽ.
  const dailyRate = selected ? (selected.returnRate ?? selected.baseReturnRate) : 0;
  const daily = selected
    ? await getNominalDailyForProduct(
        selected.productId,
        period,
        dailyRate,
        report.assumptions,
        basis,
      )
    : [];
  const t = report.totals;
  const pj = t.projection;
  const riskPct = report.assumptions.inventoryRiskPercent ?? DEFAULT_PROFIT_ASSUMPTIONS.inventoryRiskPercent;

  return (
    <div className="space-y-5">
      {/*
        ═══ MỐC COHORT ĐỨNG NGAY ĐẦU TAB, VÌ NÓ QUYẾT ĐỊNH MỌI CON SỐ BÊN DƯỚI ═══

        Trang Tỷ lệ giao thành công có đúng ô này. Đặt cả hai về cùng một mốc thì cùng một mã phải
        ra CÙNG một tỷ lệ GTC ước tính — `tests/reporting-parity.test.ts` khoá điều đó.
      */}
      <DataTableToolbar
        period={{ defaultKey: "month" }}
        facets={[
          {
            key: "moc",
            label: "Mốc thời gian",
            options: TIME_BASES.map((b) => ({ value: b, label: TIME_BASIS_LABEL[b] })),
            single: true,
          },
        ]}
        resultLabel={`${TIME_BASIS_QUESTION[basis]} Cùng mốc + cùng mã ⇒ trang Tỷ lệ giao thành công phải ra cùng một tỷ lệ GTC ước tính. Chi phí quảng cáo và chi phí vận hành luôn theo NGÀY PHÁT SINH của chính chúng, không đổi theo mốc này; bảng theo marketer giữ mốc ngày tạo đơn vì nó ghi đơn theo người phụ trách fanpage tại lúc đơn lên.`}
      />

      <AssumptionsForm assumptions={report.assumptions} canWrite={canWrite} />

      <CostQualityPanel period={period} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          label="Doanh số POS (đơn lên)"
          value={formatVND(t.grossSales, { compact: true })}
          note={`${formatNumber(t.orders)} đơn · ${formatNumber(t.items)} sản phẩm · không tính đơn huỷ`}
          icon={PackageCheck}
          tone="blue"
        />
        <MetricCard
          label="Doanh thu GTC ước tính"
          hint="DT đơn ĐÃ GIAO THẬT + Σ(DT từng đơn đang giao × xác suất giao được của trạng thái ĐVVC nó đang ở) + Σ(DT đơn chưa gửi × P(chưa gửi)). Cân theo TỪNG ĐƠN, không nhân tổng doanh số với một tỷ lệ. Mã có tỷ lệ ghi đè tay / lịch sử / mặc định thì mới tính Doanh số POS × tỷ lệ và mang nhãn “ước tính theo tỷ lệ”. Đơn ở trạng thái chưa đủ mẫu nằm NGOÀI ước tính và được nêu riêng."
          value={formatVND(t.expectedRevenue, { compact: true })}
          note={`Thực tế đã giao ${formatVND(t.actualRevenue, { compact: true })}${t.pendingOrders ? ` · ${formatNumber(t.pendingOrders)} đơn chưa gửi` : ""}${t.unmodelledRevenue ? ` · ${formatVND(t.unmodelledRevenue, { compact: true })} ngoài ước tính` : ""}`}
          icon={Calculator}
          tone="primary"
        />
        <MetricCard
          label="Chi phí quảng cáo"
          value={formatVND(t.adSpend, { compact: true })}
          note={
            report.unmatchedAdSpend
              ? `${formatVND(t.adSpendAttributed, { compact: true })} đã quy kết theo mã · ${formatVND(report.unmatchedAdSpend, { compact: true })} chưa quy kết (trừ vào tổng, không rải vào mã nào)`
              : "Đã quy kết hết theo mã hàng"
          }
          icon={Megaphone}
          tone="rose"
        />
        <MetricCard
          label="Chi phí ngoài hàng · QC · vận chuyển"
          value={formatVND(t.otherCostsTotal, { compact: true })}
          note={`${formatVND(t.opexPerOrder ?? 0)}/đơn lên · ${formatVND(t.opexPerDelivered ?? 0)}/đơn GTC ước tính · vận hành ${formatVND(t.opexTotal, { compact: true })} + rủi ro TK ${formatVND(t.inventoryRisk, { compact: true })} + thuế ${formatVND(t.tax, { compact: true })} + CP khác ${formatVND(t.otherCost, { compact: true })}`}
          icon={TrendingUp}
          tone="amber"
        />
        <MetricCard
          label="Lợi nhuận danh nghĩa"
          value={
            <span
              className={t.netProfit >= 0 ? "text-success" : "text-destructive"}
            >
              {formatVND(t.netProfit, { compact: true })}
            </span>
          }
          note={`Margin ${t.netMargin !== null ? `${t.netMargin.toFixed(1)}%` : "—"} · = DT GTC ƯT − giá vốn − vận chuyển − CPQC − vận hành ${formatVND(t.opexTotal, { compact: true })} (đã nhập ${formatVND(t.operatingExpenses, { compact: true })} · ${formatNumber(report.operatingCount)} khoản, đóng hàng ${formatVND(t.packingCost, { compact: true })}, NV vận đơn ${formatVND(t.opsStaffCost, { compact: true })} · cứu ước ${formatNumber(t.rescued)} đơn, cố định ${formatVND(t.fixedCost, { compact: true })} · ${report.periodMonths} tháng) − rủi ro TK ${formatVND(t.inventoryRisk, { compact: true })} (${riskPct}% giá vốn hàng bán ${formatVND(t.expectedCogs, { compact: true })}; còn treo trên tồn ${formatVND(t.inventoryRiskPending, { compact: true })}) − thuế ${formatVND(t.tax, { compact: true })} − CP khác ${formatVND(t.otherCost, { compact: true })}${!t.cogsKnown ? ` · ${formatNumber(t.cogsUnknownQty)} sản phẩm CHƯA BIẾT giá vốn (đang tính 0đ)` : ""}`}
          icon={Wallet}
          tone={t.netProfit >= 0 ? "green" : "rose"}
        />
        {/*
          THẺ NÀY LÀ ĐÚNG CON SỐ CỦA HỢP ĐỒNG Ở GRAIN ĐƠN (`orderLevel.projectedRate`, mốc ngày chốt
          đơn) — cùng hàm, cùng bảng xác suất với trang hiệu quả theo mã. Nhãn tin cậy từ thử ngược
          đứng ngay cạnh; bình quân các tỷ lệ đang dùng trong phép tính tiền (kể cả ghi đè tay) hiện
          riêng ở ghi chú, không thay thế.
        */}
        <MetricCard
          label="Tỷ lệ giao thành công ước tính"
          hint={`Ước tính giao được ÷ (đã gửi − đơn ngoài ước tính), trong đó ước tính giao được = đã giao thật (ORDER_OUTCOME) + Σ(đơn đang giao × xác suất giao được của trạng thái ĐVVC nó đang ở). Đơn chưa gửi, đơn CHỜ ĐVVC TỚI LẤY (hàng còn trong kho) và đơn huỷ không ở tử số lẫn mẫu số. ${PROJECTED_GTC_VERSION}, mốc ngày chốt đơn — cùng hợp đồng với trang Tỷ lệ giao thành công theo mã hàng. “—” = chưa đo được (không phải 0%).`}
          value={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className={successTone(t.weightedDeliveryRate)}>{t.weightedDeliveryRate !== null ? `${t.weightedDeliveryRate.toFixed(1)}%` : "—"}</span>
              {pj ? <ProjectionConfidence backtest={pj.backtest} error={pj.backtestError} /> : null}
            </span>
          }
          note={
            t.projectionError
              ? `LỖI khi tính ước tính: ${t.projectionError}`
              : `${pj ? `${formatNumber(pj.eligibleSent)} đơn đã gửi · ${formatNumber(pj.active)} đang giao${pj.unmodelledActive ? ` (${formatNumber(pj.unmodelledActive)} ngoài ước tính)` : ""}${pj.awaitingPickup ? ` · ${formatNumber(pj.awaitingPickup)} chờ ĐVVC lấy, ngoài tỷ lệ` : ""}` : "chưa có cohort"} · thực tế ${formatNumber(t.delivered)} giao TC, ${formatNumber(t.returned)} không TC${t.assumedDeliveryRate !== null && t.weightedDeliveryRate !== null && Math.abs(t.assumedDeliveryRate - t.weightedDeliveryRate) >= 0.05 ? ` · bình quân tỷ lệ đang dùng trong bảng (gồm ghi đè/lịch sử) ${t.assumedDeliveryRate.toFixed(1)}%` : ""}`
          }
          icon={Percent}
          tone={t.weightedDeliveryRate === null ? "slate" : t.weightedDeliveryRate < 55 ? "rose" : "green"}
        />
        {/*
          BA tỷ lệ quảng cáo, MỘT hàm (`adsRatios`), mỗi thẻ nói rõ mẫu số của mình. Tử số ở thẻ là
          TỔNG chi (kể cả chưa quy kết). Mẫu số bằng 0 thì hiện "—", không bao giờ hiện vô cực.
        */}
        <MetricCard
          label="QC / Doanh số POS"
          hint="Tổng chi quảng cáo trong kỳ (kể cả phần chưa quy kết) ÷ doanh số đơn đã chốt trên Pancake, CHƯA trừ hoàn. Luôn đẹp hơn hai tỷ lệ kia vì mẫu số chưa trừ đơn hoàn."
          value={t.ads.overPosSales !== null ? `${t.ads.overPosSales.toFixed(1)}%` : "—"}
          note={`${period.label} · ${formatVND(t.adSpend, { compact: true })} ÷ ${formatVND(t.salesAfterDiscount, { compact: true })} doanh số POS${t.ads.overPosSales === null ? " · chưa có doanh số để chia" : ""}`}
          icon={Percent}
          tone="amber"
        />
        <MetricCard
          label="QC / DT GTC ước tính"
          hint="Tổng chi quảng cáo ÷ Doanh thu GTC ƯỚC TÍNH (đã giao thật + đang giao × P, cân theo từng đơn). Đây là mẫu số mà bảng theo mã dùng ở cột cùng tên. Thẻ bên cạnh chia cho doanh thu ĐÃ GIAO THẬT tới hôm nay — hai mẫu số khác nhau, hai con số khác nhau, cố ý."
          value={t.ads.overProjectedRevenue !== null ? `${t.ads.overProjectedRevenue.toFixed(1)}%` : "—"}
          note={`${period.label} · ${formatVND(t.adSpend, { compact: true })} ÷ ${formatVND(t.expectedRevenue, { compact: true })} DT GTC ước tính · so với DT ĐÃ GIAO THẬT ${formatVND(t.actualRevenue, { compact: true })}: ${t.ads.overDeliveredActual !== null ? `${t.ads.overDeliveredActual.toFixed(1)}%` : "—"}`}
          icon={Percent}
          tone="amber"
        />
      </section>

      <SectionCard
        title="Lợi nhuận danh nghĩa theo mã hàng"
        description={`${period.label} · mỗi mã: đơn ĐÃ XÁC NHẬN lên trong kỳ, CPQC Facebook ghép theo tên chiến dịch. Tỷ lệ và doanh thu GTC ước tính (đơn GTC theo ORDER_OUTCOME) dùng CÙNG hợp đồng với trang Tỷ lệ giao thành công theo mã hàng (${PROJECTED_GTC_VERSION}): mỗi đơn chưa có kết cục được cân theo xác suất của CHÍNH trạng thái Viettel Post nó đang ở, học từ vận đơn đã kết thúc và đủ chín. Mã có cohort mà chưa đo được thì in “—” (không lùi về giả định); chỉ mã KHÔNG có đơn nào trong cohort mới dùng tỷ lệ hoàn ${report.assumptions.returnRateWindowDays} ngày của mã, và tiền của mã đó mang nhãn “ước tính theo tỷ lệ”. Cột nhỏ dưới mỗi tỷ lệ nói rõ nguồn. Bấm mã để xem theo ngày.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1500px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">SP</TableHead>
                <TableHead className="text-right">Doanh số POS</TableHead>
                <TableHead className="text-right">CPQC</TableHead>
                {/*
                  HAI TỶ LỆ QUẢNG CÁO — MẪU SỐ KHÁC NHAU CÓ CHỦ ĐÍCH, KHÔNG THAY THẾ CHO NHAU.

                  Một bên chia cho tiền khách CHỐT, một bên chia cho tiền dự kiến THẬT SỰ TỚI TAY
                  KHÁCH. Tỷ lệ đầu luôn đẹp hơn vì mẫu số chưa trừ đơn hoàn; đọc nhầm nó thành
                  hiệu quả quảng cáo là lý do người ta tăng ngân sách cho một mã đang lỗ.
                */}
                <TableHead className="text-right" title="Tỷ lệ chi phí quảng cáo trên doanh số đơn đã lên POS trong kỳ. Tử số: CPQC đã quy kết về đúng mã trong kỳ. Mẫu số: doanh số POS của cùng mã, cùng kỳ. Mẫu số bằng 0 hoặc chưa quy kết được ⇒ hiện “—”, KHÔNG hiện 0%.">CPQC / DS POS %</TableHead>
                <TableHead className="text-right" title="Tỷ lệ chi phí quảng cáo trên doanh thu giao thành công ƯỚC TÍNH (cột DT GTC ƯT bên cạnh: đã giao thật + đang giao × P, cân theo từng đơn). Mẫu số bằng 0 hoặc chưa đo được ⇒ “—”, KHÔNG phải 0%.">CPQC / DT GTC ƯT %</TableHead>
                <TableHead className="text-right" title="Tỷ lệ giao thành công ước tính = ước tính giao được ÷ (đã gửi − ngoài ước tính); đơn GTC theo ORDER_OUTCOME. “—” = chưa đo được.">TL GTC ƯT</TableHead>
                <TableHead className="text-right" title="DT đơn đã giao thật + Σ(DT đơn đang giao × P(trạng thái)) + Σ(DT đơn chưa gửi × P(chưa gửi)) — cân theo TỪNG ĐƠN. Dòng có nhãn “ước tính theo tỷ lệ” (ghi đè / lịch sử / mặc định) mới là Doanh số POS × TL GTC.">DT GTC ƯT</TableHead>
                <TableHead className="text-right" title="Giá vốn cân theo từng đơn cùng cách với DT GTC ƯT. “—” = có sản phẩm chưa biết giá vốn (không phiếu nhập, không giá Pancake).">Giá vốn</TableHead>
                <TableHead className="text-right">Vận chuyển</TableHead>
                <TableHead className="text-right">CPQC/đơn</TableHead>
                <TableHead className="text-right">DT/đơn</TableHead>
                <TableHead className="text-right" title="Chi phí vận hành đã nhập ở bảng Chi phí trong kỳ (lương, phần mềm, khác; trừ QC & nhập hàng) phân bổ theo tỷ trọng doanh số POS">CP vận hành đã nhập</TableHead>
                <TableHead className="text-right" title={`Đóng hàng = đơn gửi × ${(report.assumptions.packingFeePerOrder ?? 0).toLocaleString("vi-VN")} ₫`}>Đóng hàng</TableHead>
                <TableHead className="text-right" title={`Nhân viên vận đơn = đơn × ${(report.assumptions.opsStaffPerOrder ?? 0).toLocaleString("vi-VN")} ₫ + đơn giao thất bại cứu được thành GTC × ${(report.assumptions.opsStaffPerRescued ?? 0).toLocaleString("vi-VN")} ₫`}>NV vận đơn</TableHead>
                <TableHead className="text-right" title={`Chi phí cố định (văn phòng, điện nước…) ${(report.assumptions.fixedCostMonthly ?? 0).toLocaleString("vi-VN")} ₫/tháng × ${report.periodMonths} tháng của kỳ, phân bổ theo tỷ trọng doanh số POS`}>CP cố định</TableHead>
                <TableHead className="text-right" title="Mọi chi phí ngoài tiền hàng, QC, vận chuyển (vận hành đã nhập + đóng hàng + NV vận đơn + cố định + rủi ro TK + thuế + CP khác) ÷ số đơn lên (trước hoàn huỷ)">CP vận hành/đơn trước hoàn</TableHead>
                <TableHead className="text-right" title="Cùng các chi phí trên ÷ số đơn giao thành công ước tính (sau hoàn huỷ)">CP vận hành/đơn sau hoàn huỷ</TableHead>
                <TableHead className="text-right" title="Dự phòng rủi ro tồn kho ghi vào kỳ = % giả định × GIÁ VỐN HÀNG BÁN RA trong kỳ. Không tính trên giá trị hàng nhập: nhập hàng là sự kiện một lần, ném trọn vào kỳ chứa nó thì tuần chỉ bán được 1/10 lô vẫn gánh đủ dự phòng cả lô. Phần rủi ro của hàng chưa bán nằm ở cột 'Rủi ro còn treo'. “—” = chưa biết giá vốn nên chưa tính được.">Rủi ro TK {riskPct}% giá vốn bán</TableHead>
                <TableHead className="text-right" title="Dự trù thuế = DT GTC ước tính × %">Thuế {report.assumptions.taxPercent ?? 1.5}%</TableHead>
                <TableHead className="text-right" title="Chi phí khác = CPQC × % (phí thanh toán thẻ ngoại tệ khi Meta thu tiền)">CP khác {report.assumptions.otherCostPercentOfAds ?? 1.1}% QC</TableHead>
                <TableHead className="text-right" title="Lợi nhuận danh nghĩa = DT GTC ước tính − giá vốn − vận chuyển − CPQC − vận hành − rủi ro TK − thuế − CP khác">LN danh nghĩa</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={24}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    Không có đơn trong kỳ.
                  </TableCell>
                </TableRow>
              ) : (
                report.rows.map((r) => (
                  <TableRow
                    key={r.productId}
                    className={cn(
                      selected?.productId === r.productId && "bg-primary/5",
                    )}
                  >
                    <TableCell>
                      <Link
                        href={`/reports?${tabQuery}&product=${encodeURIComponent(r.productId)}#ma-hang`}
                        className="flex items-center gap-2.5 hover:text-primary"
                      >
                        {r.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.image}
                            alt=""
                            className="size-9 shrink-0 rounded-md border object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="size-9 shrink-0 rounded-md border bg-muted" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-semibold">
                            {r.productName}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {r.code ? `${r.code} · ` : ""}giao thật{" "}
                            {r.delivered} · hoàn {r.returned} · đang giao{" "}
                            {r.inTransit}
                          </div>
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="numeric text-right font-semibold">
                      {formatNumber(r.orders)}
                    </TableCell>
                    <TableCell className="numeric text-right text-muted-foreground">
                      {formatNumber(r.items)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={r.grossSales} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.adSpend}
                        className={
                          r.adSpend ? "text-rose-600" : "text-muted-foreground"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right"><Pct value={r.ads.overPosSales} tone={false} /></TableCell>
                    <TableCell className="text-right"><Pct value={r.ads.overProjectedRevenue} tone={false} /></TableCell>
                    <TableCell className="text-right">
                      <OTyLe r={r} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.expectedRevenue}
                        className="font-semibold"
                      />
                      {r.unmodelledRevenue ? <div className="text-[10.5px] text-muted-foreground" title="Doanh số của đơn ở trạng thái chưa đủ mẫu — không nằm trong DT GTC ƯT">ngoài ƯT {formatVND(r.unmodelledRevenue, { compact: true })}</div> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <TienCoTheChuaBiet value={r.expectedCogs} known={r.cogsKnown} reason={`${formatNumber(r.cogsUnknownQty)} sản phẩm chưa biết giá vốn (không phiếu nhập, không giá Pancake) — giá vốn đang bị tính 0đ nên không in ra`} className="text-muted-foreground" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.shipCost}
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.cpo === null ? 0 : Math.round(r.cpo)}
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={
                          r.revenuePerOrder === null
                            ? 0
                            : Math.round(r.revenuePerOrder)
                        }
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right"><Money value={r.operatingAlloc} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.packingCost} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right">
                      <Money value={r.opsStaffCost} className="text-muted-foreground" />
                      {r.rescued ? <div className="text-[10.5px] text-muted-foreground">cứu ước {formatNumber(r.rescued)} đơn</div> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={r.fixedAlloc} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.opexPerOrder ?? 0} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.opexPerDelivered ?? 0} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right">
                      <TienCoTheChuaBiet value={r.inventoryRisk} known={r.cogsKnown} reason="Chưa biết giá vốn hàng bán ⇒ chưa tính được dự phòng rủi ro (không phải rủi ro = 0)" className="text-muted-foreground" />
                      {r.inventoryRiskPending ? <div className="text-[10.5px] text-muted-foreground" title="Rủi ro của hàng CÒN TRONG KHO — chưa trừ vào lợi nhuận kỳ này, sẽ được ghi dần khi hàng bán ra">còn treo {formatVND(r.inventoryRiskPending, { compact: true })}</div> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={r.tax} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.otherCost} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.netProfit}
                        className={cn(
                          "font-bold",
                          r.netProfit >= 0 ? "text-success" : "text-destructive",
                        )}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.netMargin} />
                    </TableCell>
                  </TableRow>
                ))
              )}
              {report.rows.length ? (
                <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                  <TableCell>
                    Tổng
                    {report.unmatchedAdSpend ? (
                      <div className="text-[10.5px] font-normal text-muted-foreground" title="Tiền quảng cáo chưa ghép được mã hàng: trừ vào tổng, KHÔNG rải vào dòng nào. Hai cột tỷ lệ QC ở dòng tổng chỉ tính phần ĐÃ quy kết để khớp Σ các dòng.">
                        + {formatVND(report.unmatchedAdSpend)} QC chưa quy kết
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="numeric text-right">
                    {formatNumber(t.orders)}
                  </TableCell>
                  <TableCell className="numeric text-right">
                    {formatNumber(t.items)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.grossSales} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.adSpend} className="text-rose-600" />
                  </TableCell>
                  <TableCell className="text-right" title={`CPQC đã quy kết ${formatVND(t.adSpendAttributed)} ÷ doanh số POS`}><Pct value={t.adsAttributed.overPosSales} tone={false} /></TableCell>
                  <TableCell className="text-right" title={`CPQC đã quy kết ${formatVND(t.adSpendAttributed)} ÷ DT GTC ước tính`}><Pct value={t.adsAttributed.overProjectedRevenue} tone={false} /></TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      <Pct value={t.weightedDeliveryRate} tone={false} />
                      {pj ? <ProjectionConfidence backtest={pj.backtest} error={pj.backtestError} /> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.expectedRevenue} />
                    {t.unmodelledRevenue ? <div className="text-[10.5px] font-normal text-muted-foreground">ngoài ƯT {formatVND(t.unmodelledRevenue, { compact: true })}</div> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <TienCoTheChuaBiet value={t.expectedCogs} known={t.cogsKnown} reason={`${formatNumber(t.cogsUnknownQty)} sản phẩm chưa biết giá vốn — tổng giá vốn đang thiếu phần đó`} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.shipCost} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={t.orders ? Math.round(t.adSpend / t.orders) : 0}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={
                        t.orders ? Math.round(t.expectedRevenue / t.orders) : 0
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right"><Money value={t.operatingExpenses} /></TableCell>
                  <TableCell className="text-right"><Money value={t.packingCost} /></TableCell>
                  <TableCell className="text-right">
                    <Money value={t.opsStaffCost} />
                    {t.rescued ? <div className="text-[10.5px] font-normal text-muted-foreground">cứu ước {formatNumber(t.rescued)} đơn</div> : null}
                  </TableCell>
                  <TableCell className="text-right"><Money value={t.fixedCost} /></TableCell>
                  <TableCell className="text-right"><Money value={t.opexPerOrder ?? 0} /></TableCell>
                  <TableCell className="text-right"><Money value={t.opexPerDelivered ?? 0} /></TableCell>
                  <TableCell className="text-right">
                    <TienCoTheChuaBiet value={t.inventoryRisk} known={t.cogsKnown} reason="Có sản phẩm chưa biết giá vốn ⇒ dự phòng rủi ro chưa tính đủ" />
                    {t.inventoryRiskPending ? <div className="text-[10.5px] font-normal text-muted-foreground" title={`Rủi ro của hàng còn trong kho (${formatVND(t.stockValue, { compact: true })} giá trị tồn) — chưa trừ vào lợi nhuận kỳ này`}>còn treo {formatVND(t.inventoryRiskPending, { compact: true })}</div> : null}
                  </TableCell>
                  <TableCell className="text-right"><Money value={t.tax} /></TableCell>
                  <TableCell className="text-right"><Money value={t.otherCost} /></TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={t.netProfit}
                      className={
                        t.netProfit >= 0 ? "text-success" : "text-destructive"
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pct value={t.netMargin} />
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          Công thức mỗi mã (TL GTC = tỷ lệ giao thành công ước tính, đơn GTC theo ORDER_OUTCOME): DT GTC ước tính = DT đơn đã giao thật + Σ(DT
          từng đơn đang giao × xác suất giao được của trạng thái ĐVVC nó đang ở) + Σ(DT đơn chưa gửi × P(chưa gửi)) — cân theo TỪNG ĐƠN; giá
          vốn cân cùng cách. Chỉ dòng mang nhãn “ước tính theo tỷ lệ” (ghi đè tay / lịch sử / mặc định) mới là Doanh số POS × TL GTC và Giá
          vốn = SP × giá nhập × TL GTC. Đơn ở trạng thái chưa đủ mẫu nằm NGOÀI ước tính (dòng “ngoài ƯT”). Vận chuyển = Đơn × cước gửi + Đơn
          × (1 − TL GTC) × phí hoàn về (tức Đơn × [TL GTC × cước gửi + (1 − TL GTC)
          × cước đơn hoàn đi + về]). LN danh nghĩa = DT − giá vốn − vận chuyển
          − CPQC − CP vận hành đã nhập (bảng Chi phí, trừ QC & nhập hàng, phân
          bổ theo doanh số) − đóng hàng (đơn × đơn giá) − nhân viên vận đơn (đơn
          × đơn giá + đơn cứu được GTC ước theo % × thưởng) − CP cố định (tháng ×
          số tháng của kỳ, phân bổ theo doanh số) − dự phòng rủi ro tồn kho (% ×
          GIÁ VỐN HÀNG BÁN RA trong kỳ, không phải % giá trị hàng nhập — phần
          rủi ro của hàng chưa bán hiện riêng ở dòng “còn treo”) − thuế − CP khác. CP vận hành/đơn = mọi chi phí ngoài tiền
          hàng, QC, vận chuyển chia cho số đơn lên (trước hoàn) hoặc số đơn giao
          thành công ước tính (sau hoàn huỷ); sửa đơn giá ở Giả định. Đơn chưa giao vẫn được tính theo tỷ lệ ước tính, nên
          đây là lợi nhuận danh nghĩa; đối chiếu với tab “Dòng tiền thực” khi
          tiền về.
        </div>
      </SectionCard>

      {selected ? (
        <div id="ma-hang">
          <SectionCard
            title={`${selected.productName}${selected.code ? ` (${selected.code})` : ""} · theo ngày`}
            description={`Tỷ lệ giao thành công ước tính ${selected.deliveryRate === null ? "— (chưa đo được)" : `${selected.deliveryRate.toFixed(1)}%`} (${moTaUocTinh(selected)}) · bảng theo ngày tính theo tỷ lệ ${(100 - dailyRate).toFixed(1)}%${selected.returnRate === null ? " (tỷ lệ lịch sử của mã, vì mô hình chưa đo được)" : ""} · giá vốn ${selected.items && selected.cogsKnown ? formatVND(Math.round(selected.expectedCogs / Math.max(1 - dailyRate / 100, 0.01) / selected.items)) : "—"}/sp`}
            actions={
              <div className="flex items-center gap-3">
                <ReturnRateOverride
                  productId={selected.productId}
                  assumptions={report.assumptions}
                  current={selected.deliveryRate ?? Math.round((100 - selected.baseReturnRate) * 10) / 10}
                  source={selected.returnRateSource}
                  canWrite={canWrite}
                />
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/reports?${tabQuery}`}>Đóng</Link>
                </Button>
              </div>
            }
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead className="text-right">Đơn</TableHead>
                    <TableHead className="text-right">SP</TableHead>
                    <TableHead className="text-right">CPQC</TableHead>
                    <TableHead className="text-right">Doanh số POS</TableHead>
                    <TableHead className="text-right">DT GTC ƯT</TableHead>
                    <TableHead className="text-right">Giá vốn</TableHead>
                    <TableHead className="text-right">Vận chuyển</TableHead>
                    <TableHead className="text-right">CPQC/đơn</TableHead>
                    <TableHead className="text-right" title="Theo ngày chỉ có DT − giá vốn − vận chuyển − CPQC (chưa trừ vận hành, rủi ro TK, thuế, CP khác vì các khoản này tính theo kỳ)">LN gộp sau QC</TableHead>
                    <TableHead className="text-right">Margin gộp</TableHead>
                    <TableHead className="text-right">Thực tế</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {daily.map((d) => (
                    <TableRow key={d.day}>
                      <TableCell className="font-medium">
                        {d.day.split("-").reverse().join("/")}
                      </TableCell>
                      <TableCell className="numeric text-right">
                        {formatNumber(d.orders)}
                      </TableCell>
                      <TableCell className="numeric text-right text-muted-foreground">
                        {formatNumber(d.items)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.adSpend}
                          className={
                            d.adSpend
                              ? "text-rose-600"
                              : "text-muted-foreground"
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={d.grossSales} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.expectedRevenue}
                          className="font-semibold"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.expectedCogs}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.shipCost}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.cpo === null ? 0 : Math.round(d.cpo)}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.expectedProfit}
                          className={cn(
                            "font-bold",
                            d.expectedProfit >= 0
                              ? "text-success"
                              : "text-destructive",
                          )}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Pct value={d.margin} />
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        giao {d.delivered} · hoàn {d.returned}
                      </TableCell>
                    </TableRow>
                  ))}
                  {daily.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={12}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Không có dữ liệu trong kỳ.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </div>
      ) : null}

      <SectionCard
        title="Lợi nhuận theo tổng giá trị hàng nhập trong kỳ"
        description={`Thay giá vốn hàng giao ước tính bằng TOÀN BỘ giá trị hàng nhập trong kỳ theo phiếu nhập (${formatNumber(t.purchaseQty)} sp · ${formatVND(t.purchaseCost, { compact: true })}). LN = DT GTC ước tính − CPQC − hàng nhập − vận chuyển − tổng vận hành (đã nhập + đóng hàng + NV vận đơn + cố định) − CP rủi ro tồn kho phân bổ cho kỳ (theo giá vốn hàng BÁN RA, cùng một con số với bảng trên — không theo giá trị hàng nhập) − thuế − CP khác. Thấp hơn bảng trên đúng bằng phần hàng nhập còn tồn chưa bán; mã nhập hàng mà chưa có đơn vẫn được liệt kê.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1200px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right">SL nhập</TableHead>
                <TableHead className="text-right">Giá trị hàng nhập</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">DT GTC ƯT</TableHead>
                <TableHead className="text-right">CPQC</TableHead>
                <TableHead className="text-right" title="Tỷ lệ chi phí quảng cáo trên doanh số đơn đã lên POS trong kỳ. Tử số: CPQC đã quy kết về đúng mã trong kỳ. Mẫu số: doanh số POS của cùng mã, cùng kỳ. Mẫu số bằng 0 hoặc chưa quy kết được ⇒ hiện “—”, KHÔNG hiện 0%.">CPQC / DS POS %</TableHead>
                <TableHead className="text-right" title="Tỷ lệ chi phí quảng cáo trên doanh thu giao thành công ƯỚC TÍNH. Doanh thu ước tính dùng CÙNG mô hình dự báo với báo cáo giao vận: từng đơn chưa kết thúc được cân theo xác suất giao thành công của chính trạng thái nó đang ở. Mẫu số bằng 0 hoặc chưa đo được ⇒ “—”, KHÔNG phải 0%.">CPQC / DT GTC ƯT %</TableHead>
                <TableHead className="text-right">Vận chuyển</TableHead>
                <TableHead className="text-right" title="Tổng vận hành = CP vận hành đã nhập + đóng hàng + nhân viên vận đơn + chi phí cố định">Vận hành (tổng)</TableHead>
                <TableHead className="text-right" title="CHI PHÍ CỦA KỲ NÀY, không phải rủi ro cả đời của lô: % giả định × GIÁ VỐN HÀNG BÁN RA trong kỳ — cùng MỘT con số với bảng trên. Trước bản này cột lấy % × giá trị hàng NHẬP, nên kỳ có phiếu nhập thì gánh rủi ro của hàng sẽ bán nhiều tháng sau, còn kỳ không nhập gì thì bằng đúng 0 và bảng nói hàng đang bán không có rủi ro nào. Rủi ro cả đời của lô nhập vẫn tính và hiện ở cột bên cạnh — là GHI CHÚ, không trừ vào lợi nhuận.">CP rủi ro TK phân bổ kỳ này</TableHead>
                <TableHead className="text-right" title="GHI CHÚ, KHÔNG trừ vào lợi nhuận: rủi ro CẢ ĐỜI của lô hàng nhập trong kỳ (% × giá trị hàng nhập). Đây là phơi nhiễm TẠI MỘT THỜI ĐIỂM, không phải chi phí CỦA MỘT KỲ.">Rủi ro cả lô nhập (ghi chú)</TableHead>
                <TableHead className="text-right">Thuế</TableHead>
                <TableHead className="text-right">CP khác</TableHead>
                <TableHead className="text-right">LN theo hàng nhập</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right" title="Giá vốn hàng giao ước tính (bảng trên) để đối chiếu: hàng nhập − giá vốn ước tính ≈ giá trị còn tồn / chưa bán">Giá vốn ƯT (đối chiếu)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...report.rows].sort((a, b) => b.profitOnPurchase - a.profitOnPurchase).map((r) => (
                <TableRow key={`pur-${r.productId}`} className={cn(!r.orders && "text-muted-foreground")}>
                  <TableCell className="font-medium">{r.code ? `${r.code} · ` : ""}{r.productName}{!r.orders ? <span className="ml-1 text-[11px]">(chưa có đơn)</span> : null}</TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.purchaseQty)}</TableCell>
                  <TableCell className="text-right"><TienCoTheChuaBiet value={r.purchaseCost} known={r.purchaseCostKnown} reason="Phiếu nhập trong kỳ có dòng không ghi đơn giá — giá trị hàng nhập CHƯA BIẾT, không phải 0 ₫" className={r.purchaseCost ? "text-rose-600" : "text-muted-foreground"} /></TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.orders)}</TableCell>
                  <TableCell className="text-right"><Money value={r.expectedRevenue} /></TableCell>
                  <TableCell className="text-right"><Money value={r.adSpend} className="text-rose-600" /></TableCell>
                  <TableCell className="text-right"><Pct value={r.ads.overPosSales} tone={false} /></TableCell>
                  <TableCell className="text-right"><Pct value={r.ads.overProjectedRevenue} tone={false} /></TableCell>
                  <TableCell className="text-right"><Money value={r.shipCost} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.opexTotal} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><TienCoTheChuaBiet value={r.inventoryRisk} known={r.cogsKnown} reason="Chưa biết giá vốn hàng bán ⇒ chưa tính được dự phòng" className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><TienCoTheChuaBiet value={r.inventoryRiskOnPurchase} known={r.purchaseCostKnown} reason="Giá trị hàng nhập chưa biết ⇒ rủi ro cả lô chưa tính được" className="text-muted-foreground/70 italic" /></TableCell>
                  <TableCell className="text-right"><Money value={r.tax} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.otherCost} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.profitOnPurchase} className={cn("font-bold", r.profitOnPurchase >= 0 ? "text-success" : "text-destructive")} /></TableCell>
                  <TableCell className="text-right"><Pct value={r.marginOnPurchase} /></TableCell>
                  <TableCell className="text-right"><Money value={r.expectedCogs} className="text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                <TableCell>Tổng{report.unmatchedAdSpend ? <div className="text-[10.5px] font-normal text-muted-foreground">+ {formatVND(report.unmatchedAdSpend)} QC chưa quy kết (tỷ lệ ở dòng này chỉ tính phần đã quy kết)</div> : null}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(t.purchaseQty)}</TableCell>
                <TableCell className="text-right"><TienCoTheChuaBiet value={t.purchaseCost} known={t.purchaseCostKnown} reason="Có phiếu nhập không ghi đơn giá — tổng giá trị hàng nhập chưa biết đủ" className="text-rose-600" /></TableCell>
                <TableCell className="numeric text-right">{formatNumber(t.orders)}</TableCell>
                <TableCell className="text-right"><Money value={t.expectedRevenue} /></TableCell>
                <TableCell className="text-right"><Money value={t.adSpend} className="text-rose-600" /></TableCell>
                <TableCell className="text-right"><Pct value={t.adsAttributed.overPosSales} tone={false} /></TableCell>
                <TableCell className="text-right"><Pct value={t.adsAttributed.overProjectedRevenue} tone={false} /></TableCell>
                <TableCell className="text-right"><Money value={t.shipCost} /></TableCell>
                <TableCell className="text-right"><Money value={t.opexTotal} /></TableCell>
                <TableCell className="text-right"><TienCoTheChuaBiet value={t.inventoryRisk} known={t.cogsKnown} reason="Có sản phẩm chưa biết giá vốn ⇒ dự phòng chưa tính đủ" /></TableCell>
                <TableCell className="text-right"><TienCoTheChuaBiet value={t.inventoryRiskOnPurchase} known={t.purchaseCostKnown} reason="Giá trị hàng nhập chưa biết đủ ⇒ rủi ro cả lô chưa tính được" className="text-muted-foreground/70 italic" /></TableCell>
                <TableCell className="text-right"><Money value={t.tax} /></TableCell>
                <TableCell className="text-right"><Money value={t.otherCost} /></TableCell>
                <TableCell className="text-right"><Money value={t.profitOnPurchase} className={t.profitOnPurchase >= 0 ? "text-success" : "text-destructive"} /></TableCell>
                <TableCell className="text-right"><Pct value={t.marginOnPurchase} /></TableCell>
                <TableCell className="text-right"><Money value={t.expectedCogs} /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Lợi nhuận danh nghĩa theo Marketer"
        description={`Cách ghi nhận: đơn & DT GTC ước tính của mỗi mã ghi cho marketer theo FANPAGE phát sinh đơn — trước hết bằng ẢNH CHỤP người phụ trách page TẠI MỐC ĐƠN LÊN (đổi người phụ trách hôm nay KHÔNG làm đổi số của kỳ đã qua), rồi tới bảng gán phẳng khai ở Lương & hoa hồng (${byMarketer.pagesMapped}/${byMarketer.pagesTotal} page có đơn đã có người nhận). Fanpage không nói được gì thì mới tới AD_ID của đơn; còn lại chia theo tỷ trọng tiền QC trên mã, không QC → về chủ mã. Quảng cáo KHÔNG ghi đè người được tính đơn theo fanpage. LN ròng trước QC của mã (đã trừ giá vốn, vận chuyển, vận hành gồm đóng hàng / NV vận đơn / cố định, rủi ro TK, thuế) × tỷ trọng − QC của chính mình − CP khác theo QC − QC test = LN ròng cá nhân; chủ mã hưởng X% LN đơn của mình, người chạy cùng hưởng Y% LN đơn mình tạo và (100 − Y)% về chủ mã (mặc định Y = ${100 - byMarketer.ownerSharePct}%, khai riêng từng mã ở Lương & hoa hồng). Bấm tên marketer để xem chi tiết từng mã hàng có phát sinh số liệu.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">QC mã hàng</TableHead>
                <TableHead className="text-right">QC test</TableHead>
                <TableHead className="text-right">CP khác</TableHead>
                <TableHead className="text-right">Đơn phân bổ</TableHead>
                <TableHead className="text-right">DT GTC ƯT phân bổ</TableHead>
                <TableHead className="text-right">LN ròng trước QC</TableHead>
                <TableHead className="text-right">% chủ mã</TableHead>
                <TableHead className="text-right">LN ròng cá nhân</TableHead>
                <TableHead className="text-right">CPQC/đơn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byMarketer.rows.map((x) => (
                <MarketerNominalRows key={x.marketerId ?? "none"} row={x} ownerSharePct={byMarketer.ownerSharePct} />
              ))}
              {byMarketer.rows.length ? (() => {
                const sum = (f: (x: (typeof byMarketer.rows)[number]) => number) => byMarketer.rows.reduce((t, x) => t + f(x), 0);
                const adSpend = sum((x) => x.adSpend);
                const testSpend = sum((x) => x.testSpend);
                const orders = sum((x) => x.attributedOrders);
                const received = sum((x) => x.ownerBonusReceived);
                const paid = sum((x) => x.ownerBonusPaid);
                const personal = sum((x) => x.personalNet);
                return (
                  <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                    <TableCell>
                      Tổng · {formatNumber(byMarketer.rows.length)} marketer
                      {byMarketer.unattributed || byMarketer.shopRetained ? <div className="text-[10.5px] font-normal text-muted-foreground">chưa gồm phần không phân bổ / shop giữ lại ở các dòng dưới</div> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={adSpend} className="text-rose-600" /></TableCell>
                    <TableCell className="text-right"><Money value={testSpend} className={testSpend ? "text-amber-600" : "text-muted-foreground"} /></TableCell>
                    <TableCell className="text-right"><Money value={sum((x) => x.otherCost)} /></TableCell>
                    <TableCell className="numeric text-right">{formatNumber(orders)}</TableCell>
                    <TableCell className="text-right"><Money value={sum((x) => x.attributedRevenue)} /></TableCell>
                    <TableCell className="text-right"><Money value={sum((x) => x.profitBeforeAds)} /></TableCell>
                    <TableCell className="text-right text-xs font-normal">
                      {received ? <div className="text-emerald-700">+{formatVND(received)}</div> : null}
                      {paid ? <div className="text-rose-600">−{formatVND(paid)}</div> : null}
                      {!received && !paid ? <span className="text-muted-foreground">—</span> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={personal} className={personal >= 0 ? "text-success" : "text-destructive"} /></TableCell>
                    <TableCell className="text-right"><Money value={orders ? Math.round((adSpend + testSpend) / orders) : 0} /></TableCell>
                  </TableRow>
                );
              })() : null}
              {byMarketer.unattributed ? (
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={8}>Mã không có quảng cáo và chưa gán người phụ trách (không phân bổ cho ai)</TableCell>
                  <TableCell className="text-right"><Money value={byMarketer.unattributed} /></TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
              {byMarketer.shopRetained ? (
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={8}>Shop giữ lại (chủ mã chỉ hưởng X% &lt; 100% LN đơn của mình)</TableCell>
                  <TableCell className="text-right"><Money value={byMarketer.shopRetained} /></TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
