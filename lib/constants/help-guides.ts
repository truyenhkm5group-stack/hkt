/**
 * ═══════════ HƯỚNG DẪN SỬ DỤNG TRONG ỨNG DỤNG — MỘT SỔ KHAI (docs/platform/help-guides.md) ═══════════
 *
 * Khách thuê theo tháng không có ai ngồi cạnh chỉ cho. Trang `/help` in các bài ở đây, LỌC theo đúng thứ người xem mở
 * được: quyền (`can()`), module đang bật của tổ chức (`hrefVisible`), và bài chỉ dành cho tổ chức khách (`tenantOnly`).
 * Người xem không bao giờ thấy một bài dẫn tới trang họ không vào được.
 *
 * ─── CHỐNG MỤC ───
 * Hướng dẫn cũ đi nhanh hơn mã. `tests/help-guides.test.ts` khoá: mọi đường dẫn trỏ tới một `page.tsx` CÓ THẬT, quyền
 * của bài trùng quyền mà chính trang đó đòi, và mọi tên nút / tên ô đặt trong «…» phải xuất hiện nguyên văn trong mã giao
 * diện. Đổi tên nút mà quên bài ⇒ đỏ. Câu mô tả HÀNH VI (ai được trừ nợ trước, khi nào bị chặn) thì không máy nào kiểm
 * được — viết lại bài cùng commit với lần đổi luật.
 *
 * Client-safe: hằng số thuần + một hàm lọc thuần (không đọc CSDL).
 */
import type { Permission } from "@/lib/auth/permissions";
import { hrefVisible, type ModuleViewer } from "@/lib/platform-ui/module-visibility";

export type HelpTopic = "START" | "SELL" | "CUSTOMERS" | "SERVICE" | "AI" | "ACCOUNT";

export const HELP_TOPIC_ORDER: readonly HelpTopic[] = ["START", "SELL", "CUSTOMERS", "SERVICE", "AI", "ACCOUNT"];

export const HELP_TOPIC_LABEL: Record<HelpTopic, string> = {
  START: "Bắt đầu",
  SELL: "Sản phẩm & đơn hàng",
  CUSTOMERS: "Khách hàng & công nợ",
  SERVICE: "Dịch vụ & lịch hẹn",
  AI: "Chatbot bán hàng",
  ACCOUNT: "Tài khoản & thanh toán",
};

export type HelpStep = { text: string; href?: string };

export type HelpGuide = {
  /** Khoá ổn định (neo `#…` trên trang). */
  key: string;
  topic: HelpTopic;
  title: string;
  /** Một câu: bài này giúp làm xong việc gì. */
  summary: string;
  /** Trang chính của bài — bài chỉ hiện khi trang này mở được với người xem. */
  href: string;
  /** Quyền mà trang chính đòi ở cổng đầu. Bỏ trống ⇒ mọi tài khoản. */
  permission?: Permission;
  /** Quyền trang còn đòi THÊM sau cổng đầu (vd tạo đơn tay cần `orders:write`, thiếu thì trang 404). */
  alsoRequires?: readonly Permission[];
  /** Chỉ tổ chức khách (trang dựng trên đơn tạo tay — tổ chức nhà đồng bộ Pancake nên trang ấy đóng). */
  tenantOnly?: true;
  steps: readonly HelpStep[];
};

