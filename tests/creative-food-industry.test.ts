/**
 * ═══════════ THƯ VIỆN MEDIA CHO SHOP THỰC PHẨM + KHOÁ AI CỦA TỔ CHỨC (chủ shop 04/10/2026) ═══════════
 *
 * «Hải Sản Làng Chài» (tổ chức khách, mẫu ngành `food-commerce`) phải gen được ảnh + câu chữ quảng cáo trong Thư viện Media từ
 * ảnh sản phẩm THẬT của chính shop, bằng khoá AI CỦA CHÍNH HỌ.
 *
 * Thuần: ngành của tổ chức (nhà luôn thời trang · mẫu ngành · ghi đè · mặc định) · câu lệnh vẽ thực phẩm KHÔNG một chữ thời
 * trang nào (người mẫu, vải, váy, selfie, ma-nơ-canh…) và luôn dặn giữ đúng món + bao bì, không chữ / logo / tem chứng nhận ·
 * kiểu ảnh / màu thời trang bị bỏ · gen thực phẩm luôn hợp lệ, không người · câu chữ thực phẩm theo dàn ý + DỮ KIỆN SẢN PHẨM ·
 * luật khẳng định (khối lượng / xuất xứ / sức khoẻ / 100% / chứng nhận / không chất bảo quản) · thời trang giữ NGUYÊN chữ.
 *
 * Tổ chức thật (hai CSDL PGlite riêng, fetch GIẢ — không mạng, không khoá thật):
 *  · A (`food-commerce`) bật «OpenAI — khoá của tổ chức»: gen tay vẽ bằng ĐÚNG khoá của A (tiêu đề Authorization), câu lệnh
 *    thực phẩm, ảnh lưu lại, sổ dùng AI ghi `creative_image` · BYOK · tổ chức A; duyệt ảnh ⇒ câu chữ viết bằng provider BYOK
 *    (phương án bịa xuất xứ / khối lượng bị bắt viết lại), sổ ghi `creative_copy`; thiết kế mới bị chặn ở đường ghi.
 *  · Hàng rào điểm ảnh còn nguyên trên đường khoá của tổ chức: ảnh SPY / thiếu ảnh sản phẩm thật ⇒ NÉM trước fetch.
 *  · Máy vẽ mở trong ngữ cảnh A đem sang ngữ cảnh B ⇒ `CredentialOwnerMismatchError` trước fetch; B không mở được khoá của A.
 *  · B (không mẫu ngành ⇒ thời trang, ghi đè thành thực phẩm) dùng Gemini: chưa khai «Model vẽ ảnh» ⇒ KHÔNG vẽ (không đoán
 *    model); khai rồi ⇒ vẽ bằng khoá của B qua `x-goog-api-key`, ảnh PNG lưu được, tiền CHƯA BIẾT (null, không 0).
 *  · Nhà: `creativeImageClient` / `creativeCaptioner` trả ĐÚNG `editImage` / `captionFromImage` cũ; `editImage` trong ngữ cảnh
 *    tổ chức khách vẫn NÉM `ConnectorUnavailableError` trước fetch (assertHomeCredentials không đổi).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveAiConnectionAsOperator, saveConnection, setAiConnectionStatusAsOperator, setConnectionStatus, testAiConnectionAsOperator, openActiveConnection } from "@/lib/connectors/service";
import { CUSTOMER_AI_CONFIG_MANAGED } from "@/lib/saas/visibility";
import {
  FOOD_COPY_FORMULAS,
  FOOD_COPY_STRUCTURE,
  FOOD_FASHION_ONLY_MESSAGE,
  FOOD_PRESERVE_PRODUCT_CLAUSE,
  foodClaimProblems,
  foodEditPrompt,
  foodFactLines,
  resolveCreativeIndustry,
} from "@/lib/constants/creative-industry";
import { DEFAULT_CREATIVE_CONFIG, GENE_KEYS, GENE_VOCAB, IMAGE_EDIT_LAYOUTS, parseGenes } from "@/lib/constants/creative-loop";
import { OUTPUT_STYLE_KEYS, applyStyleGenes, normalizeStudioOptions, outputStyleKeysFor, studioDirectives } from "@/lib/constants/creative-studio";
import { decodeGeminiImageBody } from "@/lib/creative/byok-image";
import { briefOf, captionFromImage, captionInstructionsFor, captionProblems, pickCaptionOptions, type CaptionInput } from "@/lib/creative/caption";
import { storeCreativeImage } from "@/lib/creative/images";
import { drawManualGen, manualEditPrompt, manualGenGenes, manualGenPrompt, reviewManualGenImage, startManualDesignGen, startManualEdit, startManualGen } from "@/lib/creative/manual-gen";
import { creativeAiStatus, creativeCaptioner, creativeImageClient, readCreativeIndustry, writeCreativeIndustry } from "@/lib/creative/org-ai";
import { OPENAI_IMAGES_EDIT_URL, editImage, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { isConnectorUnavailable } from "@/lib/platform/credentials";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const OPERATOR_AI_REF = { orgCode: "home", email: "op@nha.local" }; // khoá AI của workspace khách: chỉ người vận hành ghi (lib/saas/visibility.ts)

/** Chữ thời trang KHÔNG được có trong câu lệnh / lời dặn của shop thực phẩm. */
const FASHION_WORDS = /\b(fashion|garment|fabric|wearing|worn|mannequin|dress|selfie|model|outfit|silhouette)\b|vải|váy|người mẫu|thời trang|chất liệu|form dáng/i;

