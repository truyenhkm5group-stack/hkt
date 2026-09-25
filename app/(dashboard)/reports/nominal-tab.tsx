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
import { InfoHint } from "@/components/info-hint";
import { DataWarnings } from "@/components/data-warnings";
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
import { NewProductRates } from "@/app/(dashboard)/reports/new-product-rates";
import { AdsCeilingTable } from "@/app/(dashboard)/reports/ads-ceiling-table";
import { adsCeiling } from "@/lib/constants/estimated-cost";
import { DELIVERY_RATE_MEASURED } from "@/lib/constants/delivery-rate";
import { PROJECTED_GTC_VERSION } from "@/lib/constants/projected-delivery";
import { TIME_BASES, TIME_BASIS_LABEL, TIME_BASIS_QUESTION, type TimeBasis } from "@/lib/constants/report-time-basis";
import { successTone } from "@/lib/constants/returns";
import { ADS_EXCLUDED_NOTE, NO_ORDER_VALUE_FILTER, orderValueActive, orderValueLabel, type OrderValueFilter } from "@/lib/constants/order-value";
import { OrderValueFilterControl } from "@/components/order-value-filter";
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
  // SỐ ĐƠN ĐÃ KẾT THÚC đứng trước: nó cho biết tỷ lệ này dựa trên bao nhiêu SỰ THẬT của chính mã,
  // còn phần đang giao chỉ là xác suất. Một mã 3 đơn kết thúc phải trông khác một mã 500 đơn.
  projected: (r) => (r.projection ? `${formatNumber(r.projection.finished)} đơn đã kết thúc · ${formatNumber(r.projection.eligibleSent)} đã gửi${r.projection.unmodelledActive ? ` · ${formatNumber(r.projection.unmodelledActive)} ngoài ước tính` : ""}${choLay(r)}` : "mô hình"),
  unmeasured: (r) =>
    r.projection
      ? r.projection.eligibleSent === 0
        ? `chưa gửi đơn nào${choLay(r)}`
        : `chưa đo được · ${formatNumber(r.projection.unmodelledActive)}/${formatNumber(r.projection.active)} đang giao ngoài ước tính${choLay(r)}`
      : "chưa đo được",
  /*
    CO NGÓT phải tự khai ĐỦ BA THỨ: số đo thật của chính mã, mốc neo, và còn bao nhiêu đơn nữa thì
    máy tự đo. Thiếu vế cuối thì chủ shop không biết con số này sẽ đứng yên tới bao giờ.
  */
  blended: (r) =>
    r.blendReason === "MOSTLY_BORROWED"
      ? `${formatNumber(r.rateOwnFinished)} đơn kết thúc · mô hình mượn ${r.borrowedShare === null ? "phần lớn" : `${Math.round(r.borrowedShare * 100)}%`} số của mã khác nên KHÔNG dùng${r.measuredDeliveryRate === null ? "" : ` · mã đang ở ${r.measuredDeliveryRate.toFixed(1)}%`}${choLay(r)}`
      : `${formatNumber(r.rateOwnFinished)}/${formatNumber(r.rateMatureAt)} đơn kết thúc · co ngót về ${(100 - r.baseReturnRate).toFixed(0)}% khai${r.measuredDeliveryRate === null ? "" : ` · mã đang ở ${r.measuredDeliveryRate.toFixed(1)}%`}${choLay(r)}`,
  history: (r) => `lịch sử ${formatNumber(r.historyFinished)} đơn · ước tính theo tỷ lệ`,
  // GIẢ ĐỊNH phải tự khai là giả định, kèm CON SỐ đang dùng — "mặc định" không nói được nó là bao nhiêu.
  default: (r) => `giả định ${(100 - r.baseReturnRate).toFixed(0)}% GTC (Giả định) · chưa đo được${choLay(r)}`,
};

function moTaUocTinh(r: NominalRow): string {
  const dem = `Đã giao TC ${formatNumber(r.delivered)} · không thành công ${formatNumber(r.returned)} · đang giao ${formatNumber(Math.max(0, r.orders - r.delivered - r.returned))}`;
  if (r.returnRateSource === "override") return `${dem} — tỷ lệ do chủ shop gõ tay, thắng mọi nguồn khác; tiền = Doanh số POS × tỷ lệ (ước tính theo tỷ lệ)`;
  if (r.returnRateSource === "projected" && r.projection)
    return `${dem} — ${formatNumber(r.projection.finished)} đơn của chính mã đã có kết cục; phần còn lại cân theo xác suất của chính trạng thái ĐVVC từng đơn đang ở (${PROJECTED_GTC_VERSION}, ${formatNumber(r.projection.eligibleSent)} đơn đã gửi trong kỳ${r.projection.pending ? `, ${formatNumber(r.projection.pending)} chưa gửi cân theo P(chưa rời kho)` : ""}${r.projection.awaitingPickup ? `, ${formatNumber(r.projection.awaitingPickup)} chờ ĐVVC tới lấy — hàng còn trong kho nên KHÔNG ở tử số lẫn mẫu số tỷ lệ` : ""})${r.projection.unmodelledActive ? ` · ${formatNumber(r.projection.unmodelledActive)} đơn ngoài ước tính (${formatVND(r.unmodelledRevenue, { compact: true })})` : ""}`;
  if (r.returnRateSource === "unmeasured" && r.projection?.eligibleSent === 0)
    return `${dem} — CHƯA ĐO ĐƯỢC: mã này chưa có đơn nào rời kho trong kỳ${r.projection.awaitingPickup ? ` (${formatNumber(r.projection.awaitingPickup)} đơn đã có mã vận đơn nhưng ĐVVC chưa cầm hàng)` : ""}. Không có mẫu số thì không có tỷ lệ — “—” KHÔNG phải 0%`;
  if (r.returnRateSource === "unmeasured")
    return `${dem} — CHƯA ĐO ĐƯỢC: phần đang giao ở trạng thái chưa đủ mẫu quá lớn, không lùi về giả định. DT GTC ƯT chỉ gồm phần đã dự báo được; ${formatVND(r.unmodelledRevenue, { compact: true })} doanh số nằm ngoài ước tính`;
  if (r.returnRateSource === "blended" && r.blendReason === "MOSTLY_BORROWED")
    return (
      `${dem} — MÔ HÌNH CHƯA BIẾT GÌ VỀ MÃ NÀY. Mã đã đủ ${formatNumber(r.rateOwnFinished)} đơn kết thúc, nhưng ` +
      `${r.borrowedShare === null ? "phần lớn" : `${Math.round(r.borrowedShare * 100)}%`} tử số dự báo là xác suất MƯỢN của mã khác: ` +
      `hợp đồng ${PROJECTED_GTC_VERSION} đòi 10 quan sát cho MỖI ô (trạng thái ĐVVC × tuổi kiện), và mã này chưa đủ ở ô nào. ` +
      `Nên con số in ra là SỐ ĐO CỦA CHÍNH MÃ${r.measuredDeliveryRate === null ? "" : ` (${r.measuredDeliveryRate.toFixed(1)}% trên ${formatNumber(r.rateOwnFinished)} đơn)`} ` +
      `co ngót về tỷ lệ khai ở Giả định (${(100 - r.baseReturnRate).toFixed(0)}%), KHÔNG phải tỷ lệ nền của toàn shop. ` +
      `Đây là giới hạn của MÔ HÌNH, không phải của thời gian — đợi thêm đơn không làm nó tự hết; ` +
      `muốn chốt một con số thì đặt tay ở bảng “Mã mới · chưa đủ căn cứ”. Tiền = Doanh số POS × tỷ lệ.`
    );
  if (r.returnRateSource === "blended")
    return (
      `${dem} — MÃ CHƯA CHÍN: mới ${formatNumber(r.rateOwnFinished)}/${formatNumber(r.rateMatureAt)} đơn của chính mã đi tới kết cục, chưa đủ để máy tự đo. ` +
      `Con số này là SỐ ĐO CỦA CHÍNH MÃ${r.measuredDeliveryRate === null ? "" : ` (${r.measuredDeliveryRate.toFixed(1)}% trên ${formatNumber(r.rateOwnFinished)} đơn)`} co ngót về tỷ lệ khai ở Giả định ` +
      `(${(100 - r.baseReturnRate).toFixed(0)}%), trọng số mốc neo = ${formatNumber(r.rateMatureAt)} đơn. ` +
      `KHÔNG dùng tỷ lệ nền của toàn shop: một mã hoàn nhiều sẽ kéo tụt dự tính của mọi mã mới. ` +
      `Đủ ${formatNumber(r.rateMatureAt)} đơn kết thúc thì máy tự chuyển sang số đo. Tiền = Doanh số POS × tỷ lệ.`
    );
  if (r.returnRateSource === "history") return `${dem} — mô hình chưa dự báo được cho mã này, dùng tỷ lệ hoàn LỊCH SỬ thật của mã (${formatNumber(r.historyFinished)} đơn đã kết thúc); tiền = Doanh số POS × tỷ lệ`;
  return `${dem} — mã chưa có đơn nào kết thúc nên KHÔNG có tỷ lệ đo được. Đang dùng tỷ lệ GTC khai ở Giả định (${(100 - r.baseReturnRate).toFixed(0)}%) để còn ước lượng được lợi nhuận và margin; tiền = Doanh số POS × tỷ lệ. Đây là GIẢ ĐỊNH — đổi con số ở khối Giả định phía trên là cả cột đổi theo.`;
}

