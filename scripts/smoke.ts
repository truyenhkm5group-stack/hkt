/**
 * Smoke test sau deploy: mở thật các màn hình chính bằng một phiên đăng nhập hợp lệ.
 *
 * Vì sao cần: `/api/health` chỉ chứng minh tiến trình còn sống và CSDL kết nối được.
 * Nó KHÔNG phát hiện trang lỗi runtime (truy vấn hỏng, cột thiếu, lỗi render) — đúng loại
 * lỗi mà một checkpoint dữ liệu dễ gây ra nhất. Script này chạy TRONG container app nên
 * dùng được AUTH_SECRET và DATABASE_URL thật, không cần mở cổng hay biết mật khẩu quản trị.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/smoke.ts
 */
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";

/**
 * Hết kiên nhẫn chờ ĐẦU PHẢN HỒI. Máy chủ không nhả nổi đầu phản hồi trong ngần này là TREO — lỗi
 * thật, chặn deploy. Đây là ý nghĩa nguyên bản của hạn chờ và nó KHÔNG đổi.
 */
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);

/**
 * ═══ HẠN CHỜ RIÊNG CHO THÂN TRANG — VÀ VƯỢT NÓ KHÔNG CHẶN DEPLOY ═══
 *
 * Hai giai đoạn, hai ý nghĩa, nên phải có hai hạn chờ.
 *
 * Đầu phản hồi không về = máy chủ treo = lỗi thật. Thân trang về chậm = trang CHẬM — mà luật của
 * chính tệp này đã chốt từ deploy #172: "chặn bản mới vì nó chậm có thể đang chặn đúng bản vá làm
 * nó nhanh hơn".
 *
 * Suýt dẫm phải: bản sửa phép đo đầu tiên để NGUYÊN một hạn chờ bao cả hai giai đoạn. Làm thế là
 * lặng lẽ dựng thêm một điều kiện CHẶN mới — trang nào thân chảy quá 60 giây sẽ nhảy từ SUCCESS
 * sang TIMEOUT và chặn deploy của cả ba phiên đang chạy song song. Sửa một phép đo không được phép
 * đổi luật chặn; đổi luật chặn là một quyết định riêng, và nó phải được nói ra.
 */
const BODY_TIMEOUT_MS = Number(process.env.SMOKE_BODY_TIMEOUT_MS ?? 60_000);

/**
 * NGƯỠNG "CHẬM" — trang trả 200 nhưng lâu hơn mức này là vấn đề HIỆU NĂNG, không phải lỗi ứng dụng.
 *
 * Hai chuyện khác hẳn nhau và phải xử lý khác nhau: một trang hỏng thì KHÔNG được lên production;
 * một trang chậm thì phải sửa, nhưng chặn deploy vì nó là chặn nhầm — bản mới có khi còn nhanh hơn
 * bản đang chạy. Deploy #172 đã đỏ đúng vì gộp hai thứ này làm một.
 */
const SLOW_MS = Number(process.env.SMOKE_SLOW_MS ?? 2_000);

/**
 * NGÂN SÁCH CHO CẢ LƯỢT CHẠY.
 *
 * Sự cố thật: 5 trang chậm × 60 giây quá hạn = 5 phút đốt sạch, đẩy bước deploy vượt hạn 35 phút và
 * làm cả lần deploy ĐỎ — trong khi ứng dụng đã lên đúng bản và đang chạy tốt. Một phép kiểm mà tự nó
 * làm hỏng lần phát hành thì tệ hơn là không có.
 *
 * Hết ngân sách thì các trang còn lại ghi BỎ QUA — nói thẳng là chưa kiểm, KHÔNG phải là đã đạt.
 *
 * ─────────── VÌ SAO NÂNG TỪ 300s LÊN 600s (15/09/2026) ───────────
 *
 * 300 giây được chọn khi phép đo còn dừng đồng hồ ở ĐẦU phản hồi, tức khi cả 54 trang "cộng lại"
 * chỉ 5,6 giây. Lượt đo trung thực đầu tiên (deploy #307) cho thấy con số thật:
 *
 *   /ads 58,9s · /cod 50,6s · /data-quality 48,3s · /reports/returns 41,5s · /payroll 14,6s
 *   /customers 12,6s · /cod?recon=unproven 12,1s · /cod?recon=stale 11,4s · … 13 trang > 2s
 *
 * RIÊNG 13 trang chậm đã ngốn ~279 giây. Giữ 300 giây nghĩa là mỗi lần deploy có hơn HAI MƯƠI màn
 * hình không bao giờ được kiểm — và chúng bị bỏ theo thứ tự trong danh sách chứ không theo mức rủi
 * ro, tức là luôn cùng một nhóm trang bị bỏ. Một lá chắn chỉ che được nửa đầu danh sách thì nửa sau
 * coi như không có lá chắn.
 *
 * Bước SSH của workflow deploy có hạn 35 phút và lượt bootstrap đang dùng ~8 phút, nên 600 giây vẫn
 * còn rất nhiều chỗ.
 *
 * ĐÂY LÀ MIẾNG VÁ, KHÔNG PHẢI LỜI GIẢI. Lời giải là làm những trang kia nhanh lại; nâng ngân sách
 * chỉ để lá chắn nhìn được hết màn hình trong lúc việc ấy chưa xong. Hạ lại ngay khi các trang trên
 * đã sửa.
 */
const BUDGET_MS = Number(process.env.SMOKE_BUDGET_MS ?? 600_000);

