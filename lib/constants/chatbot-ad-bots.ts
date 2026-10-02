import { z } from "zod";

/**
 * ═══════════ BOT CHAT RIÊNG CHO TỪNG CAMP TEST — THEO ID QUẢNG CÁO ═══════════
 *
 * Mỗi mẫu test (Thư viện Media · tab ④ Đang chạy) là một quảng cáo "INBOX NGAY" mang `fb_ad_id`. Khách bấm
 * quảng cáo ⇒ hội thoại Pancake mang đúng ID đó ⇒ bot chat (container `erp-chatbot`) dùng BOT RIÊNG của camp:
 * mặc định khách đang hỏi ĐÚNG mẫu đang test, cộng hướng dẫn riêng chủ shop viết cho camp ấy.
 *
 * Ba luật:
 *  1. ERP là NGUỒN DUY NHẤT của danh sách: mẫu nào gắn với quảng cáo nào đọc từ bảng quảng cáo test
 *     (`creative_variants` · `creative_scale_drafts` · `video_scale_ads`), không gõ lại. Người chỉ thêm LỚP
 *     GHI ĐÈ (bật/tắt · đổi mã mẫu · hướng dẫn riêng) — lưu ở `settings` khoá `CHATBOT_AD_BOTS_KEY`.
 *  2. Bot riêng chỉ ĐỊNH HƯỚNG mẫu. Giá vẫn chỉ từ bảng giá / danh mục POS của bot; nội dung quảng cáo đưa
 *     sang bị che số tiền ở phía bot (`chatbot/src/adpersona.js::maskMoney`).
 *  3. Quảng cáo KHÔNG gắn mã và chưa ai viết hướng dẫn ⇒ KHÔNG có bot riêng (`NO_PRODUCT`), in ra màn hình
 *     để người gắn — không đoán mẫu theo tên chiến dịch.
 */

export const CHATBOT_AD_BOTS_KEY = "chatbot.ad-bots";

/** Quảng cáo test đã dừng vẫn còn khách nhắn tới (bấm từ trước) — giữ bot riêng thêm chừng ấy ngày. */
export const AD_BOT_WINDOW_DAYS = 45;

export const AD_ID_PATTERN = /^\d{6,25}$/;
export const PRODUCT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const AD_BOT_INSTRUCTIONS_MAX = 4000;

export const AD_BOT_SOURCES = ["CREATIVE_TEST", "CREATIVE_SCALE", "VIDEO_SCALE", "MANUAL"] as const;
export type AdBotSource = (typeof AD_BOT_SOURCES)[number];
export const AD_BOT_SOURCE_LABEL: Record<AdBotSource, string> = {
  CREATIVE_TEST: "Camp test (Thư viện Media)",
  CREATIVE_SCALE: "Camp scale mẫu thắng",
  VIDEO_SCALE: "Quảng cáo video",
  MANUAL: "Quảng cáo dựng tay trên Facebook",
};

/**
 * ═══ MẪU TEST MỚI (chưa có trên POS) — nút "Chat test" ở Thư viện Media · tab ④ ═══
 * Người chọn màu ⇒ AI đổi màu ảnh quảng cáo của camp (mỗi màu một ảnh), người nhập giá + chất vải ⇒ chat thử trong ERP ⇒
 * bấm "Bật" mới chạy cho khách thật. Chưa lên đơn POS (chủ shop 01/10/2026: chỉ khi mẫu thắng).
 */
export type AdTestColor = {
  color: string;
  imageId: string;
  sha: string;
  /** `ORIGINAL` = chính ảnh quảng cáo (màu gốc) · `AI` = ảnh AI đổi màu · `UPLOAD` = người tải ảnh lên. */
  source: "ORIGINAL" | "AI" | "UPLOAD";
  createdAt: string;
};

