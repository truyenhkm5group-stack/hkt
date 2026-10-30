/**
 * ═══════════ SĂN KHÁCH SỈ QUỐC TẾ / B2B — BỘ QUÉT GOOGLE PLACES MỞ RỘNG (27/10/2026) ═══════════
 *
 * Chủ shop chốt: tìm khách sỉ cả trong nước lẫn nước ngoài bằng đúng bộ quét đang chạy — CHƯA gửi gì. Bài này khoá:
 *  1. Vùng quét quốc tế (areas-intl.ts): 15 nước, khoá `intl xx` không bao giờ đụng ô trong nước; khoá ô cũ không đổi.
 *  2. Từ khoá theo ngôn ngữ: tiếng Việt chỉ quét trong nước, tiếng Anh mọi nước ngoài, bản địa đúng nước; chữ CJK không
 *     gộp làm một ô.
 *  3. Ngôn ngữ / vùng / tâm thiên vị đi tới Google (và qua trạm chuyển tiếp nguyên vẹn); lượt trong nước gửi y như cũ.
 *  4. Mẫu «HSLC – International Seafood Importers (pilot)»: DRAFT, bắt buộc website, ước tính chi phí = số truy vấn × giá SKU.
 *  5. Phân khúc B2B mới + hệ số «tự nhận là nhà buôn» — tất định, trần 15, ngưỡng A–D không đổi, khoá phân khúc cũ giữ nguyên.
 *
 * THUẦN — không CSDL, không mạng (fetch giả; luật 65). Phần CSDL (mẫu DRAFT trong tổ chức thật) nằm trong
 * tests/wholesale-lead-hunter.test.ts::testDb.
 */
import assert from "node:assert/strict";
import { normalizeProvince, provinceRegion } from "@/lib/constants/vn-regions";
import { placeDetails, placesLocale, textSearch } from "@/lib/integrations/google-places/client";
import { parseCustomAreas, SEARCH_PROVINCES } from "@/lib/wholesale/areas";
import { INTL_SEARCH_PROVINCES, intlCellContext, intlCountryByName, intlSearchProvince, isIntlProvinceKey } from "@/lib/wholesale/areas-intl";
import { campaignCostEstimate, HSLC_INTL_TEMPLATE_KEY, HSLC_INTL_TEMPLATE_NAME, HSLC_TEMPLATES, hslcTemplateValues, intlPilotTemplateValues, resolveKeywordGroups } from "@/lib/wholesale/campaigns";
import { DEFAULT_KEYWORD_GROUPS, DEFAULT_LEAD_HUNTER_CONFIG, DEFAULT_TARGET_SEGMENTS, skuCostMicros } from "@/lib/wholesale/config";
import { ALL_KEYWORD_GROUPS, INTL_KEYWORD_GROUPS } from "@/lib/wholesale/keywords-intl";
import { googlePlacesProvider } from "@/lib/wholesale/providers";
import { cellKeyOf, enabledKeywordEntries, keywordFold, planTextCells, queryTextOf } from "@/lib/wholesale/query-plan";
import { B2B_INTENT_BONUS, DEFAULT_GRADE_THRESHOLDS, scoreLead, type ScoreInput } from "@/lib/wholesale/scoring";
import { b2bSignal, classifySegment, foldVietnamese, LEAD_SEGMENT_LABEL, LEAD_SEGMENTS, passesTargetSegments, SEGMENT_POINTS } from "@/lib/wholesale/segments";
import { handle as relayHandle } from "../deploy/places-relay/relay.js";

const API_KEY = "AIzaFAKE_intl_discovery_key_0123456789abcd";

/** 17 khoá phân khúc đã lưu ở `wholesale_leads.segment` trước 27/10/2026 — đúng thứ tự, không được đổi tên / bỏ. */
const LEGACY_SEGMENTS = ["SPECIALTY_STORE", "MOM_BABY", "GROCERY", "EATERY", "SEAFOOD_RESTAURANT", "HOTPOT", "BBQ", "BUFFET", "CATERING", "PUB_BEER", "HOTEL_RESORT", "FROZEN_FOOD_STORE", "RESTAURANT", "SUPERMARKET", "OTHER_FOOD", "NOT_FIT", "UNCLASSIFIED"];