/** Các màn hình phải mở được. Thêm route mới vào đây khi bổ sung màn hình quan trọng. */
const ROUTES = [
  "/",
  // Trang điều hành hằng ngày: chủ shop mở nó đầu ngày, và nó đọc cả hàng đợi việc lẫn đường ống
  // hàng hoàn. Phải nằm trong lá chắn hiệu năng, nếu không một tính năng mới có thể kéo nó chậm lại
  // mà không lượt đo nào thấy.
  "/operations",
  "/orders",
  "/shipments",
  // Tuyến NẶNG NHẤT của trang Vận đơn: tháp điều khiển mở sẵn một rổ, tức là render cả danh sách
  // kiện kèm tuổi tin cuối. Không phủ nó thì lá chắn chỉ canh trang rỗng.
  "/shipments?bucket=CARE_TODAY",
  // Hàng đợi "VTP cần đối chiếu": quét TOÀN BỘ kiện có mã VTP và chạy sáu vị ngữ trên chúng, nên
  // nó là tuyến nặng nhất của module — và là tuyến duy nhất đọc `vtp_webhook_gaps`.
  "/shipments?view=reconcile",
  // Báo cáo kết cục ca chăm sóc: quét toàn bộ ca trong kỳ và chạy phép suy kết cục trên từng ca.
  // Hai mốc lọc kỳ đứng trên HAI TẬP CA khác nhau nên phải phủ cả hai — một tuyến xanh không nói
  // gì về tuyến kia.
  "/shipments?view=report&basis=CASE_OPENED_AT",
  "/shipments?view=report&basis=CASE_RESOLVED_AT",
  "/import-vtp",
  "/cod",
  "/cod?recon=unproven",
  "/cod?recon=stale",
  "/reports",
  "/reports/returns",
  "/reports/scenario",
  "/products",
  "/inventory",
  "/inventory/receipts",
  "/inventory/returns",
  "/returns",
  "/inventory/planning",
  "/inventory/decisions",
  "/inventory/purchasing",
  "/customers",
  "/customers/retention",
  "/ads",
  "/ads/daily",
  "/payroll",
  /*
    ═══ TÁM MÀN HÌNH LƯƠNG, KHÔNG PHẢI MỘT ═══

    `/payroll` trước đây là tuyến DUY NHẤT của cả module, vì cả module chỉ có một trang. Nay nó có
    tám, và bảy trang kia KHÔNG nằm trên thanh điều hướng (chúng là tab bên trong `/payroll`) nên
    `tests/smoke-coverage.test.ts` — vốn đọc thanh điều hướng — không thể đòi chúng.

    Đó đúng là hình dạng lỗi mà `/bank` và `/ideas` đã dẫm phải ngày 10/09/2026: trang hỏng trên
    production và chủ shop tự phát hiện, vì lá chắn chỉ canh những gì có người nhớ thêm vào. Bảy
    trang này đụng tới tiền của người thật, nên chúng phải được mở thật sau mỗi lượt deploy.
  */
  "/payroll/payslip",
  "/payroll/policies",
  "/payroll/assignments",
  "/payroll/adjustments",
  "/payroll/migration",
  "/payroll/runs",
  "/payroll/settings",
  "/expenses",
  "/alerts",
  // Bản đồ phòng ban & AI: in hai sổ khai + một phép đếm người theo phòng. Nhẹ, nhưng nó đọc CSDL
  // (`department_members`) nên vẫn phải mở thử — một trang chỉ-đọc-hằng-số cũng hỏng được vì một
  // truy vấn duy nhất của nó.
  "/departments",
  "/data-quality",
  "/data-quality?issue=unlinked-shipment",
  "/data-quality?issue=return-not-received",
  /*
    ═══ MƯỜI MỘT TUYẾN TỪNG KHÔNG ĐƯỢC PHỦ ═══

    SỰ CỐ THẬT (10/09/2026). `/bank` và `/ideas` hỏng hẳn trên production và chủ shop phải tự phát
    hiện — cả hai đều KHÔNG có trong danh sách này. Lá chắn canh một danh sách gõ tay thì nó chỉ
    canh được những gì có người nhớ thêm vào, và 11/34 tuyến của thanh điều hướng đang ở ngoài.

    Đây là lần thứ tám cùng một hình dạng lỗi trong kho mã này: một lá chắn canh whitelist thay vì
    canh cả bề mặt. `tests/smoke-coverage.test.ts` nay đọc thanh điều hướng và bắt buộc mọi tuyến
    phải có mặt ở đây, hoặc được khai miễn trừ KÈM LÝ DO.
  */
  "/bank",
  // Buồng lái tài chính: đọc năm engine cùng lúc (số dư, dòng tiền, kết quả đơn, COD, chi phí) nên
  // nó là trang tài chính NẶNG NHẤT. Không phủ thì một engine chậm lại sẽ không lượt đo nào thấy.
  "/finance",
  // Hàng đợi tác vụ tài chính: nơi người dùng PHÂN LOẠI và NỐI dòng tiền. Trang này hỏng thì mọi
  // con số của buồng lái ở trên đứng im vì không ai còn phân loại được nữa.
  "/finance-ops",
  "/cs",
  // Hàng đợi THEO TỪNG VIỆC — tuyến duy nhất mang cả ba nút sao chép (SĐT · mã vận đơn · mã đơn).
  // `/cs` mặc định mở tab "theo khách", nên không phủ tuyến này thì hợp đồng sao chép mã vận đơn
  // không có chỗ nào kiểm được trên bản chạy thật.
  "/cs?view=theo-case",
  "/outreach",
  "/chatbot",
  "/landing",
  "/ideas",
  // QUY KẾT FANPAGE → MARKETER. Ba tab đọc ba đường khác nhau trên cùng ảnh chụp `order_attributions`,
  // nên mở mỗi tab một lần mới phủ hết: bảng theo người · danh sách từng đơn · màn hình khai báo.
  "/marketing/fanpages",
  "/marketing/fanpages?tab=orders",
  "/marketing/fanpages?tab=assign",
  "/products/performance",
  "/reports/funnel",
  "/reports/cashflow",
  /*
    Phòng Tech AI: năm màn hình nhưng chỉ `/tech` có trên thanh điều hướng, nên
    `tests/smoke-coverage.test.ts` chỉ đòi được tuyến đó. Bốn tuyến kia là tab BÊN TRONG module —
    đúng hình dạng đã làm `/bank` và `/ideas` hỏng trên production ngày 10/09/2026, nên liệt kê
    đủ cả năm ở đây.

    `/tech` là tuyến nặng nhất của module: nó dựng bảng sức khoẻ (đo CSDL, đọc `sync_runs`, gọi
    `getIntegrationHealth`) cùng lúc với năm truy vấn đếm.
  */
  "/tech",
  "/tech/tasks",
  "/tech/agents",
  /*
    `/tech/cto` đọc sổ đề xuất VÀ chạy lại `classifyTechRisk()` cho từng việc con để in ra mức
    rủi ro MÁY sẽ xếp lúc duyệt — không phải mức AI đề nghị. Nó KHÔNG gọi model (việc đó nằm sau
    một cú bấm của người), nên đo được như mọi trang đọc khác.
  */
  "/tech/cto",
  "/tech/deployments",
  "/tech/incidents",
  "/integrations",
  "/settings/users",
  "/audit",
  /*
    BÀN LÀM VIỆC CÔNG VIỆC — tuyến NẶNG NHẤT của bản Work OS.

    `/work` chiếu BẢY nguồn việc cùng lúc (case CSKH, care vận đơn, nút thắt fulfillment, dòng tiền
    chưa phân loại, quyết định quảng cáo, cảnh báo, việc tay). Một nguồn chậm lại sẽ kéo cả trang,
    và đây là trang nhân viên mở đầu ca — nếu nó chậm thì cả đội chờ.

    Ba tuyến còn lại đọc đúng ba engine khác nhau trên cùng phép chiếu đó: buồng lái phòng ban,
    danh sách chéo phòng, và thẻ điểm mục tiêu (nơi mọi chỉ số OKR/BSC được đọc sống).
  */
  "/work",
  // Màn hình sáng của trưởng phòng: dựng phép chiếu + bảng sức chứa + năm việc cần can thiệp.
  "/work/today",
  "/work/department",
  "/work/all",
  "/work/okr",
  /*
    `/work/settings` vào danh sách từ bản vận hành: nó chạy `getReadiness()`, tức là dựng lại TOÀN
    BỘ phép chiếu một lần nữa để đếm lỗ hổng khai báo. Đây là trang cấu hình nên chậm vài trăm mili
    giây là chấp nhận được — nhưng nếu nó đổ thì admin mất đúng màn hình để xếp phòng ban cho nhân
    viên, và không có đường nào khác làm việc đó.
  */
  "/work/settings",
  "/work/performance",
  "/work/review",
  /*
    HAI TRANG NGOẠI LỆ VÒNG ĐỜI ĐƠN — vào danh sách vì chúng KHÔNG có mục trên thanh điều hướng.

    `tests/ui-consistency.test.ts` bắt buộc mọi tuyến CÓ mục menu phải nằm trong smoke. Hai trang
    này nằm ở `INTENTIONALLY_UNLINKED` (mở từ hàng đợi việc, không từ menu), nên luật đó không với
    tới — và hệ quả là chúng là hai tuyến DUY NHẤT chưa từng được mở thật trên máy chủ. Trang không
    ai mở thử là trang đổ lúc người thật cần nó nhất.

    Cả hai đều NẶNG theo cách riêng và đáng đo: `/operations/dwell` quét `shipment_events` hai lượt
    cho mỗi vận đơn đang đi (đo EXPLAIN production: 24,5 ms, index-only), `/operations/preship` chạy
    13 luật soát trên toàn bộ đơn chưa gửi.
  */
  "/operations/dwell",
  "/operations/preship",
];

