/**
 * Danh mục quyền theo module (client-safe, không đụng DB).
 * Mỗi người dùng có vai trò (mẫu quyền) và có thể được tuỳ chỉnh riêng từng quyền;
 * mẫu quyền của từng vai trò cũng chỉnh được (lưu trong settings "auth.rolePermissions").
 * Quản trị (ADMIN) luôn có toàn quyền.
 */
import type { Role } from "@/db/schema";

export const PERMISSION_GROUPS = [
  {
    module: "Vận hành",
    items: [
      { key: "dashboard:view", label: "Tổng quan", hint: "Trang tổng quan, KPI, biểu đồ" },
      { key: "orders:read", label: "Đơn hàng: xem", hint: "Danh sách & chi tiết đơn" },
      { key: "orders:export", label: "Đơn hàng: xuất CSV" },
      { key: "shipments:view", label: "Vận đơn", hint: "Vận đơn, hành trình, cập nhật từ Viettel Post" },
      /*
        MỘT KHOÁ, HAI VIỆC — VÀ NHÃN PHẢI NÓI RA CẢ HAI.

        Từ bản 19/09/2026 khoá này gác THÊM kết quả xử lý care (Đã hoàn · Phát tiếp · Xử lý sau).
        Nhãn cũ chỉ nói "thao tác Viettel Post", nên màn hình phân quyền mô tả thiếu một nửa thứ nó
        thật sự mở ra — người cấp quyền đọc nhãn chứ không đọc mã nguồn.

        KHÔNG tách thành khoá thứ hai: cùng một đội (CS, LEADER) làm cả hai việc, và thêm một khoá
        nữa là thêm một ô người ta phải nhớ tick — quên tick thì nhân viên không ghi nhận được việc
        mình vừa làm, đúng lỗi mà bản này sinh ra để chặn.
      */
      { key: "shipments:manage", label: "Vận đơn: xử lý case + thao tác Viettel Post", hint: "Ghi kết quả care (Đã hoàn / Phát tiếp / Xử lý sau), và gửi lệnh phát tiếp, duyệt hoàn, gửi lại, huỷ, sửa người nhận / COD sang Viettel Post" },
      { key: "alerts:view", label: "Cần xử lý: xem", hint: "Danh sách cảnh báo vận hành" },
      { key: "alerts:manage", label: "Cần xử lý: cấu hình", hint: "Ngưỡng cảnh báo, Lark / Telegram, đóng cảnh báo" },
      { key: "cs:view", label: "CSKH: xem case" },
      { key: "cs:manage", label: "CSKH: xử lý case", hint: "Tạo / cập nhật case đổi size, đổi màu, sai địa chỉ, sai SĐT, trả hàng" },
      { key: "cs:config", label: "CSKH: quy tắc & mẫu tin", hint: "Từ khoá nhận diện, mẫu tin nhắn khách giao không thành / xác nhận SĐT" },
      { key: "outreach:view", label: "Chăm sóc & bán chéo: xem" },
      { key: "outreach:send", label: "Chăm sóc & bán chéo: gửi tin / cập nhật" },
      { key: "outreach:config", label: "Chăm sóc & bán chéo: kịch bản", hint: "Mẫu tin, bước chăm sóc, ưu đãi, ảnh/video" },
      { key: "landing:view", label: "Đơn landing page: xem", hint: "Đơn từ Google Sheet, trạng thái, cảnh báo trùng / rủi ro" },
      { key: "landing:manage", label: "Đơn landing page: xử lý", hint: "Xác nhận / huỷ, chọn mẫu mã, gửi đơn nháp lên POS, nhập lại sheet" },
      { key: "landing:config", label: "Đơn landing page: cấu hình sheet", hint: "Link Google Sheet, cột, phí ship, kho mặc định" },
      { key: "returns:view", label: "Đổi / trả hàng" },
      { key: "customers:view", label: "Khách hàng" },
    ],
  },
  {
    module: "Kho & sản xuất",
    items: [
      { key: "products:view", label: "Sản phẩm & tồn kho", hint: "Sản phẩm, tồn kho, nhật ký kho" },
      { key: "inventory:write", label: "Nhập hàng & kiểm kê", hint: "Tạo / xoá phiếu nhập, điều chỉnh kiểm kê" },
      /*
        CỐ Ý TÁCH KHỎI `inventory:write`. Mọi lượt tái nhập hàng hoàn khác đều đứng trên một chứng
        từ đối chiếu được: vận đơn, đơn hàng, số kỳ vọng. Lượt này thì không — nhãn đã mất, không
        lần ra đơn nào, và toàn bộ căn cứ là lời khẳng định của người đang cầm món hàng rằng họ
        nhận diện đúng mẫu mã. Đó là một quyết định kinh doanh, không phải một thao tác kho.

        Người kho vẫn nhận kiện, vẫn đếm, vẫn tra đơn bằng `inventory:write`; chỉ bước cuối — cộng
        vào tồn bán được mà không có chứng từ nào — mới cần quyền này.
      */
      { key: "inventory:restock-unidentified", label: "Tái nhập hàng hoàn không xác định nguồn", hint: "Cộng vào tồn món hàng hoàn không lần ra được đơn / vận đơn. Bắt buộc ghi lý do, có nhật ký." },
      { key: "planning:view", label: "Kế hoạch đặt hàng SX: xem", hint: "Đề xuất đặt hàng, bảng đặt hàng chốt" },
      { key: "planning:write", label: "Kế hoạch đặt hàng SX: lập bảng", hint: "Tạo / sửa / duyệt bảng đặt hàng gửi xưởng, sửa tham số" },
      // Company OS · Agent A — sổ mẫu & vòng đời. `models:view` được kéo theo từ `products:view` (LEGACY_IMPLIES).
      { key: "models:view", label: "Vòng đời mẫu: xem", hint: "Sổ mẫu (mã chủ shop), trạng thái vòng đời đã khai, giai đoạn máy quan sát (ước tính), dòng thời gian của mẫu" },
      { key: "models:write", label: "Vòng đời mẫu: khai & đồng bộ", hint: "Đổi trạng thái vòng đời (lùi bước / nhảy cóc bắt buộc lý do), đổi người phụ trách, đăng ký mẫu mới, chạy đồng bộ sổ mẫu" },
    ],
  },
  {
    module: "Tài chính",
    items: [
      { key: "cod:view", label: "Đối soát COD: xem" },
      { key: "cod:write", label: "Đối soát COD: cập nhật", hint: "Đánh dấu đã thu / đã về ngân hàng, nhập bảng kê, tạo đợt nhận tiền" },
      { key: "expenses:view", label: "Chi phí vận hành & Quảng cáo: xem", hint: "Module Chi phí (kê khai chi phí) và module Quảng cáo (hiệu suất theo mã / marketer, ngưỡng thanh toán)" },
      { key: "expenses:write", label: "Chi phí vận hành & Quảng cáo: sửa", hint: "Thêm chi phí, nhập sao kê, thêm chi tiêu QC, ghép chiến dịch, gán marketer" },
      { key: "bank:view", label: "Sổ ngân hàng: xem", hint: "Giao dịch thu / chi thực trên sao kê, đối chiếu với sổ sách ERP" },
      { key: "bank:write", label: "Sổ ngân hàng: nhập & phân loại", hint: "Nhập sao kê, gán nhóm kế toán, quy tắc gán nhãn, đẩy khoản chi sang bảng Chi phí" },
      // CỐ Ý TÁCH KHỎI `bank:write`. Xác nhận một tài khoản ngân hàng là quyết định "tiền của tài
      // khoản này được tính vào sổ của shop" — cao hơn hẳn việc gán nhãn cho một dòng đã có. Kế
      // toán nhập sao kê hằng ngày không cần quyền đó; chủ shop cấp thêm khi muốn.
      { key: "bank:accounts", label: "Sổ ngân hàng: xác nhận tài khoản", hint: "Đặt tên, xác nhận tài khoản ngân hàng mới do webhook phát hiện, hoặc ngừng dùng một tài khoản" },
    ],
  },
  {
    module: "Báo cáo lợi nhuận",
    items: [
      { key: "reports:delivered", label: "BCLN theo đơn giao thành công" },
      { key: "reports:cash", label: "BCLN theo dòng tiền thực", hint: "Tiền COD về, tiền ra, lợi nhuận tiền mặt" },
      { key: "reports:nominal", label: "BCLN danh nghĩa theo mã hàng & marketer" },
      { key: "reports:returns", label: "Tỷ lệ giao thành công theo mã hàng" },
      { key: "reports:assumptions", label: "Sửa giả định báo cáo", hint: "Cước, đóng hàng, NV vận đơn, cố định, rủi ro tồn kho, thuế…" },
    ],
  },
  {
    module: "Lương & hoa hồng",
    items: [
      { key: "payroll:view-own", label: "Lương: xem của mình", hint: "Chỉ dòng lương / lợi nhuận cá nhân của chính mình. Khớp bằng KHOÁ TÀI KHOẢN: ô “Email đăng nhập ERP” trong hồ sơ nhân sự phải trùng email phiên đăng nhập — KHÔNG so tên (hai người trùng tên sẽ đọc được lương của nhau). Chưa khai email ⇒ người đó thấy bảng rỗng kèm câu chỉ đường." },
      {
        key: "payroll:view-all",
        label: "Lương: xem của MỌI NGƯỜI (toàn công ty)",
        hint: "Khoá DUY NHẤT mở ra bảng lương của người khác. Phải cấp TƯỜNG MINH cho từng vai trò / từng người — không vai trò nào có nó vì tên gọi, và không cấu hình cũ nào mang sẵn nó. Chưa có phạm vi “trưởng nhóm xem nhóm mình”; ai cần xem chéo thì cấp khoá này, có tên, có người quyết.",
      },
      {
        key: "payroll:view",
        label: "Lương: xem (khoá CŨ — nay chỉ còn của chính mình)",
        hint: "TỪ 16/09/2026 khoá này KHÔNG còn nghĩa là xem toàn công ty. Nó rơi về đúng phạm vi của “xem của mình”. Muốn xem của mọi người thì phải có “Lương: xem của MỌI NGƯỜI”. Lý do: production có bản ghi đè vai trò cũ mang khoá này, và một bản ghi đè lỗi thời không được phép mở bảng lương toàn công ty.",
      },
      { key: "payroll:manage", label: "Lương: khai báo nhân sự & chia mã", hint: "Cơ chế lương, chính sách lương, phân công, người phụ trách mã, % chủ mã, fanpage → marketer. Tính và chụp ảnh kỳ." },
      {
        key: "payroll:approve",
        label: "Lương: duyệt, khoá & đánh dấu đã trả",
        hint: "DUYỆT là một chữ ký, không phải một lượt bấm — nên nó tách khỏi quyền KHAI BÁO. Người khai số và người duyệt số không nên là một; đây là chỗ để tách hai vai ấy. Gồm cả mở khoá kỳ đã chốt (có lý do bắt buộc) và đánh dấu đã trả tiền.",
      },
    ],
  },
  {
    module: "Ý tưởng marketing",
    items: [
      { key: "ideas:view", label: "Ý tưởng: xem" },
      { key: "ideas:write", label: "Ý tưởng: đăng & sửa", hint: "Đăng ý tưởng kèm ảnh, sửa hoặc xoá ý tưởng của chính mình" },
      { key: "ideas:review", label: "Ý tưởng: nhận xét & duyệt", hint: "Quyền của quản lý: viết nhận xét và chốt Duyệt / Cần sửa / Không duyệt" },
    ],
  },
  {
    module: "Công việc & mục tiêu",
    items: [
      { key: "work:view", label: "Công việc: xem việc của mình", hint: "Hàng đợi Việc của tôi — việc được giao ở mọi phòng ban" },
      { key: "work:manage", label: "Công việc: xử lý", hint: "Nhận việc, ghi chú, hoãn, báo bị chặn, đổi trạng thái việc tay" },
      { key: "work:assign", label: "Công việc: giao cho người khác", hint: "Quyền của trưởng phòng: giao việc, đổi mức ưu tiên, đặt hạn cho người trong phòng" },
      { key: "work:department", label: "Công việc: xem cả phòng", hint: "Hàng đợi của phòng mình: tồn đọng, quá hạn, chưa ai nhận, tải theo người" },
      { key: "work:all", label: "Công việc: xem chéo phòng ban", hint: "Buồng lái điều hành — phòng nào đang kẹt, xem được việc của mọi phòng" },
      { key: "work:admin", label: "Công việc: cấu hình phòng ban & việc định kỳ", hint: "Thêm/bớt phòng, trưởng phòng, thành viên, định nghĩa việc lặp" },
      { key: "okr:view", label: "Mục tiêu: xem OKR & BSC" },
      { key: "okr:manage", label: "Mục tiêu: đặt & chấm", hint: "Tạo Objective / Key Result, cấu hình thẻ điểm BSC và trọng số, chấm tiến độ" },
      { key: "performance:view", label: "Hiệu suất: xem thẻ điểm nhân sự", hint: "Kết quả / chất lượng / SLA / năng suất / OKR của người trong phạm vi quyền" },
      { key: "review:manage", label: "Kỳ review: lập & chốt", hint: "Review tuần / tháng / quý; chốt kỳ là đóng băng số liệu của kỳ đó" },
    ],
  },
  {
    module: "Phòng Tech AI",
    items: [
      { key: "tech:view", label: "Phòng Tech AI: xem", hint: "Sức khoẻ hệ thống, hàng đợi việc Tech, sổ agent, lịch sử deploy, sự cố đang mở" },
      {
        key: "tech:manage",
        label: "Phòng Tech AI: quản trị",
        hint: "Tạo / đổi việc Tech, đổi mức rủi ro (có lý do bắt buộc), duyệt việc mức R2, bật tắt định nghĩa agent, mở & đóng sự cố. Đây là cổng phê duyệt của chủ shop — không cấp cho vai trò nào theo mặc định.",
      },
    ],
  },
  {
    module: "Hệ thống",
    items: [
      { key: "integrations:view", label: "Kết nối dữ liệu: xem" },
      { key: "integrations:manage", label: "Kết nối dữ liệu: cấu hình", hint: "Secret webhook, tài khoản Viettel Post, cấu hình đồng bộ" },
      { key: "sync:run", label: "Chạy đồng bộ", hint: "Bấm đồng bộ Pancake / Viettel Post / Facebook" },
      { key: "audit:view", label: "Nhật ký hệ thống" },
      { key: "users:manage", label: "Quản lý người dùng & phân quyền" },
      { key: "settings:manage", label: "Cấu hình hệ thống khác" },
      // ═══ Company OS · Agent G ═══ — xem `withDerivedApprovalDecide()` cuối tệp.
      {
        key: "approvals:decide",
        label: "Duyệt việc cần người thứ hai",
        hint: "Duyệt / từ chối yêu cầu phê duyệt hai bước (điều chỉnh kho, sửa chi phí lớn, sửa lương, đổi luật…). Quản trị viên, Quản lý và người có “Cấu hình hệ thống khác” LUÔN có quyền này — đúng tập người duyệt được trước khi có khoá. Vai trò tuỳ chỉnh không cấp được nó. Người xin không bao giờ tự duyệt việc của mình.",
      },
    ],
  },
] as const;