function testIntlAreas() {
  const isoRequired = ["sg", "my", "th", "jp", "kr", "tw", "hk", "au", "us", "ca", "gb", "de", "fr", "nl", "ae"];
  const keys = INTL_SEARCH_PROVINCES.map((p) => p.key);
  assert.deepEqual([...keys].sort(), isoRequired.map((c) => `intl ${c}`).sort(), "đủ 15 nước chủ shop yêu cầu, mỗi nước một lần");
  for (const p of INTL_SEARCH_PROVINCES) {
    assert.ok(isIntlProvinceKey(p.key));
    assert.equal(normalizeProvince(p.key), p.key, `${p.key}: normalizeProvince giữ nguyên khoá (engine so tỉnh lead với tỉnh ô bằng nó)`);
    assert.equal(provinceRegion(p.key), null, `${p.key}: không bao giờ bị đọc nhầm thành một tỉnh VN`);
    assert.ok(p.locale && p.locale.languageCode === "en" && /^[A-Z]{2}$/.test(p.locale.regionCode) && p.locale.keywordLangs.includes("en"));
    assert.equal(p.locale.regionCode.toLowerCase(), p.key.slice(5), "regionCode = mã nước của khoá");
    assert.ok(p.areas.length >= 1);
    assert.equal(new Set(p.areas.map((a) => a.code)).size, p.areas.length, `${p.key}: mã thành phố trùng`);
    for (const a of p.areas) {
      assert.ok(a.center && Math.abs(a.center.lat) <= 90 && Math.abs(a.center.lng) <= 180 && a.center.radiusM >= 100 && a.center.radiusM <= 50_000, `${p.key}/${a.code}: tâm thiên vị hợp lệ`);
      assert.equal(a.coastal, false);
    }
  }
  for (const vn of SEARCH_PROVINCES) {
    assert.ok(!isIntlProvinceKey(vn.key), `${vn.key}: tỉnh VN không mang tiền tố quốc tế`);
    assert.equal(intlCountryByName(vn.label), null, `${vn.label}: tên tỉnh không bị hiểu thành một nước`);
    assert.equal(intlCountryByName(vn.queryName), null);
  }
  assert.equal(intlCountryByName("Nhật Bản")?.key, "intl jp");
  assert.equal(intlCountryByName("Japan")?.key, "intl jp");
  assert.equal(intlCountryByName("Hàn Quốc")?.key, "intl kr");
  assert.equal(intlCountryByName("Đức")?.key, "intl de");
  assert.equal(intlCountryByName("Sao Hoả"), null, "không nhận ra ⇒ không đoán");
  assert.equal(intlSearchProvince("INTL  SG")?.key, "intl sg");
  // Khu vực tự khai: tên nước ⇒ khoá quốc tế + ngôn ngữ; thành phố có trong danh sách mang tâm, thành phố lạ thì không.
  const custom = parseCustomAreas("Nhật Bản: Tokyo, Kobe");
  const jp = custom.provinces[0]!;
  assert.equal(jp.key, "intl jp");
  assert.equal(jp.locale?.regionCode, "JP");
  assert.ok(jp.areas.find((a) => a.code === "tokyo")?.center);
  assert.equal(jp.areas.find((a) => a.code === "kobe")?.center, undefined);
  // Tỉnh trong nước: khu vực giữ đúng chữ người gõ như trước, không mang locale / tâm.
  const vn = parseCustomAreas("Đà Nẵng: hải châu").provinces[0]!;
  assert.equal(vn.areas[0]!.name, "hải châu");
  assert.equal(vn.locale, undefined);
  assert.equal(vn.areas[0]!.center, undefined);
  // Ngữ cảnh lượt tìm: ô trong nước ⇒ null (client gửi vi/VN như cũ).
  assert.equal(intlCellContext("ha noi", "cau-giay"), null);
  const sg = intlCellContext("intl sg", "singapore");
  assert.deepEqual(sg, { languageCode: "en", regionCode: "SG", bias: { lat: 1.3521, lng: 103.8198, radiusM: 25_000 } });
  assert.deepEqual(intlCellContext("intl jp", "kobe"), { languageCode: "en", regionCode: "JP", bias: null }, "thành phố tự khai ⇒ vẫn đúng nước, không thiên vị toạ độ");
}

