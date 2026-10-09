/**
 * ═══════════ VÀO VIỆC NGAY THEO KÊNH — KHÔNG BẮT BUỘC PANCAKE (docs/messaging-providers.md) ═══════════
 *
 * Trước đây ô «Vào việc ngay» là MỘT danh sách cố định: kết nối fanpage QUA PANCAKE → dán URL webhook VÀO PANCAKE → bật bot.
 * Shop chưa từng nghe tới Pancake không có đường nào. Giờ bước kênh do shop CHỌN cách quản lý tin nhắn:
 *  · `DIRECT`  — nối thẳng Facebook Page (đăng nhập Facebook → chọn page; không webhook, không phần mềm thứ ba) — khuyên dùng;
 *  · `PANCAKE` — shop đang dùng Pancake: nối page qua Pancake + dán URL webhook (bước này CHỈ hiện cho lối này);
 *  · `OTHER`   — shop dùng phần mềm khác: các kênh nối thẳng còn lại (Zalo OA, ô chat website) + lối gửi yêu cầu kết nối.
 * Lối đang dùng SUY RA từ kết nối thật (không lưu lựa chọn): đã nối Pancake ⇒ PANCAKE, đã nối Messenger ⇒ DIRECT, đã nối
 * Zalo ⇒ OTHER; chưa nối gì ⇒ `null` (màn hình cho chọn, khuyên DIRECT).
 *
 * Mốc onboarding là HÀM THUẦN của dữ liệu thật — không có ô bấm cho xong. Tổ chức tới được ACTIVATED mà không cần Pancake.
 */

export const GO_LIVE_PATHS = ["DIRECT", "PANCAKE", "OTHER"] as const;
export type GoLivePath = (typeof GO_LIVE_PATHS)[number];

