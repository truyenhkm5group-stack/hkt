import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { memo } from "@/lib/cache";
import {
  AD_TEST_IMAGE_LIMITS,
  CHATBOT_AD_BOTS_KEY,
  adTestReadiness,
  manualAdIdOf,
  manualAdKey,
  pageIdOfPost,
  testImageGate,
  testImageSpendToday,
  testProductMissing,
  type AdBotConfig,
  type AdTestColor,
  type AdTestProduct,
  type AdTestView,
  type ChatReply,
  type SaveAdTestInfoInput,
} from "@/lib/constants/chatbot-ad-bots";
import { estimateImageUsd } from "@/lib/constants/creative-loop";
import { gatherPixels } from "@/lib/creative/generate";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { manualEditPrompt, parseManualDesignSpec } from "@/lib/creative/manual-gen";
import { batchConfig } from "@/lib/creative/publish";
import { getAdBotConfig, getBotAdStatus, pushAdBots, type AdBotPushResult } from "@/lib/integrations/chatbot/ad-bots";
import { chatbotFetch, getChatbotStatus } from "@/lib/integrations/chatbot/client";
import { editImage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ NÚT "CHAT TEST" CỦA MỘT CAMP (Thư viện Media · tab ④) ═══════════
 *
 * Mẫu test MỚI (chưa có trên POS): người chọn màu ⇒ AI đổi màu ẢNH QUẢNG CÁO của camp (cùng câu lệnh và cùng hàng rào điểm
 * ảnh của nút "Sửa ảnh" — `manualEditPrompt`, `gatherPixels`), người nhập giá + chất vải ⇒ chat thử ngay trong ERP bằng
 * CHÍNH bot thật (container `erp-chatbot`, đường `test-chat`, không đụng Pancake) ⇒ bấm "Bật" mới chạy cho khách thật.
 * Luật dữ liệu: `lib/constants/chatbot-ad-bots.ts`. Không đụng đơn, tiền, tồn kho: chưa lên đơn POS (chỉ khi mẫu thắng).
 */


type Camp = {
  campKey: string;
  adId: string;
  campaignName: string;
  headline: string;
  imageId: string | null;
  productId: string | null;
  productName: string | null;
  pageId: string | null;
  photoSourceId: string | null;
  isDesign: boolean;
};

/**
 * Khoá camp của khung: id mẩu Thư viện Media, hoặc `ad:<ID quảng cáo>` cho quảng cáo DỰNG TAY trên Facebook (người khai ở
 * trang /chatbot/ad-bots — `manualAds` của sổ cấu hình). Quảng cáo dựng tay không có ảnh trong ERP và không có ảnh sản
 * phẩm thật đi kèm ⇒ ảnh màu do người TẢI LÊN, AI không đổi màu (ranh giới điểm ảnh của vòng mẫu).
 */
async function loadCamp(db: Db, campKey: string): Promise<Camp | null> {
  const manual = manualAdIdOf(campKey);
  if (manual) {
    const m = (await getAdBotConfig()).manualAds?.[manual];
    if (!m) return null;
    return { campKey, adId: manual, campaignName: m.label || `Quảng cáo ${manual}`, headline: "", imageId: null, productId: null, productName: null, pageId: m.pageId || null, photoSourceId: null, isDesign: false };
  }
  const cv = schema.creativeVariants;
  const [v] = await db
    .select({ v: cv, productName: schema.products.name, snapshot: schema.creativeBatches.configSnapshot })
    .from(cv)
    .innerJoin(schema.creativeBatches, eq(schema.creativeBatches.id, cv.batchId))
    .leftJoin(schema.products, eq(schema.products.id, cv.productId))
    .where(eq(cv.id, campKey))
    .limit(1);
  if (!v || !v.v.fbAdId) return null;
  // Fanpage: bài viết Facebook của quảng cáo (chứng từ) → người chọn trong khung → fanpage lô đã đăng (cấu hình chụp lúc đăng).
  const chosenPage = (await getAdBotConfig()).overrides[v.v.fbAdId]?.pageId || null;
  const batchPage = batchConfig(v.snapshot ?? {}).config.pageId || null;
  // Ảnh sản phẩm thật đi kèm (máy vẽ bắt buộc có một — ranh giới 3): của mẩu, không có thì của lượt gen tay đã sinh ra mẩu.
  let photoSourceId = v.v.productPhotoSourceId;
  let isDesign = v.v.mode === "DESIGN";
  if (!photoSourceId) {
    const [g] = await db
      .select({ design: schema.creativeManualGenImages.design, runPhoto: schema.creativeManualGens.productPhotoSourceId })
      .from(schema.creativeManualGenImages)
      .innerJoin(schema.creativeManualGens, eq(schema.creativeManualGens.id, schema.creativeManualGenImages.genId))
      .where(eq(schema.creativeManualGenImages.variantId, v.v.id))
      .limit(1);
    const spec = g?.design ? parseManualDesignSpec(g.design) : null;
    if (spec) isDesign = true;
    photoSourceId = g?.runPhoto ?? spec?.photoSourceIds[0] ?? null;
  }
  return {
    campKey: v.v.id,
    adId: v.v.fbAdId,
    campaignName: v.v.campaignName || v.v.adName || v.v.fbAdId,
    headline: v.v.headline,
    imageId: v.v.imageId,
    productId: v.v.productId,
    productName: v.productName ?? null,
    pageId: pageIdOfPost(v.v.fbPostId) ?? chosenPage ?? (batchPage && /^\d{5,25}$/.test(batchPage) ? batchPage : null),
    photoSourceId,
    isDesign,
  };
}

type BotPage = { id: string; name: string; enabled: boolean; dryRun: boolean; pauseTagId: string | null; minCustomerMessages: number };

async function readBotPages(): Promise<BotPage[]> {
  const res = await chatbotFetch("/api/state", { timeoutMs: 5000 });
  if (!res.ok) throw new Error(`Bot trả HTTP ${res.status}`);
  const b = (await res.json()) as { pages?: { id: string; name?: string; pancakeName?: string; pauseTagId?: string | null; effective?: { enabled?: boolean; dryRun?: boolean; minCustomerMessages?: number } }[] };
  return (b.pages ?? []).map((p) => ({
    id: String(p.id),
    name: p.name || p.pancakeName || "",
    enabled: p.effective?.enabled !== false,
    dryRun: !!p.effective?.dryRun,
    pauseTagId: p.pauseTagId ?? null,
    minCustomerMessages: Number(p.effective?.minCustomerMessages ?? 1) || 1,
  }));
}

async function readPancakePageIds(): Promise<{ ids: string[] | null; names: Map<string, string>; error: string | null }> {
  try {
    const pages = await memo("pancake:pages-list", 10 * 60_000, () => getPancakePagesClient().listPages());
    return { ids: pages.map((p) => p.id), names: new Map(pages.map((p) => [p.id, p.name])), error: null };
  } catch (e) {
    return { ids: null, names: new Map(), error: e instanceof Error ? e.message : String(e) };
  }
}

async function imageCfg(db: Db) {
  const { config } = await readCurrentCreativeConfig(db);
  return { model: config.imageModel, size: config.imageSize, quality: config.imageQuality, estimateUsd: estimateImageUsd(config.imageModel, config.imageQuality, config.imageSize) };
}

function emptyTest(c: Camp): AdTestProduct {
  return { name: c.productName ?? "", code: "", price: null, shipFee: null, comboPrice: null, fabric: "", sizes: "", offer: "", colors: [] };
}

export async function loadAdTestView(campKey: string, now = new Date()): Promise<AdTestView | { error: string }> {
  const db = await getDb();
  const camp = await loadCamp(db, campKey);
  if (!camp) return { error: "Camp này chưa có ID quảng cáo trên Facebook." };
  const [config, img, status, pancake] = await Promise.all([getAdBotConfig(), imageCfg(db), getChatbotStatus(), readPancakePageIds()]);
  const o = config.overrides[camp.adId];
  const test = o?.test ?? null;
  const live = !!test && o?.enabled === true;
  let botPages: BotPage[] = [];
  let botError: string | null = status.state === "UNREACHABLE" ? status.error : null;
  if (status.state === "RUNNING") botPages = await readBotPages().catch((e: unknown) => ((botError = e instanceof Error ? e.message : String(e)), []));
  const bot = status.state === "RUNNING" ? await getBotAdStatus() : null;
  const botPage = camp.pageId ? (botPages.find((p) => p.id === camp.pageId) ?? null) : null;
  const shas = new Set((test?.colors ?? []).map((c) => c.sha));
  const imagesMissingOnBot = bot && bot.reachable ? bot.missingImages.filter((s) => shas.has(s)).length : 0;
  const spentTodayUsd = testImageSpendToday(config.imageSpend, now);
  const gate = testImageGate({ colors: test?.colors.length ?? 0, spentTodayUsd, estimateUsd: img.estimateUsd });
  const r = adTestReadiness({
    pageId: camp.pageId,
    pageName: botPage?.name || (camp.pageId ? (pancake.names.get(camp.pageId) ?? null) : null),
    pancakePageIds: pancake.ids,
    pancakeError: pancake.error,
    botState: status.state,
    botError,
    botPage,
    testMissing: testProductMissing(test),
    imagesMissingOnBot,
    live,
    seenCount: bot && bot.reachable ? (bot.seen[camp.adId]?.count ?? 0) : 0,
  });
  const chatPage = botPage ?? botPages[0] ?? null;
  return {
    campKey: camp.campKey,
    manual: manualAdIdOf(camp.campKey) !== null,
    adId: camp.adId,
    campaignName: camp.campaignName,
    productName: camp.productName,
    pageId: camp.pageId,
    pageName: botPage?.name || (camp.pageId ? (pancake.names.get(camp.pageId) ?? null) : null),
    originalImageId: camp.imageId,
    test,
    live,
    estimateUsd: img.estimateUsd,
    spentTodayUsd,
    limits: AD_TEST_IMAGE_LIMITS,
    canRecolor: gate.ok && !!camp.photoSourceId && !!camp.imageId,
    recolorBlocked: manualAdIdOf(camp.campKey) ? "Quảng cáo dựng tay: ERP không có ảnh quảng cáo / ảnh sản phẩm thật để AI đổi màu — tải ảnh từng màu lên." : !camp.imageId ? "Camp không còn ảnh quảng cáo." : !camp.photoSourceId ? "Camp không có ảnh sản phẩm thật đi kèm — AI không đổi màu được; chỉ dùng được màu gốc." : gate.ok ? null : gate.reason,
    readiness: r.checks,
    canChat: r.canChat && !!chatPage,
    canGoLive: r.canGoLive,
    chatPageId: chatPage?.id ?? null,
    pageOptions: mergePageOptions(botPages, pancake),
    chatPageNote: chatPage && !botPage ? `Bot chưa có page của camp — chat thử tạm dùng page "${chatPage.name || chatPage.id}" (bảng size, xưng hô của page đó).` : null,
  };
}

async function saveOverride(adId: string, fn: (o: AdBotConfig["overrides"][string] | undefined, c: AdBotConfig) => AdBotConfig["overrides"][string], actor: { id: string; name: string }, extra?: (c: AdBotConfig) => Partial<AdBotConfig>): Promise<AdBotPushResult> {
  const config = await getAdBotConfig();
  const next = fn(config.overrides[adId], config);
  const merged: AdBotConfig = { ...config, ...(extra ? extra(config) : {}), overrides: { ...config.overrides, [adId]: { ...next, updatedByUserId: actor.id, updatedByName: actor.name, updatedAt: new Date().toISOString() } } };
  await setSettingJson(CHATBOT_AD_BOTS_KEY, merged);
  return pushAdBots();
}

type Actor = { id: string; name: string };
export type AdTestResult = { ok: true; push: AdBotPushResult } | { ok: false; error: string };

export async function saveAdTestInfo(input: SaveAdTestInfoInput, actor: Actor): Promise<AdTestResult> {
  const camp = await loadCamp(await getDb(), input.campKey);
  if (!camp) return { ok: false, error: "Camp này chưa có ID quảng cáo trên Facebook." };
  const push = await saveOverride(
    camp.adId,
    (o) => ({
      ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }),
      // Mẫu test mới luôn bắt đầu ở TẮT: chat thử xong người bấm "Bật" mới chạy cho khách thật.
      enabled: o?.test ? o.enabled : false,
      test: { ...(o?.test ?? emptyTest(camp)), name: input.name, code: input.code.toUpperCase(), price: input.price, shipFee: input.shipFee, comboPrice: input.comboPrice, fabric: input.fabric, sizes: input.sizes, offer: input.offer },
    }),
    actor,
  );
  return { ok: true, push };
}

