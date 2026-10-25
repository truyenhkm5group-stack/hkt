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
import { RETURN_REASONS, type ReturnReason } from "@/lib/constants/return-reason";
import { isReasonGroupKey } from "@/lib/constants/return-reason-evidence";
import { getReturnRateBySource, getReturnRateByTier, getReturnRateByVariant, getReturnRateSummary, listOrdersForVariant, listReturnSummaryOrders, RETURN_RATE_SORTABLE, RETURN_SUMMARY_BUCKETS, type ReturnSummaryBucket } from "@/lib/queries/return-rate";
import { logisticsPerformance } from "@/lib/queries/logistics";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { buildCauseBoard } from "@/lib/returns/cause-board";
import { getReturnIntelligence, TREND_GRAINS, type TrendGrain } from "@/lib/queries/return-intelligence";
import { listAttributedMarketers } from "@/lib/queries/order-marketer";
import { listProductCodes } from "@/lib/queries/product-code";
import { POST_OFFICE_QUERY_MAX, REASON_FILTER_KEYS, REASON_OUTCOME_FILTERS } from "@/lib/constants/return-reason-filters";
import type { OutcomeGroup } from "@/lib/constants/truth";
import { reasonFiltersActive, type ReasonFilterSelection } from "@/lib/returns/reason-filters";
import { collectAsOf } from "@/lib/cache";

/**
 * 2b — bộ lọc của khối lý do hoàn đọc từ URL. Giá trị là đầu vào của người ngoài: trạng thái chỉ nhận nhóm trong danh sách đóng; các ô
 * khác chỉ được SO KHỚP (không bao giờ ghép vào SQL), cắt trần độ dài. HÀM THUẦN.
 */
export function reasonFilterSelectionOf(raw: SearchParams): ReasonFilterSelection {
  const list = (k: string) => {
    const v = raw[k];
    const xs = (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim().slice(0, 80)).filter(Boolean);
    return xs.length ? [...new Set(xs)].slice(0, 30) : undefined;
  };
  const outcomes = list(REASON_FILTER_KEYS.outcome)?.filter((x): x is OutcomeGroup => (REASON_OUTCOME_FILTERS as readonly string[]).includes(x));
  const po = (param(raw, REASON_FILTER_KEYS.postOffice) ?? "").trim().slice(0, POST_OFFICE_QUERY_MAX);
  return {
    ...(list(REASON_FILTER_KEYS.source) ? { sources: list(REASON_FILTER_KEYS.source) } : {}),
    ...(list(REASON_FILTER_KEYS.carrier) ? { carriers: list(REASON_FILTER_KEYS.carrier) } : {}),
    ...(list(REASON_FILTER_KEYS.care) ? { careOwners: list(REASON_FILTER_KEYS.care) } : {}),
    ...(list(REASON_FILTER_KEYS.province) ? { provinces: list(REASON_FILTER_KEYS.province) } : {}),
    ...(po ? { postOffice: po } : {}),
    ...(outcomes?.length ? { outcomes } : {}),
  };
}

/** Tham số của trang, dựng từ URL. `{}` = trang mặc định (kỳ 90 ngày, mốc gửi hàng, không lọc). */
/**
 * Tổ chức KHÔNG có module vận chuyển (đơn tay, giao bằng phiếu ký nhận — không vận đơn nào) thì mốc «ngày gửi ĐVVC» luôn
 * rỗng ⇒ URL chưa chọn mốc thì dùng NGÀY LÊN ĐƠN. Điền vào URL trước `returnsPageParams(raw)` — trang và job làm ấm vẫn
 * đi CÙNG một đường dựng tham số. HÀM THUẦN.
 */
export function withDefaultReturnsBasis(raw: SearchParams, hasLogistics: boolean): SearchParams {
  return hasLogistics || raw.basis ? raw : { ...raw, basis: "ORDERED" };
}