// ─────────────────────────── 1. THUẦN ───────────────────────────

export function testCreativeFoodIndustryPure() {
  // Ngành của tổ chức.
  assert.deepEqual(resolveCreativeIndustry({ isHome: true, templateKey: "food-commerce", override: "FOOD" }).industry, "FASHION", "nhà LUÔN thời trang, kể cả có ghi đè");
  assert.equal(resolveCreativeIndustry({ isHome: false, templateKey: "food-commerce" }).industry, "FOOD");
  assert.equal(resolveCreativeIndustry({ isHome: false, templateKey: "seafood-commerce" }).basis, "TEMPLATE");
  assert.equal(resolveCreativeIndustry({ isHome: false, templateKey: "fashion-commerce" }).industry, "FASHION");
  const none = resolveCreativeIndustry({ isHome: false, templateKey: null });
  assert.ok(none.industry === "FASHION" && none.basis === "DEFAULT", "không mẫu ngành ⇒ giữ hành vi cũ");
  assert.equal(resolveCreativeIndustry({ isHome: false, templateKey: null, override: "FOOD" }).basis, "OVERRIDE");
  assert.equal(resolveCreativeIndustry({ isHome: false, templateKey: "food-commerce", override: "rác" }).industry, "FOOD", "ghi đè lạ bị bỏ");

  // Gen thực phẩm: luôn hợp lệ (máy học được), không người, không phố / chụp gương / lưới màu, không chữ.
  const genes = manualGenGenes("seed-food", 20, { industry: "FOOD" });
  for (const g of genes) {
    assert.ok(parseGenes(g), JSON.stringify(g));
    assert.equal(g.model, "NONE");
    assert.equal(g.textOverlay, "NONE");
    assert.ok(!["STREET"].includes(g.scene) && !["COLOR_GRID", "MIRROR_SELFIE"].includes(g.composition), JSON.stringify(g));
  }
  assert.ok(new Set(genes.slice(0, 10).map((g) => `${g.scene}|${g.composition}`)).size >= 6, "10 ảnh đầu là nhiều tổ hợp khác nhau");
  assert.deepEqual(manualGenGenes("seed-food", 5), manualGenGenes("seed-food", 5, {}), "thời trang không đổi khi không khai ngành");

  // Kiểu ảnh / màu: thời trang bị bỏ ở shop thực phẩm.
  const foodStyles = outputStyleKeysFor("FOOD");
  for (const k of ["UGC_SELFIE", "MANNEQUIN", "COLOR_VARIANTS"] as const) assert.ok(!foodStyles.includes(k), `${k} không dùng cho thực phẩm`);
  assert.deepEqual(normalizeStudioOptions({ styles: ["UGC_SELFIE", "MANNEQUIN", "STUDIO", "FLATLAY"], colors: ["Đỏ đô"] }, "MOCKUP", "FOOD"), { styles: ["STUDIO", "FLATLAY"], colors: [], size: null, quality: null });
  assert.deepEqual(normalizeStudioOptions({ styles: ["UGC_SELFIE"], colors: ["Đen"] }), { styles: ["UGC_SELFIE"], colors: ["Đen"], size: null, quality: null }, "thời trang giữ nguyên");
  for (const style of OUTPUT_STYLE_KEYS) {
    for (const g of [...genes.slice(0, 4), ...manualGenGenes("x", 4)]) {
      const out = applyStyleGenes(g, style, "FOOD");
      assert.ok(parseGenes(out) && out.model === "NONE" && out.textOverlay === "NONE" && out.composition !== "MIRROR_SELFIE" && out.scene !== "STREET", `${style}: ${JSON.stringify(out)}`);
      for (const k of GENE_KEYS) assert.ok((GENE_VOCAB[k] as readonly string[]).includes(out[k]));
    }
  }

  // Câu lệnh vẽ thực phẩm: không một chữ thời trang, luôn giữ đúng món + bao bì, không chữ / logo / tem.
  for (const style of foodStyles) {
    for (const [i, g] of genes.slice(0, 7).entries()) {
      const p = manualGenPrompt({ idea: i % 2 ? "" : "mâm cơm ngày mưa", genes: applyStyleGenes(g, style, "FOOD"), productName: "Chả cá thu", hasOwnAd: i % 3 === 0, uploadCount: i % 2, cell: { style, color: "" }, industry: "FOOD" });
      const sansIdea = p.split("mâm cơm ngày mưa").join("");
      assert.ok(!FASHION_WORDS.test(sansIdea), `${style}#${i}: câu lệnh thực phẩm có chữ thời trang «${sansIdea.match(FASHION_WORDS)?.[0]}»\n${p}`);
      assert.ok(p.includes(FOOD_PRESERVE_PRODUCT_CLAUSE) && p.includes("No text, letters or numbers") && p.includes("Chả cá thu"), p);
      assert.ok(/certification mark/.test(p) && /weight/.test(p), "dặn không bịa tem chứng nhận / khối lượng");
    }
  }
  assert.deepEqual(studioDirectives({ style: "STUDIO", color: "Đỏ đô" }, "MOCKUP", "FOOD").length, 1, "thực phẩm: không câu đổi màu");
  const ep = manualEditPrompt({ request: { color: "", layout: "LIFESTYLE", detail: "thêm rau thơm" }, productName: "Chả mực", isDesign: false, industry: "FOOD" });
  assert.ok(!FASHION_WORDS.test(ep) && ep.includes(FOOD_PRESERVE_PRODUCT_CLAUSE), ep);
  assert.equal(ep, foodEditPrompt({ layout: "LIFESTYLE", detail: "thêm rau thơm", productName: "Chả mực" }));
  for (const l of IMAGE_EDIT_LAYOUTS) assert.ok(!FASHION_WORDS.test(foodEditPrompt({ layout: l, detail: "", productName: "Chả" })), l);

  // Thời trang (và mọi lượt của nhà): câu lệnh GIỐNG HỆT khi khai ngành thời trang hay không khai.
  const g0 = manualGenGenes("seed-a", 1)[0];
  const fb = { idea: "đi biển", genes: g0, productName: "Đầm A", hasOwnAd: true, uploadCount: 1, cell: { style: "STUDIO" as const, color: "Đen" } };
  assert.equal(manualGenPrompt({ ...fb, industry: "FASHION" }), manualGenPrompt(fb));
  assert.ok(manualGenPrompt(fb).includes("Vietnamese fashion shop"), "thời trang vẫn là thời trang");
  assert.equal(captionInstructionsFor(undefined), captionInstructionsFor("FASHION"));
  assert.ok(captionInstructionsFor(undefined).includes("shop thời trang Việt Nam"));

  // Câu chữ thực phẩm: lời dặn + dàn ý + DỮ KIỆN SẢN PHẨM, không chữ thời trang.
  const facts = foodFactLines({ net_weight: "500g", package_size: "Túi hút chân không 500g", storage_instruction: "Ngăn đá −18°C", internal_cost: "bí mật" });
  assert.deepEqual(facts, ["Quy cách đóng gói: Túi hút chân không 500g", "Khối lượng tịnh: 500g", "Hướng dẫn bảo quản: Ngăn đá −18°C"], "chỉ field được phép, không field nội bộ");
  const ci: CaptionInput = {
    image: { bytes: new Uint8Array([1]), contentType: "image/jpeg" },
    product: { name: "Chả cá thu", code: "CCT", priceVnd: 120_000 },
    genes: genes[0],
    draft: null,
    winningExamples: [],
    formulas: ["HOOK_QUESTION", "OCCASION"],
    noPrice: true,
    industry: "FOOD",
    facts,
  };
  const brief = briefOf(ci, null, 2);
  assert.ok(brief.includes(FOOD_COPY_STRUCTURE) && brief.includes("Khối lượng tịnh: 500g") && brief.includes(FOOD_COPY_FORMULAS.OCCASION.instruction), brief);
  assert.ok(!FASHION_WORDS.test(brief), `bản giao việc thực phẩm có chữ thời trang: ${brief.match(FASHION_WORDS)?.[0]}`);
  assert.ok(!FASHION_WORDS.test(captionInstructionsFor("FOOD")), "lời dặn thực phẩm không chữ thời trang");
  for (const f of Object.values(FOOD_COPY_FORMULAS)) assert.ok(!FASHION_WORDS.test(`${f.label} ${f.hint} ${f.instruction}`), f.label);
  assert.ok(briefOf({ ...ci, industry: undefined, facts: undefined }, null, 2).includes("Câu hỏi mở đầu"), "thời trang vẫn đọc công thức cũ");

  // Luật khẳng định.
  const factText = ["Chả cá thu", ...facts, "Tên shop: Hải Sản Làng Chài"].join("\n");
  assert.deepEqual(foodClaimProblems("Chả cá thu chiên vàng giòn — nhắn shop đặt ngay cho bữa tối!", factText), []);
  assert.deepEqual(foodClaimProblems("Túi 500g tiện nấu", factText), [], "khối lượng ĐÚNG dữ kiện thì được");
  assert.equal(foodClaimProblems("Túi 1kg siêu to", factText).length, 1, "khối lượng bịa");
  assert.ok(foodClaimProblems("Đặc sản Phú Quốc chính gốc", factText).length >= 2, "xuất xứ bịa");
  assert.ok(foodClaimProblems("Ăn tốt cho sức khoẻ, tăng đề kháng", `${factText}\ntốt cho sức khỏe`).length >= 1, "công dụng sức khoẻ: KHÔNG BAO GIỜ, kể cả dữ kiện ghi");
  assert.ok(foodClaimProblems("Cá thu 100% nguyên chất", factText).length >= 1);
  assert.deepEqual(foodClaimProblems("Cá thu 100%", `${factText}\nCá thu 100%`), [], "100% có trong dữ kiện thì được");
  assert.ok(foodClaimProblems("Đạt chuẩn VietGAP, HACCP", factText).length >= 2, "chứng nhận bịa");
  assert.ok(foodClaimProblems("Không chất bảo quản", factText).length === 1);
  assert.deepEqual(foodClaimProblems("Hàng làng chài chính hiệu", factText), [], "tên shop là dữ kiện");
  assert.ok(captionProblems([{ headline: "Đặc sản Nha Trang", primaryText: "1kg chả" }], null, factText).length >= 2);
  assert.deepEqual(captionProblems([{ headline: "Đặc sản Nha Trang", primaryText: "1kg chả" }], null, null), [], "thời trang: không luật khẳng định thực phẩm (giữ nguyên)");
  const picked = pickCaptionOptions({ seen: "", options: [{ headline: "Đặc sản Nha Trang", primaryText: "Ngon" }, { headline: "Chả cá thu vàng giòn", primaryText: "Nhắn shop đặt ngay" }] }, { ...ci, formulas: undefined, options: 2 }, 2, null);
  assert.deepEqual(
    picked.options.map((o) => o.headline),
    ["Chả cá thu vàng giòn"],
  );
  assert.equal(picked.claimDropped, 1, "phương án còn khẳng định bịa bị BỎ CẢ, không vá hộ");

  // Gemini trả ảnh: đọc inlineData; chỉ chữ ⇒ lỗi nói rõ; tiền CHƯA BIẾT.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const dec = decodeGeminiImageBody({ candidates: [{ content: { parts: [{ text: "Đây" }, { inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 } });
  assert.ok(dec.contentType === "image/png" && dec.costUsd === null && dec.usage?.outputTokens === 1290);
  assert.throws(() => decodeGeminiImageBody({ candidates: [{ content: { parts: [{ text: "Tôi không vẽ được" }] } }] }), /chỉ trả lời chữ/);

  console.log("✓ Thư viện Media · gói thực phẩm (thuần): ngành theo nhà / mẫu ngành / ghi đè · gen không người, luôn hợp lệ · câu lệnh vẽ + sửa không chữ thời trang, giữ đúng món + bao bì · kiểu / màu thời trang bị bỏ · câu chữ theo dàn ý + dữ kiện · luật khẳng định · thời trang giữ nguyên từng chữ · đọc ảnh Gemini");
}