export type AdTestProduct = {
  name: string;
  code: string;
  /** VND nguyên. `null` = CHƯA NHẬP (không phải 0đ) — thiếu giá thì không bật được, không chat thử được. */
  price: number | null;
  shipFee: number | null;
  comboPrice: number | null;
  fabric: string;
  sizes: string;
  offer: string;
  colors: AdTestColor[];
};

/** Một lần AI vẽ ảnh đổi màu — sổ để tính trần tiền / ngày (ước tính khi OpenAI không trả `usage`). */
export type AdTestImageSpend = { adId: string; at: string; usd: number; estimated: boolean };

/** Trần chi ảnh chat test. Mặc định an toàn chủ shop chưa chốt (01/10/2026) — đổi ở đây, không rải số khác. */
export const AD_TEST_IMAGE_LIMITS = { maxColorsPerAd: 10, maxUsdPerDay: 2 } as const;

export type AdBotOverride = {
  enabled?: boolean;
  test?: AdTestProduct;
  /** Fanpage người chọn khi máy không đọc được từ bài viết của quảng cáo. */
  pageId?: string;
  /** Mã mẫu ghi đè (vd quảng cáo test "không gắn mã"). Rỗng = theo mẫu gắn trên quảng cáo. */
  productCode?: string;
  instructions?: string;
  updatedByUserId: string | null;
  updatedByName: string;
  updatedAt: string;
};

/** Quảng cáo DỰNG TAY trên Facebook (không có trong bảng nào của ERP) — người khai ID + fanpage để có bot riêng. */
export type ManualAd = { pageId: string; label: string; addedByUserId: string | null; addedByName: string; addedAt: string };

export type AdBotConfig = {
  /** Công tắc chung. Tắt ⇒ bot nhận danh sách rỗng, mọi hội thoại chạy như trước. */
  enabled: boolean;
  overrides: Record<string, AdBotOverride>;
  imageSpend?: AdTestImageSpend[];
  manualAds?: Record<string, ManualAd>;
};

const MANUAL_PREFIX = "ad:";
export const manualAdKey = (adId: string) => `${MANUAL_PREFIX}${adId}`;
/** `ad:<ID>` ⇒ ID quảng cáo dựng tay; khoá khác (id mẩu Thư viện Media) ⇒ `null`. */
export function manualAdIdOf(campKey: string): string | null {
  if (!campKey.startsWith(MANUAL_PREFIX)) return null;
  const id = campKey.slice(MANUAL_PREFIX.length);
  return AD_ID_PATTERN.test(id) ? id : null;
}

/** Quảng cáo dựng tay thành dòng nguồn như mọi quảng cáo khác (không mẫu gắn sẵn — mẫu đến từ thông tin mẫu test). */
export function manualAdRows(config: AdBotConfig): AdBotSourceRow[] {
  return Object.entries(config.manualAds ?? {})
    .filter(([adId]) => AD_ID_PATTERN.test(adId))
    .map(([adId, m]) => ({ adId, source: "MANUAL" as const, status: "MANUAL", campaignName: m.label, adName: "", adCopy: "", productId: null, productCode: null, productName: null, publishedAt: new Date(m.addedAt) }));
}

export const addManualAdSchema = z.object({
  adId: z.string().trim().regex(AD_ID_PATTERN, "ID quảng cáo phải toàn chữ số (Trình quản lý quảng cáo → cột ID quảng cáo)"),
  pageId: z.string().trim().regex(/^\d{5,25}$/, "Chọn fanpage chạy quảng cáo"),
  label: z.string().trim().min(1, "Đặt tên gọi cho quảng cáo (vd tên camp trên Facebook)").max(200),
});

export const DEFAULT_AD_BOT_CONFIG: AdBotConfig = { enabled: true, overrides: {}, imageSpend: [] };