export const HELP_GUIDES: readonly HelpGuide[] = [
  // ───────────────── BẮT ĐẦU ─────────────────
  {
    key: "invite-staff",
    topic: "START",
    title: "Mời nhân viên vào ERP",
    summary: "Mỗi người một tài khoản riêng — nhật ký ghi đúng ai làm gì, nghỉ việc thì khoá đúng người.",
    href: "/settings/users",
    permission: "users:manage",
    steps: [
      { text: "Mở Hệ thống → Người dùng.", href: "/settings/users" },
      { text: "Bấm «Mời người dùng», nhập email, chọn vai trò (Quản lý, Kế toán, Kho, CSKH, Marketing, Chỉ xem…) rồi bấm «Tạo liên kết mời»." },
      { text: "Sao chép liên kết và gửi qua Zalo / Messenger. Liên kết dùng một lần, hết hạn sau 7 ngày." },
      { text: "Nhân viên mở liên kết, tự đặt tên và mật khẩu — xong là vào thẳng ERP." },
      { text: "Gói có trần số người dùng, và lời mời còn hạn cũng giữ một chỗ. Thu hồi lời mời không dùng tới để nhả chỗ." },
    ],
  },
  {
    key: "forgot-password",
    topic: "START",
    title: "Nhân viên quên mật khẩu",
    summary: "Gửi một liên kết để người đó tự đặt mật khẩu mới — bạn không cần biết mật khẩu của họ.",
    href: "/settings/users",
    permission: "users:manage",
    steps: [
      { text: "Mở Hệ thống → Người dùng, bấm ⋯ ở dòng của người đó.", href: "/settings/users" },
      { text: "Chọn «Gửi liên kết đặt lại», bấm «Tạo liên kết» rồi sao chép gửi cho họ." },
      { text: "Liên kết dùng một lần, hết hạn sau 24 giờ. Đặt xong, mọi phiên đăng nhập cũ của họ bị đăng xuất." },
      { text: "Chính bạn là quản trị và không còn ai quản trị khác: liên hệ bên cung cấp phần mềm — họ xác minh đúng người rồi gửi liên kết cho bạn." },
    ],
  },
  {
    key: "modules",
    topic: "START",
    title: "Bật / tắt tính năng",
    summary: "Chỉ bật đúng thứ cửa hàng dùng — menu gọn, nhân viên không lạc vào trang không liên quan.",
    href: "/settings/modules",
    permission: "modules:manage",
    steps: [
      { text: "Mở Hệ thống → Module của tổ chức.", href: "/settings/modules" },
      { text: "Bật hoặc tắt từng nhóm tính năng. Tắt không xoá dữ liệu: bật lại là thấy đủ như cũ." },
    ],
  },

  // ───────────────── SẢN PHẨM & ĐƠN HÀNG ─────────────────
  {
    key: "add-products",
    topic: "SELL",
    title: "Thêm sản phẩm",
    summary: "Sản phẩm và giá bán lẻ là gốc của đơn hàng, báo giá của chatbot và bảng giá sỉ.",
    href: "/products",
    permission: "products:view",
    steps: [
      { text: "Từng sản phẩm: Sản phẩm → «Tạo sản phẩm». Ô «Đơn vị tính» là chữ in trên đơn (cái, thùng, kg…).", href: "/products/new" },
      { text: "Nhiều sản phẩm một lúc: Sản phẩm → «Nhập từ tệp», tải tệp lên, xem trước rồi mới ghi.", href: "/products/import" },
      { text: "Số lượng trên đơn là số nguyên. Hàng cân lẻ thì đặt đơn vị nhỏ hơn (ví dụ 100 g hoặc 0,5 kg) để đơn ghi được số nguyên." },
    ],
  },
  {
    key: "create-order",
    topic: "SELL",
    title: "Tạo đơn hàng",
    summary: "Lên đơn cho khách gọi điện, nhắn tin hay mua tại quầy.",
    href: "/orders/new",
    permission: "orders:read",
    alsoRequires: ["orders:write"],
    tenantOnly: true,
    steps: [
      { text: "Mở Đơn hàng → «Tạo đơn hàng».", href: "/orders/new" },
      { text: "Chọn khách trong danh sách (mỗi dòng có tên · số điện thoại), thêm sản phẩm và số lượng. Khách đã gán bảng giá sỉ thì đơn giá tự lấy theo bảng, kể cả bậc giá khi mua nhiều." },
      { text: "Khách có hạn mức nợ: lưu đơn «Đã xác nhận» mà làm dư nợ vượt hạn mức thì ERP chặn — form hiện sẵn dư nợ hiện tại / hạn mức để bạn thấy trước." },
    ],
  },
  {
    key: "price-lists",
    topic: "SELL",
    title: "Bảng giá sỉ / đại lý",
    summary: "Mỗi nhóm khách một bảng giá, có bậc giá theo số lượng — đơn hàng và chatbot đọc cùng một bảng.",
    href: "/products/price-lists",
    permission: "products:view",
    tenantOnly: true,
    steps: [
      { text: "Mở Bảng giá sỉ → «Tạo bảng giá».", href: "/products/price-lists" },
      { text: "Mỗi dòng là một bậc: mẫu mã, «Mua từ (SL)», «Đơn giá (₫)». Muốn mua nhiều rẻ hơn thì bấm «Thêm bậc» (ví dụ từ 1 · từ 10 · từ 50), rồi «Lưu bảng giá»." },
      { text: "Tích «Mặc định cho khách chưa gán bảng» nếu muốn mọi khách chưa có bảng riêng dùng bảng này." },
      { text: "Gán bảng cho từng khách ở trang chi tiết khách → «Điều khoản bán & công nợ» → ô «Bảng giá». Thứ tự áp: bảng của khách → bảng mặc định → giá lẻ." },
    ],
  },

  // ───────────────── KHÁCH HÀNG & CÔNG NỢ ─────────────────
  {
    key: "customers",
    topic: "CUSTOMERS",
    title: "Thêm khách hàng",
    summary: "Hồ sơ khách giữ số điện thoại, địa chỉ, lịch sử mua và công nợ ở một chỗ.",
    href: "/customers",
    permission: "customers:view",
    steps: [
      { text: "Mở Khách hàng → «Tạo khách hàng».", href: "/customers/new" },
      { text: "Khách sỉ / mua chịu: mở trang chi tiết khách → «Điều khoản bán & công nợ» để đặt «Bảng giá», «Hạn mức nợ (₫)» và «Số ngày được nợ»." },
    ],
  },
  {
    key: "receivables",
    topic: "CUSTOMERS",
    title: "Theo dõi công nợ và thu nợ",
    summary: "Ai đang nợ bao nhiêu, nợ từ bao giờ — và ghi lại mỗi lần khách trả.",
    href: "/customers/receivables",
    permission: "customers:view",
    tenantOnly: true,
    steps: [
      { text: "Mở Công nợ khách hàng: danh sách khách còn nợ cùng tuổi nợ.", href: "/customers/receivables" },
      { text: "Dư nợ gồm đơn đã giao chưa trả VÀ đơn đã chốt chưa giao — cả hai cùng tính vào hạn mức. Tuổi nợ và quá hạn chỉ tính từ đơn đã giao." },
      { text: "Khách trả tiền: mở trang chi tiết của khách → «Ghi thu nợ». Tiền trừ vào đơn đã giao trước, trong đó đơn cũ nhất trước." },
    ],
  },
  {
    key: "reorder",
    topic: "CUSTOMERS",
    title: "Nhắc khách mua lại",
    summary: "Danh sách khách đến lúc mua lại theo nhịp mua thật của từng người — gọi trước khi họ mua chỗ khác.",
    href: "/customers/reorder",
    permission: "customers:view",
    tenantOnly: true,
    steps: [
      { text: "Mở Nhắc mua lại: khách quá hạn mua lại đứng đầu.", href: "/customers/reorder" },
      { text: "Gọi hoặc nhắn xong thì bấm «Ghi liên hệ». Có đặt ngày hẹn liên hệ lại thì khách tạm rời danh sách tới ngày đó." },
      { text: "Khách mới mua một lần chưa có nhịp riêng: khai «Chu kỳ mặc định (ngày)» của cửa hàng ngay trên trang. Chưa khai thì khách đó hiện «Chưa biết chu kỳ» — ERP không đoán." },
    ],
  },

  // ───────────────── DỊCH VỤ & LỊCH HẸN ─────────────────
  {
    key: "appointments",
    topic: "SERVICE",
    title: "Đặt lịch hẹn cho khách",
    summary: "Lịch theo ngày cho lễ tân: ai làm cho khách nào, lúc mấy giờ, khách đã tới hay chưa.",
    href: "/appointments",
    permission: "appointments:view",
    steps: [
      { text: "Mở Lịch hẹn, chọn ngày.", href: "/appointments" },
      { text: "Điền khách, dịch vụ, kỹ thuật viên, giờ bắt đầu rồi bấm «Đặt lịch». Đã xếp kỹ thuật viên thì ERP chặn đặt trùng giờ của người đó." },
      { text: "Cập nhật ngay trên dòng lịch: «Khách đã tới», «Đã làm xong», «Khách không tới»; huỷ thì phải ghi lý do." },
      { text: "Khách mua liệu trình: chọn «Liệu trình» khi đặt lịch — số buổi còn lại tính từ các buổi đã làm xong." },
      { text: "Mỗi ngày: khung «Nhắc lịch ngày mai» (khi xem lịch hôm nay) liệt kê khách chưa xác nhận — bấm «Sao chép câu nhắc», gửi qua Zalo; khách đồng ý thì bấm «Khách đã xác nhận»." },
    ],
  },

  {
    key: "warranty",
    topic: "SERVICE",
    title: "Bảo hành theo serial",
    summary: "Khách gọi báo lỗi: tra theo SĐT hoặc serial là biết khách mua gì, ngày nào, còn bảo hành hay không.",
    href: "/warranty",
    permission: "warranty:view",
    steps: [
      { text: "Mở Bảo hành, gõ SĐT / serial / tên khách vào ô tra.", href: "/warranty" },
      { text: "Bán máy mới: điền khách, sản phẩm, serial, ngày mua, số tháng rồi bấm «Lập phiếu bảo hành» — hạn do ERP tính." },
      { text: "Khách báo lỗi: trên phiếu bấm «Mở ca bảo hành», ghi lỗi; xử lý xong bấm «Đóng ca…» và chọn cách xử lý. Ca mở sau hạn được ghi «ngoài hạn»." },
    ],
  },

  // ───────────────── CHATBOT ─────────────────
  {
    key: "sales-chatbot",
    topic: "AI",
    title: "Thiết lập chatbot bán hàng",
    summary: "Chatbot trả lời khách bằng đúng sản phẩm, giá và tồn kho của cửa hàng, và lên đơn khi khách chốt.",
    href: "/ai/sales-chatbot",
    permission: "ai_sales:view",
    steps: [
      { text: "Mở Chatbot bán hàng → phần «Cấu hình bot»: chọn «Giọng điệu», phí ship, và ghi chính sách của shop vào ô hướng dẫn thêm.", href: "/ai/sales-chatbot" },
      { text: "Thử trong «Khung thử (TEST)» trước khi cho bot trả lời khách thật." },
      { text: "Đọc «Hội thoại gần đây»: ca bot chuyển cho người hiện ngay trong danh sách đó, kèm nút để bot tiếp tục." },
      { text: "Spa / dịch vụ (cần module Lịch hẹn): bật «Nhận đặt lịch qua chat», khai giờ mở cửa và «Số khách phục vụ cùng lúc». Bot chỉ mời giờ còn chỗ, chờ khách xác nhận rồi mới giữ chỗ; lịch vào trang Lịch hẹn để lễ tân xếp người." },
    ],
  },

  // ───────────────── TÀI KHOẢN & THANH TOÁN ─────────────────
  {
    key: "my-account",
    topic: "ACCOUNT",
    title: "Đổi mật khẩu của tôi",
    summary: "Đổi mật khẩu khi nghi lộ; đổi xong, tài khoản bị đăng xuất trên MỌI thiết bị, kể cả máy đang dùng.",
    href: "/settings/profile",
    steps: [{ text: "Bấm ảnh đại diện góc trên → «Tài khoản của tôi» → «Đổi mật khẩu của tôi».", href: "/settings/profile" }],
  },
  {
    key: "data-export",
    topic: "ACCOUNT",
    title: "Tải dữ liệu của cửa hàng ra Excel",
    summary: "Khách hàng, đơn, sản phẩm, phiếu thu, lịch hẹn — tải ra CSV bất cứ lúc nào, kể cả khi gói đã quá hạn.",
    href: "/settings/data-export",
    permission: "settings:manage",
    steps: [
      { text: "Mở Hệ thống → Xuất dữ liệu.", href: "/settings/data-export" },
      { text: "Bấm «Tải CSV» ở loại cần lấy; mở tệp bằng Excel hoặc Google Sheets. Mỗi tệp là TOÀN BỘ dữ liệu loại đó." },
      { text: "Tệp có tên, số điện thoại, địa chỉ khách — giữ cẩn thận. Mỗi lượt tải được ghi vào nhật ký." },
    ],
  },
  {
    key: "plan-billing",
    topic: "ACCOUNT",
    title: "Gói dịch vụ và gia hạn",
    summary: "Xem gói đang dùng, hạn sử dụng, và gia hạn bằng chuyển khoản quét mã QR.",
    href: "/settings/plan",
    permission: "settings:manage",
    steps: [
      { text: "Mở Hệ thống → Gói & thanh toán.", href: "/settings/plan" },
      { text: "Chọn số tháng, bấm «Tạo mã thanh toán», rồi quét mã bằng app ngân hàng. Giữ nguyên nội dung chuyển khoản — ERP đối chiếu tự động theo đúng mã đó." },
      { text: "Quá hạn: sau thời gian ân hạn, ERP chuyển sang CHỈ XEM (vẫn xem và xuất được) cho tới khi gia hạn. Không dữ liệu nào bị xoá." },
    ],
  },
];