export function returnsPageParams(raw: SearchParams) {
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
  const basis: TimeBasis = TIME_BASES.includes((params.filters.basis?.[0] ?? "") as TimeBasis) ? (params.filters.basis![0] as TimeBasis) : "SHIPPED";
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
  // Khoá của CẢ HAI cách xếp nhóm: link mở từ lúc cờ còn tắt vẫn đọc được sau khi bật (và ngược lại
  // — nhóm không có ở cách xếp đang bật thì drilldown ra rỗng, không phải lỗi).
  const nhomMo = params.filters.group?.[0] ?? "";
  const openGroup = isReasonGroupKey(nhomMo) ? nhomMo : null;
  const openProduct = (param(raw, "pcode") || "").trim() || null;
  /*
    KPI BẤM XUỐNG (OD-UX-04): `kpi` = nhóm đơn của khối KPI, `kpage` = trang của danh sách. Giá trị lạ ⇒ `null`
    (không mở danh sách), như mọi tham số drilldown khác — URL là đầu vào của người ngoài.
  */
  const kpiRaw = param(raw, "kpi") ?? "";
  const kpiBucket: ReturnSummaryBucket | null = (RETURN_SUMMARY_BUCKETS as readonly string[]).includes(kpiRaw) ? (kpiRaw as ReturnSummaryBucket) : null;
  const kpiPage = Math.max(1, Math.floor(Number(param(raw, "kpage") ?? "1")) || 1);

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

  /*
    2b: bộ lọc RIÊNG của khối lý do hoàn (E) + nguyên nhân · giải pháp (E2) — `reasonFilterBase` là bộ lọc CHUNG của trang. Tầng quyết định
    (D) đọc bản KHÔNG lọc 2b: các phần khác của D không lọc theo các ô ấy, trộn hai tập dưới một tiêu đề là đúng thứ trang này cấm.
  */
  const reasonFilterBase = { period: params.period, basis, codes, marketerIds, value: giaTriDon };
  const reasonSelection = reasonFilterSelectionOf(raw);
  const reasonFilter = { ...reasonFilterBase, ...reasonSelection };
  const reasonFiltered = reasonFiltersActive(reasonSelection);
  return { params, minShipped, variantKey, giaTriDon, dangLocGiaTri, basis, codes, marketerIds, trendGrain, openReason, openGroup, openProduct, previous, reasonFilter, reasonFilterBase, reasonSelection, reasonFiltered, kpiBucket, kpiPage };
}

export type ReturnsPageParams = ReturnType<typeof returnsPageParams>;

/**
 * Mọi truy vấn của trang — một lượt song song — nhưng trả về TỪNG LỜI HỨA, chưa chờ. Trang dùng nó để vẽ từng khối ngay khi
 * dữ liệu của khối đó xong (Suspense, 25/10/2026): KPI chỉ cần `summary`, không phải đứng chờ tầng quyết định ~7 s nguội.
 * Cùng lời gọi, cùng tham số, cùng khoá đệm với `loadReturnsPage` — hàm đó chỉ là «chờ hết các lời hứa này».
 */