/** Thiếu gì thì CHƯA chat thử / CHƯA bật được — trả danh sách câu đọc được, rỗng = đủ. */
export function testProductMissing(t: AdTestProduct | null | undefined): string[] {
  if (!t) return ["Chưa có thông tin mẫu test"];
  const out: string[] = [];
  if (!t.name.trim()) out.push("tên mẫu");
  if (!PRODUCT_CODE_PATTERN.test(t.code.trim())) out.push("mã tạm");
  if (t.price === null) out.push("giá 1 chiếc");
  if (!t.fabric.trim()) out.push("chất vải");
  if (!t.colors.length) out.push("ít nhất một màu có ảnh");
  return out;
}

/** Tổng USD vẽ ảnh chat test trong NGÀY giờ VN chứa `now`. */
export function testImageSpendToday(spend: AdTestImageSpend[] | undefined, now: Date): number {
  const day = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const today = day(now);
  return (spend ?? []).filter((x) => day(new Date(x.at)) === today).reduce((a, x) => a + x.usd, 0);
}

/** Cổng TRƯỚC khi gọi AI vẽ: số màu / camp và tiền / ngày (tính cả lượt sắp vẽ theo giá ước tính). */
export function testImageGate(i: { colors: number; spentTodayUsd: number; estimateUsd: number }): { ok: true } | { ok: false; reason: string } {
  if (i.colors >= AD_TEST_IMAGE_LIMITS.maxColorsPerAd) return { ok: false, reason: `Mỗi camp tối đa ${AD_TEST_IMAGE_LIMITS.maxColorsPerAd} màu.` };
  if (i.spentTodayUsd + i.estimateUsd > AD_TEST_IMAGE_LIMITS.maxUsdPerDay)
    return { ok: false, reason: `Đã chi ${i.spentTodayUsd.toFixed(2)} USD vẽ ảnh chat test hôm nay — thêm ảnh này (~${i.estimateUsd.toFixed(2)} USD) vượt trần ${AD_TEST_IMAGE_LIMITS.maxUsdPerDay} USD/ngày.` };
  return { ok: true };
}

/** Một quảng cáo test đọc từ CSDL (trước khi áp lớp ghi đè). */
export type AdBotSourceRow = {
  adId: string;
  source: AdBotSource;
  status: string;
  campaignName: string;
  adName: string;
  adCopy: string;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  publishedAt: Date | null;
};

/** Đúng hình dạng bot nhận (`PUT /api/erp/ad-bots`, xem `normalizeAdBot` phía bot). */
export type AdBotPush = {
  adId: string;
  /** `false` = mẫu test chưa bật: bot giữ để chat thử, KHÔNG dùng cho khách thật. */
  enabled: boolean;
  productCode: string;
  productName: string;
  campaignName: string;
  adName: string;
  adCopy: string;
  instructions: string;
  source: AdBotSource;
  status: string;
  test?: { name: string; code: string; price: number; shipFee: number | null; comboPrice: number | null; fabric: string; sizes: string; offer: string; colors: { color: string; sha: string }[] };
};

export type AdBotState = "ACTIVE" | "TEST_DRAFT" | "OFF_BY_USER" | "NO_PRODUCT" | "GLOBAL_OFF";
export const AD_BOT_STATE_LABEL: Record<AdBotState, string> = {
  ACTIVE: "Bot riêng đang bật",
  TEST_DRAFT: "Mẫu test — đang chat thử, chưa bật cho khách",
  OFF_BY_USER: "Đã tắt bot riêng",
  NO_PRODUCT: "Chưa gắn mã mẫu — chưa có bot riêng",
  GLOBAL_OFF: "Công tắc chung đang tắt",
};

export type AdBotLine = AdBotSourceRow & {
  state: AdBotState;
  effectiveCode: string;
  override: AdBotOverride | null;
};

/** Mã mẫu như bot đọc được trong danh mục POS: `custom_id`, thiếu thì `display_id` (chatbot/src/pos.js). */
export function productCodeOf(customId: string | null | undefined, displayId: number | string | null | undefined): string | null {
  const c = String(customId ?? "").trim();
  if (c) return c;
  const d = String(displayId ?? "").trim();
  return d || null;
}