/**
 * LƯỢT LÀM NÓNG — đo riêng, KHÔNG tính vào kết quả đạt/không đạt.
 *
 * Đo 09/09/2026 trên production: `/` nằm đầu danh sách nên nó gánh toàn bộ chi phí NGUỘI (mở pool
 * kết nối, mọi `memo()` còn trống, JIT chưa nóng) và vượt 60 giây, trong khi 24 trang còn lại đều
 * dưới 310 ms. Một lần đo duy nhất ở vị trí đầu KHÔNG phân biệt được "trang chủ chậm thật" với
 * "trang đầu tiên nào cũng phải trả giá nguội".
 *
 * Nên tách hẳn: gọi trước một lần để nuốt chi phí nguội và IN RA con số đó (người đầu tiên vào
 * sau mỗi lần deploy phải chờ đúng chừng ấy — vẫn là việc phải sửa, nhưng sửa bằng làm nóng đệm,
 * không phải bằng viết lại truy vấn). Sau đó mọi phép đo đều là trạng thái nóng, và deploy không
 * bị chặn chỉ vì lần chạy đầu tiên.
 */
const WARMUP_ROUTE = "/";

/**
 * Dấu hiệu trang ĐÃ render thật (khung dashboard có mặt).
 * Cố ý KHÔNG dò chuỗi lỗi trong nội dung: Next.js nhúng sẵn nội dung not-found vào bundle của
 * mọi trang, nên dò "This page could not be found" báo lỗi giả cho cả trang tốt.
 * Mã HTTP mới là tín hiệu đáng tin (200 = ổn, 404/500 = hỏng).
 *
 * Chuỗi này đến từ nhãn thương hiệu ở sidebar (`components/brand.tsx` — aria-label của BrandWordmark),
 * nên chỉ có mặt khi khung dashboard đã dựng xong.
 */
const RENDER_MARKER = "VNXcommerce";

/**
 * Dòng chữ mà ranh giới lỗi của Next in ra (`app/(dashboard)/error.tsx`).
 *
 * Trang lỗi trả HTTP 200 và có đủ khung ứng dụng, nên nó vượt qua mọi tiêu chí còn lại. Đây là
 * dấu hiệu DUY NHẤT phân biệt được nó với một trang thật.
 */
const ERROR_MARKER = "Có lỗi khi tải trang";

/**
 * ═══════════ DẤU HIỆU THỨ HAI: LỖI NẰM TRONG GÓI RSC, CHƯA THÀNH CHỮ ═══════════
 *
 * SỰ CỐ THẬT (11/09/2026). `/bank` hỏng hẳn — `TypeError: f.BANK_TABS.includes is not a function` —
 * và smoke báo **SUCCESS 124kB trong 66ms**, hai lượt deploy liên tiếp. Chủ shop là người phát hiện.
 *
 * Vì sao `ERROR_MARKER` không bắt được: lỗi nổ ở THÂN TRANG, trước mọi ranh giới Suspense. Next
 * dựng xong khung ngoài (nên `RENDER_MARKER` vẫn có), rồi đẩy lỗi sang máy khách dưới dạng gói RSC.
 * Dòng chữ "Có lỗi khi tải trang" chỉ xuất hiện SAU khi trình duyệt chạy JavaScript — HTML máy chủ
 * trả về không hề có nó. `curl` không chạy JavaScript, nên nó không bao giờ thấy.
 *
 * Nhưng MÃ LỖI thì phải có trong HTML: máy khách in được "Mã lỗi: 1532032257" nghĩa là con số đó
 * đến từ gói RSC nhúng trong trang. Đó là dấu hiệu duy nhất đọc được mà không cần trình duyệt.
 *
 * Hai dấu hiệu bổ cho nhau: lỗi trong nhánh có Suspense thì hiện thành chữ, lỗi ở thân trang thì
 * chỉ còn mã. Thiếu một trong hai là còn một nửa cửa mở.
 */