function testCellKeysAndKeywords() {
  // Khoá ô CŨ không đổi: mọi từ khoá tiếng Việt cho ra đúng chuỗi của công thức cũ (foldVietnamese).
  for (const g of DEFAULT_KEYWORD_GROUPS) for (const k of g.keywords) assert.equal(keywordFold(k), foldVietnamese(k).trim(), `«${k}»: khoá ô trong nước giữ nguyên`);
  assert.equal(cellKeyOf("TEXT", "Nhà hàng hải sản", "da nang", "hai-chau"), "TEXT|nha-hang-hai-san|da-nang|hai-chau");
  // CJK không bị gộp thành chuỗi rỗng: hai từ khoá Nhật là hai ô, và khử trùng giữ cả hai.
  assert.notEqual(cellKeyOf("TEXT", "水産卸", "intl jp", "tokyo"), cellKeyOf("TEXT", "食品卸", "intl jp", "tokyo"));
  assert.equal(cellKeyOf("TEXT", "水産卸", "intl jp", "tokyo"), "TEXT|水産卸|intl-jp|tokyo");
  const ja = INTL_KEYWORD_GROUPS.find((g) => g.key === "intl-ja")!;
  assert.equal(enabledKeywordEntries([{ ...ja, enabled: true }]).length, ja.keywords.length);
  // Ô quốc tế KHÔNG BAO GIỜ trùng ô trong nước — kể cả cùng từ khoá (từ khoá trơn áp mọi nơi).
  const all = planTextCells(["seafood importer", "nhà hàng hải sản"], [...SEARCH_PROVINCES, ...INTL_SEARCH_PROVINCES], 100_000);
  assert.equal(all.truncated, false);
  assert.equal(new Set(all.cells.map((c) => c.cellKey)).size, all.cells.length, "không hai ô nào chung khoá");
  const vnKeys = new Set(all.cells.filter((c) => !isIntlProvinceKey(c.provinceKey)).map((c) => c.cellKey));
  const intlCells = all.cells.filter((c) => isIntlProvinceKey(c.provinceKey));
  assert.ok(intlCells.length > 0 && intlCells.every((c) => !vnKeys.has(c.cellKey) && c.cellKey.includes("|intl-")));
  // Định tuyến theo ngôn ngữ: «quán nhậu» (vi) chỉ trong nước; tiếng Anh mọi nước ngoài; tiếng Nhật chỉ Nhật.
  const hn = { ...SEARCH_PROVINCES.find((p) => p.key === "ha noi")!, areas: SEARCH_PROVINCES.find((p) => p.key === "ha noi")!.areas.slice(0, 1) };
  const tokyo = { ...intlSearchProvince("intl jp")!, areas: intlSearchProvince("intl jp")!.areas.filter((a) => a.code === "tokyo") };
  const sydney = { ...intlSearchProvince("intl au")!, areas: intlSearchProvince("intl au")!.areas.filter((a) => a.code === "sydney") };
  const plan = planTextCells(
    [
      { text: "quán nhậu", lang: "vi" },
      { text: "seafood importer", lang: "en" },
      { text: "水産卸", lang: "ja" },
    ],
    [hn, tokyo, sydney],
  );
  const by = (key: string) => plan.cells.filter((c) => c.provinceKey === key).map((c) => c.keyword).sort();
  assert.deepEqual(by("ha noi"), ["quán nhậu"]);
  assert.deepEqual(by("intl jp"), ["seafood importer", "水産卸"].sort());
  assert.deepEqual(by("intl au"), ["seafood importer"]);
  assert.equal(plan.cells.find((c) => c.provinceKey === "intl jp" && c.keyword === "seafood importer")!.queryText, "seafood importer Tokyo Japan");
  assert.equal(queryTextOf("seafood importer", "Singapore", "Singapore"), "seafood importer Singapore", "thành phố-quốc gia không lặp tên");
  // Nhóm từ khoá: khoá không trùng; mọi nhóm quốc tế TẮT sẵn; nhóm trong nước mang `vi`; ngôn ngữ bản địa có nước dùng.
  assert.equal(new Set(ALL_KEYWORD_GROUPS.map((g) => g.key)).size, ALL_KEYWORD_GROUPS.length);
  assert.ok(INTL_KEYWORD_GROUPS.every((g) => !g.enabled), "quét tốn tiền ⇒ nhóm quốc tế không tự bật");
  assert.ok(DEFAULT_KEYWORD_GROUPS.every((g) => g.lang === "vi"));
  const langs = new Set(INTL_SEARCH_PROVINCES.flatMap((p) => p.locale!.keywordLangs));
  for (const g of INTL_KEYWORD_GROUPS) assert.ok(langs.has(g.lang), `${g.key}: ngôn ngữ ${g.lang} phải có nước dùng, nếu không nhóm không bao giờ sinh ô`);
  const segs = new Set(INTL_KEYWORD_GROUPS.flatMap((g) => g.segments));
  for (const s of ["SEAFOOD_IMPORTER", "ASIAN_FOOD_WHOLESALE", "FOODSERVICE_DISTRIBUTOR", "PRIVATE_LABEL_OEM", "RESTAURANT", "SUPERMARKET"] as const) assert.ok(segs.has(s), `phân khúc ${s} có nhóm từ khoá`);
  // Chiến dịch trong nước dựng từ form cũ (chỉ gửi nhóm trong nước) ⇒ nhóm quốc tế lưu ở trạng thái TẮT, không đổi số ô.
  const groups = resolveKeywordGroups(DEFAULT_KEYWORD_GROUPS.map((g) => ({ key: g.key, enabled: g.enabled })));
  assert.ok(groups.filter((g) => INTL_KEYWORD_GROUPS.some((x) => x.key === g.key)).every((g) => !g.enabled));
  assert.deepEqual(enabledKeywordEntries(groups).map((e) => e.text), enabledKeywordEntries(DEFAULT_KEYWORD_GROUPS).map((e) => e.text));
}