/**
 * HÀM THUẦN: nguồn + ghi đè ⇒ danh sách hiển thị và gói đẩy sang bot.
 * Một ad_id xuất hiện ở nhiều nguồn thì giữ dòng đăng GẦN NHẤT.
 */
export function buildAdBots(rows: AdBotSourceRow[], config: AdBotConfig): { lines: AdBotLine[]; push: AdBotPush[] } {
  const byAd = new Map<string, AdBotSourceRow>();
  for (const r of rows) {
    if (!AD_ID_PATTERN.test(r.adId)) continue;
    const cur = byAd.get(r.adId);
    if (!cur || (r.publishedAt?.getTime() ?? 0) > (cur.publishedAt?.getTime() ?? 0)) byAd.set(r.adId, r);
  }
  const lines: AdBotLine[] = [];
  const push: AdBotPush[] = [];
  for (const r of byAd.values()) {
    const o = config.overrides[r.adId] ?? null;
    const test = o?.test && testProductMissing(o.test).length === 0 ? o.test : null;
    const code = (test?.code || o?.productCode?.trim() || r.productCode || "").trim();
    const effectiveCode = PRODUCT_CODE_PATTERN.test(code) ? code.toUpperCase() : "";
    const instructions = (o?.instructions ?? "").trim();
    // Mẫu test đủ thông tin mà chưa bật ⇒ vẫn gửi sang bot ở trạng thái TẮT: bot chỉ dùng cho khung chat thử.
    const state: AdBotState = !config.enabled ? "GLOBAL_OFF" : test && o?.enabled !== true ? "TEST_DRAFT" : o?.enabled === false ? "OFF_BY_USER" : !effectiveCode && !instructions ? "NO_PRODUCT" : "ACTIVE";
    lines.push({ ...r, state, effectiveCode, override: o });
    if (state !== "ACTIVE" && state !== "TEST_DRAFT") continue;
    push.push({
      adId: r.adId,
      enabled: state === "ACTIVE",
      productCode: effectiveCode,
      // Tên mẫu chỉ đi theo mẫu GẮN trên quảng cáo; người đổi mã thì bot tự đọc tên trong danh mục POS.
      productName: effectiveCode && effectiveCode === (r.productCode ?? "").toUpperCase() ? (r.productName ?? "") : "",
      campaignName: r.campaignName,
      adName: r.adName,
      adCopy: r.adCopy.slice(0, 600),
      instructions: instructions.slice(0, AD_BOT_INSTRUCTIONS_MAX),
      source: r.source,
      status: r.status,
      ...(test && test.price !== null
        ? {
            test: {
              name: test.name.trim(),
              code: test.code.trim().toUpperCase(),
              price: test.price,
              shipFee: test.shipFee,
              comboPrice: test.comboPrice,
              fabric: test.fabric.trim(),
              sizes: test.sizes.trim(),
              offer: test.offer.trim(),
              colors: test.colors.map((c) => ({ color: c.color, sha: c.sha })),
            },
          }
        : {}),
    });
  }
  lines.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  return { lines, push };
}

export const saveAdBotSchema = z.object({
  adId: z.string().trim().regex(AD_ID_PATTERN, "ID quảng cáo phải toàn chữ số"),
  enabled: z.boolean(),
  productCode: z
    .string()
    .trim()
    .max(32)
    .refine((v) => v === "" || PRODUCT_CODE_PATTERN.test(v), "Mã mẫu chỉ gồm chữ, số, - và _ (vd Q004)"),
  instructions: z.string().max(AD_BOT_INSTRUCTIONS_MAX, `Hướng dẫn tối đa ${AD_BOT_INSTRUCTIONS_MAX} ký tự`),
});
export type SaveAdBotInput = z.infer<typeof saveAdBotSchema>;