export async function campByKey(campKey: string): Promise<Camp | null> {
  return loadCamp(await getDb(), campKey);
}

export async function addAdTestColor(i: { campKey: string; color: string; mode: "ORIGINAL" | "AI" }, actor: Actor, deps: { imageClient?: ImageEditClient; now?: Date } = {}): Promise<AdTestResult> {
  const db = await getDb();
  const camp = await loadCamp(db, i.campKey);
  if (!camp) return { ok: false, error: "Camp này chưa có ID quảng cáo trên Facebook." };
  if (!camp.imageId) return { ok: false, error: manualAdIdOf(camp.campKey) ? "Quảng cáo dựng tay không có ảnh trong ERP — dùng nút Tải ảnh lên cho màu này." : "Camp không còn ảnh quảng cáo." };
  const color = i.color.trim().slice(0, 40);
  if (!color) return { ok: false, error: "Nhập tên màu." };
  const config = await getAdBotConfig();
  const cur = config.overrides[camp.adId]?.test ?? emptyTest(camp);
  if (cur.colors.some((c) => c.color.toLowerCase() === color.toLowerCase())) return { ok: false, error: `Đã có màu "${color}".` };
  const now = deps.now ?? new Date();

  let entry: AdTestColor;
  let spend: AdBotConfig["imageSpend"] = config.imageSpend ?? [];
  if (i.mode === "ORIGINAL") {
    const px = await readCreativeImage(db, camp.imageId);
    if (!px) return { ok: false, error: "Điểm ảnh quảng cáo đã bị dọn." };
    entry = { color, imageId: camp.imageId, sha: px.sha256, source: "ORIGINAL", createdAt: now.toISOString() };
  } else {
    if (!camp.photoSourceId) return { ok: false, error: "Camp không có ảnh sản phẩm thật đi kèm — AI không đổi màu được (máy vẽ bắt buộc có ảnh thật). Dùng màu gốc." };
    const img = await imageCfg(db);
    const gate = testImageGate({ colors: cur.colors.length, spentTodayUsd: testImageSpendToday(spend, now), estimateUsd: img.estimateUsd });
    if (!gate.ok) return { ok: false, error: gate.reason };
    const ad = await readCreativeImage(db, camp.imageId);
    if (!ad) return { ok: false, error: "Điểm ảnh quảng cáo đã bị dọn." };
    // Ảnh CẦN SỬA đứng đầu (ảnh quảng cáo của shop), rồi ảnh sản phẩm thật — cùng thứ tự với nút "Sửa ảnh".
    const images: ImageEditInputImage[] = [{ kind: "OWN_VARIANT", bytes: new Uint8Array(ad.bytes), contentType: ad.contentType }];
    images.push(...(await gatherPixels(db, { productPhotoSourceId: camp.photoSourceId, parentVariantId: null, ownAdSourceId: null })));
    const prompt = manualEditPrompt({ request: { color, layout: null, detail: "" }, productName: camp.productName, isDesign: camp.isDesign });
    let res;
    try {
      res = await (deps.imageClient ?? editImage)({ model: img.model, prompt, images, size: img.size, quality: img.quality });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const stored = await storeCreativeImage(db, res.bytes);
    // Chi phí: số OpenAI đếm; không có ⇒ tính theo giá ước tính (vẫn vào trần — CHƯA BIẾT không phải 0đ).
    spend = [...spend, { adId: camp.adId, at: now.toISOString(), usd: res.costUsd ?? img.estimateUsd, estimated: res.costUsd === null }].slice(-500);
    entry = { color, imageId: stored.id, sha: stored.sha256, source: "AI", createdAt: now.toISOString() };
  }
  const push = await saveOverride(
    camp.adId,
    (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), enabled: o?.test ? o.enabled : false, test: { ...cur, colors: [...cur.colors, entry] } }),
    actor,
    () => ({ imageSpend: spend }),
  );
  return { ok: true, push };
}

