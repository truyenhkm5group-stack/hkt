import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { memo } from "@/lib/cache";
import {
  AD_TEST_IMAGE_LIMITS,
  CHATBOT_AD_BOTS_KEY,
  adTestReadiness,
  pageIdOfPost,
  testImageGate,
  testImageSpendToday,
  testProductMissing,
  type AdBotConfig,
  type AdTestColor,
  type AdTestProduct,
  type ReadinessCheck,
  type SaveAdTestInfoInput,
} from "@/lib/constants/chatbot-ad-bots";
import { estimateImageUsd } from "@/lib/constants/creative-loop";
import { gatherPixels } from "@/lib/creative/generate";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { manualEditPrompt, parseManualDesignSpec } from "@/lib/creative/manual-gen";
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

export type AdTestView = {
  variantId: string;
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
};

type Camp = {
  variantId: string;
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

async function loadCamp(db: Db, variantId: string): Promise<Camp | null> {
  const cv = schema.creativeVariants;
  const [v] = await db
    .select({ v: cv, productName: schema.products.name })
    .from(cv)
    .leftJoin(schema.products, eq(schema.products.id, cv.productId))
    .where(eq(cv.id, variantId))
    .limit(1);
  if (!v || !v.v.fbAdId) return null;
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
    variantId: v.v.id,
    adId: v.v.fbAdId,
    campaignName: v.v.campaignName || v.v.adName || v.v.fbAdId,
    headline: v.v.headline,
    imageId: v.v.imageId,
    productId: v.v.productId,
    productName: v.productName ?? null,
    pageId: pageIdOfPost(v.v.fbPostId),
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

export async function loadAdTestView(variantId: string, now = new Date()): Promise<AdTestView | { error: string }> {
  const db = await getDb();
  const camp = await loadCamp(db, variantId);
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
    variantId: camp.variantId,
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
    recolorBlocked: !camp.imageId ? "Camp không còn ảnh quảng cáo." : !camp.photoSourceId ? "Camp không có ảnh sản phẩm thật đi kèm — AI không đổi màu được; chỉ dùng được màu gốc." : gate.ok ? null : gate.reason,
    readiness: r.checks,
    canChat: r.canChat && !!chatPage,
    canGoLive: r.canGoLive,
    chatPageId: chatPage?.id ?? null,
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
  const camp = await loadCamp(await getDb(), input.variantId);
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

export async function campByVariant(variantId: string): Promise<Camp | null> {
  return loadCamp(await getDb(), variantId);
}

export async function addAdTestColor(i: { variantId: string; color: string; mode: "ORIGINAL" | "AI" }, actor: Actor, deps: { imageClient?: ImageEditClient; now?: Date } = {}): Promise<AdTestResult> {
  const db = await getDb();
  const camp = await loadCamp(db, i.variantId);
  if (!camp) return { ok: false, error: "Camp này chưa có ID quảng cáo trên Facebook." };
  if (!camp.imageId) return { ok: false, error: "Camp không còn ảnh quảng cáo." };
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

export async function removeAdTestColor(i: { variantId: string; sha: string }, actor: Actor): Promise<AdTestResult> {
  const camp = await campByVariant(i.variantId);
  if (!camp) return { ok: false, error: "Không tìm thấy camp." };
  const config = await getAdBotConfig();
  const cur = config.overrides[camp.adId]?.test;
  if (!cur) return { ok: false, error: "Camp chưa có mẫu test." };
  const push = await saveOverride(camp.adId, (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), test: { ...cur, colors: cur.colors.filter((c) => c.sha !== i.sha) } }), actor);
  return { ok: true, push };
}

export async function setAdTestLive(i: { variantId: string; live: boolean }, actor: Actor): Promise<AdTestResult> {
  const view = await loadAdTestView(i.variantId);
  if ("error" in view) return { ok: false, error: view.error };
  if (i.live && !view.canGoLive) {
    const miss = view.readiness.filter((c) => c.status === "MISSING").map((c) => c.label);
    return { ok: false, error: `Chưa bật được cho khách thật — còn thiếu: ${miss.join(", ") || "xem bảng kiểm"}.` };
  }
  const push = await saveOverride(view.adId, (o) => ({ ...(o ?? { updatedByUserId: null, updatedByName: "", updatedAt: "" }), enabled: i.live }), actor);
  return { ok: true, push };
}

export type ChatTurn = { role: "user" | "model"; text: string };
export type ChatReply = { text: string; handoff: boolean; imageIds: string[] };

/** Một lượt chat thử: gửi lịch sử sang bot THẬT (đường test-chat, không đụng Pancake) với đúng bot riêng của camp. */
export async function chatAdTest(i: { variantId: string; history: ChatTurn[] }): Promise<{ ok: true; reply: ChatReply } | { ok: false; error: string }> {
  const view = await loadAdTestView(i.variantId);
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