// ─────────────────────────── 2. TỔ CHỨC THẬT ───────────────────────────

const A = "cfi-food-a";
const B = "cfi-food-b";
const ORG_SECRETS_KEY = "khoa-kiem-thu-creative-food-0123456789abcdefghijklmnopqrstuvwxyz";
/** Khoá BỊA đúng dạng — không bao giờ là khoá thật; fetch là bản giả. */
const KEY_A = "sk-cfiFAKEorgA0123456789abcdefghij";
const KEY_B_GEMINI = "AIzaFAKEcfiOrgB0123456789abcdefghijklmn";
const GEMINI_IMAGE_MODEL = "gemini-test-image-model";

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 7, 7, 9, 1, 2, 3]);
}
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

type Seen = { url: string; method: string; auth: string | null; goog: string | null; body: string; files: string[] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Câu trả lời của OpenAI Responses (đúng hình SDK đọc). */
function responsesBody(text: string) {
  return { id: "resp_fake", object: "response", created_at: 1, status: "completed", model: "gpt-fake-copy", output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}

function makeFetch(seen: Seen[], copyAnswers: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const files: string[] = [];
    let body = "";
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) if (k === "image[]" && typeof v !== "string") files.push((v as File).name);
      body = String(init.body.get("prompt") ?? "");
    } else if (typeof init?.body === "string") body = init.body;
    seen.push({ url, method: init?.method ?? "GET", auth: h.get("authorization"), goog: h.get("x-goog-api-key"), body, files });
    if (url.endsWith("/v1/models") || url.endsWith("/v1beta/models")) return json({ data: [], models: [] });
    if (url === OPENAI_IMAGES_EDIT_URL) {
      // Lỗi giả có lặp lại khoá ⇒ câu lỗi ERP không được lộ khoá.
      if (body.includes("FORCE-401")) return json({ error: { message: `Incorrect API key provided: ${KEY_A}` } }, 401);
      return json({ data: [{ b64_json: Buffer.from(fakeJpeg(seen.length)).toString("base64") }], usage: { input_tokens: 500, output_tokens: 1000, input_tokens_details: { text_tokens: 300, image_tokens: 200 } } });
    }
    if (url.endsWith("/v1/responses")) return json(responsesBody(copyAnswers.shift() ?? copyAnswers[0] ?? "{}"));
    if (url.includes(`/models/${GEMINI_IMAGE_MODEL}:generateContent`)) return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from(PNG).toString("base64") } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 1290 } });
    if (url.includes(":generateContent")) {
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ seen: "Đĩa chả mực vàng", options: [{ headline: "Chả mực vàng giòn", primaryText: "Tối nay có chả mực chiên rồi cả nhà ơi. Nhắn shop đặt ngay!" }] }) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 80 }, modelVersion: "gemini-fake-chat" });
    }
    return json({ error: { message: `fetch giả không biết ${url}` } }, 404);
  }) as typeof fetch;
}