/** Câu hỏi thường gặp — không gắn trang nào, nên luôn hiện. */
export const HELP_FAQ: readonly { q: string; a: string }[] = [
  { q: "Bấm lưu mà ERP báo «chỉ xem»?", a: "Gói của cửa hàng đã quá hạn thanh toán. Dữ liệu vẫn còn nguyên; người quản trị gia hạn ở Hệ thống → Gói & thanh toán là ghi lại được ngay." },
  { q: "Không thấy một trang mà đồng nghiệp thấy?", a: "Mỗi vai trò thấy đúng phần việc của mình. Nhờ người quản trị kiểm tra vai trò của bạn ở Hệ thống → Người dùng." },
  { q: "Bấm vào một mục thì ERP báo module chưa bật?", a: "Tính năng đó đang tắt cho cửa hàng. Người quản trị bật ở Hệ thống → Module của tổ chức." },
  { q: "Mời thêm người mà ERP báo vượt hạn mức?", a: "Gói hiện tại có trần số người dùng, kể cả lời mời chưa nhận. Thu hồi lời mời không dùng tới, khoá tài khoản đã nghỉ, hoặc nâng gói." },
  { q: "Tôi quên mật khẩu?", a: "Nhờ người quản trị cửa hàng gửi liên kết đặt lại mật khẩu. Nếu chính bạn là quản trị, liên hệ bên cung cấp phần mềm." },
];

/**
 * Bài này có hiện cho người xem không: trang chính mở được (module đang bật), đủ quyền, và — bài `tenantOnly` — người xem
 * ở tổ chức khách. Ẩn không phải bảo mật (cổng thật ở trang); ẩn để không ai đọc một bài dẫn tới trang họ không vào được.
 */
export function helpGuideVisible(guide: HelpGuide, viewer: ModuleViewer & { isHome: boolean }, allowed: (permission: Permission) => boolean): boolean {
  if (guide.tenantOnly && viewer.isHome) return false;
  if (guide.permission && !allowed(guide.permission)) return false;
  if (guide.alsoRequires?.some((p) => !allowed(p))) return false;
  return hrefVisible(viewer, guide.href);
}