const DIGEST_MARKER = /\\?"digest\\?"\s*:\s*\\?"\d{3,}/;

/**
 * ═══════════ PHÂN LOẠI KẾT QUẢ — MỘT CHỮ "LỖI" KHÔNG ĐỦ ═══════════
 *
 * Sự cố thật 09/09/2026: bộ smoke báo "13/21 màn hình LỖI" và deploy bị đánh dấu thất bại,
 * trong khi cả 13 đều là HTTP 307 (chuyển hướng đăng nhập) do phiếu ký hết hạn giữa chừng —
 * ứng dụng hoàn toàn bình thường. Một phép kiểm gộp "trang hỏng" với "phép kiểm tự hỏng" vào
 * cùng một nhãn thì tín hiệu đỏ của nó mất hết ý nghĩa, và lần sau không ai tin nó nữa.
 *
 * Nên mỗi kết quả phải tự khai nó thuộc loại nào:
 *   SUCCESS      — trang mở được và dựng xong khung ứng dụng.
 *   APP_ERROR    — trang trả 4xx/5xx, hoặc 200 mà không dựng nổi khung. LỖI THẬT của ứng dụng.
 *   AUTH_EXPIRED — bị đá về đăng nhập vì phiếu ký đã quá hạn. Lỗi CỦA PHÉP KIỂM, không phải của app.
 *   REDIRECT     — bị đá về đăng nhập trong khi phiếu ký còn mới ⇒ quyền/cấu hình sai. Lỗi thật.
 *   SLOW         — trang MỞ ĐƯỢC nhưng lâu hơn ngưỡng. Vấn đề hiệu năng, KHÔNG chặn deploy.
 *   SKIPPED      — hết ngân sách thời gian nên CHƯA kiểm. Không phải "đạt", cũng không phải "hỏng".
 *   TIMEOUT      — trang không trả lời trong hạn. Lỗi thật (nhưng khác bản chất với APP_ERROR).
 */
type Verdict = "SUCCESS" | "SLOW" | "SKIPPED" | "APP_ERROR" | "AUTH_EXPIRED" | "REDIRECT" | "TIMEOUT";

/** Hạn của phiếu ký. Quá mốc này mà bị 307 thì nguyên nhân là hết hạn, không phải phân quyền. */
const TOKEN_TTL_MS = 10 * 60 * 1000;
/** Chừa biên: gần hết hạn cũng tính là hết hạn, vì thời điểm máy chủ kiểm có thể lệch vài giây. */
const TOKEN_NEAR_EXPIRY_MS = TOKEN_TTL_MS - 30_000;

/**
 * HAI MỐC THỜI GIAN, VÌ CHÚNG TRẢ LỜI HAI CÂU HỎI KHÁC NHAU.
 *
 * `ttfbMs` — tới lúc có ĐẦU PHẢN HỒI. `ms` — tới lúc có ĐỦ THÂN TRANG.
 *
 * Với App Router, `fetch` trả về ngay khi đầu phản hồi tới, còn thân trang chảy về sau theo từng
 * ranh giới Suspense. Đo ở mốc thứ nhất rồi gọi nó là thời gian tải trang là đo nhầm đại lượng:
 * người dùng chỉ đọc được trang khi thân đã về.
 */
type Result = { route: string; verdict: Verdict; detail: string; ms: number; ttfbMs: number };

/**
 * ĐỌC THÂN PHẢN HỒI CÓ HẠN CHỜ, VÀ GIỮ LẠI PHẦN ĐÃ VỀ.
 *
 * `response.text()` là tất-cả-hoặc-không-gì: quá hạn thì ném lỗi và ném luôn những byte đã nhận.
 * Nhưng phần đã về mới là thứ trả lời được câu hỏi quan trọng nhất — "trang này đang CHẬM hay đang
 * HỎNG" — vì dấu hiệu trang lỗi và mã lỗi RSC nằm ngay trong đó.
 *
 * Nên đọc theo từng khối và tự canh giờ: hết hạn thì DỪNG đọc, trả về những gì đã có kèm cờ
 * `complete = false`. Người gọi soi lỗi trên phần ấy trước, rồi mới kết luận chậm.
 */
async function docThan(response: Response, hanMs: number): Promise<{ text: string; complete: boolean }> {
  if (!response.body) return { text: await response.text(), complete: true };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const hetHan = Date.now() + hanMs;
  let text = "";
  try {
    for (;;) {
      const conLai = hetHan - Date.now();
      if (conLai <= 0) return { text, complete: false };
      // Chạy đua giữa "khối tiếp theo" và "hết giờ" — `reader.read()` không tự có hạn chờ, và một
      // ranh giới Suspense treo hẳn sẽ không bao giờ trả về.
      //
      // Đồng hồ phải được GỠ sau mỗi vòng. Để nó sống thì mỗi khối dữ liệu bỏ lại một hẹn giờ 60
      // giây còn treo kèm closure của nó — trang 2,9 MB về theo hàng nghìn khối là hàng nghìn hẹn
      // giờ nằm trong bộ nhớ, trên đúng cái VPS 2 GB mà phép đo này đang chạy.
      let dongHo: ReturnType<typeof setTimeout> | undefined;
      const ketQua = await Promise.race([
        reader.read(),
        new Promise<"HET_GIO">((resolve) => {
          dongHo = setTimeout(() => resolve("HET_GIO"), conLai);
        }),
      ]).finally(() => clearTimeout(dongHo));
      if (ketQua === "HET_GIO") return { text, complete: false };
      if (ketQua.done) return { text: text + decoder.decode(), complete: true };
      text += decoder.decode(ketQua.value, { stream: true });
    }
  } finally {
    // Huỷ luồng đọc dở: không huỷ thì kết nối nằm treo và trang sau phải chờ ghế trong bể kết nối.
    await reader.cancel().catch(() => {});
  }
}

