/**
 * ═══════════ /reports/returns: MỘT ĐƯỜNG DỰNG THAM SỐ + GỌI TRUY VẤN, DÙNG CHUNG CHO TRANG VÀ JOB GIỮ ẤM ═══════════
 *
 * Trang Tỷ lệ giao thành công gọi mười hàm, mỗi hàm tự nhớ đệm theo khoá dựng từ CHÍNH tham số của
 * nó (kỳ, mốc, bộ lọc giá trị, sắp xếp…). Job giữ ấm chỉ có ích khi nó dựng ĐÚNG những khoá ấy — lệch
 * một tham số (mốc `SHIPPED` so với `ORDERED`, trang 1 so với trang 0) là job tính cho không ai và người
 * mở trang vẫn trả giá đầy đủ, mà không có gì báo lỗi.
 *
 * Nên cả hai đi qua hai hàm dưới đây: `returnsPageParams(searchParams)` → `loadReturnsPage(p)`. Trang
 * truyền URL thật; job truyền `{}` — tức đúng trang mặc định mà người dùng mở từ menu.
 *
 * Tách ra khỏi `page.tsx` NGUYÊN VĂN — không đổi một tham số hay thứ tự gọi nào.
 */
import { parseListParams, param, type SearchParams } from "@/lib/search-params";
import { orderValueActive, parseOrderValue } from "@/lib/constants/order-value";
import { TIME_BASES, type TimeBasis } from "@/lib/constants/report-time-basis";
import { RETURN_REASONS, RETURN_REASON_GROUPS, type ReturnReason, type ReturnReasonGroup } from "@/lib/constants/return-reason";
import { getReturnRateBySource, getReturnRateByTier, getReturnRateByVariant, getReturnRateSummary, listOrdersForVariant, RETURN_RATE_SORTABLE } from "@/lib/queries/return-rate";
import { logisticsPerformance } from "@/lib/queries/logistics";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { getReturnIntelligence, TREND_GRAINS, type TrendGrain } from "@/lib/queries/return-intelligence";
import { listAttributedMarketers } from "@/lib/queries/order-marketer";
import { listProductCodes } from "@/lib/queries/product-code";

/** Tham số của trang, dựng từ URL. `{}` = trang mặc định (kỳ 90 ngày, mốc gửi hàng, không lọc). */
/**
 * `defaultBasis`: mốc khi URL không chọn. Tổ chức KHÔNG có module vận chuyển (đơn tay, giao bằng phiếu ký nhận — không
 * vận đơn nào) thì mốc «ngày gửi ĐVVC» luôn rỗng ⇒ trang đó truyền `ORDERED`.
 */
export function returnsPageParams(raw: SearchParams, defaultBasis: TimeBasis = "SHIPPED") {
  const params = parseListParams(raw, {
    defaultSort: "successRate",
    defaultDir: "asc",
    filterKeys: ["min", "product", "basis", "group", "reason", "marketer", "trend"],
    sortable: RETURN_RATE_SORTABLE,
    defaultPeriod: "90d",
    defaultPageSize: 50,
  });
  const minShipped = Math.max(1, Number(params.filters.min?.[0] ?? "1") || 1);
  const variantKey = param(raw, "variant");
  /*
    BỘ LỌC GIÁ TRỊ ĐƠN — xem `lib/constants/order-value.ts` cho định nghĩa và lý do chọn giá chốt.
    Nó áp cho KPI tổng quan, bảng theo mã, bảng theo nguồn đơn và bảng lý do hoàn, tức mọi con số
    trên trang trừ bảng "theo bậc giá trị đơn" (bảng ấy CHÍNH LÀ phép phân bậc).
  */
  const giaTriDon = parseOrderValue(raw);
  const dangLocGiaTri = orderValueActive(giaTriDon);
  /*
    MỐC LỌC LÀ MỘT LỰA CHỌN CÓ TÊN, KHÔNG PHẢI MỘT GIẢ ĐỊNH NGẦM.

    Mặc định `SHIPPED` vì bảng này có cột "Đã gửi" — nó trả lời "lô hàng gửi trong khoảng này đi
    tới đâu rồi". Người muốn hỏi câu khác ("đơn chốt tuần này ra sao") đổi sang `ORDERED`, và màn
    hình nói rõ đang ở mốc nào.
  */
  const basis: TimeBasis = TIME_BASES.includes((params.filters.basis?.[0] ?? "") as TimeBasis) ? (params.filters.basis![0] as TimeBasis) : defaultBasis;
  const codes = params.filters.product?.length ? params.filters.product : undefined;
  const marketerIds = params.filters.marketer?.length ? params.filters.marketer : undefined;
  const trendGrain: TrendGrain = TREND_GRAINS.includes((params.filters.trend?.[0] ?? "") as TrendGrain) ? (params.filters.trend![0] as TrendGrain) : "DAY";
  /*
    ═══ DRILLDOWN BA TẦNG SỐNG TRONG URL ═══

    `group` → `reason` → `pcode`. Ba tham số riêng, không phải một chuỗi ghép, để nút Lùi của
    trình duyệt đi ngược đúng từng tầng và người đọc dán được đường dẫn đúng chỗ mình đang nhìn.
    Giá trị lạ bị bỏ về `null` chứ không làm sập trang — URL là đầu vào của người ngoài.
  */
  const openReason = (RETURN_REASONS as readonly string[]).includes(params.filters.reason?.[0] ?? "") ? (params.filters.reason![0] as ReturnReason) : null;
  const openGroup = (RETURN_REASON_GROUPS as readonly string[]).includes(params.filters.group?.[0] ?? "") ? (params.filters.group![0] as ReturnReasonGroup) : null;
  const openProduct = (param(raw, "pcode") || "").trim() || null;

  /*
    ═══ KỲ TRƯỚC CÙNG ĐỘ DÀI — TÍNH MỘT LẦN, DÙNG CHO MỌI PHÉP SO ═══

    Chỉ có kỳ trước khi kỳ hiện tại CÓ CẢ HAI ĐẦU MỐC. Xem "tất cả" thì không có gì để so, và bịa
    ra một "kỳ trước" cho nó là bịa ra một mũi tên xu hướng.
  */
  const previous =
    params.period.from && params.period.to
      ? (() => {
          const doDai = params.period.to.getTime() - params.period.from.getTime();
          return { from: new Date(params.period.from.getTime() - doDai - 1), to: new Date(params.period.from.getTime() - 1) };
        })()
      : null;

  const reasonFilter = { period: params.period, basis, codes, marketerIds, value: giaTriDon };
  return { params, minShipped, variantKey, giaTriDon, dangLocGiaTri, basis, codes, marketerIds, trendGrain, openReason, openGroup, openProduct, previous, reasonFilter };
}

