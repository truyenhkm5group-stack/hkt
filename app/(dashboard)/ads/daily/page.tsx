import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "@/components/ui-bits";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { MARKETING_BASIS_LABEL, MARKETING_BASIS_QUESTION, MARKETING_DIMENSION_LABEL, MARKETING_DIMENSIONS, MARKETING_VIEWS, type MarketingBasis, type MarketingDimension, type MarketingView } from "@/lib/constants/marketing-daily";
import { getMarketingBreakdown, getMarketingDaily, hasDimensionFilter, type MarketingFilters } from "@/lib/queries/marketing-daily";
import { getMarketerDailyNominal } from "@/lib/queries/marketer-daily-nominal";
import { previousPeriod, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { MarketingDailyTable } from "./daily-table";
import { MarketingDailyFilters } from "./daily-filters";
import { MarketingDailyChart } from "./daily-chart";
import { MarketingKpis } from "./daily-kpis";
import { MarketingBreakdown } from "./breakdown";
import { MarketerNominalBreakdown, type ProfitKind } from "./marketer-nominal";
import { MarketingFindings } from "./findings";
import { AdsTabs } from "@/app/(dashboard)/ads/ads-tabs";

export const metadata = { title: "Hiệu quả theo ngày" };

function isDimension(v: string): v is MarketingDimension {
  return (MARKETING_DIMENSIONS as readonly string[]).includes(v);
}
function isView(v: string): v is MarketingView {
  return (MARKETING_VIEWS as readonly string[]).includes(v);
}

function readFilters(raw: SearchParams): MarketingFilters {
  const s = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : null);
  return { marketerId: s("marketer"), productId: s("product"), pageId: s("page"), campaignId: s("campaign"), adsetId: s("adset"), adId: s("ad"), source: s("src") };
}

/**
 * ───────────── HIỆU QUẢ MARKETING THEO NGÀY ─────────────
 *
 * Thứ tự trên trang là thứ tự câu hỏi người mở trang đang hỏi:
 *
 *   1. **Kỳ này lãi hay lỗ** (thẻ KPI, so với kỳ trước) — trả lời trong hai giây;
 *   2. **Ngày nào lỗ** (biểu đồ + bảng theo ngày);
 *   3. **Lỗ vì cái gì** (máy phân tích: bằng chứng bằng số + việc phải làm);
 *   4. **Lỗ ở đâu** (bóc tách theo MKTer / mã / chiến dịch).
 *
 * Ba khối sau nằm sau ranh giới `Suspense` riêng vì chúng đắt hơn hẳn — nhất là bóc tách, vốn chạy
 * một lượt đọc cho mỗi nhóm để con số của nó không bao giờ khác con số của dòng nó bóc.
 */
export default async function MarketingDailyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const { decision } = await requireResource("ADS", "expenses:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Hiệu quả theo ngày" reason={decision.reason} fix={decision.fix} />;

  const period = resolvePeriod(raw, "30d");
  const basis: MarketingBasis = raw.basis === "delivered" ? "delivered" : "created";
  const view: MarketingView = typeof raw.view === "string" && isView(raw.view) ? raw.view : "basic";
  const dimension: MarketingDimension = typeof raw.dim === "string" && isDimension(raw.dim) ? raw.dim : "marketer";
  const filters = readFilters(raw);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title="Hiệu quả theo ngày"
        description="Mỗi ngày tiêu bao nhiêu → ra bao nhiêu đơn → thu về bao nhiêu → lãi hay lỗ"
        hint={
          <>
            <p className="mb-2">
              <strong>Mốc mặc định là NGÀY PHÁT SINH ĐƠN</strong> (cohort): đơn lên ngày 01/09 mà giao ngày 05/09 vẫn được tính vào dòng 01/09. Chỉ mốc này mới trả lời được &ldquo;10 triệu quảng cáo chạy
              ngày 01/09 cuối cùng ra kết quả gì&rdquo;.
            </p>
            <p className="mb-2">{MARKETING_BASIS_QUESTION.delivered}</p>
            <p className="mb-2">
              <strong>Luôn đọc ĐỘ CHÍN trước khi đọc lợi nhuận.</strong> Ngày mới, phần lớn đơn còn đang đi, nên tiền quảng cáo đã tiêu hết mà hàng chưa tới tay ai — ngày nào cũng trông như đang lỗ.
            </p>
            <p>
              Doanh thu, giá vốn, cước và kết quả đơn dùng CHUNG bộ máy với Báo cáo lợi nhuận (`lib/queries/reports.ts`), nên hai trang không thể nói hai con số. Chênh lệch duy nhất được phép là phần
              đơn bị kết luận TRÙNG — và nó được in ra thành số.
            </p>
          </>
        }
      />

      <AdsTabs />

      <MarketingDailyFilters period={period} basis={basis} view={view} filters={filters} />

      <Suspense fallback={<Skeleton className="h-[420px] rounded-xl" />}>
        <MainBlock raw={raw} period={period} basis={basis} view={view} filters={filters} />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
        <FindingsBlock period={period} basis={basis} filters={filters} />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-72 rounded-xl" />}>
        <BreakdownBlock raw={raw} period={period} basis={basis} dimension={dimension} filters={filters} />
      </Suspense>
    </div>
  );
}