/**
 * Quyền cũ (bản lưu trước khi tách chi tiết) → các quyền mới được suy ra, để cấu hình đã lưu vẫn chạy đúng.
 * Khi lưu lại trên trang Người dùng, hệ thống ghi thẳng quyền mới.
 */
export const LEGACY_IMPLIES: Record<string, string[]> = {
  "reports:view": ["reports:delivered", "reports:cash", "reports:nominal", "reports:returns"],
  "orders:read": ["orders:export", "cs:view", "outreach:view", "landing:view"],
  "shipments:view": ["alerts:view"],
  "cs:manage": ["cs:view", "outreach:send", "landing:manage", "shipments:manage"],
  "settings:manage": ["cs:config", "outreach:config", "alerts:manage", "integrations:manage", "landing:config"],
  "expenses:write": ["reports:assumptions"],
  "products:view": ["planning:view", "models:view"],
  "inventory:write": ["planning:write"],
  /*
    `payroll:view` KHÔNG kéo theo `payroll:view-all`, và đó là cả điểm của bản vá này. Chiều kéo
    chỉ đi từ RỘNG xuống HẸP: ai được xem của mọi người thì đương nhiên xem được của mình.
  */
  "payroll:view": ["payroll:view-own"],
  "payroll:view-all": ["payroll:view", "payroll:view-own"],
};