async function cleanupOrgs() {
  const pdb = await getPlatformDb();
  for (const code of [A, B]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [A, B]));
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(org: string): Promise<SessionUser> {
  const u = await withOrganization(org, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) }));
  assert.ok(u, `quản trị của ${org}`);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false }, modules: ["core", "customers", "products", "orders", "marketing"] };
}

/** Mã hàng + ảnh sản phẩm THẬT (đúng đường ghi của tab Nguồn ảnh: lưu điểm ảnh → nguồn PRODUCT_PHOTO gắn mã) + field thực phẩm. */
async function seedProduct(prefix: string, name: string, facts: Record<string, string>) {
  const db = await getDb();
  await db.insert(schema.products).values({ id: `${prefix}prod`, name });
  await db.insert(schema.productVariants).values({ id: `${prefix}var`, productId: `${prefix}prod`, retailPrice: 120_000, retailPriceAfterDiscount: 120_000 });
  await db.insert(schema.customValues).values({ objectKey: "product", recordId: `${prefix}prod`, values: facts });
  const photo = await storeCreativeImage(db, fakeJpeg(1));
  await db.insert(schema.creativeSources).values({ id: `${prefix}photo`, kind: "PRODUCT_PHOTO", productId: `${prefix}prod`, imageId: photo.id, title: "Ảnh thật gói chả" });
  const spy = await storeCreativeImage(db, fakeJpeg(2));
  await db.insert(schema.creativeSources).values({ id: `${prefix}spy`, kind: "SPY", productId: `${prefix}prod`, imageId: spy.id, title: "ảnh đối thủ" });
  const users = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).limit(1);
  return { actor: { id: users[0].id, name: users[0].name } };
}