/**
 * ═══════════ DẤU HIỆU BẮT BUỘC PHẢI CÓ TRONG HTML CỦA MỘT SỐ TUYẾN ═══════════
 *
 * Chỉ khai thứ mà THIẾU NÓ THÌ TRANG VÔ DỤNG, không khai chi tiết bố cục — một danh sách bám vào
 * cách viết HTML sẽ đỏ mỗi lần đổi lớp CSS và rồi bị ai đó tắt đi.
 *
 * Dùng `aria-label` làm dấu: nó là HỢP ĐỒNG TRỢ NĂNG, ổn định hơn tên lớp, và nếu nó đổi thì nhãn
 * người dùng trình đọc màn hình nghe thấy cũng đã đổi — đúng là chuyện đáng đỏ.
 */
const EXPECT: Record<string, { marker: string; why: string }[]> = {
  "/cs": [{ marker: 'aria-label="Sao chép SĐT"', why: "CSKH phải chép được SĐT, không gõ lại" }],
  "/cs?view=theo-case": [
    { marker: 'aria-label="Sao chép SĐT"', why: "CSKH phải chép được SĐT, không gõ lại" },
    { marker: 'aria-label="Sao chép mã vận đơn"', why: "gõ lại mã vận đơn sai một chữ số là tra ra đơn người khác" },
    /*
      BA CÔNG CỤ CỦA HÀNG ĐỢI V2. Đo production 14/09/2026 TRƯỚC bản này: 2/417 case đang mở có
      người phụ trách thật — một hàng đợi mà không giao được việc thì chỉ là một bảng để ngắm.
      Ba dấu hiệu dưới đây là ba thứ người trực dùng, và chúng phải có mặt trong HTML thật chứ
      không chỉ trong bản dựng ở máy người viết.
    */
    { marker: 'aria-label="Người phụ trách"', why: "trưởng nhóm phải giao được việc, không chỉ tự nhận" },
    { marker: "Phát sinh", why: "mốc case RA ĐỜI (created_at) — thiếu nó thì không sắp xếp được hàng đợi theo tuổi thật" },
    { marker: "Ghi chú", why: "ghi chú xử lý tách khỏi bằng chứng; trộn lại thì không ai phân biệt lời khách với kết luận đồng nghiệp" },
  ],
  "/shipments": [{ marker: 'aria-label="Sao chép mã vận đơn"', why: "bàn vận đơn sống bằng việc dán mã sang trang ĐVVC" }],
  /*
    Ô ĐƯA SỔ HÀNG HOÀN VÀO MÁY CHỦ.

    Đây là đường DUY NHẤT chủ shop đưa được tệp Excel tới nơi có CSDL production (máy của chủ shop
    không có khoá SSH). Ô này không hiện ra trên HTML thật thì cả bộ máy đối soát HMT không chạy
    được lần nào — và đó đúng là tình trạng đã kéo dài từ 13/09/2026.
  */
  "/inventory/returns": [{ marker: 'id="hmt-file"', why: "không có ô này thì sổ hàng hoàn không có đường nào tới máy chủ" }],
};

