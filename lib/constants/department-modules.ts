import type { Permission } from "@/lib/auth/permissions";
import { DEPARTMENT_HINT, DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ BẢN ĐỒ MÀN HÌNH: MỖI MODULE THUỘC ĐÚNG MỘT PHÒNG BAN ═══════════
 *
 * Trước bản này thanh menu xếp theo LUỒNG CÔNG VIỆC ("tin nhắn → chốt đơn → giao vận → tiền → kho"),
 * và cách xếp đó đúng cho MỘT người: người nhìn cả shop. Với người làm một khâu thì nó trộn việc của
 * ba phòng vào một nhóm — `docs/navigation-review.md` đề xuất Đ1 đã nêu từ 12/09/2026 rồi để chủ shop
 * quyết. Chủ shop chốt 23/09/2026: **gom theo phòng ban**, và tách phòng Sản xuất thành phòng riêng.
 *
 * ─── VÌ SAO LÀ MỘT SỔ KHAI, KHÔNG PHẢI MỘT MẢNG TRONG `app-sidebar.tsx` ───
 *
 * Danh sách module trước đây sống trong một client component, nên ba thứ khác phải ĐỌC LẠI MÃ NGUỒN
 * của nó bằng biểu thức chính quy để biết ERP có những trang nào: bài kiểm phủ điều hướng, bài kiểm
 * phủ smoke, và chính thanh bên. Một sổ khai đọc bằng `import` thì tất cả cùng nhìn một bảng, và bảng
 * đó trả lời được câu mà mảng cũ không trả lời được: *phòng nào sở hữu màn hình này, và vì sao.*
 *
 * ─── BA LUẬT ───
 *
 * 1. **Một module thuộc ĐÚNG MỘT phòng.** Trang nào hai phòng cùng dùng thì vẫn phải chọn một chủ —
 *    phòng mà QUYẾT ĐỊNH của họ sinh ra từ trang đó. Hai chủ thì tới ngày không ai dọn.
 * 2. **`why` là bắt buộc.** Một dòng nói vì sao phòng này chứ không phải phòng kia. Không có `why`
 *    thì lần sắp xếp sau sẽ là một lượt đoán ý người trước.
 * 3. **Phòng không có màn hình riêng phải NÓI RA, không được biến mất.** Xem `NO_MODULE_REASON`:
 *    phòng Nhân sự hôm nay không sở hữu một trang top-level nào, và đó là một sự thật đáng đọc chứ
 *    không phải một chỗ trống để lấp bằng một trang giả.
 *
 * Icon KHÔNG nằm ở đây: `lucide-react` là thư viện giao diện, còn tệp này được cả bài kiểm quét mã
 * nguồn lẫn trang máy chủ đọc. `components/app-sidebar.tsx` giữ bảng icon và TypeScript đòi bảng đó
 * phủ đủ mọi `href` — thiếu một mục là lỗi biên dịch, không phải một mục menu không có hình.
 */

/** Hai nhóm KHÔNG thuộc phòng nào — và cả hai đều có lý do riêng, không phải chỗ dồn đồ lẻ. */
export const CROSS_ZONES = ["EVERYONE", "SYSTEM"] as const;
export type CrossZone = (typeof CROSS_ZONES)[number];

export type ModuleZone = DepartmentCode | CrossZone;

export type ModuleSpec = {
  href: string;
  label: string;
  zone: ModuleZone;
  /** Quyền tối thiểu để thấy mục. Không khai = ai đăng nhập cũng thấy. */
  permission?: Permission;
  /** Đủ MỘT trong các quyền này là thấy — dùng cho trang gộp nhiều sổ (ví dụ Tổng quan tài chính). */
  anyOf?: readonly Permission[];
  /** Một dòng: vì sao phòng này sở hữu màn hình này. */
  why: string;
};

/**
 * ═══ SỔ KHAI ═══
 *
 * Thứ tự trong mảng KHÔNG quyết định thứ tự các NHÓM (`ZONE_ORDER` làm việc đó), nhưng quyết định
 * thứ tự các MỤC trong một nhóm — xếp theo thứ tự người của phòng đó mở trong ngày.
 */
export const NAV_MODULES = [
  // ───────────────── MỌI PHÒNG: ba màn hình trả lời "hôm nay làm gì" ─────────────────
  {
    href: "/",
    label: "Tổng quan",
    zone: "EVERYONE",
    permission: "dashboard:view",
    why: "Ảnh chụp cả shop. Không thuộc phòng nào vì mọi phòng đều mở nó đầu ngày.",
  },
  {
    href: "/alerts",
    label: "Cần xử lý",
    zone: "EVERYONE",
    permission: "alerts:view",
    why: "Hàng đợi cảnh báo của cả shop, bên trong đã tự xếp theo phòng chịu trách nhiệm. Đặt nó vào một phòng là giấu việc của bảy phòng kia.",
  },
  {
    href: "/work",
    label: "Công việc & mục tiêu",
    zone: "EVERYONE",
    permission: "work:view",
    why: "Bàn làm việc cá nhân + hàng đợi phòng + mục tiêu. Mỗi người mở nó thấy đúng phần của mình, nên nó là màn hình dùng chung chứ không phải của một phòng.",
  },

  // ───────────────── KINH DOANH & CSKH ─────────────────
  {
    href: "/cs",
    label: "CSKH & tin nhắn",
    zone: "SALES",
    permission: "cs:view",
    why: "Khách nhắn tin là khâu chốt đơn — người trả lời chính là người bán (cùng lý do với luật sở hữu việc CS_CASE).",
  },
  {
    href: "/orders",
    label: "Đơn hàng",
    zone: "SALES",
    permission: "orders:read",
    why: "Sổ đơn là kết quả của khâu chốt đơn; người sửa một đơn sai địa chỉ là người gọi được khách.",
  },
  {
    href: "/landing",
    label: "Đơn landing page",
    zone: "SALES",
    permission: "landing:view",
    why: "Đơn từ landing vẫn phải gọi xác nhận trước khi lên vận đơn — cùng người, cùng việc với đơn từ tin nhắn.",
  },
  {
    href: "/customers",
    label: "Khách hàng",
    zone: "SALES",
    permission: "customers:view",
    why: "Hồ sơ khách và lịch sử mua là công cụ của người bán, không phải báo cáo của ban điều hành.",
  },
  {
    href: "/outreach",
    label: "Chăm sóc & bán chéo",
    zone: "SALES",
    permission: "outreach:view",
    why: "Nhắn lại cho khách cũ là bán hàng, dù nó chạy bằng chiến dịch. Marketing mua khách MỚI; đây là khách đã có.",
  },
  {
    href: "/chatbot",
    label: "Bot chat bán hàng",
    zone: "SALES",
    permission: "cs:config",
    why: "Bot trả lời và chốt đơn THAY nhân viên bán hàng trên fanpage — cài đặt của nó là kịch bản bán hàng của phòng này.",
  },

  // ───────────────── MARKETING ─────────────────
  {
    href: "/ads",
    label: "Quảng cáo",
    zone: "MARKETING",
    permission: "expenses:view",
    why: "Tiền quảng cáo và quyết định cắt/tăng từng chiến dịch — việc của người tiêu tiền quảng cáo.",
  },
  {
    href: "/ideas",
    label: "Ý tưởng marketing",
    zone: "MARKETING",
    permission: "ideas:view",
    why: "Xưởng ý tưởng (Idea Factory): nội dung, góc tiếp cận, mẫu thử. Đầu vào của chiến dịch, nên đứng cạnh chiến dịch.",
  },
  {
    href: "/marketing/creatives",
    label: "Thư viện Media",
    zone: "MARKETING",
    permission: "ideas:view",
    why: "Thư viện Media (trước 26/09/2026 tên \"Vòng mẫu QC\"): ảnh nguồn → máy dựng lô → duyệt → test → chấm → học. Người chạy quảng cáo nạp ảnh, khai luật tắt/giữ và duyệt lô.",
  },
  {
    href: "/marketing/video-scale",
    label: "Video Scale",
    zone: "MARKETING",
    permission: "ideas:view",
    why: "Video Reels 9:16 cho MÃ WIN: ảnh sản phẩm thật → kịch bản theo góc bán → clip Veo → hậu kỳ → QC → duyệt. Cùng người chạy quảng cáo với Thư viện Media, tách màn hình vì luồng video có hàng đợi và trần tiền riêng.",
  },
  {
    href: "/marketing/topics",
    label: "Topic gửi sản xuất",
    zone: "MARKETING",
    permission: "production:topic-open",
    why: "Chủ shop 27/09/2026: marketer là người MỞ topic — mẫu thắng test cần hỏi giá, chất liệu, giá sản xuất mong muốn — và tag người sản xuất vào trao đổi. Phòng Sản xuất vẫn giữ màn hình \"Topic sản xuất\" để làm việc với xưởng.",
  },
  {
    href: "/marketing/fanpages",
    label: "Fanpage & quy kết MKT",
    zone: "MARKETING",
    permission: "reports:nominal",
    why: "Ánh xạ fanpage → marketer quyết định đơn về tay ai; chỉ người chạy quảng cáo biết phân công thật.",
  },

  // ───────────────── GIAO VẬN ─────────────────
  {
    href: "/shipments",
    label: "Vận đơn & care",
    zone: "LOGISTICS",
    permission: "shipments:view",
    why: "Bàn làm việc với Viettel Post: hành trình kiện, ca chăm sóc, yêu cầu phát lại.",
  },
  {
    href: "/returns",
    label: "Phiếu đổi / trả (Pancake)",
    zone: "LOGISTICS",
    permission: "returns:view",
    why: "Vòng đời một kiện hoàn bắt đầu ở chiều vận chuyển. Khâu ĐẾM hàng về là của kho và có màn hình riêng.",
  },
  {
    href: "/reports/returns",
    label: "Tỷ lệ giao thành công",
    zone: "LOGISTICS",
    permission: "reports:returns",
    why: "Đây là thước đo NGHỀ của giao vận, không phải một báo cáo tài chính — người mở nó hằng ngày là người care kiện hàng.",
  },

  // ───────────────── KHO ─────────────────
  {
    href: "/inventory/packing",
    label: "Đóng gói theo lượt",
    zone: "WAREHOUSE",
    permission: "products:view",
    why: "Đóng gói là việc tốn người nhất của kho, và chỉ người đứng ở kệ mới đi lấy hàng — bày đơn đủ hàng theo cách đi kho ít vòng nhất là việc của chính họ.",
  },
  {
    href: "/products",
    label: "Sản phẩm & tồn kho",
    zone: "WAREHOUSE",
    permission: "products:view",
    why: "Số tồn thực tế và khả dụng bán — chỉ người giữ kho làm nó đúng lên được.",
  },
  {
    href: "/inventory/receipts",
    label: "Nhập hàng & kiểm kê",
    zone: "WAREHOUSE",
    permission: "products:view",
    why: "Phiếu kho là chứng từ duy nhất đưa hàng vào tồn; người lập phiếu là người đếm.",
  },
  {
    href: "/inventory/returns",
    label: "Kiểm đếm hàng hoàn · kho",
    zone: "WAREHOUSE",
    permission: "products:view",
    why: "Hàng hoàn CHỈ vào tồn khi kho mở kiện và đếm thật — ĐVVC báo 'đã hoàn' không phải là một phiếu nhập.",
  },
  {
    href: "/inventory",
    label: "Nhật ký kho",
    zone: "WAREHOUSE",
    permission: "products:view",
    why: "Đường truy vết cuối cùng khi một con số tồn kho sai. Người tra nó là người giữ kho.",
  },

  // ───────────────── SẢN XUẤT ─────────────────
  {
    href: "/inventory/planning",
    label: "Kế hoạch đặt hàng SX",
    zone: "PRODUCTION",
    permission: "planning:view",
    why: "Đặt bao nhiêu, mẫu nào, khi nào — quyết định trung tâm của phòng Sản xuất.",
  },
  {
    href: "/inventory/workshop",
    label: "Đặt xưởng & thanh toán",
    zone: "PRODUCTION",
    permission: "planning:view",
    why: "Lô đặt xưởng, đợt vải và đợt trả tiền xưởng là việc phòng Sản xuất theo dõi hằng ngày; giá SX thực tế sinh ra từ đây là căn cứ cho lần đặt hàng sau.",
  },
  {
    href: "/inventory/shortage",
    label: "Thiếu hàng giao đơn",
    zone: "PRODUCTION",
    permission: "planning:view",
    why: "Đơn đã chốt đang chờ vì kho không đủ hàng: việc gỡ nó là đặt / giục xưởng. Kho đọc để kiểm đếm, CSKH đọc để báo khách — nhưng nguồn cung là quyết định của phòng Sản xuất.",
  },
  {
    href: "/inventory/decisions",
    label: "Quyết định vốn tồn kho",
    zone: "PRODUCTION",
    permission: "planning:view",
    why: "Bỏ thêm vốn vào mẫu nào, dừng mẫu nào: cùng một quyết định với đặt hàng, chỉ nhìn từ phía tiền.",
  },
  // Company OS · Agent A — sổ mẫu & vòng đời.
  {
    href: "/models",
    label: "Vòng đời mẫu",
    zone: "PRODUCTION",
    permission: "models:view",
    why: "Mẫu nào đang ở khâu nào — thắng test, bàn giá, làm mẫu, sản xuất, bán, xả — và ai phụ trách. Các khai báo trên trang này quyết định mẫu nào được đưa vào sản xuất / đặt lại / ngừng, tức quyết định của phòng Sản xuất; marketing đọc nó để biết mẫu thắng của mình đã đi tới đâu.",
  },
  // Company OS · Agent BD — bảng quy trình: cùng sổ mẫu, xếp theo 13 bước của chủ shop, mỗi thẻ một việc tiếp theo.
  {
    href: "/models?view=bang",
    label: "Bảng quy trình mẫu",
    zone: "PRODUCTION",
    permission: "models:view",
    why: "Một màn hình cho mọi mẫu đang ở bước nào của quy trình 13 bước (creative → test → thắng → bàn SX → giá thành & mẫu → duyệt → kế hoạch → sản xuất → bán → đẩy tồn) và VIỆC TIẾP THEO của từng mẫu. Là một cách xem của sổ mẫu nên cùng phòng Sản xuất, cùng quyền `models:view`.",
  },
  // Company OS · Agent C — sản xuất nửa đầu (bước 4–6 của chủ shop).
  {
    href: "/production",
    label: "Topic sản xuất",
    zone: "PRODUCTION",
    permission: "planning:view",
    why: "Hỏi giá xưởng, chốt phương án, giá thành tạm tính, làm mẫu và duyệt mẫu — các quyết định bỏ vốn TRƯỚC khi có lệnh đặt hàng. Lệnh sản xuất trỏ vào bản thiết kế được duyệt ở đây.",
  },
  {
    href: "/products/performance",
    label: "Hiệu quả mẫu mã",
    zone: "PRODUCTION",
    permission: "reports:returns",
    why: "Mẫu nào bán được, mẫu nào hoàn nhiều là ĐẦU VÀO của lệnh đặt hàng tiếp theo. Kho đọc để biết xếp hàng ở đâu, nhưng người QUYẾT theo nó là phòng Sản xuất.",
  },

  // ───────────────── KẾ TOÁN ─────────────────
  {
    href: "/finance",
    label: "Tổng quan tài chính",
    zone: "FINANCE",
    permission: "bank:view",
    anyOf: ["bank:view", "reports:cash", "cod:view"],
    why: "Còn bao nhiêu tiền, nằm ở đâu — câu đầu tiên của mỗi buổi sáng, và bảy sổ bên dưới cộng lại vẫn không trả lời thay được.",
  },
  {
    href: "/cod",
    label: "Đối soát COD",
    zone: "FINANCE",
    permission: "cod:view",
    why: "Tiền đã giao mà chưa về: chứng từ nằm ở kế toán, dù việc đòi phải làm với ĐVVC.",
  },
  {
    href: "/bank",
    label: "Sổ ngân hàng",
    zone: "FINANCE",
    permission: "bank:view",
    why: "Phân loại dòng tiền là việc kế toán; gán cho phòng khác thì lợi nhuận sai mà không ai chịu trách nhiệm.",
  },
  {
    href: "/finance-ops",
    label: "Hàng đợi tác vụ tài chính",
    zone: "FINANCE",
    permission: "bank:view",
    why: "Việc tồn của chính hai sổ trên, xếp theo hạn.",
  },
  {
    href: "/expenses",
    label: "Chi phí vận hành",
    zone: "FINANCE",
    permission: "expenses:view",
    why: "Bảng Chi phí là nguồn CÓ THẨM QUYỀN cho mọi khoản không phải quảng cáo / giá vốn / cước (sổ `cost-authority`).",
  },
  {
    href: "/reports",
    label: "Báo cáo lợi nhuận",
    zone: "FINANCE",
    permission: "reports:delivered",
    anyOf: ["reports:delivered", "reports:cash", "reports:nominal"],
    why: "Lợi nhuận danh nghĩa và tiền thật, cùng phễu và mô phỏng kịch bản — người dựng và bảo vệ các số này là kế toán.",
  },
  {
    href: "/reports/cashflow",
    label: "Dòng tiền",
    zone: "FINANCE",
    permission: "reports:cash",
    why: "Tiền vào ra theo kỳ, đọc từ sổ ngân hàng và bảng kê.",
  },
  {
    href: "/payroll",
    label: "Lương & hoa hồng",
    zone: "FINANCE",
    permission: "payroll:view-own",
    anyOf: ["payroll:view-own", "payroll:view"],
    why: "Chốt kỳ lương là việc kế toán — phòng Nhân sự duyệt CHÍNH SÁCH, nhưng phép tính và chứng từ nằm ở đây. Nhân viên chỉ mở phiếu của mình.",
  },

  // ───────────────── BAN ĐIỀU HÀNH ─────────────────
  // Company OS · Agent H — buồng lái chủ shop.
  {
    href: "/cockpit",
    label: "Cần anh quyết",
    zone: "MANAGEMENT",
    permission: "dashboard:view",
    why: "Duyệt, chốt phương án, cắt quảng cáo, đặt / xả hàng là quyết định BỎ VỐN — của người điều hành, không của phòng nào làm một khâu. Trang gom chúng từ màn hình chủ của từng phòng (mỗi dòng mở về đó) và lưu phản ứng của người quyết để đo đề xuất nào đúng.",
  },
  {
    href: "/departments",
    label: "Bản đồ phòng ban & AI",
    zone: "MANAGEMENT",
    permission: "dashboard:view",
    why: "Phòng nào sở hữu màn hình nào, và agent của từng phòng đang làm được tới khâu nào. Câu hỏi của người xếp bộ máy, không phải của người làm một khâu.",
  },
  {
    href: "/data-quality",
    label: "Chất lượng dữ liệu",
    zone: "MANAGEMENT",
    permission: "dashboard:view",
    why: "Số liệu sai không thuộc phòng nào cụ thể — nó chặn quyết định của MỌI phòng. Cùng lý do nhóm việc DATA được xếp về Ban điều hành.",
  },

  // ───────────────── HỆ THỐNG ─────────────────
  {
    href: "/tech",
    label: "Phòng Tech AI",
    zone: "SYSTEM",
    permission: "tech:view",
    why: "Phòng AI dựng chính ERP: hàng đợi việc kỹ thuật, AI CTO, sổ agent, deploy, sự cố. Nó sửa bộ máy chứ không vận hành một khâu kinh doanh nào.",
  },
  {
    href: "/integrations",
    label: "Kết nối dữ liệu",
    zone: "SYSTEM",
    permission: "integrations:view",
    why: "Pancake · Viettel Post · Facebook · ngân hàng: hỏng một đường là mọi phòng đọc số sai.",
  },
  {
    href: "/settings/users",
    label: "Người dùng",
    zone: "SYSTEM",
    permission: "users:manage",
    why: "Tài khoản, vai trò, phạm vi dữ liệu. Ba chiều quyền truy cập là việc của quản trị, KHÔNG phải của phòng Nhân sự (chức danh không sinh quyền — AGENTS.md mục 29).",
  },
  {
    href: "/audit",
    label: "Nhật ký hệ thống",
    zone: "SYSTEM",
    permission: "audit:view",
    why: "Ai đã làm gì, lúc nào. Đường truy vết của cả ERP.",
  },
  {
    href: "/settings/modules",
    label: "Module của tổ chức",
    zone: "SYSTEM",
    permission: "modules:manage",
    why: "Tổ chức dùng những mảng nào của ERP. Bật một module là mở cả màn hình, quyền và job của nó cho mọi người — quyết định của quản trị, không của một phòng làm một khâu.",
  },
  // Metadata của tổ chức (Phase 2): bốn màn hình cùng khoá `metadata:manage`. Đổi ở đây đổi màn hình
  // của MỌI phòng (field, form, cột, nhãn trạng thái) nên là việc của quản trị, không của phòng nào.
  {
    href: "/settings/data-model",
    label: "Mô hình dữ liệu",
    zone: "SYSTEM",
    permission: "metadata:manage",
    why: "Field tuỳ biến của khách hàng, đơn hàng, sản phẩm… cho CẢ tổ chức. Một field mới hiện ở form và danh sách của mọi phòng — quyết định của quản trị.",
  },
  {
    href: "/settings/forms",
    label: "Form nhập liệu",
    zone: "SYSTEM",
    permission: "metadata:manage",
    why: "Bố cục form (nhóm, thứ tự, bắt buộc, chỉ đọc) theo Nháp → Xuất bản. Xuất bản đổi màn hình nhập liệu của mọi người mà không cần deploy.",
  },
  {
    href: "/settings/lists",
    label: "Danh sách",
    zone: "SYSTEM",
    permission: "metadata:manage",
    why: "Cột, sắp xếp và bộ lọc mặc định của danh sách chạy theo metadata. Cùng mô hình Nháp → Xuất bản với form.",
  },
  {
    href: "/settings/statuses",
    label: "Trạng thái",
    zone: "SYSTEM",
    permission: "metadata:manage",
    why: "Nhãn hiển thị, thứ tự và bộ lọc của trạng thái HỆ THỐNG (vd trạng thái đơn). Giá trị và chuyển trạng thái do Core sở hữu — trang này chỉ đổi phần hiển thị.",
  },
  // Luật tự động (Phase 3): khoá riêng `workflow:manage` — một luật chạy thật cho máy làm thay người trên CẢ
  // tổ chức (tạo việc cho mọi phòng, gửi báo, ghi giá trị), nên là việc của quản trị, không của phòng nào.
  {
    href: "/settings/workflows",
    label: "Luật tự động",
    zone: "SYSTEM",
    permission: "workflow:manage",
    why: "Khi nào · điều kiện · làm gì (tạo việc, báo, ghi giá trị) · có cần người duyệt. Luật mới luôn ở NHÁP + CHẠY THỬ; chuyển CHẠY THẬT là quyết định của quản trị vì máy sẽ làm thay người trên cả tổ chức.",
  },
  // Trang tuỳ biến (Phase 4): cùng khoá `metadata:manage` với bốn màn hình metadata — một trang xuất bản lên menu
  // của CẢ tổ chức và ghép số liệu của nhiều phòng, nên là việc của quản trị, không của phòng nào.
  {
    href: "/settings/pages",
    label: "Trang tuỳ biến",
    zone: "SYSTEM",
    permission: "metadata:manage",
    why: "Ghép trang từ khối có sẵn (chỉ số, bảng, biểu đồ, Kanban, nhật ký, form, nút) theo Nháp → Xuất bản, không cần deploy. Trang lên menu của mọi người nên là quyết định của quản trị; mỗi khối vẫn tự kiểm quyền của người xem.",
  },
  // Kết nối theo tổ chức (Phase 9): khoá `settings:manage` của lõi — `integrations:*` thuộc module «Kết nối dữ
  // liệu» chỉ tổ chức nhà bật được, nên tổ chức khác sẽ không bao giờ tới được màn hình khai kết nối của chính mình.
  {
    href: "/settings/connections",
    label: "Kết nối theo tổ chức",
    zone: "SYSTEM",
    permission: "settings:manage",
    why: "Sổ connector: tích hợp của tổ chức nhà hiện CHỈ ĐỌC (không bí mật nào), kết nối do chính tổ chức khai thì mã hoá, kiểm tra thật rồi mới bật. Bí mật kết nối là việc của quản trị, không của phòng nào.",
  },
  // Mẫu cấu hình (Phase 7): cùng khoá `metadata:manage` — cài một mẫu dựng field, form, danh sách, trang và luật cho CẢ
  // tổ chức; bước bật module / vai trò / luật còn đòi thêm quyền riêng của chúng (kế hoạch đánh dấu BỊ CHẶN nếu thiếu).
  {
    href: "/settings/templates",
    label: "Mẫu cấu hình",
    zone: "SYSTEM",
    permission: "metadata:manage",
    why: "Cài một mẫu ngành (thời trang, TMĐT chung, bán sỉ…) theo Xem trước → Xác nhận: máy chỉ gọi các màn hình cấu hình sẵn có, luật sinh ở NHÁP. Nâng mẫu lên phiên bản mới không đè thứ tổ chức đã sửa.",
  },
  {
    href: "/platform",
    label: "Vận hành nền tảng",
    zone: "SYSTEM",
    permission: "platform:operate",
    why: "Mọi tổ chức trên nền tảng: sức khoẻ CSDL, lỗi cấu hình module. Chỉ người của tổ chức nhà — nó nhìn xuyên qua ranh giới giữa các tổ chức.",
  },
] as const satisfies readonly ModuleSpec[];

/** Mọi đường dẫn có mục menu — TypeScript đòi bảng icon phải phủ đủ, không thiếu một mục. */
export type ModuleHref = (typeof NAV_MODULES)[number]["href"];

export const ZONE_ORDER: ModuleZone[] = ["EVERYONE", ...DEPARTMENT_ORDER, "SYSTEM"];

export const ZONE_LABEL: Record<ModuleZone, string> = {
  EVERYONE: "Hôm nay",
  ...DEPARTMENT_LABEL,
  SYSTEM: "Hệ thống",
};

export const ZONE_HINT: Record<ModuleZone, string> = {
  EVERYONE: "Mọi phòng đều mở — không thuộc phòng nào",
  ...DEPARTMENT_HINT,
  SYSTEM: "Bộ máy của chính ERP: tích hợp, tài khoản, nhật ký, module, phòng Tech AI",
};

/** Module của một vùng, giữ nguyên thứ tự khai. */
export function modulesOfZone(zone: ModuleZone): ModuleSpec[] {
  return NAV_MODULES.filter((m) => m.zone === zone);
}

/** Nhóm để vẽ menu và bản đồ phòng ban. Vùng không có mục nào thì KHÔNG trả về. */
export const MODULE_GROUPS: { zone: ModuleZone; label: string; hint: string; items: ModuleSpec[] }[] = ZONE_ORDER.map((zone) => ({
  zone,
  label: ZONE_LABEL[zone],
  hint: ZONE_HINT[zone],
  items: modulesOfZone(zone),
})).filter((g) => g.items.length > 0);

/**
 * PHÒNG KHÔNG SỞ HỮU MÀN HÌNH NÀO — PHẢI KHAI VÌ SAO, VÀ KHAI CHỖ VIỆC CỦA HỌ ĐANG NẰM.
 *
 * Bỏ trống thì bản đồ phòng ban in một ô rỗng, và một ô rỗng đọc như "phòng này không làm gì".
 */
export const NO_MODULE_REASON: Partial<Record<DepartmentCode, string>> = {
  HR: "Chưa có màn hình top-level nào. Việc nhân sự hôm nay nằm trong hai tab của bàn làm việc chung — Công việc → Hiệu suất (thẻ điểm, kỳ review) và Công việc → Cấu hình → Nhân sự và phòng ban — còn chính sách lương nằm trong Lương & hoa hồng. Chấm công, tuyển dụng và đào tạo thì ERP CHƯA CÓ BẢNG NÀO, nên chưa dựng màn hình: một trang rỗng không phải một tính năng.",
};

/** Lá chắn khai báo: phòng không có module mà cũng không khai lý do. Phải luôn rỗng. */
export const DEPARTMENTS_WITHOUT_MODULE: DepartmentCode[] = DEPARTMENT_ORDER.filter((d) => modulesOfZone(d).length === 0 && !NO_MODULE_REASON[d]);

/** Nhãn của mọi trang có mục menu — nền cho breadcrumb; `app-sidebar` gộp thêm trang vào-từ-tab. */
export const MODULE_TITLES: Record<string, string> = Object.fromEntries(NAV_MODULES.map((m) => [m.href, m.label]));