async function ledger(org: string, feature: string) {
  const pdb = await getPlatformDb();
  return pdb
    .select()
    .from(schema.platformAiUsage)
    .where(and(eq(schema.platformAiUsage.orgCode, org), eq(schema.platformAiUsage.feature, feature)));
}

export async function testCreativeFoodIndustryOrg() {
  await cleanupOrgs();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedFetch = globalThis.fetch;
  const seen: Seen[] = [];
  const copyAnswers: string[] = [];
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  globalThis.fetch = makeFetch(seen, copyAnswers);
  try {
    const modules = ["customers", "products", "orders", "marketing"];
    await provisionOrganization({ code: A, name: "Hải Sản Làng Chài thử", plan: "standard", modules, templateKey: "food-commerce", admin: { email: `admin@${A}.local`, name: "QT A", password: "HaiSan@12345" }, source: "TEST", actor: null });
    await provisionOrganization({ code: B, name: "Shop B thử", plan: "standard", modules, admin: { email: `admin@${B}.local`, name: "QT B", password: "HaiSan@12345" }, source: "TEST", actor: null });
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    const cfg = DEFAULT_CREATIVE_CONFIG;
    const photoOnly = (bytes: Uint8Array): ImageEditInputImage[] => [{ kind: "PRODUCT_PHOTO", bytes, contentType: "image/jpeg" }];

    // ── NHÀ: đường cũ nguyên vẹn ──
    assert.equal(await creativeImageClient(cfg.imageModel), editImage, "nhà ⇒ đúng editImage (khoá môi trường + assertHomeCredentials)");
    assert.equal(await creativeCaptioner(), captionFromImage, "nhà ⇒ đúng captionFromImage");

    let imageId = "";
    await withOrganization(A, async () => {
      const db = await getDb();
      const { actor } = await seedProduct("cfa-", "Chả cá thu", { net_weight: "500g", storage_instruction: "Ngăn đá −18°C" });
      const ind = await readCreativeIndustry(db);
      assert.ok(ind.industry === "FOOD" && ind.basis === "TEMPLATE", JSON.stringify(ind));

      // Chưa có khoá AI của tổ chức ⇒ không vẽ, câu lỗi chỉ đúng việc phải làm; KHÔNG lùi về khoá của nhà.
      const before = await creativeAiStatus(cfg.imageModel);
      assert.equal(before.mode, "NONE");
      const noKey = await creativeImageClient(cfg.imageModel);
      assert.notEqual(noKey, editImage);
      await assert.rejects(() => noKey({ model: cfg.imageModel, prompt: "x", images: photoOnly(fakeJpeg(9)), size: "1024x1024", quality: "low" }), /Kết nối dữ liệu/);
      assert.equal(seen.length, 0, "không request nào khi chưa có khoá");

      // Nhà vẫn chặn: editImage trong ngữ cảnh tổ chức khách NÉM trước fetch (assertHomeCredentials không đổi).
      await assert.rejects(
        () => editImage({ model: cfg.imageModel, prompt: "x", images: photoOnly(fakeJpeg(9)), size: "1024x1024", quality: "low" }, { apiKey: "sk-home-env-FAKE-000000000000000", fetchImpl: globalThis.fetch }),
        (e: unknown) => isConnectorUnavailable(e),
      );
      assert.equal(seen.length, 0);

      // Bật «OpenAI — khoá của tổ chức». Quản trị shop KHÔNG tự lưu khoá AI (lib/saas/visibility.ts) — người vận hành ghi hộ.
      const selfA = await saveConnection(adminA, { connectorKey: "openai-byok", secrets: { apiKey: KEY_A } });
      assert.ok("error" in selfA && selfA.error === CUSTOMER_AI_CONFIG_MANAGED, `shop tự lưu khoá AI của Thư viện Media ⇒ từ chối: ${JSON.stringify(selfA)}`);
      assert.ok("ok" in (await saveAiConnectionAsOperator({ operator: OPERATOR_AI_REF, reason: "kiểm thử", connectorKey: "openai-byok", secrets: { apiKey: KEY_A } })));
      assert.ok("ok" in (await testAiConnectionAsOperator({ connectorKey: "openai-byok", operator: OPERATOR_AI_REF, reason: "kiểm thử" }, { tester: { fetch: globalThis.fetch } })));
      assert.ok("ok" in (await setAiConnectionStatusAsOperator({ connectorKey: "openai-byok", status: "ACTIVE", operator: OPERATOR_AI_REF, reason: "kiểm thử" })));
      const st = await creativeAiStatus(cfg.imageModel);
      assert.ok(st.mode === "BYOK" && st.connectorKey === "openai-byok" && st.imageReady && st.imageModel === cfg.imageModel, JSON.stringify(st));
      seen.length = 0;

      // Thiết kế mới bị chặn ở ĐƯỜNG GHI cho shop thực phẩm.
      const des = await startManualDesignGen(db, { inspirationProductIds: ["cfa-prod"], idea: "" }, cfg, actor, new Date(), { industry: "FOOD" });
      assert.ok(!des.ok && des.error === FOOD_FASHION_ONLY_MESSAGE);

      // Gen tay: kiểu thời trang + màu bị bỏ, câu lệnh thực phẩm.
      const s = await startManualGen(db, { productPhotoSourceId: "cfa-photo", ownAdSourceId: null, idea: "", count: 2, studio: { styles: ["MANNEQUIN", "STUDIO", "LIFESTYLE"], colors: ["Đỏ đô"], quality: "low" } }, cfg, actor, { industry: "FOOD" });
      assert.ok(s.ok, s.ok ? "" : s.error);
      if (!s.ok) return;
      assert.equal(s.requested, 4, "2 bố cục × 2 kiểu thực phẩm × 0 màu");
      const rows = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s.genId));
      for (const r of rows) {
        assert.ok(!FASHION_WORDS.test(r.prompt) && r.prompt.includes(FOOD_PRESERVE_PRODUCT_CLAUSE) && r.color === "" && ["STUDIO", "LIFESTYLE"].includes(r.outputStyle), r.prompt);
        assert.equal((r.genes as Record<string, string>).model, "NONE");
      }

      // Vẽ: KHÔNG tiêm máy vẽ ⇒ đường thật của tổ chức (khoá BYOK), fetch giả.
      const d = await drawManualGen(db, { genId: s.genId });
      assert.equal(d.drawn, 4, JSON.stringify(d));
      const calls = seen.filter((x) => x.url === OPENAI_IMAGES_EDIT_URL);
      assert.equal(calls.length, 4);
      for (const c of calls) {
        assert.equal(c.auth, `Bearer ${KEY_A}`, "vẽ bằng ĐÚNG khoá của tổ chức A");
        assert.ok(c.files.length >= 1 && c.files[0].includes("product_photo"), "ảnh sản phẩm thật đứng đầu");
        assert.ok(!FASHION_WORDS.test(c.body), "câu lệnh gửi đi là câu lệnh thực phẩm");
      }
      const drawn = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s.genId));
      assert.ok(drawn.every((r) => r.status === "GENERATED" && r.imageId && r.costUsd !== ""), "ảnh lưu + tiền theo bảng giá gpt-image");
      imageId = drawn[0].id;
      const img = await ledger(A, "creative_image");
      assert.equal(img.length, 4, "mỗi ảnh một dòng sổ dùng AI");
      assert.ok(img.every((r) => r.billingSource === "BYOK" && r.status === "OK" && r.provider === "openai-byok" && r.requests === 1 && r.outputTokens === 1000), JSON.stringify(img[0]));

      // Hàng rào điểm ảnh còn nguyên trên đường khoá của tổ chức — NÉM trước fetch.
      const client = await creativeImageClient(cfg.imageModel);
      const n0 = seen.length;
      await assert.rejects(() => client({ model: cfg.imageModel, prompt: "x", images: [{ kind: "SPY", bytes: fakeJpeg(3), contentType: "image/jpeg" } as unknown as ImageEditInputImage], size: "1024x1024", quality: "low" }), /ranh giới 2/);
      await assert.rejects(() => client({ model: cfg.imageModel, prompt: "x", images: [{ kind: "OWN_VARIANT", bytes: fakeJpeg(3), contentType: "image/jpeg" }], size: "1024x1024", quality: "low" }), /PRODUCT_PHOTO/);
      assert.equal(seen.length, n0, "không request nào đi khi điểm ảnh không an toàn");

      // Lỗi nhà cung cấp có lặp lại khoá ⇒ câu lỗi ERP không lộ khoá; sổ ghi ERROR.
      await assert.rejects(
        () => client({ model: cfg.imageModel, prompt: "FORCE-401", images: photoOnly(fakeJpeg(4)), size: "1024x1024", quality: "low" }),
        (e: unknown) => e instanceof Error && e.message.includes("HTTP 401") && !e.message.includes(KEY_A),
      );
      assert.equal((await ledger(A, "creative_image")).filter((r) => r.status === "ERROR").length, 1);

      // Máy vẽ của A đem sang ngữ cảnh B ⇒ NÉM trước fetch.
      const n1 = seen.length;
      await assert.rejects(() => withOrganization(B, () => client({ model: cfg.imageModel, prompt: "x", images: photoOnly(fakeJpeg(5)), size: "1024x1024", quality: "low" })), /thuộc tổ chức/);
      assert.equal(seen.length, n1, "khoá của A không rời máy trong ngữ cảnh B");

      // Sửa ảnh thực phẩm: đổi màu bị chặn ở đường ghi.
      const recolor = await startManualEdit(db, { sourceImageId: imageId, request: { color: "Đỏ", layout: null, detail: "" } }, cfg, actor, { industry: "FOOD" });
      assert.ok(!recolor.ok && recolor.error === FOOD_FASHION_ONLY_MESSAGE);
      const mann = await startManualEdit(db, { sourceImageId: imageId, request: { color: "", layout: "MANNEQUIN", detail: "" } }, cfg, actor, { industry: "FOOD" });
      assert.ok(!mann.ok);

      // Duyệt ⇒ câu chữ viết bằng provider BYOK của A: lượt đầu bịa xuất xứ + khối lượng ⇒ viết lại; lượt sau sạch.
      copyAnswers.push(JSON.stringify({ seen: "Đĩa chả cá thu", options: [{ headline: "Đặc sản Phú Quốc", primaryText: "Túi 1kg chả cá thu" }] }));
      copyAnswers.push(JSON.stringify({ seen: "Đĩa chả cá thu", options: [{ headline: "Chả cá thu vàng giòn", primaryText: "Túi 500g, rã đông chiên là có món ngon. Nhắn shop đặt ngay!" }] }));
      const n2 = seen.length;
      const rv = await reviewManualGenImage(db, { imageId, decision: "APPROVE", reason: "" }, actor, new Date());
      assert.ok(rv.ok && rv.caption?.ok, JSON.stringify(rv));
      const copyCalls = seen.slice(n2).filter((x) => x.url.endsWith("/v1/responses"));
      assert.equal(copyCalls.length, 2, "bịa ⇒ viết lại MỘT lần");
      assert.ok(copyCalls.every((c) => c.auth === `Bearer ${KEY_A}`), "câu chữ cũng bằng khoá của A");
      assert.ok(copyCalls[0].body.includes("THỰC PHẨM") && copyCalls[0].body.includes("Khối lượng tịnh: 500g") && copyCalls[0].body.includes("input_image"), "lời dặn thực phẩm + dữ kiện + ảnh");
      assert.ok(copyCalls[1].body.includes("Phú Quốc") && copyCalls[1].body.includes("bỏ khẳng định"), "lượt viết lại nêu đúng khẳng định bịa");
      const [ap] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.id, imageId));
      assert.equal(ap.headline, "Chả cá thu vàng giòn");
      const cp = await ledger(A, "creative_copy");
      assert.ok(cp.length === 1 && cp[0].billingSource === "BYOK" && cp[0].requests === 2 && cp[0].status === "OK", JSON.stringify(cp));
    });

    // ── B: không mẫu ngành ⇒ thời trang; ghi đè thực phẩm; Gemini ──
    await withOrganization(B, async () => {
      const db = await getDb();
      assert.equal((await openActiveConnection("openai-byok")).ok, false, "B không thấy khoá của A");
      assert.equal((await creativeAiStatus(cfg.imageModel)).mode, "NONE");
      assert.equal((await readCreativeIndustry(db)).basis, "DEFAULT");
      assert.ok("ok" in (await writeCreativeIndustry(db, "FOOD")));
      const ind = await readCreativeIndustry(db);
      assert.ok(ind.industry === "FOOD" && ind.basis === "OVERRIDE");
      const { actor } = await seedProduct("cfb-", "Chả mực", { package_size: "Hộp 300g" });

      // Gemini chưa khai model vẽ ⇒ câu chữ được, vẽ KHÔNG (không đoán model). Shop không tự lưu / bật khoá AI — người vận hành ghi hộ.
      for (const r of [await saveConnection(adminB, { connectorKey: "gemini-byok", secrets: { apiKey: KEY_B_GEMINI } }), await setConnectionStatus(adminB, "gemini-byok", "ACTIVE")])
        assert.ok("error" in r && r.error === CUSTOMER_AI_CONFIG_MANAGED, `shop tự ghi khoá AI ⇒ từ chối: ${JSON.stringify(r)}`);
      assert.ok("ok" in (await saveAiConnectionAsOperator({ operator: OPERATOR_AI_REF, reason: "kiểm thử", connectorKey: "gemini-byok", secrets: { apiKey: KEY_B_GEMINI } })));
      assert.ok("ok" in (await testAiConnectionAsOperator({ connectorKey: "gemini-byok", operator: OPERATOR_AI_REF, reason: "kiểm thử" }, { tester: { fetch: globalThis.fetch } })));
      assert.ok("ok" in (await setAiConnectionStatusAsOperator({ connectorKey: "gemini-byok", status: "ACTIVE", operator: OPERATOR_AI_REF, reason: "kiểm thử" })));
      const st0 = await creativeAiStatus(cfg.imageModel);
      assert.ok(st0.mode === "BYOK" && !st0.imageReady && /Model vẽ ảnh/.test(st0.imageReason ?? ""), JSON.stringify(st0));
      const n0 = seen.length;
      await assert.rejects(async () => (await creativeImageClient(cfg.imageModel))({ model: "x", prompt: "x", images: photoOnly(fakeJpeg(6)), size: "1024x1024", quality: "low" }), /Model vẽ ảnh/);
      assert.equal(seen.length, n0);

      // Khai model vẽ ⇒ vẽ bằng khoá của B, ảnh PNG, tiền CHƯA BIẾT.
      assert.ok("ok" in (await saveAiConnectionAsOperator({ operator: OPERATOR_AI_REF, reason: "kiểm thử", connectorKey: "gemini-byok", settings: { imageModel: GEMINI_IMAGE_MODEL }, secrets: {} })));
      assert.ok("ok" in (await testAiConnectionAsOperator({ connectorKey: "gemini-byok", operator: OPERATOR_AI_REF, reason: "kiểm thử" }, { tester: { fetch: globalThis.fetch } })));
      assert.ok("ok" in (await setAiConnectionStatusAsOperator({ connectorKey: "gemini-byok", status: "ACTIVE", operator: OPERATOR_AI_REF, reason: "kiểm thử" })));
      const st1 = await creativeAiStatus(cfg.imageModel);
      assert.ok(st1.mode === "BYOK" && st1.imageReady && st1.imageModel === GEMINI_IMAGE_MODEL, JSON.stringify(st1));
      const s = await startManualGen(db, { productPhotoSourceId: "cfb-photo", ownAdSourceId: null, idea: "", count: 1 }, { ...cfg, imageModel: GEMINI_IMAGE_MODEL }, actor, { industry: "FOOD" });
      assert.ok(s.ok, s.ok ? "" : s.error);
      if (!s.ok) return;
      // Ảnh SPY của cùng mã không bao giờ lọt vào lượt vẽ.
      const d = await drawManualGen(db, { genId: s.genId });
      assert.equal(d.drawn, 1, JSON.stringify(d));
      const g = seen.filter((x) => x.url.includes(`/models/${GEMINI_IMAGE_MODEL}:generateContent`));
      assert.equal(g.length, 1);
      assert.equal(g[0].goog, KEY_B_GEMINI, "khoá Gemini của B đi trong tiêu đề");
      assert.ok(!g[0].url.includes(KEY_B_GEMINI), "khoá không nằm trong URL");
      assert.ok(!FASHION_WORDS.test(JSON.parse(g[0].body).contents[0].parts[0].text), "câu lệnh thực phẩm");
      assert.equal(JSON.parse(g[0].body).contents[0].parts.filter((p: { inlineData?: unknown }) => p.inlineData).length, 1, "chỉ đúng ảnh sản phẩm thật, không ảnh SPY");
      const [row] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s.genId));
      assert.ok(row.status === "GENERATED" && row.costUsd === "", "Gemini: tiền CHƯA BIẾT ⇒ chuỗi rỗng, không 0");
      const [stored] = await db.select({ ct: schema.creativeImages.contentType }).from(schema.creativeImages).where(eq(schema.creativeImages.id, row.imageId ?? ""));
      assert.equal(stored.ct, "image/png");
      const lb = await ledger(B, "creative_image");
      assert.ok(lb.length === 1 && lb[0].costUsd === null && lb[0].provider === "gemini-byok", JSON.stringify(lb));
      assert.equal((await ledger(A, "creative_image")).length, 5, "sổ của A không đổi vì lượt của B");

      // Câu chữ bằng Gemini của B.
      const rv = await reviewManualGenImage(db, { imageId: row.id, decision: "APPROVE", reason: "" }, actor, new Date());
      assert.ok(rv.ok && rv.caption?.ok, JSON.stringify(rv));
      assert.equal((await ledger(B, "creative_copy")).length, 1);
    });

    console.log("✓ Thư viện Media · tổ chức khách: vẽ + viết bằng khoá AI của CHÍNH tổ chức (OpenAI · Gemini), câu lệnh thực phẩm, sổ dùng AI ghi đúng tổ chức · hàng rào điểm ảnh + chủ khoá chặn trước fetch · lỗi không lộ khoá · Gemini không đoán model vẽ · nhà giữ editImage / captionFromImage");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrgs();
  }
}