/** Ô "TL GTC ƯT" của một dòng: số + nguồn, KHÔNG có prose; `null` in "—" chứ không in 0% hay 100%. */
/**
 * TÔ MÀU LÀ MỘT KẾT LUẬN. Chỉ tỷ lệ ĐO ĐƯỢC (`projected`, `history`) hoặc do chủ shop tự đặt
 * (`override`) mới được tô; tỷ lệ GIẢ ĐỊNH thì không — xem AGENTS.md §44: chưa kết luận được thì
 * hiện thực tế, KHÔNG tô màu, KHÔNG xếp hạng. Một con số giả định tô xanh trông y hệt một con số
 * đã đo, và đó là cách nhanh nhất để người đọc tin vào thứ chưa ai đo.
 */
function OTyLe({ r }: { r: NominalRow }) {
  /*
    ĐỌC TỪ SỔ KHAI (`DELIVERY_RATE_MEASURED`) thay vì so chuỗi tại chỗ. Phép so cũ (`!== "default"`)
    tô màu cả `override` lẫn `unmeasured`, và sẽ tô luôn `blended` khi bậc ấy ra đời — tức tô một
    con số mà mốc neo đang chiếm hơn nửa trọng số. Thêm một bậc ở sổ khai nay là đủ.
  */
  const doDuoc = r.returnRateSource !== "unmeasured" && DELIVERY_RATE_MEASURED[r.returnRateSource];
  return (
    <>
      <span className={cn("numeric font-semibold", doDuoc ? successTone(r.deliveryRate) : "text-muted-foreground")}>
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

/**
 * ═══════════ Ô SỐ HAI TẦNG — CÁCH BẢNG NÀY HẸP LẠI MÀ KHÔNG BỎ MỘT CON SỐ NÀO ═══════════
 *
 * Bảng "Lợi nhuận danh nghĩa theo mã hàng" từng có 24 cột và `min-w-[1500px]`; bảng "theo hàng
 * nhập" có 17 cột và `min-w-[1200px]`. Màn hình 1440px trừ thanh điều hướng còn chừng 1.150px,
 * nên cả hai luôn phải kéo ngang — và ngay khi kéo, cột "Mã hàng" trôi ra khỏi màn hình. Từ lúc
 * đó mọi phép so sánh theo hàng đều làm bằng trí nhớ, tức là bảng rộng không cho đọc được NHIỀU
 * hơn, nó chỉ cho đọc được ÍT hơn.
 *
 * Cách chữa KHÔNG phải là bỏ cột: mỗi con số ở đây đều có người cần. Những con số vốn luôn được
 * đọc CÙNG NHAU — tiền và số lượng của cùng một thứ, một khoản chi và tỷ lệ của chính nó, lợi
 * nhuận và margin của chính nó — vào chung một ô, con số chính ở trên và phần chi tiết ở dưới.
 * Không có phép cộng nào bị giấu: hai tầng là hai con số riêng, chỉ đứng gần nhau hơn.
 */
function OKep({ children, sub, subTitle, className }: { children: React.ReactNode; sub?: React.ReactNode; subTitle?: string; className?: string }) {
  return (
    <TableCell className={cn("text-right align-top", className)}>
      <div>{children}</div>
      {sub ? (
        <div className="text-[10.5px] font-normal leading-tight text-muted-foreground" title={subTitle}>
          {sub}
        </div>
      ) : null}
    </TableCell>
  );
}

/** Bốn khoản vận hành in dưới tổng — gộp bốn cột thành một ô, KHÔNG gộp bốn con số thành một. */
function chiTietVanHanh(r: { operatingAlloc: number; packingCost: number; opsStaffCost: number; fixedAlloc: number; rescued: number }) {
  const phan = [
    r.operatingAlloc ? `nhập ${formatVND(r.operatingAlloc, { compact: true })}` : null,
    r.packingCost ? `đóng ${formatVND(r.packingCost, { compact: true })}` : null,
    r.opsStaffCost ? `NV ${formatVND(r.opsStaffCost, { compact: true })}` : null,
    r.fixedAlloc ? `cố định ${formatVND(r.fixedAlloc, { compact: true })}` : null,
  ].filter(Boolean);
  if (!phan.length) return null;
  return (
    <span title={`CP vận hành đã nhập ${formatVND(r.operatingAlloc)} · đóng hàng ${formatVND(r.packingCost)} · nhân viên vận đơn ${formatVND(r.opsStaffCost)}${r.rescued ? ` (cứu ước ${formatNumber(r.rescued)} đơn)` : ""} · chi phí cố định ${formatVND(r.fixedAlloc)}`}>
      {phan.join(" · ")}
    </span>
  );
}

/** Một dòng của bảng hàng nhập, hoặc dòng tổng — hai chỗ dùng chung đúng một phép trừ. */
type CoTonKho = Pick<NominalRow, "purchaseQty" | "purchaseCost" | "purchaseCostKnown" | "expectedQty" | "expectedCogs" | "expectedCogsEstimated" | "cogsKnown" | "stockQty" | "stockValue" | "stockKnown" | "outInTransitQty" | "outAwaitingReturnQty">;

/**
 * HÀNG NHẬP − HÀNG ĐÃ TỚI TAY KHÁCH. Không kẹp về 0: số âm nghĩa là trong kỳ bán ra nhiều hơn
 * nhập vào — hoặc hàng đến từ tồn đầu kỳ, hoặc một phiếu nhập còn thiếu. Cả hai đều là việc phải
 * làm, và cả hai biến mất nếu ô in ra 0.
 */
function conLaiUocTinh(r: CoTonKho) {
  return {
    qty: r.purchaseQty - r.expectedQty,
    cost: r.purchaseCost - r.expectedCogs,
    /*
      Hiệu số chỉ biết được khi CẢ HAI vế biết — thiếu một vế thì nó là số trừ đi một ẩn số. Giá vốn
      DỰ TÍNH cũng không được vào đây: đây là phép trừ giữa hai CHỨNG TỪ (phiếu nhập − hàng đã giao),
      và một con số đặt tay trừ vào giá trị phiếu nhập cho ra một "hàng còn lại" không ai đếm được.
    */
    costKnown: r.purchaseCostKnown && r.cogsKnown && r.expectedCogsEstimated === 0,
  };
}

/** Tồn THẬT theo Sổ kho, in ngay dưới phép trừ. Chưa có phiếu nhập nào ⇒ CHƯA BIẾT, không phải 0. */
function nhanSoKho(r: CoTonKho) {
  if (!r.stockKnown) return <span title="Mã chưa có phiếu nhập nào trên ERP ⇒ Sổ kho chưa có cơ sở để nói tồn là bao nhiêu (mục 10)">sổ kho —</span>;
  return <>sổ kho {formatNumber(r.stockQty)}</>;
}

/**
 * VÌ SAO HAI CON SỐ LỆCH NHAU — câu trả lời phải đứng ngay cạnh chúng, không nằm trong đầu người
 * đã đọc mã nguồn. Đo production 21/09/2026 (toàn bộ lịch sử): Q002 nhập 1.374, giao thành công
 * 321, phép trừ ra 1.053 trong khi Sổ kho đếm 352 — 301 cái đang hoàn mà kho chưa lập phiếu tái
 * nhập, phần còn lại đang trên đường.
 */
function giaiThichConLai(r: CoTonKho, conLai: { qty: number }) {
  const cho = [
    r.stockKnown ? `trong kho ${formatNumber(r.stockQty)}` : "trong kho CHƯA BIẾT (mã chưa có phiếu nhập)",
    `đang trên đường ${formatNumber(r.outInTransitQty)}`,
    `hoàn về mà kho chưa lập phiếu tái nhập ${formatNumber(r.outAwaitingReturnQty)}`,
  ].join(" · ");
  const lech = r.stockKnown ? conLai.qty - r.stockQty : null;
  return `Hàng nhập ${formatNumber(r.purchaseQty)} − đã giao thành công (ước tính) ${formatNumber(r.expectedQty)} = ${formatNumber(conLai.qty)} sp shop còn giữ.\nHàng thật đang ở: ${cho}.${lech === null ? "" : `\nChênh với Sổ kho: ${formatNumber(lech)} sp — hàng chưa về kệ chứ không phải lỗi hiển thị.`}\nLƯU Ý: phép trừ chạy TRONG KỲ đang xem (hàng nhập theo mốc nhận hàng, hàng giao theo mốc của cohort), còn Sổ kho là số HIỆN TẠI của toàn bộ lịch sử. Hai con số chỉ so được với nhau ở kỳ “Toàn bộ”.`;
}

/**
 * Trần CPQC hoà vốn của một dòng, in ngay dưới CPQC hiện tại để so bằng mắt — cùng MỘT hàm với bảng
 * “Bàn dự tính” (`adsCeiling`), không có công thức thứ hai. Mã còn sản phẩm chưa biết giá vốn thì
 * trần đang cao hơn thật, và ô nói ra điều đó thay vì in một con số trông chắc chắn.
 */
function TranHoaVon({ r, otherPct }: { r: NominalRow; otherPct: number }) {
  const c = adsCeiling({ netProfit: r.netProfit, adSpend: r.adSpend, otherCost: r.otherCost, expectedRevenue: r.expectedRevenue, posSales: r.salesAfterDiscount, orders: r.orders, otherCostPercentOfAds: otherPct, targetMarginPct: null });
  if (c.breakEven.overPosSales === null) return null;
  return (
    <div title={`Trần CPQC hoà vốn = (LN danh nghĩa + CPQC + CP khác) ÷ (1 + ${otherPct}%) = ${formatVND(c.breakEven.spend)} cả kỳ${r.cogsUncoveredQty ? ` — CAO HƠN THẬT vì ${formatNumber(r.cogsUncoveredQty)} sp đang tính giá vốn 0 ₫` : ""}`}>
      {c.breakEven.spend <= 0 ? "lỗ cả khi không QC" : <>hoà vốn ≤ {c.breakEven.overPosSales.toFixed(1)}% DS{r.cogsUncoveredQty ? " ⚠" : ""}</>}
    </div>
  );
}

export async function NominalTab({
  period,
  productId,
  tabQuery,
  canWrite,
  basis = "ORDERED",
  value = NO_ORDER_VALUE_FILTER,
  includeAds = true,
  targetMargin = null,
}: {
  period: Period;
  productId: string;
  tabQuery: string;
  canWrite: boolean;
  /** Mốc gán đơn vào kỳ. Mặc định ngày tạo đơn — xem `mocCuaBasis` ở lib/queries/profit-nominal.ts. */
  basis?: TimeBasis;
  /** Khoảng giá trị đơn đang lọc — xem `lib/constants/order-value.ts`. */
  value?: OrderValueFilter;
  /** Công tắc CPQC: `false` ⇒ CPQC hiện 0 và lợi nhuận không trừ quảng cáo. */
  includeAds?: boolean;
  /** Biên LN người xem gõ (`?bien=`) để tính trần CPQC giữ biên — `null` = chỉ tính trần hoà vốn. */
  targetMargin?: number | null;
}) {
  /*
    BẢNG MARKETER CỐ Ý Ở LẠI MỐC NGÀY TẠO ĐƠN.

    Nó ghi đơn cho người phụ trách fanpage TẠI MỐC ĐƠN LÊN; đổi mốc cohort sang ngày gửi là hỏi
    một câu mà cách ghi nhận ấy không trả lời được. Chú thích dưới bảng nói ra điều đó thay vì để
    hai khối trên cùng màn hình lặng lẽ đứng trên hai tập đơn.
  */
  const dangLocGiaTri = orderValueActive(value);
  /*
    BẢNG MARKETER NHẬN CÙNG BỘ LỌC với bảng theo mã: hai bảng đứng trên cùng một trang, dưới cùng
    một tiêu đề kỳ. Để một bảng lọc còn bảng kia đọc cả kỳ là đặt hai tập đơn khác nhau cạnh nhau
    mà không ai biết — rồi người đọc sẽ cộng chúng lại.
  */
  /*
    TAB NÀY — VÀ CHỈ TAB NÀY — BẬT GIÁ VỐN DỰ TÍNH (`lib/constants/estimated-cost.ts`). Bảng marketer
    đứng trên cùng trang nên bật theo, để hai bảng nói cùng một lợi nhuận cho cùng một mã; bảng
    lương và trang Quảng cáo gọi hai hàm này không tham số nên không bao giờ thấy giá đoán.
  */
  const [report, byMarketer] = await Promise.all([
    getNominalProfitReport(period, basis, value, includeAds, true),
    getNominalMarketerBreakdown(period, value, includeAds, true),
  ]);
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
        selected.estimatedCost?.unitCost ?? null,
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
        extraResetKeys={["vmin", "vmax", "ads"]}
        resultLabel={
          <span className="inline-flex items-center gap-1">
            Mốc: {TIME_BASIS_LABEL[basis]}
            <InfoHint>{`${TIME_BASIS_QUESTION[basis]} Cùng mốc + cùng mã ⇒ trang Tỷ lệ giao thành công phải ra cùng một tỷ lệ GTC ước tính. Chi phí quảng cáo và chi phí vận hành luôn theo NGÀY PHÁT SINH của chính chúng, không đổi theo mốc này; bảng theo marketer giữ mốc ngày tạo đơn vì nó ghi đơn theo người phụ trách fanpage tại lúc đơn lên.`}</InfoHint>
          </span>
        }
      >
        <OrderValueFilterControl value={value} showAds adsIncluded={includeAds} />
      </DataTableToolbar>

      {/*
        ═══ ĐANG XEM MỘT LÁT CẮT THÌ PHẢI NÓI RA, Ở CHỖ KHÔNG BỎ QUA ĐƯỢC ═══

        Hai lời khai khác nhau, hai hậu quả khác nhau:
         · LỌC GIÁ TRỊ ĐƠN — các con số vẫn cộng ra được tổng kỳ (chi phí chung chia theo tỷ trọng
           doanh số), nhưng đây KHÔNG phải toàn bộ đơn của kỳ.
         · TẮT CPQC — con số lợi nhuận KHÔNG cộng ra được lợi nhuận thật, vì tiền quảng cáo vẫn đã
           tiêu. Cảnh báo này tô đậm hơn đúng vì nó dễ bị đọc nhầm hơn.
      */}
      {dangLocGiaTri || !includeAds ? (
        <div className={cn("rounded-xl border px-4 py-2.5 text-[12.5px] leading-5", includeAds ? "border-primary/30 bg-primary/5" : "border-amber-400/60 bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100")}>
          {dangLocGiaTri ? (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <b>{orderValueLabel(value)}</b> · <b>{(report.costShare * 100).toFixed(1)}%</b> doanh số của kỳ
              <InfoHint>
                Chỉ tính đơn có tiền hàng sau giảm giá trong khoảng này (chưa gồm cước, lấy theo CẢ ĐƠN). Chi phí quảng cáo và chi phí vận hành chung được chia
                theo tỷ trọng doanh số của tập này.
              </InfoHint>
              <DataWarnings items={report.unknownValueOrders ? [`${formatNumber(report.unknownValueOrders)} đơn không khai được giá trị (tổng tiền bằng 0) nằm ngoài bộ lọc — chưa biết, không phải đơn 0đ.`] : []} />
            </p>
          ) : null}
          {!includeAds ? (
            <p className={cn("flex items-center gap-1.5", dangLocGiaTri && "mt-1")}>
              <b>KHÔNG tính chi phí quảng cáo.</b>
              <InfoHint>{ADS_EXCLUDED_NOTE}</InfoHint>
            </p>
          ) : null}
        </div>
      ) : null}

      <AssumptionsForm assumptions={report.assumptions} canWrite={canWrite} />

      <CostQualityPanel period={period} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          label="Doanh số POS (đơn lên)"
          value={formatVND(t.grossSales, { compact: true })}
          hint="Không tính đơn huỷ."
          note={`${formatNumber(t.orders)} đơn · ${formatNumber(t.items)} sản phẩm`}
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
          hint={report.unmatchedAdSpend ? "Phần chưa quy kết trừ vào tổng, không rải vào mã nào." : undefined}
          value={formatVND(t.adSpend, { compact: true })}
          note={
            report.unmatchedAdSpend
              ? `${formatVND(t.adSpendAttributed, { compact: true })} đã quy kết theo mã · ${formatVND(report.unmatchedAdSpend, { compact: true })} chưa quy kết`
              : "Đã quy kết hết theo mã hàng"
          }
          icon={Megaphone}
          tone="rose"
        />
        <MetricCard
          label="Chi phí ngoài hàng · QC · vận chuyển"
          hint={`Gồm: vận hành ${formatVND(t.opexTotal, { compact: true })} + rủi ro TK ${formatVND(t.inventoryRisk, { compact: true })} + thuế ${formatVND(t.tax, { compact: true })} + CP khác ${formatVND(t.otherCost, { compact: true })}`}
          value={formatVND(t.otherCostsTotal, { compact: true })}
          note={`${formatVND(t.opexPerOrder)}/đơn lên · ${formatVND(t.opexPerDelivered)}/đơn GTC ước tính`}
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
          hint={`= DT GTC ƯT − giá vốn − vận chuyển − CPQC − vận hành ${formatVND(t.opexTotal, { compact: true })} (đã nhập ${formatVND(t.operatingExpenses, { compact: true })} · ${formatNumber(report.operatingCount)} khoản, đóng hàng ${formatVND(t.packingCost, { compact: true })}, NV vận đơn ${formatVND(t.opsStaffCost, { compact: true })} · cứu ước ${formatNumber(t.rescued)} đơn, cố định ${formatVND(t.fixedCost, { compact: true })} · ${report.periodMonths} tháng) − rủi ro TK ${formatVND(t.inventoryRisk, { compact: true })} (${riskPct}% giá vốn hàng bán ${formatVND(t.expectedCogs, { compact: true })}; còn treo trên tồn ${formatVND(t.inventoryRiskPending, { compact: true })}) − thuế ${formatVND(t.tax, { compact: true })} − CP khác ${formatVND(t.otherCost, { compact: true })}`}
          note={
            <>
              Margin {t.netMargin !== null ? `${t.netMargin.toFixed(1)}%` : "—"}{" "}
              <DataWarnings
                items={[
                  t.expectedCogsEstimated ? `Giá vốn gồm ${formatVND(t.expectedCogsEstimated, { compact: true })} DỰ TÍNH (${formatNumber(t.estimatedCostProducts)} mã chưa có giá nhập)` : null,
                  !t.cogsKnown ? `${formatNumber(t.cogsUncoveredQty)} sản phẩm CHƯA BIẾT giá vốn (đang tính 0đ)` : null,
                ]}
              />
            </>
          }
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
          hint={`Ước tính giao được ÷ (đã gửi − đơn ngoài ước tính), trong đó ước tính giao được = đã giao thật (ORDER_OUTCOME) + Σ(đơn đang giao × xác suất giao được của trạng thái ĐVVC nó đang ở). Đơn chưa gửi, đơn CHỜ ĐVVC TỚI LẤY (hàng còn trong kho) và đơn huỷ không ở tử số lẫn mẫu số. ${PROJECTED_GTC_VERSION}, mốc ngày chốt đơn — cùng hợp đồng với trang Tỷ lệ giao thành công theo mã hàng. “—” = chưa đo được (không phải 0%).${t.assumedDeliveryRate !== null && t.weightedDeliveryRate !== null && Math.abs(t.assumedDeliveryRate - t.weightedDeliveryRate) >= 0.05 ? ` Bình quân tỷ lệ đang dùng trong bảng (gồm ghi đè/lịch sử): ${t.assumedDeliveryRate.toFixed(1)}%.` : ""}${pj?.awaitingPickup ? " Đơn chờ ĐVVC lấy nằm ngoài tỷ lệ." : ""}`}
          value={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className={successTone(t.weightedDeliveryRate)}>{t.weightedDeliveryRate !== null ? `${t.weightedDeliveryRate.toFixed(1)}%` : "—"}</span>
              {pj ? <ProjectionConfidence backtest={pj.backtest} error={pj.backtestError} /> : null}
            </span>
          }
          note={
            t.projectionError ? (
              <>
                LỖI khi tính ước tính <DataWarnings tone="danger" items={[`LỖI khi tính ước tính: ${t.projectionError}`]} />
              </>
            ) : (
              `${pj ? `${formatNumber(pj.eligibleSent)} đơn đã gửi · ${formatNumber(pj.active)} đang giao${pj.unmodelledActive ? ` (${formatNumber(pj.unmodelledActive)} ngoài ước tính)` : ""}${pj.awaitingPickup ? ` · ${formatNumber(pj.awaitingPickup)} chờ ĐVVC lấy` : ""}` : "chưa có cohort"} · thực tế ${formatNumber(t.delivered)} giao TC, ${formatNumber(t.returned)} không TC`
            )
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
        description={period.label}
        hint={
          <>
            <p className="mb-2">
              Mỗi mã: đơn ĐÃ XÁC NHẬN lên trong kỳ, CPQC Facebook ghép theo tên chiến dịch. Cột nhỏ dưới mỗi con số là phần chi tiết của chính nó. Bấm mã để xem theo ngày.
            </p>
            <p>
              Tỷ lệ và doanh thu GTC ước tính (đơn GTC theo ORDER_OUTCOME) dùng CÙNG hợp đồng với trang Tỷ lệ giao thành công
              theo mã hàng ({PROJECTED_GTC_VERSION}): mỗi đơn chưa có kết cục được cân theo xác suất của CHÍNH trạng thái
              Viettel Post nó đang ở, học từ vận đơn đã kết thúc và đủ chín. Mã có cohort mà chưa đo được thì in “—” (không lùi
              về giả định); chỉ mã KHÔNG có đơn nào trong cohort mới dùng tỷ lệ hoàn {report.assumptions.returnRateWindowDays}{" "}
              ngày của mã, và tiền của mã đó mang nhãn “ước tính theo tỷ lệ”. Cột nhỏ dưới mỗi tỷ lệ nói rõ nguồn.
            </p>
            <p className="mt-2">
              Bảng gộp những con số vốn phải đọc CÙNG NHAU vào một ô hai tầng (tiền ở trên, phần chi tiết ở dưới) thay vì tách
              thành hai mươi tư cột. Thanh cuộn ngang làm người đọc mất cột “Mã hàng” ngay khi kéo, nên mọi phép so sánh theo
              hàng phải làm bằng trí nhớ. Không con số nào bị bỏ đi — nút “Cột” ở góc bảng vẫn ẩn/hiện được từng cột.
            </p>
            <p className="mt-2">
              Công thức mỗi mã (TL GTC = tỷ lệ giao thành công ước tính, đơn GTC theo ORDER_OUTCOME): DT GTC ước tính = DT đơn đã giao thật + Σ(DT
              từng đơn đang giao × xác suất giao được của trạng thái ĐVVC nó đang ở) + Σ(DT đơn chưa gửi × P(chưa gửi)) — cân theo TỪNG ĐƠN; giá
              vốn cân cùng cách. Chỉ dòng mang nhãn “ước tính theo tỷ lệ” (ghi đè tay / lịch sử / mặc định) mới là Doanh số POS × TL GTC và Giá
              vốn = SP × giá nhập × TL GTC. Đơn ở trạng thái chưa đủ mẫu nằm NGOÀI ước tính (dòng “ngoài ƯT”). Vận chuyển = Đơn × cước gửi + Đơn
              × (1 − TL GTC) × phí hoàn về (tức Đơn × [TL GTC × cước gửi + (1 − TL GTC)
              × cước đơn hoàn đi + về]), cộng khoản cước / phí hoàn điều chỉnh tay có lý do ở bảng Chi phí (tiền thật, chia theo số đơn của mã
              {t.logisticsAdjustment.amount ? ` — kỳ này ${formatVND(t.logisticsAdjustment.amount)} từ ${t.logisticsAdjustment.count} khoản` : ""}). LN danh nghĩa = DT − giá vốn − vận chuyển
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
            </p>
          </>
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1120px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right" title="Tiền hàng của mã trên đơn đã xác nhận trong kỳ (trước hoàn huỷ). Dòng nhỏ: số đơn và số sản phẩm.">Doanh số POS</TableHead>
                {/*
                  HAI TỶ LỆ QUẢNG CÁO — MẪU SỐ KHÁC NHAU CÓ CHỦ ĐÍCH, KHÔNG THAY THẾ CHO NHAU.

                  Một bên chia cho tiền khách CHỐT, một bên chia cho tiền dự kiến THẬT SỰ TỚI TAY
                  KHÁCH. Tỷ lệ đầu luôn đẹp hơn vì mẫu số chưa trừ đơn hoàn; đọc nhầm nó thành
                  hiệu quả quảng cáo là lý do người ta tăng ngân sách cho một mã đang lỗ. Gộp vào
                  một ô KHÔNG phải gộp hai con số: chúng vẫn in cạnh nhau, vẫn mang nhãn riêng.
                */}
                <TableHead className="text-right" title="Chi quảng cáo đã quy kết về mã trong kỳ. Dòng nhỏ, theo thứ tự: tỷ lệ trên DOANH SỐ POS (mẫu số chưa trừ đơn hoàn — luôn đẹp hơn), tỷ lệ trên DT GIAO THÀNH CÔNG ƯỚC TÍNH, và chi phí quảng cáo trên mỗi đơn. Mẫu số bằng 0 hoặc chưa quy kết được ⇒ “—”, KHÔNG hiện 0%.">CPQC</TableHead>
                <TableHead className="text-right" title="Tỷ lệ giao thành công ước tính = ước tính giao được ÷ (đã gửi − ngoài ước tính); đơn GTC theo ORDER_OUTCOME. “—” = chưa đo được.">TL GTC ƯT</TableHead>
                <TableHead className="text-right" title="DT đơn đã giao thật + Σ(DT đơn đang giao × P(trạng thái)) + Σ(DT đơn chưa gửi × P(chưa gửi)) — cân theo TỪNG ĐƠN. Dòng có nhãn “ước tính theo tỷ lệ” (ghi đè / lịch sử / mặc định) mới là Doanh số POS × TL GTC. Dòng nhỏ: doanh thu trên mỗi đơn, và phần doanh số nằm NGOÀI ước tính (nếu có).">DT GTC ƯT</TableHead>
                <TableHead className="text-right" title="Giá vốn cân theo từng đơn cùng cách với DT GTC ƯT. Dòng nhỏ: số sản phẩm giao thành công ước tính. Tiền “—” = có sản phẩm chưa biết giá vốn (không phiếu nhập, không giá Pancake); SỐ LƯỢNG vẫn đo được nên vẫn in ra.">Giá vốn</TableHead>
                <TableHead className="text-right" title="Đơn × cước gửi + Đơn × (1 − TL GTC) × phí hoàn về, + phần cước / phí hoàn điều chỉnh tay có lý do chia theo số đơn. Sửa đơn giá ở khối Giả định.">Vận chuyển</TableHead>
                <TableHead className="text-right" title="Tổng vận hành = CP vận hành đã nhập (bảng Chi phí, trừ QC & nhập hàng, phân bổ theo doanh số POS) + đóng hàng + nhân viên vận đơn + chi phí cố định. Dòng nhỏ tách đủ bốn khoản.">Vận hành</TableHead>
                <TableHead className="text-right" title="Mọi chi phí ngoài tiền hàng, QC, vận chuyển ÷ số đơn LÊN (trước hoàn huỷ). Dòng nhỏ: cùng các chi phí ấy ÷ số đơn GIAO THÀNH CÔNG ước tính (sau hoàn huỷ) — con số thứ hai mới là chi phí thật của một đơn thành công.">CP VH/đơn</TableHead>
                <TableHead className="text-right" title="Dự phòng rủi ro tồn kho ghi vào kỳ = % giả định × GIÁ VỐN HÀNG BÁN RA trong kỳ. Không tính trên giá trị hàng nhập: nhập hàng là sự kiện một lần, ném trọn vào kỳ chứa nó thì tuần chỉ bán được 1/10 lô vẫn gánh đủ dự phòng cả lô. Dòng nhỏ “còn treo” là rủi ro của hàng CHƯA BÁN — chưa trừ vào lợi nhuận kỳ này. “—” = chưa biết giá vốn nên chưa tính được.">Rủi ro TK</TableHead>
                <TableHead className="text-right" title="Thuế = DT GTC ước tính × %. Dòng nhỏ: chi phí khác = CPQC × % (phí thanh toán thẻ ngoại tệ khi Meta thu tiền).">Thuế · khác</TableHead>
                <TableHead className="text-right" title="Lợi nhuận danh nghĩa = DT GTC ước tính − giá vốn − vận chuyển − CPQC − vận hành − rủi ro TK − thuế − CP khác. Dòng nhỏ: margin trên DT GTC ước tính.">LN danh nghĩa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={12}
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
                    <TableCell className="align-top">
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
                    <OKep sub={`${formatNumber(r.orders)} đơn · ${formatNumber(r.items)} sp`}>
                      <Money value={r.grossSales} />
                    </OKep>
                    <OKep
                      sub={
                        <>
                          <Pct value={r.ads.overPosSales} tone={false} /> DS · <Pct value={r.ads.overProjectedRevenue} tone={false} /> DT ƯT
                          {r.cpo === null ? null : <> · {formatVND(Math.round(r.cpo), { compact: true })}/đơn</>}
                          <TranHoaVon r={r} otherPct={report.assumptions.otherCostPercentOfAds ?? 0} />
                        </>
                      }
                    >
                      <Money value={r.adSpend} className={r.adSpend ? "text-rose-600" : "text-muted-foreground"} />
                    </OKep>
                    <TableCell className="text-right align-top">
                      <OTyLe r={r} />
                    </TableCell>
                    <OKep
                      sub={
                        <>
                          {r.revenuePerOrder === null ? null : <>{formatVND(Math.round(r.revenuePerOrder), { compact: true })}/đơn</>}
                          {r.unmodelledRevenue ? <div title="Doanh số của đơn ở trạng thái chưa đủ mẫu — không nằm trong DT GTC ƯT">ngoài ƯT {formatVND(r.unmodelledRevenue, { compact: true })}</div> : null}
                        </>
                      }
                    >
                      <Money value={r.expectedRevenue} className="font-semibold" />
                    </OKep>
                    <OKep sub={<>{formatNumber(r.expectedQty)} sp{r.expectedCogsEstimated ? <span title={`${formatVND(r.expectedCogsEstimated)} trong ô này là giá vốn DỰ TÍNH ${formatVND(r.estimatedCost?.unitCost ?? 0)}/sp (${r.estimatedCost?.setBy ?? "—"}) cho ${formatNumber(r.cogsUnknownQty)} sp chưa có phiếu nhập / giá Pancake — sửa ở bảng “Bàn dự tính” bên dưới`}> · gồm {formatVND(r.expectedCogsEstimated, { compact: true })} dự tính</span> : null}</>}>
                      <TienCoTheChuaBiet value={r.expectedCogs} known={r.cogsKnown} reason={`${formatNumber(r.cogsUncoveredQty)} sản phẩm chưa biết giá vốn (không phiếu nhập, không giá Pancake) — giá vốn đang bị tính 0đ nên không in ra. Đặt giá dự tính ở bảng “Bàn dự tính” bên dưới.`} className={r.expectedCogsEstimated ? "italic text-muted-foreground" : "text-muted-foreground"} />
                    </OKep>
                    <OKep><Money value={r.shipCost} className="text-muted-foreground" /></OKep>
                    <OKep sub={chiTietVanHanh(r)}>
                      <Money value={r.opexTotal} className="text-muted-foreground" />
                    </OKep>
                    <OKep sub={r.opexPerDelivered === null ? "sau hoàn —" : <>sau hoàn {formatVND(r.opexPerDelivered, { compact: true })}</>}>
                      <Money value={r.opexPerOrder} className="text-muted-foreground" />
                    </OKep>
                    <OKep sub={r.inventoryRiskPending ? <span title="Rủi ro của hàng CÒN TRONG KHO — chưa trừ vào lợi nhuận kỳ này, sẽ được ghi dần khi hàng bán ra">còn treo {formatVND(r.inventoryRiskPending, { compact: true })}</span> : null}>
                      <TienCoTheChuaBiet value={r.inventoryRisk} known={r.cogsKnown} reason="Chưa biết giá vốn hàng bán ⇒ chưa tính được dự phòng rủi ro (không phải rủi ro = 0)" className="text-muted-foreground" />
                    </OKep>
                    <OKep sub={<>khác <Money value={r.otherCost} /></>}>
                      <Money value={r.tax} className="text-muted-foreground" />
                    </OKep>
                    <OKep sub={<Pct value={r.netMargin} />}>
                      <Money
                        value={r.netProfit}
                        className={cn(
                          "font-bold",
                          r.netProfit >= 0 ? "text-success" : "text-destructive",
                        )}
                      />
                    </OKep>
                  </TableRow>
                ))
              )}
              {report.rows.length ? (
                <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                  <TableCell className="align-top">
                    Tổng
                    {report.unmatchedAdSpend ? (
                      <div className="text-[10.5px] font-normal text-muted-foreground" title="Tiền quảng cáo chưa ghép được mã hàng: trừ vào tổng, KHÔNG rải vào dòng nào. Hai cột tỷ lệ QC ở dòng tổng chỉ tính phần ĐÃ quy kết để khớp Σ các dòng.">
                        + {formatVND(report.unmatchedAdSpend)} QC chưa quy kết
                      </div>
                    ) : null}
                  </TableCell>
                  <OKep sub={`${formatNumber(t.orders)} đơn · ${formatNumber(t.items)} sp`}>
                    <Money value={t.grossSales} />
                  </OKep>
                  <OKep
                    sub={
                      <span title={`CPQC đã quy kết ${formatVND(t.adSpendAttributed)} — tỷ lệ ở dòng tổng chỉ tính phần đã quy kết`}>
                        <Pct value={t.adsAttributed.overPosSales} tone={false} /> DS · <Pct value={t.adsAttributed.overProjectedRevenue} tone={false} /> DT ƯT
                        {t.orders ? <> · {formatVND(Math.round(t.adSpend / t.orders), { compact: true })}/đơn</> : null}
                      </span>
                    }
                  >
                    <Money value={t.adSpend} className="text-rose-600" />
                  </OKep>
                  <TableCell className="text-right align-top">
                    <span className="inline-flex items-center justify-end gap-1">
                      <Pct value={t.weightedDeliveryRate} tone={false} />
                      {pj ? <ProjectionConfidence backtest={pj.backtest} error={pj.backtestError} /> : null}
                    </span>
                  </TableCell>
                  <OKep
                    sub={
                      <>
                        {t.orders ? <>{formatVND(Math.round(t.expectedRevenue / t.orders), { compact: true })}/đơn</> : null}
                        {t.unmodelledRevenue ? <div className="font-normal">ngoài ƯT {formatVND(t.unmodelledRevenue, { compact: true })}</div> : null}
                      </>
                    }
                  >
                    <Money value={t.expectedRevenue} />
                  </OKep>
                  <OKep sub={<>{formatNumber(t.expectedQty)} sp{t.expectedCogsEstimated ? <> · gồm {formatVND(t.expectedCogsEstimated, { compact: true })} dự tính</> : null}</>}>
                    <TienCoTheChuaBiet value={t.expectedCogs} known={t.cogsKnown} reason={`${formatNumber(t.cogsUncoveredQty)} sản phẩm chưa biết giá vốn — tổng giá vốn đang thiếu phần đó`} />
                  </OKep>
                  <OKep><Money value={t.shipCost} /></OKep>
                  <OKep sub={chiTietVanHanh({ operatingAlloc: t.operatingExpenses, packingCost: t.packingCost, opsStaffCost: t.opsStaffCost, fixedAlloc: t.fixedCost, rescued: t.rescued })}>
                    <Money value={t.opexTotal} />
                  </OKep>
                  <OKep sub={t.opexPerDelivered === null ? "sau hoàn —" : <>sau hoàn {formatVND(t.opexPerDelivered, { compact: true })}</>}>
                    <Money value={t.opexPerOrder} />
                  </OKep>
                  <OKep sub={t.inventoryRiskPending ? <span title={`Rủi ro của hàng còn trong kho (${formatVND(t.stockValue, { compact: true })} giá trị tồn) — chưa trừ vào lợi nhuận kỳ này`}>còn treo {formatVND(t.inventoryRiskPending, { compact: true })}</span> : null}>
                    <TienCoTheChuaBiet value={t.inventoryRisk} known={t.cogsKnown} reason="Có sản phẩm chưa biết giá vốn ⇒ dự phòng rủi ro chưa tính đủ" />
                  </OKep>
                  <OKep sub={<>khác <Money value={t.otherCost} /></>}>
                    <Money value={t.tax} />
                  </OKep>
                  <OKep sub={<Pct value={t.netMargin} />}>
                    <Money
                      value={t.netProfit}
                      className={t.netProfit >= 0 ? "text-success" : "text-destructive"}
                    />
                  </OKep>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <AdsCeilingTable report={report} canWrite={canWrite} targetMargin={targetMargin} />

      <NewProductRates rows={report.rows} assumptions={report.assumptions} canWrite={canWrite} />

      {selected ? (
        <div id="ma-hang">
          <SectionCard
            title={`${selected.productName}${selected.code ? ` (${selected.code})` : ""} · theo ngày`}
            description={`TL GTC ƯT ${selected.deliveryRate === null ? "—" : `${selected.deliveryRate.toFixed(1)}%`} · theo ngày ${(100 - dailyRate).toFixed(1)}% · giá vốn ${selected.expectedQty && selected.cogsKnown ? formatVND(Math.round(selected.expectedCogs / selected.expectedQty)) : "—"}/sp`}
            hint={`Tỷ lệ giao thành công ước tính ${selected.deliveryRate === null ? "— (chưa đo được)" : `${selected.deliveryRate.toFixed(1)}%`} (${moTaUocTinh(selected)}) · bảng theo ngày tính theo tỷ lệ ${(100 - dailyRate).toFixed(1)}%${selected.returnRate === null ? " (tỷ lệ lịch sử của mã, vì mô hình chưa đo được)" : ""} · giá vốn ${selected.expectedQty && selected.cogsKnown ? formatVND(Math.round(selected.expectedCogs / selected.expectedQty)) : "—"}/sp${selected.estimatedCost ? ` (gồm giá DỰ TÍNH ${formatVND(selected.estimatedCost.unitCost)}/sp cho sản phẩm chưa có phiếu nhập)` : ""}`}
            actions={
              <div className="flex items-center gap-3">
                <ReturnRateOverride
                  productId={selected.productId}
                  assumptions={report.assumptions}
                  current={selected.deliveryRate ?? Math.round((100 - selected.baseReturnRate) * 10) / 10}
                  source={selected.returnRateSource}
                  canWrite={canWrite}
                  mature={selected.rateMature}
                />
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/reports?${tabQuery}`}>Đóng</Link>
                </Button>
              </div>
            }
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[820px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead className="text-right" title="Tiền hàng của mã trên đơn đã xác nhận trong ngày. Dòng nhỏ: số đơn và số sản phẩm.">Doanh số POS</TableHead>
                    <TableHead className="text-right" title="Chi quảng cáo của ngày. Dòng nhỏ: chi phí quảng cáo trên mỗi đơn.">CPQC</TableHead>
                    <TableHead className="text-right">DT GTC ƯT</TableHead>
                    <TableHead className="text-right" title="Giá vốn hàng giao thành công ước tính của ngày. Dòng nhỏ: số sản phẩm. Tiền “—” = có sản phẩm chưa biết giá vốn; SỐ LƯỢNG vẫn đo được nên vẫn in ra.">Giá vốn</TableHead>
                    <TableHead className="text-right">Vận chuyển</TableHead>
                    <TableHead className="text-right" title="Theo ngày chỉ có DT − giá vốn − vận chuyển − CPQC (chưa trừ vận hành, rủi ro TK, thuế, CP khác vì các khoản này tính theo kỳ). Dòng nhỏ: margin gộp.">LN gộp sau QC</TableHead>
                    <TableHead className="text-right">Thực tế</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {daily.map((d) => (
                    <TableRow key={d.day}>
                      <TableCell className="align-top font-medium">
                        {d.day.split("-").reverse().join("/")}
                      </TableCell>
                      <OKep sub={`${formatNumber(d.orders)} đơn · ${formatNumber(d.items)} sp`}>
                        <Money value={d.grossSales} />
                      </OKep>
                      <OKep sub={d.cpo === null ? null : <>{formatVND(Math.round(d.cpo), { compact: true })}/đơn</>}>
                        <Money value={d.adSpend} className={d.adSpend ? "text-rose-600" : "text-muted-foreground"} />
                      </OKep>
                      <OKep><Money value={d.expectedRevenue} className="font-semibold" /></OKep>
                      <OKep sub={`${formatNumber(d.expectedQty)} sp`}>
                        <TienCoTheChuaBiet value={d.expectedCogs} known={d.cogsKnown} reason={`${formatNumber(d.cogsUnknownQty)} sản phẩm của ngày này chưa biết giá vốn — giá vốn đang bị tính 0đ nên KHÔNG in ra; số lượng bên dưới vẫn đo được`} className="text-muted-foreground" />
                      </OKep>
                      <OKep><Money value={d.shipCost} className="text-muted-foreground" /></OKep>
                      <OKep sub={<Pct value={d.margin} />}>
                        <Money
                          value={d.expectedProfit}
                          className={cn(
                            "font-bold",
                            d.expectedProfit >= 0
                              ? "text-success"
                              : "text-destructive",
                          )}
                        />
                      </OKep>
                      <TableCell className="align-top text-right text-xs text-muted-foreground">
                        giao {d.delivered} · hoàn {d.returned}
                      </TableCell>
                    </TableRow>
                  ))}
                  {daily.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={8}
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
        description={`${period.label} · hàng nhập ${formatNumber(t.purchaseQty)} sp · ${formatVND(t.purchaseCost, { compact: true })}`}
        hint={
          <>
            <p className="mb-2">
              Thay giá vốn hàng giao ước tính bằng TOÀN BỘ giá trị hàng nhập trong kỳ theo phiếu nhập. Ba cột đầu là một phép trừ:
              hàng nhập − hàng đã giao tới khách = hàng shop còn giữ.
            </p>
            <p>
              LN = DT GTC ước tính − CPQC − hàng nhập − vận chuyển − tổng vận hành (đã nhập + đóng hàng + NV vận đơn + cố định)
              − CP rủi ro tồn kho phân bổ cho kỳ (theo giá vốn hàng BÁN RA, cùng một con số với bảng trên — không theo giá trị
              hàng nhập) − thuế − CP khác. Thấp hơn bảng trên đúng bằng phần hàng nhập còn tồn chưa bán; mã nhập hàng mà chưa có
              đơn vẫn được liệt kê.
            </p>
            <p className="mt-2">
              <b>Cột “Còn lại ƯT” là một PHÉP TRỪ, không phải số đếm kho.</b> Nó bằng tồn kho thật chỉ khi ba điều cùng đúng:
              kỳ đang xem phủ toàn bộ lịch sử, hàng hoàn đã được kho đếm lại, và không còn kiện nào trên đường. Đo production
              21/09/2026 trên toàn bộ lịch sử, mã Q002: nhập 1.374 sản phẩm, mới 321 sản phẩm ĐÃ CÓ KẾT CỤC “giao thành công”,
              phép trừ ra 1.053 cái — trong khi SỔ KHO đếm được 352 cái. Chênh 701 cái, vì 301 cái đang hoàn mà kho chưa lập
              phiếu tái nhập (mục 10) và phần còn lại đang trên đường. Cột trên màn hình dùng số ƯỚC TÍNH (đã giao thật + đang
              giao × xác suất) nên nhỉnh hơn 321 một chút, còn khoảng cách với sổ kho thì vẫn nguyên. Nên con số sổ kho in ngay
              dưới phép trừ; hai số lệch nhau nhiều là việc phải làm, không phải lỗi hiển thị.
            </p>
            <p className="mt-2">
              Hai vế của phép trừ còn đứng trên hai CÁCH ĐỊNH GIÁ: giá trị hàng nhập lấy đơn giá ghi trên CHÍNH phiếu nhập đó,
              còn giá vốn ước tính lấy đơn giá của phiếu nhập GẦN NHẤT. Mã đổi giá nhập giữa các lô thì hiệu số mang cả phần
              chênh giá, không chỉ phần chênh số lượng.
            </p>
          </>
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right" title="Toàn bộ phiếu nhập kho (kind RECEIPT) có mốc nhận hàng trong kỳ: giá trị ở trên, số lượng ở dưới. Phiếu không ghi đơn giá ⇒ giá trị CHƯA BIẾT, in “—”.">Hàng nhập</TableHead>
                <TableHead className="text-right" title="Hàng ĐÃ TỚI TAY KHÁCH, ước tính: giá vốn ở trên, số sản phẩm ở dưới. Cân theo TỪNG ĐƠN cùng một phép cân với cột DT GTC ƯT (đã giao thật + đang giao × P + chưa rời kho × P). Giá vốn “—” = mã chưa biết giá nhập; SỐ LƯỢNG vẫn đo được bình thường nên vẫn in ra.">Đã giao TC ƯT</TableHead>
                <TableHead className="text-right" title="PHÉP TRỪ hàng nhập − đã giao TC, tức phần hàng shop CÒN GIỮ theo hai cột bên trái: giá trị ở trên, số lượng ở dưới. Dòng nhỏ thứ hai là TỒN THẬT theo Sổ kho để đối chiếu — chênh lệch nằm ở hàng đang trên đường và hàng hoàn kho chưa đếm lại. Số âm = bán nhiều hơn nhập trong kỳ (tồn đầu kỳ, hoặc thiếu phiếu nhập).">Còn lại ƯT</TableHead>
                <TableHead className="text-right" title="DT đơn đã giao thật + Σ(DT đơn đang giao × P) + Σ(DT đơn chưa gửi × P) — cân theo TỪNG ĐƠN. Dòng nhỏ: số đơn đã xác nhận trong kỳ.">DT GTC ƯT</TableHead>
                <TableHead className="text-right" title="Chi quảng cáo đã quy kết về mã trong kỳ. Dòng nhỏ: tỷ lệ trên doanh số đơn đã lên POS, và trên doanh thu giao thành công ƯỚC TÍNH. Mẫu số 0 hoặc chưa quy kết được ⇒ “—”, KHÔNG phải 0%.">CPQC</TableHead>
                <TableHead className="text-right">Vận chuyển</TableHead>
                <TableHead className="text-right" title="Tổng vận hành = CP vận hành đã nhập + đóng hàng + nhân viên vận đơn + chi phí cố định">Vận hành</TableHead>
                <TableHead className="text-right" title="CHI PHÍ CỦA KỲ NÀY, không phải rủi ro cả đời của lô: % giả định × GIÁ VỐN HÀNG BÁN RA trong kỳ — cùng MỘT con số với bảng trên. Dòng nhỏ “cả lô” là GHI CHÚ: rủi ro cả đời của lô nhập trong kỳ (% × giá trị hàng nhập), một phơi nhiễm TẠI MỘT THỜI ĐIỂM chứ không phải chi phí CỦA MỘT KỲ — KHÔNG trừ vào lợi nhuận.">Rủi ro TK</TableHead>
                <TableHead className="text-right" title="Thuế = DT GTC ước tính × %. Dòng nhỏ: chi phí khác = CPQC × % (phí thanh toán thẻ ngoại tệ…).">Thuế · khác</TableHead>
                <TableHead className="text-right">LN theo hàng nhập</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...report.rows].sort((a, b) => b.profitOnPurchase - a.profitOnPurchase).map((r) => {
                const conLai = conLaiUocTinh(r);
                return (
                  <TableRow key={`pur-${r.productId}`} className={cn(!r.orders && "text-muted-foreground")}>
                    <TableCell className="font-medium">{r.code ? `${r.code} · ` : ""}{r.productName}{!r.orders ? <span className="ml-1 text-[11px]">(chưa có đơn)</span> : null}</TableCell>
                    <OKep sub={`${formatNumber(r.purchaseQty)} sp`}>
                      <TienCoTheChuaBiet value={r.purchaseCost} known={r.purchaseCostKnown} reason="Phiếu nhập trong kỳ có dòng không ghi đơn giá — giá trị hàng nhập CHƯA BIẾT, không phải 0 ₫" className={r.purchaseCost ? "text-rose-600" : "text-muted-foreground"} />
                    </OKep>
                    <OKep sub={`${formatNumber(r.expectedQty)} sp`}>
                      <TienCoTheChuaBiet value={r.expectedCogs} known={r.cogsKnown} reason={`${formatNumber(r.cogsUnknownQty)} sản phẩm bán ra chưa biết giá vốn (không phiếu nhập, không giá Pancake) — giá vốn đang bị tính 0đ nên KHÔNG in ra; số lượng bên dưới vẫn đo được`} className="text-muted-foreground" />
                    </OKep>
                    <OKep sub={<>{formatNumber(conLai.qty)} sp · {nhanSoKho(r)}</>} subTitle={giaiThichConLai(r, conLai)}>
                      <TienCoTheChuaBiet value={conLai.cost} known={conLai.costKnown} reason="Một trong hai vế (giá trị hàng nhập / giá vốn hàng đã giao) chưa biết ⇒ hiệu số chưa tính được" className="font-semibold" />
                    </OKep>
                    <OKep sub={`${formatNumber(r.orders)} đơn`}><Money value={r.expectedRevenue} /></OKep>
                    <OKep sub={<><Pct value={r.ads.overPosSales} tone={false} /> DS · <Pct value={r.ads.overProjectedRevenue} tone={false} /> DT ƯT</>}>
                      <Money value={r.adSpend} className="text-rose-600" />
                    </OKep>
                    <OKep><Money value={r.shipCost} className="text-muted-foreground" /></OKep>
                    <OKep><Money value={r.opexTotal} className="text-muted-foreground" /></OKep>
                    <OKep sub={<>cả lô <TienCoTheChuaBiet value={r.inventoryRiskOnPurchase} known={r.purchaseCostKnown} reason="Giá trị hàng nhập chưa biết ⇒ rủi ro cả lô chưa tính được" className="italic" /></>}>
                      <TienCoTheChuaBiet value={r.inventoryRisk} known={r.cogsKnown} reason="Chưa biết giá vốn hàng bán ⇒ chưa tính được dự phòng" className="text-muted-foreground" />
                    </OKep>
                    <OKep sub={<>khác <Money value={r.otherCost} /></>}><Money value={r.tax} className="text-muted-foreground" /></OKep>
                    <OKep sub={<Pct value={r.marginOnPurchase} />}>
                      <Money value={r.profitOnPurchase} className={cn("font-bold", r.profitOnPurchase >= 0 ? "text-success" : "text-destructive")} />
                    </OKep>
                  </TableRow>
                );
              })}
              {(() => {
                const conLai = conLaiUocTinh(t);
                return (
                  <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                    <TableCell>Tổng{report.unmatchedAdSpend ? <div className="text-[10.5px] font-normal text-muted-foreground" title="Tỷ lệ ở dòng này chỉ tính phần đã quy kết">+ {formatVND(report.unmatchedAdSpend)} QC chưa quy kết</div> : null}</TableCell>
                    <OKep sub={`${formatNumber(t.purchaseQty)} sp`}>
                      <TienCoTheChuaBiet value={t.purchaseCost} known={t.purchaseCostKnown} reason="Có phiếu nhập không ghi đơn giá — tổng giá trị hàng nhập chưa biết đủ" className="text-rose-600" />
                    </OKep>
                    <OKep sub={`${formatNumber(t.expectedQty)} sp`}>
                      <TienCoTheChuaBiet value={t.expectedCogs} known={t.cogsKnown} reason={`${formatNumber(t.cogsUncoveredQty)} sản phẩm bán ra chưa biết giá vốn — tổng giá vốn đang thiếu hẳn phần đó, nên KHÔNG in ra một con số trông như đã đủ`} />
                    </OKep>
                    <OKep sub={<>{formatNumber(conLai.qty)} sp · {nhanSoKho(t)}</>} subTitle={giaiThichConLai(t, conLai)}>
                      <TienCoTheChuaBiet value={conLai.cost} known={conLai.costKnown} reason="Một trong hai vế chưa biết ⇒ hiệu số chưa tính được" />
                    </OKep>
                    <OKep sub={`${formatNumber(t.orders)} đơn`}><Money value={t.expectedRevenue} /></OKep>
                    <OKep sub={<><Pct value={t.adsAttributed.overPosSales} tone={false} /> DS · <Pct value={t.adsAttributed.overProjectedRevenue} tone={false} /> DT ƯT</>}>
                      <Money value={t.adSpend} className="text-rose-600" />
                    </OKep>
                    <OKep><Money value={t.shipCost} /></OKep>
                    <OKep><Money value={t.opexTotal} /></OKep>
                    <OKep sub={<>cả lô <TienCoTheChuaBiet value={t.inventoryRiskOnPurchase} known={t.purchaseCostKnown} reason="Giá trị hàng nhập chưa biết đủ ⇒ rủi ro cả lô chưa tính được" className="italic" /></>}>
                      <TienCoTheChuaBiet value={t.inventoryRisk} known={t.cogsKnown} reason="Có sản phẩm chưa biết giá vốn ⇒ dự phòng chưa tính đủ" />
                    </OKep>
                    <OKep sub={<>khác <Money value={t.otherCost} /></>}><Money value={t.tax} /></OKep>
                    <OKep sub={<Pct value={t.marginOnPurchase} />}>
                      <Money value={t.profitOnPurchase} className={t.profitOnPurchase >= 0 ? "text-success" : "text-destructive"} />
                    </OKep>
                  </TableRow>
                );
              })()}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Lợi nhuận danh nghĩa theo Marketer"
        description={`${byMarketer.pagesMapped}/${byMarketer.pagesTotal} page có đơn đã có người nhận`}
        hint={`Cách ghi nhận: đơn & DT GTC ước tính của mỗi mã ghi cho marketer theo FANPAGE phát sinh đơn — trước hết bằng ẢNH CHỤP người phụ trách page TẠI MỐC ĐƠN LÊN (đổi người phụ trách hôm nay KHÔNG làm đổi số của kỳ đã qua), rồi tới bảng gán phẳng khai ở Lương & hoa hồng (${byMarketer.pagesMapped}/${byMarketer.pagesTotal} page có đơn đã có người nhận). Fanpage không nói được gì thì mới tới AD_ID của đơn; còn lại chia theo tỷ trọng tiền QC trên mã, không QC → về chủ mã. Quảng cáo KHÔNG ghi đè người được tính đơn theo fanpage. LN ròng trước QC của mã (đã trừ giá vốn, vận chuyển, vận hành gồm đóng hàng / NV vận đơn / cố định, rủi ro TK, thuế) × tỷ trọng − QC của chính mình − CP khác theo QC − QC test = LN ròng cá nhân; chủ mã hưởng X% LN đơn của mình, người chạy cùng hưởng Y% LN đơn mình tạo và (100 − Y)% về chủ mã (mặc định Y = ${100 - byMarketer.ownerSharePct}%, khai riêng từng mã ở Lương & hoa hồng). Bấm tên marketer để xem chi tiết từng mã hàng có phát sinh số liệu.`}
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
                      <span className="inline-flex items-center gap-1">
                        Tổng · {formatNumber(byMarketer.rows.length)} marketer
                        {byMarketer.unattributed || byMarketer.shopRetained ? <InfoHint>chưa gồm phần không phân bổ / shop giữ lại ở các dòng dưới</InfoHint> : null}
                      </span>
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
              {byMarketer.marketerPriceMargin ? (
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={8}>Chênh lệch giá báo MKT so với giá vốn thật (dương = shop giữ, âm = shop bù cho MKT) — phần của MKT tính trên giá báo từ 01/09/2026</TableCell>
                  <TableCell className="text-right"><Money value={byMarketer.marketerPriceMargin} /></TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
              {byMarketer.workshopPenaltyCredited || byMarketer.workshopPenaltyUncredited ? (
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={8}>
                    Hoàn phạt xưởng đã cộng cho MKT phụ trách mã (shop chi){byMarketer.workshopPenaltyUncredited ? ` · ⚠ ${formatVND(byMarketer.workshopPenaltyUncredited)} phạt của mã chưa có MKT phụ trách — chưa cộng cho ai` : ""}
                  </TableCell>
                  <TableCell className="text-right"><Money value={-byMarketer.workshopPenaltyCredited} /></TableCell>
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
