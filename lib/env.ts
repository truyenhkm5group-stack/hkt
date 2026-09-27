import { peekExplicitNonHomeCode } from "@/lib/platform/peek";

function read(name: string, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readInt(name: string, fallback: number) {
  const value = Number(read(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const env = {
  get appUrl() {
    return read("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  /**
   * Khoá ký phiên đăng nhập.
   *
   * Giá trị dự phòng chỉ dùng cho máy của người viết code. Trên PRODUCTION mà thiếu biến này thì
   * mọi phiên đăng nhập được ký bằng một chuỗi NẰM CÔNG KHAI TRONG KHO MÃ — ai đọc kho cũng tự ký
   * được một cookie quản trị. Thà app không khởi động còn hơn khởi động với cửa mở: hỏng thì thấy
   * ngay, còn cửa mở thì không ai thấy.
   */
  get authSecret() {
    const value = read("AUTH_SECRET");
    if (value) return value;
    if (process.env.NODE_ENV === "production") {
      throw new Error("Thiếu AUTH_SECRET trên production — phiên đăng nhập sẽ được ký bằng khoá công khai trong kho mã. Đặt biến này trong .env của máy chủ.");
    }
    return "dev-secret-change-me-please-32-chars-min";
  },
  get cronSecret() {
    return read("CRON_SECRET");
  },
  /**
   * KHOÁ RIÊNG CHO CỬA CHÉP SỔ LƯỢT CHẠY AGENT (`POST /api/tech/agent-run`).
   *
   * TÁCH KHỎI `CRON_SECRET` có chủ ý. `CRON_SECRET` là khoá của bộ lập lịch: nó mở được hàng chục
   * job đồng bộ, trong đó có những job GHI hàng loạt. Dùng lại đúng khoá ấy cho một cửa hướng ra
   * Internet nghĩa là bán kính thiệt hại của một lượt rò rỉ ở máy GitHub Actions bằng cả bộ lập
   * lịch — trong khi thứ máy đó thật sự cần chỉ là ghi thêm dòng vào MỘT bảng quan sát.
   *
   * Rỗng = cửa ĐÓNG (`secretEquals` trả false khi thiếu một trong hai vế). Chưa khai thì
   * `/tech/agents` tiếp tục nói "0 lượt chạy" — một câu ĐÚNG, không phải một lỗi.
   */
  get agentIngestSecret() {
    return read("AGENT_INGEST_SECRET");
  },
  pancake: {
    get apiKey() {
      return read("PANCAKE_API_KEY");
    },
    get shopId() {
      return read("PANCAKE_SHOP_ID");
    },
    get baseUrl() {
      return read("PANCAKE_BASE_URL", "https://pos.pages.fm/api/v1").replace(/\/$/, "");
    },
    get webhookSecret() {
      return read("PANCAKE_WEBHOOK_SECRET");
    },
    get backfillDays() {
      return readInt("PANCAKE_BACKFILL_DAYS", 365);
    },
    /** Access token người dùng Pancake (pancake.vn → Cài đặt → Công cụ / API) để đọc hội thoại & thẻ chat */
    get pagesAccessToken() {
      return read("PANCAKE_ACCESS_TOKEN");
    },
    get pagesBaseUrl() {
      return read("PANCAKE_PAGES_BASE_URL", "https://pages.fm/api/v1").replace(/\/$/, "");
    },
  },
  facebook: {
    get accessToken() {
      return read("FACEBOOK_ACCESS_TOKEN");
    },
    /**
     * ID Business Manager chứa các tài khoản quảng cáo.
     *
     * Giá trị mặc định là BM CỦA VNX (audit ISO-23) — GIỮ NGUYÊN vì bỏ đi là đổi hành vi của tổ chức
     * nhà. An toàn đa tổ chức không dựa vào getter này: mọi lời gọi Graph đi qua
     * `assertHomeCredentials("facebook")` (lib/platform/credentials.ts), nên tổ chức khác không bao
     * giờ tới được chỗ dùng nó. Khi credential theo tổ chức ra đời (Phase 1.x), mặc định này phải
     * bỏ: thiếu BM id là "chưa cấu hình", không phải "dùng BM của VNX".
     */
    get businessId() {
      return read("FACEBOOK_BUSINESS_ID", "336423739082347");
    },
    get apiVersion() {
      return read("FACEBOOK_API_VERSION", "v21.0");
    },
    /** Tỷ giá quy đổi khi tài khoản quảng cáo tính bằng USD */
    get usdToVnd() {
      return readInt("FACEBOOK_USD_VND", 25_500);
    },
  },
  /**
   * ───────────── CHỐT NGOÀI CÙNG CỦA ĐƯỜNG GHI QUẢNG CÁO ─────────────
   *
   * Đọc THẲNG từ biến môi trường và **cố ý không hợp nhất với bảng `settings`** — ghi khoá này vào
   * CSDL là ghi vào hư không. Nó đứng TRƯỚC nấc quyền hạn, trước phiếu duyệt, trước mọi thứ.
   *
   * Chỉ đúng chuỗi `"true"` mở được: `1`, `yes`, `on` đều là CẤM, và không khai gì cũng là CẤM.
   * Một cái cổng nhận nhiều cách viết "bật" là một cái cổng sẽ bật nhầm.
   *
   * Đây là câu trả lời cho *"có tổ hợp cấu hình nào lỡ đổi ngân sách thật không"*: không, trừ khi
   * có người đặt đúng chuỗi ấy vào `.env` trên máy chủ rồi khởi động lại.
   */
  adsWrite: {
    get enabled() {
      return process.env.ADS_WRITE_ENABLED === "true";
    },
    /** `OFF` (mặc định) · `COPILOT`. `AUTO` khai ở đây cũng bị kẹp xuống — xem `MAX_ALLOWED_ADS_WRITE_MODE`. */
    get mode() {
      return read("ADS_WRITE_MODE", "OFF");
    },
  },
  /** AI Copilot. Khoá API đọc bởi chính SDK (OPENAI_API_KEY / ANTHROPIC_API_KEY) — không đi qua đây, không log. */
  ai: {
    /** `auto` (mặc định) · `openai` · `anthropic` · `off`. Chọn model ở `lib/ai/router.ts`. */
    get provider() {
      return read("AI_PROVIDER", "auto");
    },
    /** Ghi đè model bậc copilot của provider đang dùng. Trống = theo bảng trong router. */
    get model() {
      return read("AI_MODEL");
    },
    /** Trống = theo bậc (routine low · copilot medium · analysis high). */
    get effort() {
      return read("AI_EFFORT");
    },
    get maxToolRounds() {
      return readInt("AI_MAX_TOOL_ROUNDS", 6);
    },
    get openaiConfigured() {
      return Boolean(read("OPENAI_API_KEY"));
    },
    get anthropicConfigured() {
      return Boolean(read("ANTHROPIC_API_KEY") || read("ANTHROPIC_AUTH_TOKEN"));
    },
    get configured() {
      return this.openaiConfigured || this.anthropicConfigured;
    },
  },
  /**
   * Lời gọi REST THẲNG tới OpenAI của vòng mẫu quảng cáo: sinh ảnh (`/v1/images/edits`, multipart)
   * và đọc ảnh (`/v1/responses` kèm `input_image`) — hai hình dạng mà lớp `AiProvider` không che.
   * Cùng khoá `OPENAI_API_KEY` với SDK. Chỉ đi vào tiêu đề `Authorization`: không log, không ghi
   * vào sổ, không đưa vào câu lỗi.
   */
  openaiRest: {
    get apiKey() {
      return read("OPENAI_API_KEY");
    },
  },
  /**
   * Gemini API — CHỈ cho máy sinh video Veo của Video Scale (`lib/video-scale/providers/veo.ts`). Khoá đi vào tiêu đề
   * `x-goog-api-key`, không log, không ghi sổ, không vào câu lỗi. KHÁC khoá của bot chat (bot đọc `/data/bot.env`
   * riêng trong container của nó — ERP không đọc được và không được đọc khoá ấy).
   */
  gemini: {
    get apiKey() {
      return read("GEMINI_API_KEY");
    },
  },
  /** Video Scale — công cụ hậu kỳ và bộ sinh giả (chỉ ngoài production). */
  videoScale: {
    /** Đường dẫn `ffmpeg` / `ffprobe` — mặc định tìm trên PATH (image Docker cài bằng `apk add ffmpeg`). */
    get ffmpegPath() {
      return read("FFMPEG_PATH", "ffmpeg");
    },
    get ffprobePath() {
      return read("FFPROBE_PATH", "ffprobe");
    },
    /** Phông có đủ dấu tiếng Việt cho chữ trên hình. Image Docker: `font-dejavu`. */
    get fontFile() {
      return read("VIDEO_FONT_FILE", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf");
    },
    /** `1` ⇒ cho phép bộ sinh GIẢ — chỉ có hiệu lực khi `NODE_ENV !== 'production'` (`fakeProviderAllowed`). */
    get fakeProviderFlag() {
      return read("VIDEO_PROVIDER_FAKE");
    },
  },
  /**
   * SePay — cổng Open Banking đẩy biến động số dư realtime về ERP.
   *
   * HMAC là đường chính (`SEPAY_WEBHOOK_SECRET`). API key chỉ là đường lùi cho lúc dựng thử: nó
   * chứng minh nguồn gửi nhưng KHÔNG phát hiện nội dung bị sửa, nên khi đã khai secret HMAC thì
   * route từ chối hạ cấp xuống API key.
   */
  sepay: {
    get webhookSecret() {
      return read("SEPAY_WEBHOOK_SECRET");
    },
    get webhookApiKey() {
      return read("SEPAY_WEBHOOK_API_KEY");
    },
    /**
     * Token API v2 (my.sepay.vn → Cài đặt công ty → API Access).
     *
     * KHÁC secret webhook: secret dùng để XÁC MINH gói tin SePay đẩy sang, token này dùng để ERP
     * CHỦ ĐỘNG hỏi lại SePay. Thiếu token thì đường đối chiếu nằm im, đường realtime vẫn chạy.
     */
    get apiToken() {
      return read("SEPAY_API_TOKEN");
    },
    get apiBaseUrl() {
      return read("SEPAY_API_BASE_URL", "https://userapi.sepay.vn/v2").replace(/\/$/, "");
    },
  },
  viettelPost: {
    get apiKey() {
      return read("VIETTELPOST_API_KEY");
    },
    get username() {
      return read("VIETTELPOST_USERNAME");
    },
    get password() {
      return read("VIETTELPOST_PASSWORD");
    },
    get baseUrl() {
      return read("VIETTELPOST_BASE_URL", "https://partner.viettelpost.vn/v2").replace(/\/$/, "");
    },
    get webhookSecret() {
      return read("VIETTELPOST_WEBHOOK_SECRET");
    },
  },
};

/**
 * CREDENTIAL CỦA TỔ CHỨC NHÀ trong biến môi trường (hợp đồng mục 9 · integration-inventory §2.4).
 *
 * Chỉ để đọc và để máy quét biết nhóm nào là "khoá của khách" — không có mã nào rẽ nhánh theo danh
 * sách này. Chặn thật nằm ở lối gọi mạng: `assertHomeCredentials()` (lib/platform/credentials.ts)
 * và `loadAlertConfig()` (lib/alerts/config.ts — fallback Lark/Telegram chỉ cho tổ chức nhà).
 */
export const CUSTOMER_CREDENTIAL_ENV = [
  "PANCAKE_API_KEY",
  "PANCAKE_SHOP_ID",
  "PANCAKE_WEBHOOK_SECRET",
  "PANCAKE_ACCESS_TOKEN",
  "FACEBOOK_ACCESS_TOKEN",
  "FACEBOOK_BUSINESS_ID",
  "SEPAY_WEBHOOK_SECRET",
  "SEPAY_WEBHOOK_API_KEY",
  "SEPAY_API_TOKEN",
  "VIETTELPOST_API_KEY",
  "VIETTELPOST_USERNAME",
  "VIETTELPOST_PASSWORD",
  "VIETTELPOST_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "LARK_WEBHOOK_URL",
  "LARK_WEBHOOK_SECRET",
  "LARK_BILLING_WEBHOOK_URL",
  "LARK_BILLING_WEBHOOK_SECRET",
  "LARK_INVENTORY_WEBHOOK_URL",
  "LARK_INVENTORY_WEBHOOK_SECRET",
  "LARK_MANAGER_WEBHOOK_URL",
  "LARK_MANAGER_WEBHOOK_SECRET",
  "CHATBOT_ADMIN_TOKEN",
] as const;

/**
 * Kết nối nào đã có credential. Ngữ cảnh TƯỜNG MINH của tổ chức khác nhà (job, việc nền của họ) ⇒
 * mọi ô `false`: credential môi trường là của tổ chức nhà (P12), màn hình và job của tổ chức khác
 * không được tưởng là có kết nối. Request mang phiên tổ chức khác không có ngữ cảnh tường minh —
 * lối gọi mạng vẫn chặn bằng `assertHomeCredentials`.
 */
export function integrationStatus() {
  if (peekExplicitNonHomeCode() !== null) {
    return { pancake: false, pancakePages: false, viettelPost: false, facebook: false, pancakeWebhook: false, viettelPostWebhook: false, sepayWebhook: false, sepayWebhookSigned: false, sepayApi: false };
  }
  return {
    pancake: Boolean(env.pancake.apiKey && env.pancake.shopId),
    pancakePages: Boolean(env.pancake.pagesAccessToken),
    viettelPost: Boolean(env.viettelPost.apiKey || (env.viettelPost.username && env.viettelPost.password)),
    facebook: Boolean(env.facebook.accessToken),
    pancakeWebhook: Boolean(env.pancake.webhookSecret),
    viettelPostWebhook: Boolean(env.viettelPost.webhookSecret),
    sepayWebhook: Boolean(env.sepay.webhookSecret || env.sepay.webhookApiKey),
    sepayWebhookSigned: Boolean(env.sepay.webhookSecret),
    sepayApi: Boolean(env.sepay.apiToken),
  };
}