export type Permission = (typeof PERMISSION_GROUPS)[number]["items"][number]["key"];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])));

// `work:view` + `work:manage` nằm trong mọi vai: một người không xem được việc của CHÍNH MÌNH thì
// hàng đợi vô nghĩa với họ. Quyền leo thang nằm ở `work:assign` / `work:department` / `work:all`.
const VIEW_ALL: Permission[] = ["dashboard:view", "ideas:view", "orders:read", "shipments:view", "alerts:view", "cs:view", "outreach:view", "landing:view", "returns:view", "customers:view", "products:view", "planning:view", "models:view", "work:view", "work:manage", "okr:view"];

/*
  ═══ LƯƠNG TOÀN CÔNG TY KHÔNG PHẢI MỘT MẶC ĐỊNH ═══

  `payroll:view` cho thấy lương của MỌI nhân sự. ERP hôm nay chỉ có hai mức — xem TẤT CẢ hoặc xem
  của CHÍNH MÌNH; **chưa có phạm vi "trưởng nhóm xem nhóm mình"**. Nên mở `payroll:view` cho một
  vai trò quản lý không phải là cấp quyền đúng mức, mà là cấp quyền RỘNG NHẤT để bù cho một phạm vi
  chưa được xây.

  Hai chỗ đã sai theo đúng kiểu ấy và nay sửa lại:

   · `MANAGER` nhận `payroll:view` vì danh sách dựng bằng phép LOẠI TRỪ — không ai từng quyết định
     cấp nó; nó lọt vào vì không có tên trong danh sách loại. Đây là cách nguy hiểm nhất để một
     quyền tiền xuất hiện: không có dòng nào để đọc lại và hỏi "vì sao".
   · `LEADER` nhận `payroll:view` tường minh, kèm chú thích "xem lương & LN của CẢ NHÓM". Nhưng
     không có phạm vi nhóm nào, nên thứ mã nguồn thật sự cấp là CẢ CÔNG TY. Chú thích mô tả một ý
     định mà mã không thực hiện được — và khoảng cách ấy là chỗ dữ liệu rò ra.

  Mọi nhánh sai phải rơi về phía HẸP HƠN (AGENTS.md mục 31). Chủ shop vẫn cấp tay được cho từng
  người ở trang Người dùng — mất quyền vì một lần triển khai thì tệ, nhưng cấp thừa một quyền tiền
  vì một phép loại trừ thì tệ hơn, vì không ai biết là nó đã được cấp.

  `ACCOUNTANT` GIỮ quyền xem toàn công ty: kế toán cần bảng lương để trả tiền. Đó là một quyết định
  tường minh, đúng với chức năng — không phải một phạm vi bị thiếu được lấp bằng quyền rộng.

  ═══ VÀ SỬA MẶC ĐỊNH TRONG MÃ VẪN CHƯA ĐỦ (đo trên production 15/09/2026) ═══

  Production có `settings['auth.rolePermissions']`, và mảng `MANAGER` trong đó CHỨA `payroll:view`.
  `rolePermissions()` đọc mẫu vai trò bằng phép THAY THẾ — có mảng lưu thì mảng ấy LÀ quyền của vai
  trò, và đoạn `DEFAULT_ROLE_PERMISSIONS` ngay dưới đây KHÔNG được hỏi tới. Nghĩa là bản vá ở trên,
  tự nó, không với tới được tài khoản Quản lý trên máy chủ thật.

  Nên khoá `payroll:view-all` được tách ra: nó MỚI, nên **không cấu hình cũ nào đang mang nó**, và
  đó chính là thứ làm nó an toàn trước một bản ghi đè lỗi thời. `payroll:view` từ nay rơi về SELF.
  Phạm vi được tính một chỗ duy nhất ở `lib/auth/payroll-scope.ts`.

  Hệ quả phải nói thẳng: tài khoản nào đang xem bảng lương toàn công ty NHỜ một mảng ghi đè trong
  `settings` (kể cả `ACCOUNTANT`) sẽ rơi về "chỉ của mình" cho tới khi được cấp `payroll:view-all`.
  Đó là mất quyền xem, không phải lộ dữ liệu — và là chiều đúng để hỏng.
*/

