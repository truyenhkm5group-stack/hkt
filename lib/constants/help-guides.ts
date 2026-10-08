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
import { SERVICE_COMMITMENTS } from "@/lib/constants/company";
import { SALES_AGENT_NAV, salesAgentPathAllowed } from "@/lib/constants/saas-nav";
import { hrefVisible, type ModuleViewer } from "@/lib/platform-ui/module-visibility";

/**
 * ĐỐI TƯỢNG ĐỌC (docs/saas/HELP_CENTER.md §4): `ERP` = chỉ ngoài vỏ Chốt Đơn (bài gọi menu «Hệ thống → …», dẫn vào trang vỏ
 * chặn); `CHOTDON` = chỉ trong vỏ (gọi đúng tên menu của vỏ: Hội thoại · AI Sales · Kênh kết nối · Nhân viên · Gói dịch vụ);
 * `ALL` = cả hai. Bỏ trống ⇒ `ERP`: bài cũ viết cho ERP, không tự lọt vào vỏ khi quên khai. Bài kiểm khoá: mọi đường dẫn của
 * bài `CHOTDON` / `ALL` phải qua `salesAgentPathAllowed` — cùng hàm với cổng máy chủ, không danh sách thứ hai.
 */
export type HelpAudience = "ERP" | "CHOTDON" | "ALL";

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

/**
 * Tiêu đề chủ đề khi người đọc ở TRONG vỏ Chốt Đơn: chủ đề AI mang ĐÚNG tên mục menu của vỏ («AI Sales»), đọc thẳng từ
 * `SALES_AGENT_NAV` — không gõ lại chuỗi thứ hai để hai nơi trôi khỏi nhau. Chủ đề khác giữ nhãn chung.
 */
export function helpTopicLabel(topic: HelpTopic, shell: boolean): string {
  if (shell && topic === "AI") return SALES_AGENT_NAV.find((i) => i.key === "ai")?.label ?? HELP_TOPIC_LABEL.AI;
  return HELP_TOPIC_LABEL[topic];
}

export type HelpStep = {
  text: string;
  /**
   * Câu của bước khi người đọc ở TRONG vỏ Chốt Đơn — chỉ cho bài `ALL` mà đường đi khác nhau giữa hai nơi (ERP gọi menu
   * «Hệ thống → …», vỏ gọi «Cài đặt → …»). Bỏ trống ⇒ `text`. Trang và bài kiểm đọc qua `helpStepText` — một chỗ chọn câu.
   */
  shellText?: string;
  href?: string;
};

/** Câu người đọc THẤY ở bước này: trong vỏ ⇒ `shellText` nếu có, còn lại `text`. */
export function helpStepText(step: HelpStep, shell: boolean): string {
  return shell && step.shellText ? step.shellText : step.text;
}

/** Câu hạn giữ dữ liệu sau khi hết hạn — đọc từ cam kết của Điều khoản (`SERVICE_COMMITMENTS`), không gõ lại con số. */
const RETENTION_SENTENCE = `Dữ liệu được giữ ít nhất ${SERVICE_COMMITMENTS.retainAfterExpiryDays} ngày sau khi hết hạn; trước khi xoá, quản trị được báo qua email trước ${SERVICE_COMMITMENTS.deletionNoticeDays} ngày.`;

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
  /**
   * Quyền mà VIỆC của bài còn đòi THÊM sau cổng đầu của trang (vd tạo đơn tay cần `orders:write`, thiếu thì trang 404; nối kênh
   * cần `settings:manage`, thiếu thì trang Kênh kết nối không có nút nối) — thiếu thì bài ẩn: không dạy một việc người đọc không
   * làm được.
   */
  alsoRequires?: readonly Permission[];
  /** Chỉ tổ chức khách (trang dựng trên đơn tạo tay — tổ chức nhà đồng bộ Pancake nên trang ấy đóng). */
  tenantOnly?: true;
  /** Ai đọc bài này — xem `HelpAudience`. Bỏ trống ⇒ `ERP`. */
  audience?: HelpAudience;
  steps: readonly HelpStep[];
};