async function MainBlock({ period, basis, view, filters }: { raw: SearchParams; period: ReturnType<typeof resolvePeriod>; basis: MarketingBasis; view: MarketingView; filters: MarketingFilters }) {
  const data = await getMarketingDaily(period, basis, filters, previousPeriod(period));
  return (
    <div className="space-y-5">
      <MarketingKpis data={data} />
      <SectionCard
        title="Xu hướng theo ngày"
        description={MARKETING_BASIS_LABEL[basis]}
        hint="Đường trung bình động 7 ngày để không ra quyết định trên một ngày nhiễu. Ngày chưa ngã ngũ được vẽ mờ — số của nó chưa phải kết quả cuối."
      >
        <MarketingDailyChart rows={data.rows} />
      </SectionCard>
      <SectionCard
        title="Bảng theo ngày"
        description="Một dòng = một ngày. Hàng tổng tính lại mọi tỷ lệ từ tử số và mẫu số, không lấy trung bình phần trăm."
        padded={false}
      >
        <MarketingDailyTable data={data} view={view} />
      </SectionCard>
    </div>
  );
}

async function FindingsBlock({ period, basis, filters }: { period: ReturnType<typeof resolvePeriod>; basis: MarketingBasis; filters: MarketingFilters }) {
  /*
    CÙNG THAM SỐ VỚI `MainBlock` — CỐ Ý.

    Bản đầu gọi `getMarketingDaily(period, basis, filters)` KHÔNG kèm kỳ trước, nên nó rơi vào một
    khoá đệm khác và cả bộ máy chạy lại lần thứ hai cho cùng một trang. Kỳ trước nằm trong khoá đệm
    (đúng luật AGENTS.md mục 2: tham số ảnh hưởng kết quả phải vào khoá), nên chỉ cần truyền đúng
    cùng bộ tham số là hai khối dùng chung một lượt đọc.
  */
  const data = await getMarketingDaily(period, basis, filters, previousPeriod(period));
  return <MarketingFindings data={data} />;
}