async function main() {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) throw new Error("Thiếu AUTH_SECRET — không mint được phiên đăng nhập để smoke test");

  // SMOKE_USER_ID cho phép chạy mà không mở CSDL (PGlite chỉ cho một tiến trình mở thư mục dữ liệu,
  // nên khi thử tại máy dev thì server đang giữ khoá). Trên production luôn là PostgreSQL nên tra thẳng.
  let userId = (process.env.SMOKE_USER_ID ?? "").trim();
  let email = "smoke@erp.local";
  let name = "Smoke test";
  if (!userId) {
    const db = await getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
    if (!user) throw new Error("Chưa có tài khoản quản trị nào để smoke test");
    userId = user.id;
    email = user.email;
    name = user.name;
  }

  /**
   * PHIÊN ĐƯỢC KÝ LẠI TRƯỚC TỪNG TRANG.
   *
   * Sự cố thật 09/09/2026: một phiếu ký duy nhất hạn 10 phút, mà cả lượt smoke trên VPS 2 nhân
   * (lần render đầu của mỗi trang phải dựng báo cáo từ đầu, chưa có bộ nhớ đệm) mất 10 phút 07
   * giây. Đúng phút thứ 10, mọi trang còn lại bị đá về trang đăng nhập — báo cáo ra "13/21 màn
   * hình LỖI" trong khi ứng dụng hoàn toàn bình thường. Một phép kiểm mà hỏng vì chính nó chạy
   * lâu thì nó không đo được cái nó định đo.
   *
   * Ký lại tốn vài chục micro giây và không gọi mạng, nên rẻ hơn nhiều so với việc kéo dài hạn
   * phiếu — kéo dài chỉ đẩy ngưỡng đi chứ không bỏ được ngưỡng.
   */
  const key = new TextEncoder().encode(secret);
  const mint = () =>
    new SignJWT({ email, name, role: "ADMIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);

  const results: Result[] = [];

  // Chi phí nguội: đo và in ra, không tính đạt/không đạt. Hạn chờ nới rộng vì đây chính là lần
  // chậm nhất theo thiết kế — mục đích là BIẾT nó bao lâu, không phải đánh trượt deploy vì nó.
  {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 3);
    try {
      const r = await fetch(`${BASE}${WARMUP_ROUTE}`, {
        headers: { cookie: `erp_session=${await mint()}` },
        redirect: "manual",
        signal: controller.signal,
      });
      await r.text();
      console.log(`  ⏱ làm nóng ${WARMUP_ROUTE} → HTTP ${r.status} (${Date.now() - started}ms) — chi phí NGUỘI, không tính vào kết quả`);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      console.error(`  ⏱ làm nóng ${WARMUP_ROUTE} → ${aborted ? `quá ${Math.round((TIMEOUT_MS * 3) / 1000)}s` : String(error)} (không tính vào kết quả)`);
    } finally {
      clearTimeout(timer);
    }
  }

  /*
    ═══════════ TRANG CHI TIẾT VẬN ĐƠN — ĐỊA CHỈ PHẢI LẤY TỪ DỮ LIỆU THẬT ═══════════

    `ROUTES` là danh sách TĨNH, nên tuyến `/shipments/[id]` chưa bao giờ nằm trong lá chắn: không
    có mã vận đơn nào gõ cứng được mà vẫn đúng sau một tháng. Nhưng đó lại là trang NẶNG NHẤT của
    module giao vận — từ 16/09/2026 nó dựng nhật ký hợp nhất, đọc sáu bảng cho một kiện — và một
    truy vấn hỏng ở đó sẽ không lượt smoke nào thấy.

    Nên hai địa chỉ được PHÂN GIẢI LÚC CHẠY:
      · kiện có NHIỀU SỰ KIỆN ĐVVC nhất — tuyến nặng của chiều chứng từ;
      · kiện có THAO TÁC CHĂM SÓC của người — tuyến duy nhất đi qua cả bốn chiều của nhật ký.

    Không tìm được thì BỎ QUA im lặng (kho mới, chưa có dữ liệu) chứ không làm đỏ lần deploy: đây
    là lá chắn hiệu năng, không phải bài kiểm dữ liệu.
  */
  const routes = [...ROUTES];
  try {
    const db = await getDb();
    const them = async (sql: string, vi_sao: string) => {
      const rows = (await db.execute(sql as never)) as unknown as { rows?: { id: string }[] } | { id: string }[];
      const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
      const id = list[0]?.id;
      if (id && !routes.includes(`/shipments/${id}`)) {
        routes.push(`/shipments/${id}`);
        console.error(`  · thêm tuyến động /shipments/${id} — ${vi_sao}`);
      }
    };
    await them(
      `select s.id from shipments s join shipment_events e on e.shipment_id = s.id group by s.id order by count(*) desc limit 1`,
      "kiện nhiều sự kiện ĐVVC nhất",
    );
    await them(
      `select s.id from shipments s where exists (select 1 from care_actions a where a.shipment_id = s.id) order by s.created_at desc limit 1`,
      "kiện có thao tác chăm sóc của người",
    );
    /*
      TRANG CHI TIẾT MỘT LẦN NHẬP TỆP — cùng lý do, cùng cách: không có mã lần nhập nào gõ cứng
      được mà vẫn đúng sau một tuần. Trang này đọc ba bảng (`vtp_import_batches`,
      `vtp_webhook_gaps`, và các lượt cùng checksum) nên một truy vấn hỏng ở đó không lượt smoke
      nào thấy nếu chỉ phủ trang danh sách.
    */
    try {
      const rows = (await db.execute(
        `select id from vtp_import_batches order by created_at desc limit 1` as never,
      )) as unknown as { rows?: { id: string }[] } | { id: string }[];
      const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
      const id = list[0]?.id;
      if (id) {
        routes.push(`/import-vtp/${id}`);
        console.error(`  · thêm tuyến động /import-vtp/${id} — lần nhập tệp gần nhất`);
      }
    } catch {
      // Chưa có lần nhập nào ⇒ bỏ qua im lặng, không làm đỏ lần deploy.
    }
  } catch (e) {
    console.error(`  · không phân giải được tuyến chi tiết vận đơn (bỏ qua): ${e instanceof Error ? e.message : e}`);
  }

  const runStarted = Date.now();

  for (const route of routes) {
    // Hết ngân sách: ghi BỎ QUA cho phần còn lại thay vì đốt thêm 60 giây mỗi trang và làm hỏng
    // chính lần deploy đang kiểm.
    if (Date.now() - runStarted > BUDGET_MS) {
      results.push({ route, verdict: "SKIPPED", detail: `hết ngân sách ${Math.round(BUDGET_MS / 1000)}s cho cả lượt — CHƯA kiểm`, ms: 0, ttfbMs: 0 });
      console.error(`  – ${route} [SKIPPED] chưa kiểm vì hết ngân sách`);
      continue;
    }
    const started = Date.now();
    // Phiếu ký được tạo NGAY TRƯỚC lần gọi này, nên tuổi của nó gần bằng thời gian chờ của
    // chính trang này — dùng nó để phân biệt "hết hạn" với "sai quyền".
    const mintedAt = Date.now();
    const cookie = `erp_session=${await mint()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    // Khai ngoài `try` để khối `catch` cũng nói được "đầu phản hồi đã về hay chưa" — một trang quá
    // hạn TRƯỚC khi có đầu phản hồi là máy chủ treo, quá hạn SAU đó là thân trang chảy quá lâu.
    let ttfbMs = 0;
    try {
      const response = await fetch(`${BASE}${route}`, {
        headers: { cookie },
        redirect: "manual",
        signal: controller.signal,
      });
      ttfbMs = Date.now() - started;
      // Đầu phản hồi đã về ⇒ giai đoạn "máy chủ treo" đã qua. Gỡ đồng hồ CHẶN ở đây để nó không
      // lấn sang giai đoạn đọc thân — thân chảy chậm là chuyện hiệu năng, không phải cớ chặn.
      clearTimeout(timer);

      if (response.status >= 300 && response.status < 400) {
        const ms = ttfbMs;
        const tokenAge = Date.now() - mintedAt;
        const expired = tokenAge >= TOKEN_NEAR_EXPIRY_MS;
        results.push({
          route,
          verdict: expired ? "AUTH_EXPIRED" : "REDIRECT",
          detail: expired
            ? `HTTP ${response.status} sau ${Math.round(tokenAge / 1000)}s — phiếu ký hết hạn giữa lần gọi, KHÔNG phải lỗi trang`
            : `HTTP ${response.status} với phiếu ký còn mới (${Math.round(tokenAge / 1000)}s) — kiểm tra quyền của tài khoản quản trị`,
          ms,
          ttfbMs,
        });
        continue;
      }

      if (response.status !== 200) {
        results.push({ route, verdict: "APP_ERROR", detail: `HTTP ${response.status}`, ms: ttfbMs, ttfbMs });
        continue;
      }

      /*
        ═══ ĐỒNG HỒ DỪNG Ở ĐÂY, KHÔNG PHẢI Ở `fetch` ═══

        SỰ CỐ THẬT (15/09/2026, đo trên bản ghi của deploy #304). Smoke báo cả 54 màn hình đều dưới
        310ms — tổng cộng 5,6 giây — trong khi CẢ LƯỢT chạy mất 269 giây. 263 giây, tức 97,9% thời
        gian thật, không nằm trong bất kỳ con số nào mà phép đo in ra.

        Nguyên nhân: `fetch` hoàn tất khi ĐẦU phản hồi về, còn thân trang RSC chảy về sau. Ngưỡng
        `SLOW_MS` vì thế đang xét thời gian tới đầu phản hồi, nên một trang chảy ba mươi giây vẫn
        được ghi "SUCCESS 74ms". Lá chắn hiệu năng đã mù đúng ở chỗ nó sinh ra để canh, và không
        cách nào biết trang nào đang đốt ngân sách 300 giây của cả lượt.

        Đọc hết thân rồi mới dừng đồng hồ. Con số sẽ XẤU đi so với bản trước — đó là vì nó bắt đầu
        nói thật, không phải vì ứng dụng vừa chậm lại.
      */
      const { text: body, complete: thanDayDu } = await docThan(response, BODY_TIMEOUT_MS);
      const ms = Date.now() - started;

      if (!body.includes(RENDER_MARKER)) {
        results.push({ route, verdict: "APP_ERROR", detail: "HTTP 200 nhưng không dựng được khung ứng dụng", ms, ttfbMs });
        continue;
      }

      /*
        ═══ TRANG LỖI CŨNG TRẢ HTTP 200 ═══

        SỰ CỐ THẬT (10/09/2026). `/operations` hỏng hoàn toàn vì một lỗi SQL, chủ shop mở ra thấy
        "Có lỗi khi tải trang" — mà smoke báo **SUCCESS 121kB trong 102ms**, hai lần deploy liên
        tiếp. Ranh giới lỗi của Next dựng ra một trang hoàn chỉnh, có đủ khung ứng dụng, và trả
        HTTP 200. Mọi tiêu chí smoke đang dùng đều đạt.

        Nghĩa là suốt thời gian đó lá chắn hiệu năng vẫn xanh trong khi một trang chết hẳn. Đo mã
        HTTP và kích thước là chưa đủ: phải đọc xem trang có đang NÓI rằng nó lỗi hay không.
      */
      if (body.includes(ERROR_MARKER)) {
        results.push({ route, verdict: "APP_ERROR", detail: "HTTP 200 nhưng dựng ra TRANG LỖI (ranh giới lỗi của Next) — xem log máy chủ theo mã lỗi", ms, ttfbMs });
        continue;
      }

      /*
        Lỗi ở THÂN TRANG không kịp thành chữ trong HTML — chỉ còn mã lỗi trong gói RSC. Xem
        DIGEST_MARKER ở trên: đây chính là lỗ hổng đã để `/bank` đi qua hai lượt deploy.
      */
      const ma = DIGEST_MARKER.exec(body);
      if (ma) {
        const so = /(\d{3,})/.exec(ma[0])?.[1] ?? "";
        results.push({ route, verdict: "APP_ERROR", detail: `HTTP 200 nhưng gói RSC mang LỖI MÁY CHỦ (mã ${so}) — trang chỉ hiện lỗi sau khi chạy JavaScript`, ms, ttfbMs });
        continue;
      }

      /*
        ═══ TRANG MỞ ĐƯỢC MÀ THIẾU CÔNG CỤ CHÍNH CŨNG LÀ TRANG HỎNG ═══

        SỰ CỐ THẬT (13/09/2026). Một bản phát hành giao nút sao chép cho hàng đợi CSKH nhưng SÓT
        bàn care; chuyện đó chỉ lộ ra lúc rà lại để viết biên bản — tức SAU khi deploy đã chạy, và
        tốn một lượt deploy thứ hai (`docs/release-2026-09-13-cskh-returns-ops.md`).

        Không lá chắn nào bắt được: trang trả 200, dựng đủ khung, không lỗi, đúng kích thước. Nó
        chỉ thiếu mất cái nút mà cả bản phát hành sinh ra để giao. Đo mã HTTP và kích thước không
        trả lời được câu "thứ vừa giao có thật sự ở trên đó không".
      */
      const thieu = (EXPECT[route] ?? []).filter((e) => !body.includes(e.marker));
      if (thieu.length) {
        results.push({
          route,
          verdict: "APP_ERROR",
          detail: `HTTP 200 nhưng THIẾU công cụ bắt buộc: ${thieu.map((e) => `"${e.marker}" (${e.why})`).join(" · ")}`,
          ms,
          ttfbMs,
        });
        continue;
      }

      /*
        THÂN TRANG CHƯA VỀ HẾT TRONG HẠN — CHẬM, KHÔNG PHẢI LỖI.

        Đặt SAU mọi phép dò lỗi ở trên là có chủ ý: phần thân đã về vẫn được soi tìm trang lỗi và mã
        lỗi RSC, nên một trang HỎNG mà lại chảy chậm vẫn bị bắt đúng là APP_ERROR. Chỉ khi không tìm
        thấy lỗi nào thì mới kết luận "trang này chậm", và con số in ra là CẬN DƯỚI — nói thẳng như
        thế thay vì in một con số trông như đã đo xong.
      */
      if (!thanDayDu) {
        results.push({
          route,
          verdict: "SLOW",
          detail: `${Math.round(body.length / 1024)}kB đã về · đầu phản hồi ${ttfbMs}ms · thân CHƯA xong sau ${Math.round(BODY_TIMEOUT_MS / 1000)}s (con số là cận dưới) · không tìm thấy lỗi trong phần đã về`,
          ms,
          ttfbMs,
        });
        continue;
      }

      // Trang mở được: phân biệt NHANH với CHẬM. Chậm là việc phải sửa, không phải cớ chặn deploy.
      //
      // In KÈM mốc đầu phản hồi khi hai mốc lệch nhau đáng kể: "đầu 102ms · đủ thân 28,4s" chỉ
      // thẳng vào ranh giới Suspense chảy lâu, còn "đầu 9,8s · đủ thân 9,9s" chỉ vào một truy vấn
      // chặn trước khi trang kịp bắt đầu. Hai bệnh khác nhau, hai chỗ sửa khác nhau.
      const lechDangKe = ms - ttfbMs > 1_000;
      results.push({
        route,
        verdict: ms > SLOW_MS ? "SLOW" : "SUCCESS",
        detail:
          `${Math.round(body.length / 1024)}kB` +
          (lechDangKe ? ` · đầu phản hồi ${ttfbMs}ms · thân ${((ms - ttfbMs) / 1000).toFixed(1)}s` : "") +
          (ms > SLOW_MS ? ` · CHẬM, ngưỡng ${Math.round(SLOW_MS / 1000)}s` : ""),
        ms,
        ttfbMs,
      });
    } catch (error) {
      const ms = Date.now() - started;
      const aborted = error instanceof Error && error.name === "AbortError";
      results.push({
        route,
        verdict: aborted ? "TIMEOUT" : "APP_ERROR",
        detail: aborted
          ? `không trả lời trong ${Math.round(TIMEOUT_MS / 1000)}s${ttfbMs ? ` (đầu phản hồi đã về sau ${ttfbMs}ms — treo ở THÂN trang)` : " (chưa có cả đầu phản hồi)"}`
          : error instanceof Error
            ? error.message
            : String(error),
        ms,
        ttfbMs,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const icon: Record<Verdict, string> = {
    SUCCESS: "✓",
    APP_ERROR: "✗",
    AUTH_EXPIRED: "⚠",
    REDIRECT: "✗",
    SLOW: "⚠",
    SKIPPED: "–",
    TIMEOUT: "✗",
  };
  for (const r of results) {
    const line = `  ${icon[r.verdict]} ${r.route} [${r.verdict}] ${r.detail} (${r.ms}ms)`;
    if (r.verdict === "SUCCESS") console.log(line);
    else console.error(line);
  }

  const by = (v: Verdict) => results.filter((r) => r.verdict === v);
  console.log(
    `\n[smoke] ${(by("SUCCESS").length + by("SLOW").length)}/${results.length} đạt · ` +
      `${by("APP_ERROR").length} lỗi ứng dụng · ${by("REDIRECT").length} sai quyền · ` +
      `${by("SLOW").length} chậm · ${by("SKIPPED").length} chưa kiểm · ${by("TIMEOUT").length} quá hạn · ${by("AUTH_EXPIRED").length} hết phiên ` +
      `(cả lượt chạy ${Math.round((Date.now() - runStarted) / 1000)}s)`,
  );

  /*
    ═══ PHÉP ĐO PHẢI TỰ KHAI PHẦN NÓ KHÔNG ĐO ĐƯỢC ═══

    Bài học của chính lỗi vừa sửa: tổng thời gian các trang là 5,6 giây trong khi cả lượt mất 269
    giây, và KHÔNG con số nào in ra nói lên điều đó — nên suốt nhiều lượt deploy không ai thấy lá
    chắn hiệu năng đang đo nhầm đại lượng.

    Dòng dưới đây là cái chốt: nếu mai này lại có thứ gì nằm ngoài đồng hồ, khoảng chênh sẽ tự hiện
    ra ở đây thay vì phải đi lục bản ghi mới thấy.
  */
  const tongDo = results.reduce((t, r) => t + r.ms, 0);
  const caLuot = Date.now() - runStarted;
  const ngoaiDo = caLuot - tongDo;
  console.log(
    `[smoke] đồng hồ: ${(tongDo / 1000).toFixed(1)}s nằm trong các trang · ` +
      `${(ngoaiDo / 1000).toFixed(1)}s ngoài phép đo (${Math.round((ngoaiDo / Math.max(1, caLuot)) * 100)}% cả lượt — ký phiếu, dựng kết nối, chi phí giữa các lần gọi)`,
  );

  // HẾT PHIÊN KHÔNG PHẢI LỖI CỦA ỨNG DỤNG nên không đánh trượt deploy — nhưng phải hiện ra, vì
  // với cơ chế ký lại mỗi trang thì nó chỉ xảy ra khi một trang chậm hơn cả hạn phiếu ký.
  if (by("AUTH_EXPIRED").length) {
    console.error(
      `\n[smoke] ⚠ ${by("AUTH_EXPIRED").length} trang không kiểm được vì phiếu ký hết hạn giữa lần gọi ` +
        `(trang chậm hơn ${TOKEN_TTL_MS / 60000} phút). Không tính là lỗi trang, nhưng KHÔNG chứng minh được trang đó tốt.`,
    );
  }

  /**
   * CHỈ LỖI THẬT MỚI CHẶN DEPLOY.
   *
   * `SLOW` cố ý KHÔNG nằm trong danh sách chặn: trang vẫn mở được, và chặn bản mới vì nó chậm có thể
   * đang chặn đúng bản vá làm nó nhanh hơn. Nhưng cũng KHÔNG im lặng — in riêng thành một mục để
   * không ai bỏ qua.
   */
  const slow = by("SLOW");
  if (slow.length) {
    console.error(`
[smoke] ${slow.length} màn hình CHẬM (mở được, không chặn deploy — nhưng phải sửa):`);
    for (const r of slow.sort((a, b) => b.ms - a.ms)) console.error(`  - ${r.route} → ${(r.ms / 1000).toFixed(1)}s`);
  }

  const fatal = [...by("APP_ERROR"), ...by("REDIRECT"), ...by("TIMEOUT")];
  if (fatal.length) {
    console.error(`\n[smoke] ${fatal.length}/${results.length} màn hình LỖI THẬT:`);
    for (const f of fatal) console.error(`  - ${f.route} [${f.verdict}] ${f.detail}`);
    process.exit(1);
  }
  console.log(`[smoke] ✓ Không có lỗi thật.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[smoke] Không chạy được smoke test:", error instanceof Error ? error.message : error);
  process.exit(1);
});