export const ONBOARDING_STAGES = ["ACCOUNT_CREATED", "CHANNEL_CONNECTED", "MESSAGING_READY", "CATALOG_READY", "AI_CONFIGURED", "TEST_PASSED", "ACTIVATED"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const ONBOARDING_STAGE_LABEL: Record<OnboardingStage, string> = {
  ACCOUNT_CREATED: "Đã có tài khoản",
  CHANNEL_CONNECTED: "Đã nối kênh bán hàng",
  MESSAGING_READY: "Đã nhận tin khách",
  CATALOG_READY: "Đã có sản phẩm có giá",
  AI_CONFIGURED: "AI dùng được",
  TEST_PASSED: "Đã thử lên đơn",
  ACTIVATED: "Bot đang trả lời khách",
};

export type ChannelFacts = { pancake: boolean; messenger: boolean; zalo: boolean; webChat: boolean };

/** Cửa hàng đã nối ÍT NHẤT một kênh nhận tin chưa — mốc «đã nối kênh» của onboarding và trạng thái rỗng của hộp thư. HÀM THUẦN. */
export function anyChannelConnected(c: ChannelFacts): boolean {
  return c.pancake || c.messenger || c.zalo || c.webChat;
}

/** Lối đang dùng, suy từ kết nối thật. Pancake đứng trước: shop đã nối Pancake thì hướng dẫn webhook vẫn phải hiện. HÀM THUẦN. */
export function goLivePathOf(c: ChannelFacts): GoLivePath | null {
  if (c.pancake) return "PANCAKE";
  if (c.messenger) return "DIRECT";
  if (c.zalo || c.webChat) return "OTHER";
  return null;
}

export type StageFacts = ChannelFacts & { messagesReceived: number; pricedVariants: number; aiReady: boolean; testDrafts: number; botEnabled: boolean };

/**
 * Mốc xa nhất đã tới, đi THEO THỨ TỰ (thiếu một mốc thì dừng ở mốc trước nó — bot bật mà chưa có kênh không phải «đang trả
 * lời khách»). Kèm danh sách mốc đã / chưa để màn hình vẽ. HÀM THUẦN.
 */
export function onboardingStage(f: StageFacts): { stage: OnboardingStage; done: Record<OnboardingStage, boolean> } {
  const done: Record<OnboardingStage, boolean> = {
    ACCOUNT_CREATED: true,
    CHANNEL_CONNECTED: anyChannelConnected(f),
    MESSAGING_READY: f.messagesReceived > 0,
    CATALOG_READY: f.pricedVariants > 0,
    AI_CONFIGURED: f.aiReady,
    TEST_PASSED: f.testDrafts > 0,
    ACTIVATED: f.botEnabled,
  };
  let stage: OnboardingStage = "ACCOUNT_CREATED";
  for (const s of ONBOARDING_STAGES) {
    if (!done[s]) break;
    stage = s;
  }
  return { stage, done };
}

/**
 * ═══════════ DANH SÁCH «GIÁ TRỊ ĐẦU TIÊN» CỦA VỎ CHỐT ĐƠN — CHÍN BƯỚC, MỘT DANH SÁCH (chủ shop 10/10/2026) ═══════════
 *
 * Khách ít rành công nghệ đăng nhập xong thấy ĐÚNG MỘT danh sách việc, thay cho các thẻ rải rác: nối Facebook → chọn Page →
 * sản phẩm → giá + tồn + chính sách → AI → nhắn thử → AI trả lời thử → thử lên đơn → bật chạy thật.
 *
 * Mỗi bước có BA trạng thái, không hai: `DONE` (có chứng cứ trong dữ liệu thật) · `NEEDS_ACTION` (chưa làm, HOẶC chưa kiểm được —
 * câu chữ nói rõ là cái nào) · `ERROR` (đã thử mà hỏng — kèm lý do thật bằng lời thường, vd lần kiểm tra kết nối không đạt, AI
 * chưa dùng được). Không bao giờ `DONE` khi thiếu chứng cứ (luật 42): chưa biết là việc phải làm, không phải việc đã xong.
 *
 * HÀM THUẦN trên một bộ SỰ THẬT mà lớp đọc máy chủ (`loadFirstValue`, go-live.ts) gom từ đúng các hàm đang có: kênh đã nối =
 * `channelFactsOf` (MỘT định nghĩa với hộp thư và mốc onboarding), sức khoẻ Page = `channelHealth` của màn Kênh kết nối, AI sẵn
 * sàng = `loadChatbotAiView`, tồn khả dụng = công thức sổ kho. Không định nghĩa thứ hai cho câu hỏi nào trong số đó.
 *
 * Câu chữ là câu KHÁCH đọc: không thuật ngữ kỹ thuật (tests/onboarding-v2.test.ts quét mọi câu sinh ra).
 */

export const FIRST_VALUE_STEPS = ["CHANNEL", "PAGE", "PRODUCTS", "PRICE_STOCK_POLICY", "AI_CONFIG", "TEST_MESSAGE", "TEST_REPLY", "TEST_ORDER", "GO_LIVE"] as const;
export type FirstValueStepKey = (typeof FIRST_VALUE_STEPS)[number];
export type FirstValueStatus = "DONE" | "NEEDS_ACTION" | "ERROR";

export const FIRST_VALUE_STATUS_LABEL: Record<FirstValueStatus, string> = { DONE: "Xong", NEEDS_ACTION: "Cần làm", ERROR: "Cần sửa" };

export const FIRST_VALUE_STEP_LABEL: Record<FirstValueStepKey, string> = {
  CHANNEL: "Kết nối Facebook",
  PAGE: "Chọn Page",
  PRODUCTS: "Thêm sản phẩm",
  PRICE_STOCK_POLICY: "Giá, tồn kho và chính sách",
  AI_CONFIG: "Cấu hình AI",
  TEST_MESSAGE: "Nhắn thử một tin",
  TEST_REPLY: "AI trả lời thử",
  TEST_ORDER: "Thử tạo đơn",
  GO_LIVE: "Bật chạy thật",
};

/** Màn hình của từng việc — đều là trang vỏ mở được (`SALES_AGENT_ALLOWED_PREFIXES`); neo `#…` đặt sẵn trên trang AI Sales. */
export const FIRST_VALUE_HREF = {
  connections: "/settings/connections",
  channels: "/ai/channels",
  products: "/products",
  productImport: "/products/import",
  stock: "/inventory/receipts",
  botConfig: "/ai/sales-chatbot#bot-config",
  testFrame: "/ai/sales-chatbot#khung-thu",
  plan: "/settings/plan",
  publish: "/setup",
} as const;

export type FirstValueStep = {
  key: FirstValueStepKey;
  label: string;
  status: FirstValueStatus;
  detail: string;
  /** Màn hình sửa / làm bước này; `null` = người xem không có quyền làm (câu `detail` nói ai làm). */
  href: string | null;
  cta: string;
  /** Mốc chứng cứ SỚM NHẤT (ISO) khi dữ liệu có sẵn mốc — dùng đo «thời gian tới giá trị đầu tiên»; `null` = không có mốc. */
  at: string | null;
};

export type FirstValueFacts = {
  /** Kênh đang nối — `channelFactsOf`. */
  channels: ChannelFacts;
  /** Đã thử nối mà hỏng (kết nối qua Pancake / Zalo OA kiểm tra không đạt) — câu khách; `null` = không có lần hỏng nào. */
  channelProblem: string | null;
  /** Nút nối thẳng Facebook đang mở cho người xem (`directConnectFor`); đóng ⇒ lối chính là Fanpage qua Pancake. */
  directConnect: boolean;
  /** Page đang nhận tin: số Page dùng được · lý do của Page mất kết nối (câu khách) · số Page đang tắt AI. */
  pages: { ready: number; problem: string | null; aiOff: number };
  /** Số sản phẩm; `null` = không đếm được (chức năng sản phẩm tắt) ⇒ chưa kiểm được. */
  products: number | null;
  canImportProducts: boolean;
  pricedVariants: number;
  /** Mẫu mã có giá ĐÃ có phiếu nhập (tồn biết được) · trong đó còn hàng bán được (tồn khả dụng > 0). */
  stockKnownVariants: number;
  sellableVariants: number;
  sellWithoutStockCheck: boolean;
  /** Đã khai phí ship / miễn phí ship / câu chính sách cho bot. */
  policySet: boolean;
  aiReady: boolean;
  /** Câu khách khi AI chưa dùng được; `aiFix = PLAN` khi lý do là hết lượt của gói. */
  aiProblem: string | null;
  aiFix: "PLAN" | "CONFIG";
  /** Cấu hình bot đã được LƯU ít nhất một lần (có dòng cài đặt) — không phải mặc định của máy. */
  configSaved: boolean;
  botName: string;
  testMessages: number;
  testReplies: number;
  testOrders: number;
  /** Đơn thật đã tạo trong ứng dụng (tạo tay, hoặc bot lên đơn trên kênh thật). */
  realOrders: number;
  botEnabled: boolean;
  /** `null` = cửa hàng không có bước xuất bản; `false` = còn bản nháp. */
  published: boolean | null;
  canConnect: boolean;
  canBot: boolean;
  canPublish: boolean;
  firstAt: { testMessage: string | null; testReply: string | null; testOrder: string | null };
};

const vi = (n: number) => n.toLocaleString("vi-VN");
const OWNER_ONLY = "Cần chủ cửa hàng làm bước này.";

function channelList(c: ChannelFacts): string {
  return [c.pancake ? "Fanpage qua Pancake" : null, c.messenger ? "Facebook" : null, c.zalo ? "Zalo OA" : null, c.webChat ? "ô chat trên website" : null].filter(Boolean).join(" · ");
}

/** Chín bước theo thứ tự cố định. HÀM THUẦN. */
export function firstValueSteps(f: FirstValueFacts): FirstValueStep[] {
  const connected = anyChannelConnected(f.channels);
  const step = (key: FirstValueStepKey, status: FirstValueStatus, detail: string, href: string | null, cta: string, at: string | null = null): FirstValueStep => ({
    key,
    label: FIRST_VALUE_STEP_LABEL[key],
    status,
    detail,
    href,
    cta: status === "DONE" ? "Xem lại" : status === "ERROR" ? "Sửa ngay" : cta,
    at,
  });
  const gate = (ok: boolean, href: string) => (ok ? href : null);
  const steps: FirstValueStep[] = [];

  // 1. Kênh — Fanpage qua Pancake là lối đang chạy; nối thẳng Facebook chỉ khi cổng mở. Zalo OA / ô chat web cũng tính.
  const connectHref = f.directConnect ? FIRST_VALUE_HREF.channels : FIRST_VALUE_HREF.connections;
  if (connected) steps.push(step("CHANNEL", "DONE", `Đã nối: ${channelList(f.channels)}.`, FIRST_VALUE_HREF.channels, "Xem lại"));
  else if (f.channelProblem) steps.push(step("CHANNEL", "ERROR", f.canConnect ? f.channelProblem : `${f.channelProblem} ${OWNER_ONLY}`, gate(f.canConnect, connectHref), "Sửa ngay"));
  else
    steps.push(
      step(
        "CHANNEL",
        "NEEDS_ACTION",
        !f.canConnect
          ? OWNER_ONLY
          : f.directConnect
            ? "Bấm «Kết nối Facebook», đăng nhập rồi chọn Page của shop. Có Pancake thì nối Fanpage qua Pancake cũng được."
            : "Nối Fanpage qua Pancake: dán mã Page và mã kết nối lấy trong Pancake, bấm Kiểm tra rồi Bật. Nối thẳng Facebook sắp mở.",
        gate(f.canConnect, connectHref),
        "Làm bước này",
      ),
    );

  // 2. Page — có ít nhất một Page đang nhận tin, không mất kết nối, AI không bị tắt riêng.
  const pageChannel = f.channels.pancake || f.channels.messenger || f.channels.zalo;
  const channelsHref = gate(f.canConnect, FIRST_VALUE_HREF.channels);
  if (!connected) steps.push(step("PAGE", "NEEDS_ACTION", "Làm sau bước «Kết nối Facebook».", channelsHref, "Làm bước này"));
  else if (!pageChannel) steps.push(step("PAGE", "DONE", "Bạn dùng ô chat trên website — không cần chọn Page.", FIRST_VALUE_HREF.channels, "Xem lại"));
  else if (f.pages.ready > 0) steps.push(step("PAGE", "DONE", `${vi(f.pages.ready)} Page / tài khoản đang nhận tin cho bot.`, FIRST_VALUE_HREF.channels, "Xem lại"));
  else if (f.pages.problem) steps.push(step("PAGE", "ERROR", f.pages.problem, channelsHref, "Sửa ngay"));
  else if (f.pages.aiOff > 0) steps.push(step("PAGE", "NEEDS_ACTION", "Page đã nối nhưng đang tắt AI — bật AI cho Page ở mục Kênh kết nối.", channelsHref, "Làm bước này"));
  else steps.push(step("PAGE", "NEEDS_ACTION", "Chưa kiểm được Page nào đang nhận tin — mở Kênh kết nối để chọn Page.", channelsHref, "Làm bước này"));

  // 3. Sản phẩm.
  if (f.products === null) steps.push(step("PRODUCTS", "NEEDS_ACTION", "Chưa kiểm được danh sách sản phẩm.", FIRST_VALUE_HREF.products, "Mở sản phẩm"));
  else if (f.products > 0) steps.push(step("PRODUCTS", "DONE", `${vi(f.products)} sản phẩm.`, FIRST_VALUE_HREF.products, "Xem lại"));
  else
    steps.push(
      step(
        "PRODUCTS",
        "NEEDS_ACTION",
        f.canImportProducts ? "Chưa có sản phẩm nào — thêm từng món hoặc nhập cả danh sách từ tệp Excel." : "Chưa có sản phẩm nào.",
        f.canImportProducts ? FIRST_VALUE_HREF.productImport : FIRST_VALUE_HREF.products,
        f.canImportProducts ? "Nhập sản phẩm" : "Mở sản phẩm",
      ),
    );

  // 4. Giá + tồn + chính sách — bot chỉ báo giá đọc từ đây, chỉ hứa còn hàng khi tồn khả dụng > 0, chỉ nói phí ship đã khai.
  if (!f.products) steps.push(step("PRICE_STOCK_POLICY", "NEEDS_ACTION", "Làm sau bước «Thêm sản phẩm».", FIRST_VALUE_HREF.products, "Làm bước này"));
  else {
    const noPrice = f.pricedVariants === 0;
    const soldOut = !f.sellWithoutStockCheck && f.stockKnownVariants > 0 && f.sellableVariants === 0;
    const noStock = !f.sellWithoutStockCheck && f.sellableVariants === 0 && !soldOut;
    const missing = [noPrice ? "giá bán" : null, noStock ? "số tồn (lập phiếu nhập hàng)" : null, f.policySet ? null : "phí ship / chính sách cho bot"].filter((x): x is string => x !== null);
    const fixHref = noPrice ? FIRST_VALUE_HREF.products : noStock || soldOut ? FIRST_VALUE_HREF.stock : gate(f.canBot, FIRST_VALUE_HREF.botConfig);
    if (soldOut && !noPrice) steps.push(step("PRICE_STOCK_POLICY", "ERROR", `Mọi mẫu mã có giá đều đã hết hàng — bot sẽ báo hết hàng với khách. Lập phiếu nhập hàng.${missing.length ? ` Còn thiếu: ${missing.join(", ")}.` : ""}`, FIRST_VALUE_HREF.stock, "Sửa ngay"));
    else if (missing.length) steps.push(step("PRICE_STOCK_POLICY", "NEEDS_ACTION", `Còn thiếu: ${missing.join(", ")}.${fixHref ? "" : ` ${OWNER_ONLY}`}`, fixHref, "Làm bước này"));
    else steps.push(step("PRICE_STOCK_POLICY", "DONE", `${vi(f.pricedVariants)} mẫu mã có giá · ${f.sellWithoutStockCheck ? "shop chọn bán không kiểm tồn" : `${vi(f.sellableVariants)} mẫu mã còn hàng`} · đã khai phí ship / chính sách.`, FIRST_VALUE_HREF.botConfig, "Xem lại"));
  }

  // 5. AI — dùng được (lý do thật khi không) + cấu hình bot đã lưu.
  const aiHref = f.aiFix === "PLAN" ? gate(f.canConnect, FIRST_VALUE_HREF.plan) : gate(f.canBot, FIRST_VALUE_HREF.botConfig);
  if (!f.aiReady) steps.push(step("AI_CONFIG", "ERROR", f.aiProblem ?? "AI chưa dùng được.", aiHref, "Sửa ngay"));
  else if (!f.configSaved) steps.push(step("AI_CONFIG", "NEEDS_ACTION", f.canBot ? "Đặt tên bot, lời chào, giọng điệu rồi bấm «Lưu»." : OWNER_ONLY, gate(f.canBot, FIRST_VALUE_HREF.botConfig), "Làm bước này"));
  else steps.push(step("AI_CONFIG", "DONE", `AI sẵn sàng · bot «${f.botName}».`, FIRST_VALUE_HREF.botConfig, "Xem lại"));

  // 6–8. Khung thử — chỉ người cấu hình bot mở được khung thử.
  const testHref = gate(f.canBot, FIRST_VALUE_HREF.testFrame);
  if (f.testMessages > 0) steps.push(step("TEST_MESSAGE", "DONE", `Đã nhắn thử ${vi(f.testMessages)} tin trong Khung thử.`, testHref, "Xem lại", f.firstAt.testMessage));
  else steps.push(step("TEST_MESSAGE", "NEEDS_ACTION", f.canBot ? "Mở Khung thử, gõ một câu khách hay hỏi (vd «Còn hàng không shop?»)." : OWNER_ONLY, testHref, "Làm bước này"));

  if (f.testReplies > 0) steps.push(step("TEST_REPLY", "DONE", `AI đã trả lời ${vi(f.testReplies)} lượt trong Khung thử.`, testHref, "Xem lại", f.firstAt.testReply));
  else if (f.testMessages > 0 && !f.aiReady) steps.push(step("TEST_REPLY", "ERROR", `AI chưa trả lời được: ${f.aiProblem ?? "AI chưa dùng được."}`, aiHref, "Sửa ngay"));
  else if (f.testMessages > 0) steps.push(step("TEST_REPLY", "NEEDS_ACTION", "Đã nhắn thử nhưng AI chưa trả lời — nhắn lại một câu hỏi về sản phẩm.", testHref, "Làm bước này"));
  else steps.push(step("TEST_REPLY", "NEEDS_ACTION", "Làm sau bước «Nhắn thử một tin».", testHref, "Làm bước này"));

  if (f.testOrders > 0 || f.realOrders > 0) steps.push(step("TEST_ORDER", "DONE", f.testOrders > 0 ? `AI đã lên ${vi(f.testOrders)} đơn thử.` : `Đã có ${vi(f.realOrders)} đơn tạo trong ứng dụng.`, testHref, "Xem lại", f.firstAt.testOrder));
  else steps.push(step("TEST_ORDER", "NEEDS_ACTION", f.canBot ? "Trong Khung thử, đặt thử một đơn (món, số lượng, tên, SĐT, địa chỉ) tới khi AI lên đơn nháp." : OWNER_ONLY, testHref, "Làm bước này"));

  // 9. Chạy thật — bot bật + có kênh + đã xuất bản (khi cửa hàng có bước xuất bản).
  if (f.botEnabled && connected && f.published !== false) steps.push(step("GO_LIVE", "DONE", "Bot đang trả lời khách thật.", FIRST_VALUE_HREF.botConfig, "Xem lại"));
  else if (!f.botEnabled) steps.push(step("GO_LIVE", "NEEDS_ACTION", f.canBot ? "Bấm «Lưu và bật bot» ở phần Cấu hình bot." : OWNER_ONLY, gate(f.canBot, FIRST_VALUE_HREF.botConfig), "Làm bước này"));
  else if (!connected) steps.push(step("GO_LIVE", "NEEDS_ACTION", "Bot đã bật nhưng chưa có kênh nào — làm bước «Kết nối Facebook».", gate(f.canConnect, connectHref), "Làm bước này"));
  else steps.push(step("GO_LIVE", "NEEDS_ACTION", f.canPublish ? "Cửa hàng còn là bản nháp — bấm «Xuất bản»." : OWNER_ONLY, gate(f.canPublish, FIRST_VALUE_HREF.publish), "Làm bước này"));
  return steps;
}

export type FirstValueSummary = {
  done: number;
  total: number;
  allDone: boolean;
  /** Bước CHƯA xong đầu tiên mà người xem làm được (có `href`) — đích DUY NHẤT của nút «Tiếp tục thiết lập». */
  next: FirstValueStep | null;
};

/** Tiến độ + đích của nút chính. HÀM THUẦN. */
export function firstValueSummary(steps: readonly FirstValueStep[]): FirstValueSummary {
  const done = steps.filter((s) => s.status === "DONE").length;
  return { done, total: steps.length, allDone: steps.length > 0 && done === steps.length, next: steps.find((s) => s.status !== "DONE" && s.href !== null) ?? null };
}