export async function removeAdTestColor(i: { campKey: string; sha: string }, actor: Actor): Promise<AdTestResult> {
  const camp = await campByKey(i.campKey);
  if (!camp) return { ok: false, error: "Không tìm thấy camp." };
  const config = await getAdBotConfig();
  const cur = config.overrides[camp.adId]?.test;
  if (!cur) return { ok: false, error: "Camp chưa có mẫu test." };
  const push = await saveOverride(camp.adId, (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), test: { ...cur, colors: cur.colors.filter((c) => c.sha !== i.sha) } }), actor);
  return { ok: true, push };
}

export async function setAdTestLive(i: { campKey: string; live: boolean }, actor: Actor): Promise<AdTestResult> {
  const view = await loadAdTestView(i.campKey);
  if ("error" in view) return { ok: false, error: view.error };
  if (i.live && !view.canGoLive) {
    const miss = view.readiness.filter((c) => c.status === "MISSING").map((c) => c.label);
    return { ok: false, error: `Chưa bật được cho khách thật — còn thiếu: ${miss.join(", ") || "xem bảng kiểm"}.` };
  }
  const push = await saveOverride(view.adId, (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), enabled: i.live }), actor);
  return { ok: true, push };
}

export type ChatTurn = { role: "user" | "model"; text: string };