export type ReturnsPageParams = ReturnType<typeof returnsPageParams>;

/** Mọi truy vấn của trang — một lượt song song. Xem chú thích trong thân về vì sao song song không phải chỗ sửa. */
export async function loadReturnsPage(p: ReturnsPageParams) {
  const { params, minShipped, variantKey, giaTriDon, basis, codes, marketerIds, trendGrain, previous, reasonFilter } = p;

  /*
    MỘT LƯỢT SONG SONG, KHÔNG PHẢI HAI LƯỢT NỐI ĐUÔI.

    Tầng quyết định dùng LẠI báo cáo lý do vừa dựng — không dựng lần thứ hai cho cùng một tập ca. Nó
    chỉ cần ĐÚNG báo cáo đó, nên bắt đầu ngay khi báo cáo lý do xong (`reasonP.then`), không đứng chờ
    bảng theo mẫu mã.

    ĐỪNG TRÔNG ĐỢI NÓ NHANH HƠN NHIỀU: đo sau deploy (#382) trang vẫn 7,4 s so với 6,9 s trước đó.
    Máy chủ có hai nhân và bể năm kết nối; các câu nặng tranh nhau đúng hai nhân ấy, nên xếp lại thứ
    tự không bớt được việc. Chỗ sửa thật là BỚT VIỆC: `reasonsForShipments` thôi kéo mọi sự kiện
    (#383, trang còn 4,7 s), và câu dự phóng GTC + câu xu hướng thôi tính trạng thái con / mốc bàn giao
    lặp lại cho từng đơn (xem `getProjectedDeliveryMetrics`).

    (Một lần đọc số sai đáng ghi lại: cột "ứng dụng" của `ops perf-probe` gồm CẢ các câu chạy trong
    `chayKhongJit` — chúng đi `Client.query`, bộ đếm "CSDL" chỉ bọc `Pool.query`. Từng đọc cột ấy
    thành "Node một luồng đang bận"; EXPLAIN cho thấy đó là SQL.)

    Mọi lời hứa nằm trong CÙNG một `Promise.all`: không lời hứa nào bị bỏ lơ nếu một nhánh khác lỗi trước.
  */
  const reasonP = getReturnReasonReport(reasonFilter);
  const [{ rows, total, pageCount, all, productRows, projectionError: loiBang }, summary, variantOrders, theoNguon, reasonReport, danhMucMa, danhSachMarketer, logistics, intel, theoBacGia] = await Promise.all([
    getReturnRateByVariant({ period: params.period, basis, value: giaTriDon, q: params.q, minShipped, sort: params.sort, dir: params.dir, page: params.page, pageSize: params.pageSize }),
    getReturnRateSummary(params.period, params.q, basis, giaTriDon),
    variantKey ? listOrdersForVariant(variantKey, params.period) : Promise.resolve([]),
    getReturnRateBySource(params.period, params.q, giaTriDon),
    reasonP,
    listProductCodes(),
    listAttributedMarketers(),
    logisticsPerformance(params.period, giaTriDon),
    reasonP.then((baoCaoLyDo) => getReturnIntelligence({ period: params.period, previous, basis, codes, marketerIds, trendGrain, reasonReport: baoCaoLyDo, value: giaTriDon })),
    getReturnRateByTier(params.period, params.q, basis),
  ]);
  return { rows, total, pageCount, all, productRows, loiBang, summary, variantOrders, theoNguon, reasonReport, danhMucMa, danhSachMarketer, logistics, intel, theoBacGia };
}