export const HELP_GUIDES: readonly HelpGuide[] = [
  // ───────────────── VỎ CHỐT ĐƠN TỰ ĐỘNG — khách không rành kỹ thuật, gọi đúng tên menu của vỏ ─────────────────
  {
    key: "chotdon-connect-facebook",
    topic: "START",
    audience: "CHOTDON",
    // Chỉ hướng dẫn đường nối ĐANG CHẠY (Pancake · Zalo OA · ô chat website). Nối thẳng Facebook chờ Meta duyệt quyền Page
    // (meta-messenger-access BLOCKED_EXTERNAL) — chỉ nhắc kèm «sắp mở», không phải bước khách làm (review #706, 09/10/2026).
    title: "Nối fanpage để nhận tin khách",
    summary: "Nối kênh là bước đầu tiên: tin khách nhắn vào fanpage (qua Pancake), Zalo OA hoặc ô chat website sẽ hiện ở Hội thoại và AI bắt đầu trả lời.",
    href: "/ai/channels",
    permission: "ai_sales:view",
    // Nút «Kết nối Facebook» và trang Kết nối chỉ mở cho người có quyền cài đặt (cùng cổng với route bắt đầu nối Facebook).
    alsoRequires: ["settings:manage"],
    steps: [
      // Vỏ không có mục menu «Cài đặt → Kết nối»: dẫn thẳng tới trang (vỏ mở được — `/settings/connections` nằm dưới mục Kênh kết nối).
      { text: "Fanpage qua Pancake: mở trang Kết nối, mục «Fanpage qua Pancake», nhập mã trang và mã truy cập của page (lấy trong Pancake → Cài đặt page → Công cụ), rồi Lưu → Kiểm tra → Bật.", href: "/settings/connections" },
      { text: "Trong Pancake: dán địa chỉ nhận tin của shop vào phần cài đặt nhận tin của page — làm theo từng bước trên thẻ «Fanpage (qua Pancake)» ở AI Sales.", href: "/ai/sales-chatbot" },
      { text: "Không dùng Pancake: nối Zalo OA ở trang Kết nối, hoặc gắn ô chat lên website (thẻ «Trang chat công khai» trên AI Sales)." },
      { text: "Nối thẳng Facebook (không qua Pancake) đang chờ Facebook duyệt quyền — sắp mở.", href: "/ai/channels" },
    ],
  },
  {
    key: "chotdon-no-messages",
    topic: "START",
    audience: "CHOTDON",
    title: "Vì sao chưa thấy tin khách?",
    summary: "Ba chỗ cần xem theo thứ tự: đã nối kênh chưa · đường nhận tin đã thông chưa · khách có nhắn thật không.",
    href: "/ai/channels",
    permission: "ai_sales:view",
    steps: [
      { text: "Mở Kênh kết nối: chưa có kênh nào ⇒ nối fanpage qua Pancake, Zalo OA hoặc ô chat website trước (xem bài Nối fanpage để nhận tin khách).", href: "/ai/channels" },
      { text: "Fanpage qua Pancake mà vẫn trống ⇒ xem lại địa chỉ nhận tin đã dán đúng trong Pancake (thẻ «Fanpage (qua Pancake)» ở AI Sales) và kết nối ở trang Kết nối đang Bật." },
      { text: "Page sẵn sàng mà Hội thoại vẫn trống ⇒ nhờ một người nhắn thử vào fanpage; tin phải hiện trong vài giây.", href: "/ai/sales-chatbot/inbox" },
      { text: "Vẫn không thấy: nhắn hỗ trợ (cuối trang này) kèm tên cửa hàng và tên Page." },
    ],
  },
  {
    key: "chotdon-products",
    topic: "SELL",
    audience: "CHOTDON",
    title: "Thêm sản phẩm để AI báo giá đúng",
    summary: "AI chỉ báo giá và hàng còn theo đúng danh sách sản phẩm của cửa hàng — không bao giờ tự nghĩ ra giá.",
    href: "/products",
    permission: "products:view",
    steps: [
      { text: "Mở Sản phẩm, bấm «Tạo sản phẩm»: tên, giá bán, size / màu nếu có.", href: "/products/new" },
      { text: "Nhiều sản phẩm một lúc: bấm «Nhập từ tệp», tải tệp Excel / CSV lên, xem trước rồi mới ghi.", href: "/products/import" },
      { text: "Muốn AI kiểm hàng còn trước khi chốt: khai số lượng ở Nhập hàng & kiểm kê. Chưa khai thì AI không khẳng định còn hàng.", href: "/inventory/receipts" },
    ],
  },
  {
    key: "chotdon-ai-sales",
    topic: "AI",
    audience: "CHOTDON",
    title: "Thử AI rồi bật cho khách thật",
    summary: "Chat thử một lượt mua trọn vòng trong khung thử, thấy ổn thì bật — AI trả lời khách trên các Page đã nối.",
    href: "/ai/sales-chatbot",
    permission: "ai_sales:view",
    steps: [
      { text: "Mở AI Sales, xem bảng «AI đã sẵn sàng tự trả lời khách?»: dòng «Cần làm» là việc phải xong trước khi bật; dòng «Đang chuẩn bị» là phần đội hỗ trợ đang làm cho cửa hàng.", href: "/ai/sales-chatbot" },
      { text: "Ở phần Cấu hình: chọn giọng điệu, phí giao hàng và ghi chính sách của cửa hàng (đổi trả, thanh toán) vào ô hướng dẫn thêm." },
      { text: "Chat thử trong khung thử bên phải như một khách thật: hỏi giá, chọn hàng, cho địa chỉ — tới khi AI đọc lại tóm tắt đơn." },
      { text: "Bấm «Lưu và bật bot». Từ lúc này AI trả lời khách thật; nhân viên vẫn tiếp quản được từng hội thoại ở Hội thoại." },
    ],
  },
  {
    key: "chotdon-inbox",
    topic: "AI",
    audience: "CHOTDON",
    title: "Trả lời khách và xem đơn AI chốt",
    summary: "Mọi tin Facebook / Zalo / chat web ở một chỗ; nhân viên tiếp quản khi cần, AI nhường trong lúc người đang trả lời.",
    href: "/ai/sales-chatbot/inbox",
    permission: "ai_sales:view",
    steps: [
      { text: "Mở Hội thoại. Bộ lọc «Chờ trả lời» xếp khách chờ lâu nhất lên đầu; «Cần người» là ca AI đã chuyển cho nhân viên.", href: "/ai/sales-chatbot/inbox" },
      { text: "Bấm một hội thoại để đọc. Muốn tự trả lời: bấm «Tiếp quản», gõ tin và gửi — AI tạm nhường cho tới khi bạn trả lại." },
      { text: "Đơn AI đã chốt hiện ngay trong hội thoại với liên kết tới đơn; sửa đơn ở trang đơn hàng nếu AI ghi sai." },
    ],
  },
  {
    key: "chotdon-staff",
    topic: "ACCOUNT",
    audience: "CHOTDON",
    title: "Mời nhân viên vào cửa hàng",
    summary: "Mỗi người một tài khoản riêng — biết ai trả lời khách nào, nghỉ việc thì khoá đúng người.",
    href: "/settings/users",
    permission: "users:manage",
    steps: [
      { text: "Mở Nhân viên, bấm «Mời người dùng», nhập email, chọn vai trò rồi bấm «Tạo liên kết mời».", href: "/settings/users" },
      { text: "Sao chép liên kết và gửi qua Zalo / Messenger. Liên kết dùng một lần, hết hạn sau 7 ngày." },
      { text: "Nhân viên mở liên kết, tự đặt tên và mật khẩu — xong là vào được ngay." },
    ],
  },
  {
    key: "chotdon-plan",
    topic: "ACCOUNT",
    audience: "CHOTDON",
    title: "Xem gói, lượt AI và gia hạn",
    summary: "Gói đang dùng, còn bao nhiêu lượt khách AI trong tháng, hạn sử dụng, và gia hạn bằng quét mã QR.",
    href: "/settings/plan",
    permission: "settings:manage",
    steps: [
      { text: "Mở Gói dịch vụ: hạn sử dụng và số lượt khách AI đã dùng trong tháng nằm ngay đầu trang.", href: "/settings/plan" },
      { text: "Gia hạn: chọn số tháng, bấm «Tạo mã thanh toán», quét mã bằng app ngân hàng và GIỮ NGUYÊN nội dung chuyển khoản." },
      { text: `Quá hạn: sau thời gian ân hạn, cửa hàng chuyển sang chỉ xem cho tới khi gia hạn. ${RETENTION_SENTENCE}` },
    ],
  },

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

  // ───────────────── SĂN KHÁCH SỈ ─────────────────
  {
    key: "wholesale-lead-hunter",
    topic: "CUSTOMERS",
    title: "Tìm khách sỉ mới (nhà hàng, quán, khách sạn)",
    summary: "Quét Google Places theo từ khoá × khu vực, ERP tự lọc, khử trùng, chấm điểm; người bán chỉ gọi lead hạng cao.",
    href: "/wholesale/lead-hunter",
    permission: "wholesale:scan",
    steps: [
      { text: "Lần đầu: vào Cài đặt → Kết nối, mục «Google Places (tìm doanh nghiệp)», dán khoá API, kiểm tra rồi bật.", href: "/settings/connections" },
      { text: "Ở Săn khách sỉ, bấm «Dùng mẫu» trên mẫu HSLC (hoặc điền form), bấm «Xem trước truy vấn» để thấy số truy vấn và chi phí ước tính." },
      { text: "Bấm «Bắt đầu quét». Quét chạy nền, trang tự làm mới; «Tạm dừng» / «Tiếp tục» không mất tiến độ. Chạm trần chi phí ngày / tháng thì tự dừng và báo." },
      { text: "Lead đủ điểm có SĐT tự lên «Đủ điều kiện». Ở danh sách, chọn lead rồi «Xếp hàng liên hệ» — ERP KHÔNG tự gửi tin." },
    ],
  },
  {
    key: "wholesale-leads-work",
    topic: "CUSTOMERS",
    title: "Gọi và chăm khách sỉ tiềm năng",
    summary: "Mỗi ngày: mở lead được giao, gọi, ghi kết quả, gửi lời chào, chuyển thành khách khi chốt.",
    href: "/wholesale/leads",
    permission: "wholesale:view",
    steps: [
      { text: "Mở Khách sỉ tiềm năng, lọc Phụ trách = Của tôi, hoặc Liên hệ = «Đến hạn gọi lại».", href: "/wholesale/leads" },
      { text: "Trong lead: bấm «Gọi», sau cuộc gọi bấm «Ghi cuộc gọi» và chọn kết quả; hẹn ngày gọi lại nếu cần." },
      { text: "Muốn nhắn Zalo / SMS: «Soạn lời chào», duyệt ở Hàng đợi liên hệ, gửi bằng app rồi bấm «Đã gửi» và ghi kết quả." },
      { text: "Khách đồng ý mua: «Chuyển thành khách hàng» — tên, SĐT, địa chỉ lấy từ lead, không nhập lại. Khách từ chối: «Không liên hệ nữa»." },
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

  {
    key: "stays",
    topic: "SERVICE",
    title: "Lịch phòng Airbnb / homestay",
    summary: "Gộp lịch Airbnb / Booking / Agoda về một chỗ, biết ngay trùng phòng, ai nhận / trả và phòng nào phải dọn hôm nay.",
    href: "/stays",
    permission: "stays:view",
    steps: [
      { text: "Mở Lịch phòng, thẻ «Phòng & kênh», thêm từng phòng (mã, tên, chủ nhà nếu vận hành hộ).", href: "/stays?tab=phong" },
      { text: "Chép đường dẫn lịch của phòng dán vào mục nhập lịch của Airbnb / Booking / Agoda — kênh sẽ tự khoá ngày đã bán ở nơi khác." },
      { text: "Tải tệp lịch .ics từ kênh, ở khung «Nhập lịch của kênh» bấm «Chạy thử» để xem lượt mới / đổi / huỷ, rồi «Nhập thật»." },
      { text: "Thẻ «Lịch»: trùng phòng hiện đỏ đầu trang; dọn xong thì bấm «Dọn xong»; khách đặt trực tiếp thì «Đặt phòng»." },
    ],
  },

  {
    key: "field-jobs",
    topic: "SERVICE",
    title: "Phiếu công việc tại nhà",
    summary: "Báo giá, hẹn thợ, ảnh trước / sau, khách ký nghiệm thu và thu tiền theo đợt — một phiếu cho mỗi việc tại nhà khách.",
    href: "/field-jobs",
    permission: "field_jobs:view",
    steps: [
      { text: "Mở Phiếu công việc, ở khung «Lập phiếu báo giá» chọn khách, ghi tên việc và từng dòng báo giá rồi bấm «Lập phiếu».", href: "/field-jobs" },
      { text: "Khách đồng ý thì bấm «Khách đồng ý báo giá», rồi «Hẹn thợ» chọn thợ, giờ hẹn, thời lượng — ERP chặn nếu thợ đã có hẹn chồng giờ." },
      { text: "Tới nơi bấm «Bắt đầu làm», tải ảnh trước / sau, phát sinh thì thêm dòng báo giá; xong việc bấm «Nghiệm thu» và ghi tên khách ký." },
      { text: "Thu tiền ở khung «Tiền» bằng nút «Thu tiền» — cọc, đợt giữa, nghiệm thu; không thu vượt báo giá. Khách báo lại sự cố thì «Mở lượt bảo hành»." },
    ],
  },

  {
    key: "real-estate",
    topic: "SELL",
    title: "Bảng hàng bất động sản",
    summary: "Một bảng hàng chung cho cả đội sale: căn nào còn trống, ai đang giữ tới bao giờ — không ai giữ trùng một căn.",
    href: "/real-estate",
    permission: "real_estate:view",
    steps: [
      { text: "Quản lý sàn: ở khung «Tạo dự án» khai mã, tên và số giờ giữ chỗ tối đa; rồi dán danh sách căn ở khung «Thêm căn».", href: "/real-estate" },
      { text: "Sale: căn còn trống bấm «Giữ chỗ», ghi tên khách — hết giờ mà chưa cọc thì căn tự trở về còn trống." },
      { text: "Khách cọc: bấm «Đặt cọc» trên căn mình đang giữ. Quản lý xác nhận «Ký bán» bằng số hợp đồng, hoặc «Hoàn / bỏ cọc…» có lý do." },
    ],
  },

  {
    key: "lots",
    topic: "SELL",
    title: "Lô & hạn dùng",
    summary: "Gắn mã lô và hạn dùng lên phiếu nhập, biết lô nào cận hạn để bán trước và lô nào hết hạn mà còn hàng.",
    href: "/inventory/lots",
    permission: "lots:view",
    steps: [
      { text: "Lập phiếu nhập hàng như mọi lần ở Nhập hàng & kiểm kê.", href: "/inventory/receipts" },
      { text: "Mở Lô & hạn dùng, ở khung «Gắn lô cho phiếu nhập» chọn dòng phiếu, gõ mã lô, hạn dùng, số lượng rồi bấm «Gắn lô». Một dòng chia được nhiều lô.", href: "/inventory/lots" },
      { text: "Khung «Cận hạn trong» N ngày liệt kê lô sắp hết hạn còn hàng; cột «Lấy» là thứ tự lấy hàng hạn gần trước. Lô hết hạn còn hàng hiện đỏ — huỷ bằng phiếu xuất kho." },
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
    audience: "ALL",
    title: "Đổi mật khẩu của tôi",
    summary: "Đổi mật khẩu khi nghi lộ; đổi xong, tài khoản bị đăng xuất trên MỌI thiết bị, kể cả máy đang dùng.",
    href: "/settings/profile",
    steps: [
      {
        // ERP: ảnh đại diện nằm ở GÓC TRÊN BÊN PHẢI thanh menu. Vỏ: cuối thanh bên trái (máy tính) / góc trên (điện thoại) — gọi
        // đường menu chung cho cả hai khổ thay vì tả vị trí.
        text: "Bấm ảnh đại diện ở góc trên bên phải → «Tài khoản của tôi» → «Đổi mật khẩu của tôi».",
        shellText: "Mở Cài đặt → «Tài khoản của tôi», rồi bấm «Đổi mật khẩu của tôi».",
        href: "/settings/profile",
      },
    ],
  },
  {
    key: "data-export",
    topic: "ACCOUNT",
    audience: "ALL",
    title: "Tải dữ liệu của cửa hàng ra Excel",
    summary: "Khách hàng, đơn, sản phẩm, phiếu thu, lịch hẹn — tải ra CSV bất cứ lúc nào, kể cả khi gói đã quá hạn.",
    href: "/settings/data-export",
    permission: "settings:manage",
    steps: [
      { text: "Mở Hệ thống → Xuất dữ liệu.", shellText: "Mở Cài đặt → «Xuất dữ liệu».", href: "/settings/data-export" },
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
      { text: `Quá hạn: sau thời gian ân hạn, ERP chuyển sang CHỈ XEM (vẫn xem và xuất được) cho tới khi gia hạn. ${RETENTION_SENTENCE}` },
    ],
  },
];

/** Câu hỏi thường gặp — không gắn trang nào, nên luôn hiện (lọc theo đối tượng đọc như bài). */
export const HELP_FAQ: readonly { q: string; a: string; audience?: HelpAudience }[] = [
  { q: "Bấm lưu mà ERP báo «chỉ xem»?", a: "Gói của cửa hàng đã quá hạn thanh toán. Dữ liệu vẫn còn nguyên; người quản trị gia hạn ở Hệ thống → Gói & thanh toán là ghi lại được ngay." },
  { q: "Không thấy một trang mà đồng nghiệp thấy?", a: "Mỗi vai trò thấy đúng phần việc của mình. Nhờ người quản trị kiểm tra vai trò của bạn ở Hệ thống → Người dùng." },
  { q: "Bấm vào một mục thì ERP báo module chưa bật?", a: "Tính năng đó đang tắt cho cửa hàng. Người quản trị bật ở Hệ thống → Module của tổ chức." },
  { q: "Mời thêm người mà ERP báo vượt hạn mức?", a: "Gói hiện tại có trần số người dùng, kể cả lời mời chưa nhận. Thu hồi lời mời không dùng tới, khoá tài khoản đã nghỉ, hoặc nâng gói." },
  { q: "Tôi quên mật khẩu?", a: "Nhờ người quản trị cửa hàng gửi liên kết đặt lại mật khẩu. Nếu chính bạn là quản trị, liên hệ bên cung cấp phần mềm.", audience: "ALL" },
  { q: "Bấm lưu mà ứng dụng báo «chỉ xem»?", a: "Gói của cửa hàng đã quá hạn. Dữ liệu vẫn còn nguyên; người quản trị gia hạn ở Gói dịch vụ là ghi lại được ngay.", audience: "CHOTDON" },
  { q: "AI không trả lời khách?", a: "Mở AI Sales, xem bảng «AI đã sẵn sàng tự trả lời khách?»: dòng nào «Cần làm» thì làm trước; dòng «Đang chuẩn bị» là đội hỗ trợ đang làm, bạn không cần làm gì. Hết lượt khách AI của tháng thì mua thêm ở Gói dịch vụ. Vẫn không được thì nhắn hỗ trợ.", audience: "CHOTDON" },
  { q: "Mời thêm người mà ứng dụng báo vượt hạn mức?", a: "Gói hiện tại có trần số người dùng, kể cả lời mời chưa nhận. Thu hồi lời mời không dùng tới, khoá tài khoản đã nghỉ, hoặc nâng gói.", audience: "CHOTDON" },
];

/** Bài / câu hỏi này dành cho người đọc đang ở trong vỏ Chốt Đơn (`shell = true`) hay ngoài vỏ. Bỏ trống đối tượng ⇒ `ERP`. */
export function helpAudienceMatches(audience: HelpAudience | undefined, shell: boolean): boolean {
  const a = audience ?? "ERP";
  return a === "ALL" || (shell ? a === "CHOTDON" : a === "ERP");
}

/**
 * Bài này có hiện cho người xem không: trang chính mở được (module đang bật), đủ quyền, và — bài `tenantOnly` — người xem
 * ở tổ chức khách. Ẩn không phải bảo mật (cổng thật ở trang); ẩn để không ai đọc một bài dẫn tới trang họ không vào được.
 */
export function helpGuideVisible(guide: HelpGuide, viewer: ModuleViewer & { isHome: boolean; shell?: boolean }, allowed: (permission: Permission) => boolean): boolean {
  if (!helpAudienceMatches(guide.audience, viewer.shell ?? false)) return false;
  // Trong vỏ, mọi đường dẫn của bài phải mở được — cùng phép quyết định với cổng máy chủ (không bao giờ dẫn vào trang bị chặn).
  if (viewer.shell && ![guide.href, ...guide.steps.flatMap((s) => (s.href ? [s.href] : []))].every(salesAgentPathAllowed)) return false;
  if (guide.tenantOnly && viewer.isHome) return false;
  if (guide.permission && !allowed(guide.permission)) return false;
  if (guide.alsoRequires?.some((p) => !allowed(p))) return false;
  return hrefVisible(viewer, guide.href);
}
