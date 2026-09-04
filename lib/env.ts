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
  get authSecret() {
    return read("AUTH_SECRET", "dev-secret-change-me-please-32-chars-min");
  },
  get cronSecret() {
    return read("CRON_SECRET");
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
      return read("PANCAKE_PAGES_BASE_URL", "https://pages.fm/api/public_api/v1").replace(/\/$/, "");
    },
  },
  facebook: {
    get accessToken() {
      return read("FACEBOOK_ACCESS_TOKEN");
    },
    /** ID Business Manager chứa các tài khoản quảng cáo */
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

export function integrationStatus() {
  return {
    pancake: Boolean(env.pancake.apiKey && env.pancake.shopId),
    pancakePages: Boolean(env.pancake.pagesAccessToken),
    viettelPost: Boolean(env.viettelPost.apiKey || (env.viettelPost.username && env.viettelPost.password)),
    facebook: Boolean(env.facebook.accessToken),
    pancakeWebhook: Boolean(env.pancake.webhookSecret),
    viettelPostWebhook: Boolean(env.viettelPost.webhookSecret),
  };
}