/** Mẫu quyền mặc định của từng vai trò (có thể chỉnh trên trang Người dùng) */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [...ALL_PERMISSIONS],
  // `payroll:approve` đứng cùng nhóm với `payroll:manage`: cả hai đều là quyền TIỀN. Mở mặc định
  // cho MANAGER là để bản này lặng lẽ cấp thêm quyền duyệt lương cho những tài khoản đang có —
  // đúng thứ AGENTS.md mục 31 nói phải rơi về phía HẸP HƠN. `payroll:view` cùng lý do: xem lương
  // của mọi người là quyền phải được CẤP, không phải quyền còn lại sau một phép loại trừ.
  /*
    `tech:view` và `tech:manage` nằm trong danh sách LOẠI vì mẫu của MANAGER dựng bằng phép TRỪ —
    và một quyền dựng bằng phép trừ là quyền không ai từng quyết định cấp (xem ghi chú dài phía
    trên về `payroll:view`). Mặt phẳng điều khiển Tech mang cổng phê duyệt cho việc chạm lương,
    lợi nhuận, quyền và migration; nó phải được CẤP có tên, không phải còn lại sau một phép loại.
    Chủ shop cấp tay ở trang Người dùng cho ai thật sự cần.
  */
  MANAGER: ALL_PERMISSIONS.filter((p) => !["users:manage", "settings:manage", "payroll:manage", "payroll:approve", "payroll:view", "payroll:view-all", "tech:view", "tech:manage"].includes(p)),
  // Trưởng nhóm: báo cáo danh nghĩa / tỷ lệ giao thành công / theo đơn giao; không xem dòng tiền
  // thực, không sửa cấu hình. Lương: CHỈ của chính mình cho tới khi có phạm vi theo nhóm.
  LEADER: [...VIEW_ALL, "ideas:write", "ideas:review", "orders:export", "cs:manage", "outreach:send", "landing:manage", "shipments:manage", "inventory:write", "inventory:restock-unidentified", "planning:write", "models:write", "cod:view", "expenses:view", "expenses:write", "bank:view", "reports:delivered", "reports:nominal", "reports:returns", "payroll:view-own", "integrations:view", "sync:run", "work:assign", "work:department", "work:all", "okr:manage", "performance:view", "review:manage"],
  ACCOUNTANT: [...VIEW_ALL, "orders:export", "cod:view", "cod:write", "expenses:view", "expenses:write", "bank:view", "bank:write", "reports:delivered", "reports:cash", "reports:nominal", "reports:returns", "payroll:view-own", "payroll:view", "payroll:view-all", "integrations:view"],
  /*
    KHÔNG có `inventory:restock-unidentified`. Nhân viên kho nhận kiện, đếm, tra đơn — nhưng lượt
    cộng tồn cho món không có chứng từ nào là quyết định của người quản lý kho, và chủ shop cấp
    thêm cho từng tài khoản khi muốn.

    Vì lý do đó khoá này cũng KHÔNG nằm trong `PERMISSIONS_ADDED_AFTER_SNAPSHOT`: tài khoản có
    danh sách quyền lưu từ trước sẽ KHÔNG tự nhận nó. Mọi nhánh mặc định của một quyền leo thang
    phải rơi về phía HẸP HƠN.
  */
  WAREHOUSE: [...VIEW_ALL, "inventory:write", "planning:write"],
  CS: [...VIEW_ALL, "cod:view", "cs:manage", "outreach:send", "landing:manage", "shipments:manage"],
  MARKETING: [...VIEW_ALL, "ideas:write", "expenses:view", "expenses:write", "reports:nominal", "reports:returns", "payroll:view-own"],
  VIEWER: [...VIEW_ALL, "cod:view", "expenses:view", "reports:delivered", "reports:returns"],
};