const vndInt = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(String(v).replace(/[.,\s]/g, ""))), z.number().int().min(1000, "Giá phải từ 1.000đ").max(100_000_000).nullable());

export const setAdTestPageSchema = z.object({ campKey: z.string().trim().min(1).max(64), pageId: z.string().trim().regex(/^\d{5,25}$/, "Chọn fanpage") });

export const saveAdTestInfoSchema = z.object({
  campKey: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1, "Nhập tên mẫu").max(120),
  code: z.string().trim().regex(PRODUCT_CODE_PATTERN, "Mã tạm chỉ gồm chữ, số, - và _ (vd TEST-DB01)"),
  price: vndInt,
  shipFee: z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(String(v).replace(/[.,\s]/g, ""))), z.number().int().min(0).max(1_000_000).nullable()),
  comboPrice: vndInt,
  fabric: z.string().trim().max(400),
  sizes: z.string().trim().max(200),
  offer: z.string().trim().max(300),
});
export type SaveAdTestInfoInput = z.infer<typeof saveAdTestInfoSchema>;

export const AD_TEST_COLOR_MAX = 40;

// ───────────── BẢNG KIỂM "PAGE ĐÃ SẴN SÀNG CHO BOT CHƯA" (khung Chat test) ─────────────

export type ReadinessStatus = "OK" | "MISSING" | "WARN" | "UNKNOWN";
export type ReadinessCheck = { key: string; label: string; status: ReadinessStatus; detail: string; fix: string };

export type ReadinessInput = {
  pageId: string | null;
  pageName: string | null;
  /** `null` = ERP không đọc được danh sách page của Pancake (chưa có khoá / lỗi) ⇒ CHƯA BIẾT, không phải "chưa kết nối". */
  pancakePageIds: string[] | null;
  pancakeError: string | null;
  botState: "RUNNING" | "NEEDS_SETUP" | "UNREACHABLE";
  botError: string | null;
  /** Page trong bot (có token). `null` = bot không có page này. */
  botPage: { enabled: boolean; dryRun: boolean; pauseTagId: string | null; minCustomerMessages: number } | null;
  testMissing: string[];
  imagesMissingOnBot: number;
  live: boolean;
  seenCount: number;
};

/**
 * HÀM THUẦN: từng điều kiện để bot chat được với khách của camp, mỗi dòng nói CÁCH BỔ SUNG. Bốn trạng thái, không gộp:
 * CHƯA BIẾT (ERP không kiểm được) khác THIẾU (kiểm được và thiếu) — gộp là đẩy người đi sửa nhầm chỗ.
 */