/** Chuỗi truy vấn giữ nguyên mọi tham số đang có (kỳ, mốc, bộ cột…), chỉ đổi những khoá được nêu. */
function withParams(raw: SearchParams, patch: Record<string, string | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v && !(k in patch)) q.set(k, v);
  for (const [k, v] of Object.entries(patch)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/ads/daily?${s}` : "/ads/daily";
}

async function BreakdownBlock({ raw, period, basis, dimension, filters }: { raw: SearchParams; period: ReturnType<typeof resolvePeriod>; basis: MarketingBasis; dimension: MarketingDimension; filters: MarketingFilters }) {
  /*
    ═══ BÓC TÁCH THEO MKTER ĐI THEO BÁO CÁO LỢI NHUẬN, KHÔNG THEO BẢNG NGÀY PHÍA TRÊN ═══

    Chủ shop chốt 23/09/2026: số đơn · doanh thu · lợi nhuận của từng MKT phải là số ƯỚC TÍNH của
    Báo cáo lợi nhuận danh nghĩa, và phải xem được TỪNG NGÀY. Bảng cũ dựng trên bộ máy của trang này
    (doanh thu đo được + phần đang đi, cước đo được) nên in một con số khác hẳn báo cáo kia cho cùng
    một người. Các chiều khác (mã hàng, chiến dịch, adset…) vẫn đi đường cũ — báo cáo lợi nhuận
    không có số ở những grain ấy để mà chia.

    Đang lọc theo một chiều thì cũng đi đường cũ: báo cáo lợi nhuận không có "lợi nhuận của chiến
    dịch X chia theo marketer", và chia chi phí toàn shop cho một lát cắt là bịa (mục 14).
  */
  if (dimension === "marketer" && !hasDimensionFilter(filters)) {
    const data = await getMarketerDailyNominal(period);
    const kind: ProfitKind = raw.mkp === "gross" ? "gross" : "net";
    const periodQuery = period.key === "month" ? "" : `&period=${period.key}${period.key === "custom" ? `&from=${period.fromKey ?? ""}&to=${period.toKey ?? ""}` : ""}`;
    return (
      <SectionCard
        title="Bóc tách theo MKTer — đơn · doanh thu · lợi nhuận ước tính từng ngày"
        description="Số ước tính theo đúng Báo cáo lợi nhuận danh nghĩa, chia xuống từng đơn theo ngày đơn lên."
        hint={
          <>
            <p className="mb-2">
              Mỗi mã hàng lấy NGUYÊN con số của Báo cáo lợi nhuận danh nghĩa (DT GTC ước tính, giá vốn, cước theo tỷ lệ giao/hoàn, vận hành, rủi ro tồn kho, thuế), rồi chia xuống từng đơn của mã: đơn đã
              giao mang trọn doanh thu, đơn hoàn mang 0, đơn đang đi mang đúng xác suất giao được của trạng thái nó đang ở. Vì vậy cộng mọi ô ra đúng số của báo cáo — dòng &ldquo;Khớp&rdquo; phía dưới in phép
              đối chiếu ấy.
            </p>
            <p className="mb-2">
              Đơn thuộc về MKTer theo CÙNG thứ tự của bảng &ldquo;Lợi nhuận danh nghĩa theo Marketer&rdquo;: người phụ trách fanpage tại lúc đơn lên → page gán tay → ad_id → chia theo tỷ trọng QC trên mã / chủ
              mã. Chi QC đọc thẳng bảng chi tiêu theo ngày chi.
            </p>
            <p>LN ròng ở đây là TRƯỚC khi chia % chủ mã — phần chia ấy là chuyện lương, xem ở Báo cáo lợi nhuận. Ô ước tính không tô màu: ngày mới phần lớn còn đang đi.</p>
          </>
        }
        padded={false}
      >
        <MarketerNominalBreakdown
          data={data}
          kind={kind}
          hrefFor={(key) => withParams(raw, { marketer: key, dim: "product", mkp: null })}
          kindHref={(k) => withParams(raw, { mkp: k === "net" ? null : k })}
          reportHref={`/reports?tab=nominal${periodQuery}`}
        />
      </SectionCard>
    );
  }
  const bd = await getMarketingBreakdown(period, basis, dimension, filters);
  return (
    <SectionCard
      title={`Bóc tách theo ${MARKETING_DIMENSION_LABEL[dimension].toLowerCase()}`}
      description="Lỗ nặng nhất đứng đầu — đó là thứ cần xử lý trước."
      hint="Mỗi dòng đọc lại bằng ĐÚNG đường của bảng chính, nên con số ở đây không bao giờ khác con số của dòng nó bóc. Nhóm chưa quy kết luôn có mặt: giấu nó đi là làm tổng nhỏ hơn dòng gốc mà không ai giải thích được."
      padded={false}
    >
      <MarketingBreakdown data={bd} />
    </SectionCard>
  );
}