/** Mở rộng quyền cũ thành quyền mới (giữ cả khoá cũ để không phá chỗ nào còn kiểm tra khoá cũ) */
export function expandLegacy(perms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of perms) {
    out.add(p);
    for (const implied of LEGACY_IMPLIES[p] ?? []) out.add(implied);
  }
  return [...out];
}

export type RolePermissionMap = Partial<Record<Role, string[]>>;

/** Quyền mẫu của một vai trò: bản chỉnh trong settings nếu có, không thì mặc định */
export function rolePermissions(role: Role, templates?: RolePermissionMap | null): string[] {
  if (role === "ADMIN") return [...ALL_PERMISSIONS];
  const custom = templates?.[role];
  if (Array.isArray(custom)) return expandLegacy(custom).filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  return [...(DEFAULT_ROLE_PERMISSIONS[role] ?? DEFAULT_ROLE_PERMISSIONS.VIEWER)];
}

export const USER_PERMISSION_SNAPSHOT_KEY = "users.permissionsKnown";

/**
 * Khoá quyền được thêm SAU khi ERP bắt đầu ghi lại "lúc lưu danh sách quyền tuỳ chỉnh thì hệ thống
 * đang có những khoá nào". Các danh sách lưu trước đó chưa từng được hỏi về những khoá này.
 *
 * Chỉ dùng cho các bản lưu cũ; từ nay mỗi lần lưu quyền đều kèm ảnh chụp khoá hiện có nên danh
 * sách này không cần dài thêm.
 */