export function adTestReadiness(i: ReadinessInput): { checks: ReadinessCheck[]; canChat: boolean; canGoLive: boolean } {
  const c: ReadinessCheck[] = [];
  const pageTxt = i.pageId ? `${i.pageName ? `${i.pageName} · ` : ""}ID ${i.pageId}` : "";
  c.push(
    i.pageId
      ? { key: "PAGE", label: "Fanpage chạy quảng cáo", status: "OK", detail: pageTxt, fix: "" }
      : { key: "PAGE", label: "Fanpage chạy quảng cáo", status: "MISSING", detail: "Máy chưa đọc được fanpage của quảng cáo này.", fix: "Chọn fanpage ở ô \"Fanpage của camp\" ngay dưới bảng này." },
  );
  if (!i.pageId) c.push({ key: "PANCAKE", label: "Page đã kết nối Pancake", status: "UNKNOWN", detail: "Chưa biết page nên chưa kiểm được.", fix: "" });
  else if (i.pancakePageIds === null) c.push({ key: "PANCAKE", label: "Page đã kết nối Pancake", status: "UNKNOWN", detail: i.pancakeError ? `ERP không đọc được danh sách page Pancake: ${i.pancakeError}` : "ERP chưa có khoá Pancake để kiểm.", fix: "Tự kiểm trên pancake.vn: page phải nằm trong tài khoản / gói Pancake của shop." });
  else if (i.pancakePageIds.includes(i.pageId)) c.push({ key: "PANCAKE", label: "Page đã kết nối Pancake", status: "OK", detail: "Có trong tài khoản Pancake của shop.", fix: "" });
  else c.push({ key: "PANCAKE", label: "Page đã kết nối Pancake", status: "MISSING", detail: "Page KHÔNG có trong tài khoản Pancake của shop — tin nhắn của khách không tới được bot.", fix: "Vào pancake.vn → thêm fanpage này vào tài khoản / gói Pancake (cần quyền quản trị page trên Facebook)." });

  const botRunning = i.botState === "RUNNING";
  c.push(botRunning ? { key: "BOT", label: "Bot chat đang chạy", status: "OK", detail: "", fix: "" } : { key: "BOT", label: "Bot chat đang chạy", status: "MISSING", detail: i.botError ?? "Bot chưa nạp cấu hình.", fix: "Mở trang Bot chat bán hàng để nạp cấu hình / deploy lại." });

  const hasToken = botRunning && i.botPage !== null;
  c.push(
    !i.pageId || !botRunning
      ? { key: "TOKEN", label: "Bot có token Pancake của page", status: "UNKNOWN", detail: "Chưa kiểm được.", fix: "" }
      : hasToken
        ? { key: "TOKEN", label: "Bot có token Pancake của page", status: "OK", detail: "", fix: "" }
        : { key: "TOKEN", label: "Bot có token Pancake của page", status: "MISSING", detail: "Bot chưa có page này nên không đọc / trả lời được tin.", fix: "Bấm \"Tự lấy token & nạp vào bot\" ngay bên dưới, hoặc dán Page Access Token (Pancake → page → Cài đặt → Công cụ → Page Access Token, dạng eyJ…)." },
  );
  if (hasToken && i.botPage) {
    c.push(i.botPage.enabled ? { key: "ENABLED", label: "Bot đang bật cho page", status: "OK", detail: "", fix: "" } : { key: "ENABLED", label: "Bot đang bật cho page", status: "MISSING", detail: "Bot đang TẮT cho page này (chat thử vẫn chạy).", fix: "Bấm \"Bật bot cho page này\" ngay bên dưới khi muốn bot trả lời khách thật — bot sẽ trả lời MỌI tin nhắn vào page." });
    c.push(!i.botPage.dryRun ? { key: "SEND", label: "Bot được gửi tin thật", status: "OK", detail: "", fix: "" } : { key: "SEND", label: "Bot được gửi tin thật", status: "WARN", detail: "Đang ở chế độ \"chỉ log\": bot soạn trả lời nhưng KHÔNG gửi cho khách (chat thử vẫn chạy).", fix: "Trang Bot chat → tắt \"Chỉ log\" (chung hoặc của page) khi muốn bot trả lời khách thật." });
    c.push(i.botPage.pauseTagId ? { key: "TAG", label: "Tag chuyển nhân viên (BOT OFF)", status: "OK", detail: "", fix: "" } : { key: "TAG", label: "Tag chuyển nhân viên (BOT OFF)", status: "WARN", detail: "Page chưa có tag tắt bot: bot chốt xong không chuyển được cho nhân viên.", fix: "Trên Pancake tạo tag \"BOT OFF\" cho page rồi bấm Làm mới ở trang Bot chat." });
    c.push(
      i.botPage.minCustomerMessages > 1
        ? { key: "FIRST", label: "Tin đầu của khách", status: "WARN", detail: `Bot chỉ vào từ tin thứ ${i.botPage.minCustomerMessages} — tin đầu do trả lời tự động của Pancake gửi, và nó KHÔNG theo camp.`, fix: "Đổi trả lời tự động của Pancake cho page này thành câu chào chung (không báo giá mẫu cũ), hoặc đặt \"Bot vào từ tin thứ\" = 1 trong cài đặt page." }
        : { key: "FIRST", label: "Tin đầu của khách", status: "OK", detail: "Bot trả lời ngay từ tin đầu.", fix: "" },
    );
  }
  c.push(i.testMissing.length ? { key: "INFO", label: "Thông tin mẫu test", status: "MISSING", detail: `Còn thiếu: ${i.testMissing.join(", ")}.`, fix: "Điền ở bước Ảnh & màu và Giá & chất vải." } : { key: "INFO", label: "Thông tin mẫu test", status: "OK", detail: "", fix: "" });
  if (!i.testMissing.length && botRunning)
    c.push(i.imagesMissingOnBot ? { key: "IMAGES", label: "Ảnh màu đã gửi sang bot", status: "MISSING", detail: `${i.imagesMissingOnBot} ảnh chưa tới bot.`, fix: "Bấm Lưu lại để gửi lại." } : { key: "IMAGES", label: "Ảnh màu đã gửi sang bot", status: "OK", detail: "", fix: "" });
  if (i.live)
    c.push(i.seenCount > 0 ? { key: "SEEN", label: "Bot đã nhận khách từ quảng cáo", status: "OK", detail: `${i.seenCount} lượt.`, fix: "" } : { key: "SEEN", label: "Bot đã nhận khách từ quảng cáo", status: "UNKNOWN", detail: "Chưa gặp khách nào mang ID quảng cáo này.", fix: "Đợi khách nhắn. Camp có tin nhắn mà vẫn 0 lượt ⇒ Pancake không gửi ID quảng cáo — báo đội kỹ thuật." });

  const ok = (k: string) => c.find((x) => x.key === k)?.status === "OK";
  const canChat = botRunning && i.testMissing.length === 0 && i.imagesMissingOnBot === 0;
  const canGoLive = canChat && ok("PAGE") && ok("TOKEN") && ok("ENABLED") && c.find((x) => x.key === "PANCAKE")?.status !== "MISSING";
  return { checks: c, canChat, canGoLive };
}