/** Một lượt chat thử: gửi lịch sử sang bot THẬT (đường test-chat, không đụng Pancake) với đúng bot riêng của camp. */
export async function chatAdTest(i: { campKey: string; history: ChatTurn[] }): Promise<{ ok: true; reply: ChatReply } | { ok: false; error: string }> {
  const view = await loadAdTestView(i.campKey);
  if ("error" in view) return { ok: false, error: view.error };
  if (!view.canChat || !view.chatPageId) return { ok: false, error: "Chưa chat thử được — xem các dòng THIẾU trong bảng kiểm." };
  const res = await chatbotFetch(`/api/pages/${encodeURIComponent(view.chatPageId)}/test-chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adId: view.adId, customerName: "Khách test", history: i.history.slice(-30) }),
    timeoutMs: 90_000,
  });
  const b = (await res.json().catch(() => ({}))) as { text?: string; handoff?: boolean; imageUrls?: string[]; error?: string };
  if (!res.ok) return { ok: false, error: b.error || `Bot trả HTTP ${res.status}` };
  const bySha = new Map((view.test?.colors ?? []).map((c) => [c.sha, c.imageId]));
  const imageIds = (b.imageUrls ?? []).map((u) => (u.startsWith("adimg:") ? bySha.get(u.slice(6)) : undefined)).filter((x): x is string => !!x);
  return { ok: true, reply: { text: b.text ?? "", handoff: !!b.handoff, imageIds } };
}

/**
 * Người TẢI ẢNH LÊN cho một màu — dùng được cho mọi camp, và là đường DUY NHẤT của quảng cáo dựng tay. Không gọi AI, không
 * tốn tiền; ảnh lưu như mọi ảnh Thư viện Media (`storeCreativeImage` kiểm loại tệp + trần dung lượng).
 */
export async function uploadAdTestColor(i: { campKey: string; color: string; bytes: Uint8Array }, actor: Actor, now = new Date()): Promise<AdTestResult> {
  const db = await getDb();
  const camp = await loadCamp(db, i.campKey);
  if (!camp) return { ok: false, error: "Không tìm thấy camp / quảng cáo." };
  const color = i.color.trim().slice(0, 40);
  if (!color) return { ok: false, error: "Nhập tên màu." };
  const config = await getAdBotConfig();
  const cur = config.overrides[camp.adId]?.test ?? emptyTest(camp);
  if (cur.colors.some((c) => c.color.toLowerCase() === color.toLowerCase())) return { ok: false, error: `Đã có màu "${color}".` };
  if (cur.colors.length >= AD_TEST_IMAGE_LIMITS.maxColorsPerAd) return { ok: false, error: `Mỗi camp tối đa ${AD_TEST_IMAGE_LIMITS.maxColorsPerAd} màu.` };
  let stored;
  try {
    stored = await storeCreativeImage(db, i.bytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const entry: AdTestColor = { color, imageId: stored.id, sha: stored.sha256, source: "UPLOAD", createdAt: now.toISOString() };
  const push = await saveOverride(camp.adId, (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), enabled: o?.test ? o.enabled : false, test: { ...cur, colors: [...cur.colors, entry] } }), actor);
  return { ok: true, push };
}

/** Khai một quảng cáo DỰNG TAY (ID + fanpage) ⇒ trả khoá camp để mở khung Chat test. Trùng ID camp Thư viện Media ⇒ từ chối. */
export async function addManualAd(i: { adId: string; pageId: string; label: string }, actor: Actor): Promise<{ ok: true; campKey: string } | { ok: false; error: string }> {
  const db = await getDb();
  const [own] = await db.select({ id: schema.creativeVariants.id }).from(schema.creativeVariants).where(eq(schema.creativeVariants.fbAdId, i.adId)).limit(1);
  if (own) return { ok: false, error: "Quảng cáo này là camp của Thư viện Media — mở nút Chat test ở tab Đang chạy." };
  const config = await getAdBotConfig();
  const manualAds = { ...(config.manualAds ?? {}), [i.adId]: { pageId: i.pageId, label: i.label, addedByUserId: actor.id, addedByName: actor.name, addedAt: config.manualAds?.[i.adId]?.addedAt ?? new Date().toISOString() } };
  await setSettingJson(CHATBOT_AD_BOTS_KEY, { ...config, manualAds });
  return { ok: true, campKey: manualAdKey(i.adId) };
}

/** Bỏ một quảng cáo dựng tay: bot thôi dùng bot riêng của nó (ảnh trong ERP giữ nguyên, không xoá dữ liệu). */
export async function removeManualAd(adId: string): Promise<AdTestResult> {
  const config = await getAdBotConfig();
  if (!config.manualAds?.[adId]) return { ok: false, error: "Không có quảng cáo dựng tay này." };
  const manualAds = { ...config.manualAds };
  delete manualAds[adId];
  await setSettingJson(CHATBOT_AD_BOTS_KEY, { ...config, manualAds });
  return { ok: true, push: await pushAdBots() };
}

function mergePageOptions(bot: BotPage[], pancake: { ids: string[] | null; names: Map<string, string> }): { id: string; name: string; inBot: boolean }[] {
  const out = new Map<string, { id: string; name: string; inBot: boolean }>();
  for (const p of bot) out.set(p.id, { id: p.id, name: p.name || pancake.names.get(p.id) || p.id, inBot: true });
  for (const id of pancake.ids ?? []) if (!out.has(id)) out.set(id, { id, name: pancake.names.get(id) || id, inBot: false });
  return [...out.values()];
}

/** Fanpage chọn được khi khai quảng cáo dựng tay: page bot đang giữ token + page trong tài khoản Pancake. */
export async function manualAdPageOptions(): Promise<{ id: string; name: string; inBot: boolean }[]> {
  const [status, pancake] = await Promise.all([getChatbotStatus(), readPancakePageIds()]);
  const bot = status.state === "RUNNING" ? await readBotPages().catch(() => []) : [];
  return mergePageOptions(bot, pancake);
}

/** Người chọn fanpage cho camp khi máy không đọc được từ bài viết của quảng cáo. */
export async function setAdTestPage(i: { campKey: string; pageId: string }, actor: Actor): Promise<AdTestResult> {
  const camp = await campByKey(i.campKey);
  if (!camp) return { ok: false, error: "Không tìm thấy camp." };
  const adId = manualAdIdOf(i.campKey);
  if (adId) {
    const config = await getAdBotConfig();
    const m = config.manualAds?.[adId];
    if (!m) return { ok: false, error: "Không có quảng cáo dựng tay này." };
    await setSettingJson(CHATBOT_AD_BOTS_KEY, { ...config, manualAds: { ...config.manualAds, [adId]: { ...m, pageId: i.pageId } } });
    return { ok: true, push: await pushAdBots() };
  }
  const push = await saveOverride(camp.adId, (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), pageId: i.pageId }), actor);
  return { ok: true, push };
}

/**
 * Nạp page của camp vào bot ngay từ khung Chat test. Token lấy theo thứ tự: người DÁN tay → ERP tự sinh Page Access Token
 * bằng khoá Pancake của shop (`pageToken`, cùng đường đồng bộ hội thoại đang dùng). Token đi thẳng máy chủ ERP → bot,
 * KHÔNG về trình duyệt, KHÔNG vào nhật ký. Page vào bot ở trạng thái TẮT (`enabled: false` ghi trước khi gắn) —
 * thêm page là bot đọc MỌI tin của page, nên bật là một bước riêng có xác nhận.
 */
export async function connectPageToBot(i: { campKey: string; token?: string }): Promise<{ ok: true; generated: boolean } | { ok: false; error: string }> {
  const camp = await campByKey(i.campKey);
  if (!camp) return { ok: false, error: "Không tìm thấy camp." };
  if (!camp.pageId) return { ok: false, error: "Chưa biết fanpage của camp — chọn fanpage ở ô \"Fanpage của camp\" trước." };
  let token = (i.token ?? "").trim();
  let generated = false;
  if (!token) {
    try {
      const t = await getPancakePagesClient().pageToken(camp.pageId);
      // Không sinh được thì client lùi về khoá NGƯỜI DÙNG — khoá đó không phải token của page, không gửi sang bot.
      if (t.key !== "page_access_token" || !t.value) return { ok: false, error: "ERP không tự lấy được token cho page này (tài khoản Pancake của ERP không quản lý page, hoặc page chưa vào gói Pancake). Dán Page Access Token tay: Pancake → page → Cài đặt → Công cụ → Page Access Token." };
      token = t.value;
      generated = true;
    } catch (e) {
      return { ok: false, error: `ERP không tự lấy được token (${e instanceof Error ? e.message : String(e)}). Dán Page Access Token tay.` };
    }
  }
  const pancake = await readPancakePageIds();
  try {
    const res = await chatbotFetch("/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: camp.pageId, token, name: pancake.names.get(camp.pageId) ?? "", enabled: false }),
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: b.error || `Bot trả HTTP ${res.status}` };
    }
  } catch (e) {
    return { ok: false, error: `Không gửi được sang bot: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, generated };
}

/** Bật / tắt bot cho page của camp (bật = bot trả lời MỌI tin nhắn vào page, không riêng khách của quảng cáo). */
export async function setBotPageEnabled(i: { campKey: string; enabled: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
  const camp = await campByKey(i.campKey);
  if (!camp?.pageId) return { ok: false, error: "Chưa biết fanpage của camp." };
  try {
    const res = await chatbotFetch(`/api/pages/${encodeURIComponent(camp.pageId)}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: i.enabled }),
      timeoutMs: 8000,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: res.status === 404 ? "Bot chưa có page này — nạp token trước." : b.error || `Bot trả HTTP ${res.status}` };
    }
  } catch (e) {
    return { ok: false, error: `Không gửi được sang bot: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}