export const PERMISSIONS_ADDED_AFTER_SNAPSHOT: string[] = ["ideas:view", "ideas:write", "ideas:review", "work:view", "work:manage", "work:assign", "work:department", "work:all", "work:admin", "okr:view", "okr:manage", "performance:view", "review:manage"];

/** Bộ khoá quyền của thời điểm trước khi có ảnh chụp — dùng cho người chưa có ảnh chụp nào. */
function khoaDaBietKieuCu(): Set<string> {
  return new Set((ALL_PERMISSIONS as string[]).filter((p) => !PERMISSIONS_ADDED_AFTER_SNAPSHOT.includes(p)));
}

/**
 * Quyền thực tế của một người dùng: tuỳ chỉnh riêng (nếu có) → mẫu vai trò. ADMIN luôn toàn quyền.
 *
 * DANH SÁCH TUỲ CHỈNH CHỈ NÓI VỀ NHỮNG KHOÁ ĐÃ TỒN TẠI LÚC LƯU.
 *
 * Trước đây danh sách tuỳ chỉnh được coi là câu trả lời cho mọi khoá, kể cả khoá sinh ra sau đó.
 * Hậu quả: người từng được lưu quyền riêng bị đóng băng vĩnh viễn — mỗi module mới đều vô hình với
 * họ, mà không ai biết vì menu chỉ đơn giản là không hiện. Đúng chuyện đã xảy ra với module Ý
 * tưởng marketing: tài khoản Quản lý có danh sách 37 khoá lưu từ trước nên không thấy menu.
 *
 * Nay khoá nào CHƯA TỒN TẠI lúc người đó được lưu quyền thì áp mẫu của vai trò — vì chưa ai từng
 * được hỏi về nó. Khoá đã tồn tại mà bị bỏ khỏi danh sách vẫn là quyết định có chủ ý, giữ nguyên.
 *
 * `known` là ảnh chụp bộ khoá tại thời điểm lưu; chưa có thì coi như bộ khoá của thời trước ảnh chụp.
 */