type Seen = { url: string; body: Record<string, unknown> | null };
function fakeGoogle(seen: Seen[]): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    seen.push({ url: input, body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const one = { id: "ChIJintl000000001", displayName: { text: "Ocean Seafood Importers Pte Ltd" }, formattedAddress: "1 Fishery Port Rd, Singapore 619742", types: ["wholesaler"], websiteUri: "https://ocean.example" };
    return new Response(JSON.stringify(input.includes("searchText") ? { places: [one] } : one), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function testLocaleOnTheWire() {
  const seen: Seen[] = [];
  const opts = { apiKey: API_KEY, timeoutMs: 5000, maxRetries: 0 };
  // Trong nước: thân yêu cầu y hệt trước 27/10/2026 — không có khoá mới nào.
  const vn = await textSearch(opts, { textQuery: "quán nhậu Cầu Giấy Hà Nội", tier: "ENTERPRISE" }, { fetch: fakeGoogle(seen) });
  assert.ok(vn.ok);
  assert.deepEqual(seen[0]!.body, { textQuery: "quán nhậu Cầu Giấy Hà Nội", languageCode: "vi", regionCode: "VN", pageSize: 20 });
  // Quốc tế qua nhà cung cấp (đúng đường engine đi): ngôn ngữ + vùng + tâm thiên vị.
  const provider = googlePlacesProvider(opts, { fetch: fakeGoogle(seen) });
  const ctx = intlCellContext("intl sg", "singapore")!;
  const r = await provider.search({ mode: "TEXT", textQuery: "seafood importer Singapore", tier: "ENTERPRISE", pageToken: null, locale: { languageCode: ctx.languageCode, regionCode: ctx.regionCode }, bias: ctx.bias });
  assert.ok(r.ok && r.places[0]?.website === "https://ocean.example");
  assert.deepEqual(seen[1]!.body, { textQuery: "seafood importer Singapore", languageCode: "en", regionCode: "SG", pageSize: 20, locationBias: { circle: { center: { latitude: 1.3521, longitude: 103.8198 }, radius: 25_000 } } });
  const d = await placeDetails(opts, { placeId: "ChIJintl000000001", full: false, locale: { languageCode: "en", regionCode: "JP" } }, { fetch: fakeGoogle(seen) });
  assert.ok(d.ok);
  assert.ok(seen[2]!.url.endsWith("?languageCode=en&regionCode=JP"), seen[2]!.url);
  await placeDetails(opts, { placeId: "ChIJintl000000001", full: false }, { fetch: fakeGoogle(seen) });
  assert.ok(seen[3]!.url.endsWith("?languageCode=vi&regionCode=VN"), "chi tiết trong nước giữ nguyên");
  // Mã lạ không đi nguyên văn sang Google.
  assert.deepEqual(placesLocale({ languageCode: "en&x=1", regionCode: "sg" }), { languageCode: "vi", regionCode: "VN" });
  assert.deepEqual(placesLocale({ languageCode: "zh-Hant", regionCode: "TW" }), { languageCode: "zh-Hant", regionCode: "TW" });
  // Trạm chuyển tiếp (deploy/places-relay): thân POST đi NGUYÊN VẸN, chuỗi truy vấn GET giữ nguyên ⇒ languageCode / regionCode
  // / locationBias tới Google không cần sửa trạm.
  const SECRET = "mat-khau-tram-kiem-thu-0123456789";
  const up: { url: string; body: string | undefined }[] = [];
  const upFetch = (async (url: string, init: RequestInit) => {
    up.push({ url, body: init.body as string | undefined });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const body = JSON.stringify(seen[1]!.body);
  const post = await relayHandle({ method: "POST", url: "/v1/places:searchText", headers: { "x-relay-secret": SECRET, "x-goog-api-key": API_KEY, "x-goog-fieldmask": "places.id" }, body }, { secret: SECRET, fetchImpl: upFetch });
  assert.equal(post.status, 200);
  assert.equal(up[0]!.body, body, "trạm không lọc / không sửa thân yêu cầu");
  const get = await relayHandle({ method: "GET", url: "/v1/places/ChIJintl000000001?languageCode=en&regionCode=JP", headers: { "x-relay-secret": SECRET, "x-goog-api-key": API_KEY, "x-goog-fieldmask": "id" }, body: "" }, { secret: SECRET, fetchImpl: upFetch });
  assert.equal(get.status, 200);
  assert.equal(up[1]!.url, "https://places.googleapis.com/v1/places/ChIJintl000000001?languageCode=en&regionCode=JP");
}

function testPilotTemplate() {
  const t = intlPilotTemplateValues();
  assert.equal(t.name, HSLC_INTL_TEMPLATE_NAME);
  assert.equal(HSLC_INTL_TEMPLATE_KEY, "hslc-intl-seafood-importers-pilot");
  assert.ok(!HSLC_TEMPLATES.map((x): string => x.key).includes(HSLC_INTL_TEMPLATE_KEY), "khoá mẫu quốc tế không trùng ba mẫu trong nước");
  assert.equal(t.requireWebsite, true, "thu email từ website ⇒ bắt buộc website");
  assert.equal(t.requirePhone, false, "SĐT nước ngoài chưa chuẩn hoá được ⇒ bắt buộc SĐT là lọc bỏ mọi lead");
  assert.equal(t.discoveryTier, "ENTERPRISE");
  assert.ok(t.maxLeads <= 100, "mẫu thử: số lead tối đa nhỏ");
  assert.deepEqual(t.provinces.map((p) => p.key), ["intl sg", "intl my", "intl au"], "2–3 nước");
  assert.ok(t.provinces.every((p) => isIntlProvinceKey(p.key) && p.locale && p.areas.every((a) => a.center)));
  assert.deepEqual(t.keywordGroups.filter((g) => g.enabled).map((g) => g.key), ["intl-seafood-importer"]);
  assert.ok(t.targetSegments.every((s) => (LEAD_SEGMENTS as readonly string[]).includes(s)));
  // Ước tính = số truy vấn × giá SKU mà engine dùng (Text Search Enterprise, mức của mẫu).
  const cfg = DEFAULT_LEAD_HUNTER_CONFIG;
  const row = { ...t, nearbyLat: null, nearbyLng: null, radiusM: null };
  const e = campaignCostEstimate(row, cfg);
  const cities = t.provinces.reduce((n, p) => n + p.areas.length, 0);
  const kw = t.keywordGroups.find((g) => g.enabled)!.keywords.length;
  assert.equal(cities, 4, "Singapore · Kuala Lumpur · Sydney · Melbourne");
  assert.equal(e.cells, cities * kw);
  assert.equal(e.cells, 12);
  assert.equal(e.searchSku, "TEXT_SEARCH_ENTERPRISE");
  const unit = skuCostMicros("TEXT_SEARCH_ENTERPRISE", cfg);
  assert.equal(unit, 35_000, "35 US$ / 1.000 lượt");
  assert.equal(e.minMicros, 12 * unit, "ít nhất = 12 truy vấn × 1 trang × đơn giá");
  assert.equal(e.typicalMicros, Math.round(12 * 1.5 * unit));
  assert.equal(e.maxMicros, 12 * cfg.maxPagesPerCell * unit, "Enterprise: không có lượt chi tiết");
  // Đổi đơn giá ở cấu hình ⇒ ước tính đổi theo (không có giá nào ghi cứng ở UI).
  const pricier = { ...cfg, skuPriceUsdPer1000: { ...cfg.skuPriceUsdPer1000, TEXT_SEARCH_ENTERPRISE: 40 } };
  assert.equal(campaignCostEstimate(row, pricier).minMicros, 12 * 40_000);
}

function intlInput(over: Partial<ScoreInput> = {}): ScoreInput {
  return { segment: "SEAFOOD_IMPORTER", segmentEvidence: "tên có «seafood importers»", reviewCount: 12, rating: 4.6, businessStatus: "OPERATIONAL", phoneKind: null, hasWebsite: true, hasOtherChannel: true, provinceKey: "intl sg", provinceLabel: "Singapore", siblingCount: 0, branchHint: false, hasAddress: true, hasName: true, b2bSignal: "tên có «importers»", ...over };
}

function testSegmentsAndScoring() {
  // Khoá cũ giữ nguyên tên + thứ tự; khoá mới chỉ THÊM vào cuối.
  assert.deepEqual(LEAD_SEGMENTS.slice(0, LEGACY_SEGMENTS.length), LEGACY_SEGMENTS);
  assert.deepEqual(LEAD_SEGMENTS.slice(LEGACY_SEGMENTS.length), ["SEAFOOD_IMPORTER", "ASIAN_FOOD_WHOLESALE", "FOODSERVICE_DISTRIBUTOR", "PRIVATE_LABEL_OEM"]);
  for (const s of LEAD_SEGMENTS) {
    assert.ok(LEAD_SEGMENT_LABEL[s], `${s}: có nhãn`);
    assert.ok(SEGMENT_POINTS[s].fit >= 0 && SEGMENT_POINTS[s].fit <= 30 && SEGMENT_POINTS[s].intent >= 0 && SEGMENT_POINTS[s].intent <= 15, `${s}: trong trần`);
  }
  for (const s of DEFAULT_TARGET_SEGMENTS) assert.ok(LEGACY_SEGMENTS.includes(s), "mục tiêu trong nước không đổi");
  // Phân nhóm B2B (ô QUỐC TẾ) — chứng cứ trong tên, đủ ngôn ngữ; «seafood» trơn vẫn là nhà hàng.
  const seg = (name: string, types: string[] = []) => classifySegment({ name, types }, { b2b: true }).segment;
  assert.equal(seg("Ocean Seafood Trading Pte Ltd"), "SEAFOOD_IMPORTER");
  assert.equal(seg("Frozen Seafood Distributor Sydney"), "SEAFOOD_IMPORTER", "không phải cửa hàng đông lạnh");
  assert.equal(seg("丸八水産卸株式会社"), "SEAFOOD_IMPORTER");
  assert.equal(seg("부산 수산물 도매 센터"), "SEAFOOD_IMPORTER");
  assert.equal(seg("大成海鮮批發"), "SEAFOOD_IMPORTER");
  assert.equal(seg("Hamburger Fischgroßhandel GmbH"), "SEAFOOD_IMPORTER", "từ ghép tiếng Đức");
  assert.equal(seg("Asia-Großhandel Berlin"), "ASIAN_FOOD_WHOLESALE");
  assert.equal(seg("Saigon Asian Food Importers"), "ASIAN_FOOD_WHOLESALE");
  assert.equal(seg("Metro Foodservice"), "FOODSERVICE_DISTRIBUTOR");
  assert.equal(seg("Grossiste Alimentaire Paris 13"), "FOODSERVICE_DISTRIBUTOR");
  assert.equal(seg("Lim Brothers Pty", ["wholesaler", "establishment"]), "FOODSERVICE_DISTRIBUTOR", "loại hình wholesaler ⇒ nhóm phân phối chung, không nâng thành nhập khẩu hải sản");
  assert.equal(seg("Golden Private Label Foods"), "PRIVATE_LABEL_OEM");
  assert.equal(seg("Ocean Seafood Restaurant", ["restaurant"]), "SEAFOOD_RESTAURANT", "«seafood» trơn vẫn đi luật nhà hàng");
  assert.notEqual(seg("磯丸水産 新宿店", ["restaurant"]), "SEAFOOD_IMPORTER", "«水産» trơn là chuỗi quán nhậu, không phải nhà buôn");
  assert.equal(seg("Nhà hàng Hải Sản Biển Đông", ["restaurant"]), "SEAFOOD_RESTAURANT", "luật trong nước không đổi");
  // TRONG NƯỚC (mặc định, không `b2b`): luật B2B và loại hình wholesaler KHÔNG áp — một nhà phân phối VN tên «… Food
  // Distributor» vẫn qua bộ lọc nhóm khách của chiến dịch VN mặc định (lead review 27/10/2026: không hồi quy im lặng).
  const vnSeg = (name: string, types: string[] = []) => classifySegment({ name, types }).segment;
  const vnTargets = [...DEFAULT_TARGET_SEGMENTS];
  for (const [name, types] of [["Minh Phát Food Distributor", ["wholesaler"]], ["Thực phẩm Minh Phát Foodservice", []], ["Hải Sản Minh Phát Food Distributor", ["wholesaler"]], ["Ocean Seafood Trading Hải Phòng", []]] as const) {
    const s = vnSeg(name, [...types]);
    assert.ok(!["SEAFOOD_IMPORTER", "ASIAN_FOOD_WHOLESALE", "FOODSERVICE_DISTRIBUTOR", "PRIVATE_LABEL_OEM"].includes(s), `${name}: ô trong nước không ra phân khúc B2B (${s})`);
    assert.ok(passesTargetSegments(vnTargets, s), `${name}: qua bộ lọc nhóm khách mặc định trong nước (${s})`);
    for (const t of [1, 2, 3] as const) assert.ok(passesTargetSegments(hslcTemplateValues(t).targetSegments, s), `${name}: qua bộ lọc của mẫu VN ${t}`);
  }
  assert.equal(vnSeg("Minh Phát Food Distributor", ["wholesaler"]), "UNCLASSIFIED", "như trước: không chứng cứ trong nước ⇒ chưa phân loại, không loại");
  assert.equal(vnSeg("Ocean Seafood Trading Hải Phòng"), "SEAFOOD_RESTAURANT", "như trước 27/10: chữ «seafood» đi luật cũ");
  assert.ok(passesTargetSegments([], "SEAFOOD_IMPORTER") && passesTargetSegments(["GROCERY"], "UNCLASSIFIED") && !passesTargetSegments(["GROCERY"], "SEAFOOD_IMPORTER"));
  assert.equal(seg("Hải sản khô Hạ Long Cô Lan"), "SPECIALTY_STORE");
  // Dấu hiệu buôn sỉ.
  assert.equal(b2bSignal({ name: "Ocean Seafood Importers" }), "tên có «importers»");
  assert.equal(b2bSignal({ name: "X Pty", types: ["wholesaler"] }), "loại hình «wholesaler»");
  assert.equal(b2bSignal({ name: "丸八水産卸" }), "tên có «卸»");
  assert.equal(b2bSignal({ name: "Nhà hàng Biển Đông" }), null);
  // Chấm điểm: tất định, hệ số +3 vào ý định mua trong trần 15, ngưỡng hạng không đổi.
  assert.deepEqual(DEFAULT_GRADE_THRESHOLDS, { A: 80, B: 65, C: 45 });
  assert.equal(B2B_INTENT_BONUS, 3);
  const opts = { areas: DEFAULT_LEAD_HUNTER_CONFIG.serviceAreas };
  const a = scoreLead(intlInput(), opts);
  assert.deepEqual(a, scoreLead(intlInput(), opts), "cùng dữ liệu ⇒ cùng điểm, cùng lý do");
  const intentOf = (r: ReturnType<typeof scoreLead>) => r.components.find((c) => c.key === "purchaseIntent")!;
  assert.equal(intentOf(a).points, SEGMENT_POINTS.SEAFOOD_IMPORTER.intent + B2B_INTENT_BONUS);
  assert.match(intentOf(a).reason, /importers/);
  const noSig = scoreLead(intlInput({ b2bSignal: null }), opts);
  assert.equal(intentOf(noSig).points, SEGMENT_POINTS.SEAFOOD_IMPORTER.intent);
  assert.equal(a.score - noSig.score, B2B_INTENT_BONUS);
  assert.equal(intentOf(scoreLead(intlInput({ segment: "SPECIALTY_STORE" }), opts)).points, 15, "hệ số không vượt trần 15");
  const loc = a.components.find((c) => c.key === "location")!;
  assert.equal(loc.points, 0);
  assert.match(loc.reason, /nước ngoài/, "nói đúng lý do: thị trường nước ngoài chưa khai vùng xuất khẩu");
  // Lead trong nước không truyền `b2bSignal` ⇒ điểm y như trước khi có trường này.
  const vnBase: ScoreInput = { ...intlInput({ segment: "SEAFOOD_RESTAURANT", provinceKey: "da nang", provinceLabel: "Đà Nẵng", phoneKind: "MOBILE" }) };
  delete vnBase.b2bSignal;
  assert.deepEqual(scoreLead(vnBase, opts), scoreLead({ ...vnBase, b2bSignal: null }, opts));
}

export async function testWholesaleIntlDiscovery() {
  testIntlAreas();
  testCellKeysAndKeywords();
  await testLocaleOnTheWire();
  testPilotTemplate();
  testSegmentsAndScoring();
  console.log("✓ Săn khách sỉ quốc tế: 15 nước · ô quốc tế không đụng ô VN · từ khoá theo ngôn ngữ · vi/VN giữ nguyên, en/SG + thiên vị toạ độ · trạm chuyển tiếp nguyên vẹn · mẫu pilot DRAFT + website · ước tính = truy vấn × giá SKU · phân khúc B2B tất định");
}