export function startReturnsPage(p: ReturnsPageParams) {
  const { params, minShipped, variantKey, giaTriDon, basis, codes, marketerIds, trendGrain, previous, reasonFilter, reasonFilterBase, reasonFiltered, kpiBucket, kpiPage } = p;

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

  */
  // Không bật bộ lọc 2b ⇒ MỘT báo cáo (cùng khoá job giữ ấm); bật ⇒ thêm đúng một báo cáo đã lọc cho E / E2.
  const reasonBaseP = getReturnReasonReport(reasonFilterBase);
  const reasonP = reasonFiltered ? getReturnReasonReport(reasonFilter) : reasonBaseP;
  /*
    BẢNG NGUYÊN NHÂN THEO CHỨNG CỨ (P0 21/10/2026, `lib/returns/cause-board.ts`): CHỈ khi cờ cách xếp = EVIDENCE — cờ còn LEGACY thì không
    dựng (hai cách xếp không đứng chung một trang). Kỳ trước dùng ĐÚNG bộ lọc của khối intelligence nên đọc lại cùng bản nhớ đệm.
  */
  const causeP = reasonP.then(async (bc) => {
    if (bc.taxonomy !== "EVIDENCE") return null;
    const truoc = previous ? await getReturnReasonReport({ ...reasonFilter, period: { ...params.period, from: previous.from, to: previous.to } }) : null;
    return buildCauseBoard(bc, truoc && truoc.taxonomy === "EVIDENCE" ? truoc : null);
  });
  return {
    variant: getReturnRateByVariant({ period: params.period, basis, value: giaTriDon, q: params.q, minShipped, sort: params.sort, dir: params.dir, page: params.page, pageSize: params.pageSize }),
    summary: getReturnRateSummary(params.period, params.q, basis, giaTriDon),
    variantOrders: variantKey ? listOrdersForVariant(variantKey, params.period) : Promise.resolve([]),
    theoNguon: getReturnRateBySource(params.period, params.q, giaTriDon),
    reasonReport: reasonP,
    danhMucMa: listProductCodes(),
    danhSachMarketer: listAttributedMarketers(),
    logistics: logisticsPerformance(params.period, giaTriDon),
    intel: reasonBaseP.then((baoCaoLyDo) => getReturnIntelligence({ period: params.period, previous, basis, codes, marketerIds, trendGrain, reasonReport: baoCaoLyDo, value: giaTriDon })),
    theoBacGia: getReturnRateByTier(params.period, params.q, basis),
    causeBoard: causeP,
    // CÙNG bốn tham số với `getReturnRateSummary` ngay trên — danh sách ra đúng số trên thẻ (OD-UX-04).
    kpiOrders: kpiBucket ? listReturnSummaryOrders(params.period, params.q, basis, giaTriDon, kpiBucket, kpiPage) : Promise.resolve(null),
  };
}

export type ReturnsPageParts = ReturnType<typeof startReturnsPage>;

/**
 * ĐƯỜNG CỦA TRANG (Suspense theo khối, 25/10/2026): bắt đầu mọi lời hứa BÊN TRONG bộ gom mốc của OD-UX-03, nên mốc in trên
 * thẻ đồng bộ vẫn là mốc CŨ NHẤT của MỌI khối — dù từng khối được vẽ riêng ngay khi dữ liệu của nó xong.
 *
 * `collectAsOf` gọi hàm truyền vào ĐỒNG BỘ (trong `AsyncLocalStorage.run`), nên các lời hứa đã có ngay khi hàm này trả về;
 * bộ gom thì chờ `allSettled` — một khối lỗi không làm mốc của các khối khác biến mất, và không lời hứa nào bị bỏ lơ.
 */
export function streamReturnsPage(p: ReturnsPageParams): { parts: ReturnsPageParts; asOf: Promise<{ asOf: Date; cached: boolean }> } {
  const giu: { parts?: ReturnsPageParts } = {};
  const asOf = collectAsOf(async () => {
    giu.parts = startReturnsPage(p);
    await Promise.allSettled(Object.values(giu.parts));
  }).then(({ asOf: moc, cached }) => ({ asOf: moc, cached }));
  if (!giu.parts) throw new Error("streamReturnsPage: collectAsOf phải gọi hàm đồng bộ");
  return { parts: giu.parts, asOf };
}

/** Mọi truy vấn của trang, chờ hết — đường của job giữ ấm, probe và script (cùng lời hứa của `startReturnsPage`). */
export async function loadReturnsPage(p: ReturnsPageParams) {
  const s = startReturnsPage(p);
  // Mọi lời hứa nằm trong CÙNG một `Promise.all`: không lời hứa nào bị bỏ lơ nếu một nhánh khác lỗi trước.
  const [{ rows, total, pageCount, all, productRows, projectionError: loiBang }, summary, variantOrders, theoNguon, reasonReport, danhMucMa, danhSachMarketer, logistics, intel, theoBacGia, causeBoard, kpiOrders] = await Promise.all([
    s.variant,
    s.summary,
    s.variantOrders,
    s.theoNguon,
    s.reasonReport,
    s.danhMucMa,
    s.danhSachMarketer,
    s.logistics,
    s.intel,
    s.theoBacGia,
    s.causeBoard,
    s.kpiOrders,
  ]);
  return { rows, total, pageCount, all, productRows, loiBang, summary, variantOrders, theoNguon, reasonReport, danhMucMa, danhSachMarketer, logistics, intel, theoBacGia, causeBoard, kpiOrders };
}