export function resolvePermissions(
  role: Role,
  custom: string[] | null | undefined,
  templates?: RolePermissionMap | null,
  known?: string[] | null,
): string[] {
  if (role === "ADMIN") return [...ALL_PERMISSIONS];
  if (!Array.isArray(custom)) return withDerivedApprovalDecide(role, rolePermissions(role, templates));
  const rieng = new Set(expandLegacy(custom).filter((p) => (ALL_PERMISSIONS as string[]).includes(p)));
  const daBiet = Array.isArray(known) && known.length ? new Set(known) : khoaDaBietKieuCu();
  const mau = new Set(rolePermissions(role, templates));
  for (const p of ALL_PERMISSIONS as string[]) {
    if (!daBiet.has(p) && mau.has(p)) rieng.add(p);
  }
  return withDerivedApprovalDecide(role, [...rieng]);
}

export function hasPermission(perms: readonly string[] | Set<string> | null | undefined, permission: string) {
  if (!perms) return false;
  return perms instanceof Set ? perms.has(permission) : perms.includes(permission);
}

/* ═══════════ Company OS · Agent G · QUYỀN DUYỆT HAI BƯỚC GIỮ NGUYÊN TẬP NGƯỜI CŨ ═══════════
 *
 * Trước khoá `approvals:decide`, `lib/actions/approvals.ts` tự viết điều kiện:
 * `can(user, "settings:manage") || role === "ADMIN" || role === "MANAGER"`. Chuyển sang một khoá
 * quyền mà KHÔNG làm ai mất quyền duyệt đòi hai điều, vì bản ghi đè cũ trong `settings` và danh
 * sách quyền riêng của từng người không bao giờ chứa một khoá mới:
 *
 *  1. Vai ADMIN / MANAGER LUÔN có nó — theo VAI, như điều kiện cũ. Production có mảng ghi đè cho
 *     MANAGER trong `auth.rolePermissions` (đo 15/09/2026); chỉ dựa vào mẫu mặc định thì tài khoản
 *     Quản lý thật sẽ mất quyền duyệt.
 *  2. Ai có `settings:manage` (sau khi đã tính đủ ba chiều) LUÔN có nó.
 *
 * Ngoài hai nhánh đó khoá chỉ đến từ một lần CẤP TƯỜNG MINH của người có `users:manage`. Vai trò tuỳ
 * chỉnh không cấp được nó (`ROLE_BUILDER_FORBIDDEN`) — nếu không, người dựng vai trò tự cho mình
 * quyền duyệt chính yêu cầu của người khác mà không cần quyền nào khác (AGENTS.md mục 31).
 *
 * Hàm THUẦN, gọi ở ĐÚNG hai chỗ tính bó quyền: cuối `resolvePermissions` (ở đây) và nhánh vai trò
 * tuỳ chỉnh trong `lib/auth/access.ts::grantedPermissions`. Phạm vi (`applyScope`) không đụng tới
 * nó vì cả hai khoá liên quan đều không thuộc vùng nhạy cảm.
 */
export const APPROVAL_DECIDE_PERMISSION = "approvals:decide";
export const APPROVAL_DECIDE_ROLES: readonly Role[] = ["ADMIN", "MANAGER"];

export function withDerivedApprovalDecide(role: Role, perms: string[]): string[] {
  if (perms.includes(APPROVAL_DECIDE_PERMISSION)) return perms;
  if (APPROVAL_DECIDE_ROLES.includes(role) || perms.includes("settings:manage")) return [...perms, APPROVAL_DECIDE_PERMISSION];
  return perms;
}