/** Fanpage của quảng cáo: bài viết Facebook dựng từ creative có dạng `<pageId>_<postId>`. */
export function pageIdOfPost(fbPostId: string | null | undefined): string | null {
  const m = String(fbPostId ?? "").match(/^(\d{5,25})_\d+$/);
  return m ? m[1] : null;
}

/** Dữ liệu khung "Chat test" (máy chủ dựng ở `lib/integrations/chatbot/ad-test.ts`, trình duyệt chỉ đọc). */
export type AdTestView = {
  /** Id mẩu Thư viện Media, hoặc `ad:<ID quảng cáo>` cho quảng cáo dựng tay (`manualAdKey`). */
  campKey: string;
  /** Quảng cáo dựng tay trên Facebook (không qua Thư viện Media). */
  manual: boolean;
  adId: string;
  campaignName: string;
  productName: string | null;
  pageId: string | null;
  pageName: string | null;
  originalImageId: string | null;
  test: AdTestProduct | null;
  live: boolean;
  estimateUsd: number;
  spentTodayUsd: number;
  limits: typeof AD_TEST_IMAGE_LIMITS;
  canRecolor: boolean;
  recolorBlocked: string | null;
  readiness: ReadinessCheck[];
  canChat: boolean;
  canGoLive: boolean;
  /** Page của bot dùng cho khung chat thử (page của camp nếu bot có, không thì page đầu tiên — kèm cảnh báo). */
  chatPageId: string | null;
  chatPageNote: string | null;
  /** Fanpage chọn được (bot đang giữ token + tài khoản Pancake) — cho ô chọn khi máy không đọc được page. */
  pageOptions: { id: string; name: string; inBot: boolean }[];
};

export type ChatReply = { text: string; handoff: boolean; imageIds: string[] };
