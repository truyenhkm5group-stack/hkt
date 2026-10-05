/**
 * ═══════════ SĂN KHÁCH SỈ (module `wholesale_leads`, 0197) ═══════════
 *
 *  1. THUẦN — chuẩn hoá SĐT VN (+84 / 84 / 0 cùng một số, không bịa số), phân nhóm, chấm điểm xác định, kế hoạch ô quét +
 *     ước tính chi phí, khoá khử trùng, đọc trang liên hệ, rào SSRF, client Google Places (khoá trong TIÊU ĐỀ, field mask
 *     đúng mức, thử lại 5xx, KHÔNG thử lại 403), lời chào chặn bịa, cấu hình.
 *  2. TỔ CHỨC THẬT `wl-hslc`: kết nối «google-places» lưu → kiểm tra → bật; job `wholesale-leads` quét bằng Google GIẢ
 *     (fetch thay thế, không mạng thật — luật 65); lọc đóng cửa / sai nhóm / thiếu SĐT; khử trùng SĐT; chấm điểm; tự lên «Đủ
 *     điều kiện»; quét lại cùng Place ID 10 lần vẫn MỘT lead; hai lượt song song không nhân đôi; tạm dừng → tiếp tục đúng
 *     chỗ; lỗi API thử lại không nhân đôi; trần ngân sách tự dừng + báo + tự mở lại ngày sau; không liên hệ chặn mọi đường;
 *     nhập tệp +84 trùng 0…; chuyển thành khách; hàng đợi liên hệ; phạm vi dữ liệu; xoá dữ liệu Google hết hạn; nhà tắt module.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, count, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { decideScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { testGooglePlaces } from "@/lib/connectors/testers";
import { detailsFieldMask, placeDetails, searchFieldMask, textSearch } from "@/lib/integrations/google-places/client";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { parseListParams } from "@/lib/search-params";
import { runJob } from "@/lib/sync/jobs";
import { listWholesaleLeads, wholesaleDashboard } from "@/lib/queries/wholesale";
import { mobileHome, mobileQueue, nextLeadId } from "@/lib/queries/wholesale-mobile";
import { callOutcomeEffect, PRICE_REQUEST_ACTION } from "@/lib/wholesale/constants";
import { areaCode, cellScanPriority, parseCustomAreas, provinceScanTier, SEARCH_PROVINCES, scanTier } from "@/lib/wholesale/areas";
import { provinceRegion } from "@/lib/constants/vn-regions";
import { fieldHandoffMessage, mapsLinkOf, sendLeadsToFieldCore, verifiedCallPatch } from "@/lib/wholesale/field-handoff";
import { changeCampaignStateCore, createCampaignCore, hslcTemplateValues, previewCampaignCore, provincesOfTier, startCampaignCore } from "@/lib/wholesale/campaigns";
import { DEFAULT_KEYWORD_GROUPS, DEFAULT_LEAD_HUNTER_CONFIG, DEFAULT_TARGET_SEGMENTS, freeTierLeft, mergeLeadHunterConfig, nextCallCostMicros, paidCostMicros, quotaRetryAt, skuCostMicros } from "@/lib/wholesale/config";
import { branchHint, brandKey, chainBrandHit, nameAddressKey, socialKind, websiteDomain } from "@/lib/wholesale/dedupe";
import { purgeExpiredSnapshots, runLeadHunterTick } from "@/lib/wholesale/engine";
import { addLeadsToCampaignCore, assignLeadsCore, convertLeadCore, followupAt, importLeadsCore, logCallCore, logCallInitiatedCore, updateLeadStatusCore } from "@/lib/wholesale/leads";
import { channelAction, openerLooksInvented, templateOpener } from "@/lib/wholesale/opener";
import { approveOutreachCore, markOutreachSentCore, prepareOutreachCore, queueOutreachCore, recordOutreachResultCore } from "@/lib/wholesale/outreach";
import { extractVnPhones, formatVnPhone, normalizeVnPhone, samePhone } from "@/lib/wholesale/phone";
import type { DiscoveryProvider, EnrichmentProvider } from "@/lib/wholesale/providers";
import { cellKeyOf, estimateCost, planTextCells, queryTextOf } from "@/lib/wholesale/query-plan";
import { gradeOf, learnedAdjustment, scoreLead, type ScoreInput } from "@/lib/wholesale/scoring";
import { classifySegment, SEGMENT_POINTS } from "@/lib/wholesale/segments";
import { saveLeadHunterConfig } from "@/lib/wholesale/store";
import { isPrivateAddress } from "@/lib/net/public-url";
import { allowed as relayAllowed, handle as relayHandle } from "../deploy/places-relay/relay.js";
import { enrichFromWebsite } from "@/lib/wholesale/website";
import { contactPageCandidates, extractFindings, robotsAllows } from "@/lib/wholesale/website-parse";
import type { PlaceRecord } from "@/lib/integrations/google-places/client";

const ORG = "wl-hslc";
const API_KEY = "AIzaFAKE_wholesale_test_key_0123456789abcd";
const ORG_SECRETS_KEY = "khoa-kiem-thu-wholesale-leads-0123456789abcdefghijklmnopqrstuvwxyz";

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testPhone() {
  const same = ["+84912345678", "84912345678", "0912345678", "0912 345 678", "+84 (0) 912-345-678", "+84 912.345.678"];
  for (const s of same) assert.equal(normalizeVnPhone(s)?.normalized, "+84912345678", s);
  assert.equal(normalizeVnPhone("0912345678")?.kind, "MOBILE");
  assert.equal(normalizeVnPhone("0912345678")?.national, "0912345678");
  assert.equal(normalizeVnPhone("0912345678")?.countryCode, "84");
  assert.ok(samePhone("+84901234567", "0901234567"), "+84901234567 và 0901234567 là MỘT số");
  assert.ok(!samePhone("0901234567", "0901234568"));
  const land = normalizeVnPhone("(028) 3823 4567");
  assert.equal(land?.normalized, "+842838234567");
  assert.equal(land?.kind, "LANDLINE");
  assert.equal(normalizeVnPhone("1900 1234")?.kind, "SPECIAL");
  // Không bịa số: thiếu số 0, đầu số cũ 11 số, số nước ngoài, chuỗi chữ.
  assert.equal(normalizeVnPhone("912345678")?.normalized, null, "thiếu số 0 ⇒ không tự thêm");
  assert.equal(normalizeVnPhone("01681234567")?.normalized, null, "đầu số cũ ⇒ không tự đổi");
  assert.equal(normalizeVnPhone("+1 415 555 0100")?.normalized, null);
  assert.equal(normalizeVnPhone("liên hệ fanpage")?.kind, "UNKNOWN");
  assert.equal(normalizeVnPhone(""), null);
  assert.equal(normalizeVnPhone(null), null);
  const found = extractVnPhones("Hotline: 0905 123 456 – Đặt bàn +84 236 3888 999, fax 1900 6868. Mã SP 123456.");
  assert.deepEqual(
    found.map((p) => p.normalized),
    ["+84905123456", "+842363888999", "19006868"],
  );
  assert.equal(formatVnPhone("+84912345678"), "0912 345 678");
  assert.equal(formatVnPhone("+842838234567"), "028 3823 4567", "TP.HCM: mã vùng 3 số");
  assert.equal(formatVnPhone("02363555777"), "0236 355 5777", "Đà Nẵng: mã vùng 4 số, không tách sai thành 023 6355…");
}

function testSegments() {
  assert.equal(classifySegment({ name: "Nhà hàng Hải Sản Biển Đông", primaryType: "restaurant", types: ["restaurant"] }).segment, "SEAFOOD_RESTAURANT");
  assert.equal(classifySegment({ name: "Lẩu Dê 404", types: ["restaurant"] }).segment, "HOTPOT");
  assert.equal(classifySegment({ name: "Lâu Đài Café", primaryType: "cafe" }).segment, "OTHER_FOOD", "«Lâu» không phải «lẩu»");
  assert.equal(classifySegment({ name: "Khách sạn Mường Thanh", types: ["lodging"] }).segment, "HOTEL_RESORT");
  assert.equal(classifySegment({ name: "Cô Ba Minh Anh" }).segment, "UNCLASSIFIED", "không chứng cứ ⇒ không đoán");
  // Nhóm theo danh mục HSLC (05/10/2026): cửa hàng bán lại đặc sản đứng TRƯỚC nhà hàng hải sản.
  assert.equal(classifySegment({ name: "Hải sản khô Hạ Long Cô Lan" }).segment, "SPECIALTY_STORE", "«hải sản khô» là cửa hàng bán lại, không phải nhà hàng");
  assert.equal(classifySegment({ name: "Chả mực Hạ Long 79", types: ["restaurant"] }).segment, "SPECIALTY_STORE");
  assert.equal(classifySegment({ name: "Đặc sản vùng miền Quê Nhà" }).segment, "SPECIALTY_STORE");
  assert.equal(classifySegment({ name: "Shop Mẹ và Bé Kids" }).segment, "MOM_BABY");
  assert.equal(classifySegment({ name: "Tạp hoá Minh Anh" }).segment, "GROCERY");
  assert.equal(classifySegment({ name: "Bún chả cá Hải Phòng", types: ["restaurant"] }).segment, "EATERY");
  assert.equal(classifySegment({ name: "Cửa hàng tiện ích", primaryType: "convenience_store" }).segment, "GROCERY");
  assert.equal(classifySegment({ name: "Siêu thị Hà Nội", primaryType: "supermarket" }).segment, "SUPERMARKET");
  assert.ok(SEGMENT_POINTS.SPECIALTY_STORE.fit > SEGMENT_POINTS.HOTEL_RESORT.fit && SEGMENT_POINTS.GROCERY.intent > SEGMENT_POINTS.CATERING.intent, "chưa xuất hoá đơn ⇒ khách bán lại xếp trên khách sạn / tiệc");
  for (const sg of DEFAULT_TARGET_SEGMENTS) assert.ok(!["HOTEL_RESORT", "CATERING", "BUFFET", "SUPERMARKET"].includes(sg), `${sg}: nhóm thường đòi hoá đơn không nằm trong mục tiêu mặc định`);
  // Chuỗi lớn: khớp theo TỪ trên tên đã bỏ dấu, gạch nối = khoảng trắng.
  const brands = DEFAULT_LEAD_HUNTER_CONFIG.chainFilter.brands;
  assert.equal(chainBrandHit("Kichi-Kichi Royal City", brands), "Kichi-Kichi");
  assert.equal(chainBrandHit("Lẩu băng chuyền KICHI KICHI Times City", brands), "Kichi-Kichi");
  assert.equal(chainBrandHit("Siêu thị Bách Hoá Xanh 123", brands), "Bách Hóa Xanh");
  assert.equal(chainBrandHit("Quán Gogi Bà Tư", brands), "Gogi", "khớp theo từ — chủ shop sửa danh sách nếu nhầm");
  assert.equal(chainBrandHit("Hải sản Cô Lan", brands), null);
  assert.equal(chainBrandHit("Logogia", brands), null, "không khớp giữa chữ");
  assert.equal(brandKey("Nhà hàng Hải Sản Biển Đông 2"), "hai san bien dong");
  const ev = classifySegment({ name: "BBQ Garden", types: [] });
  assert.equal(ev.segment, "BBQ");
  assert.match(ev.evidence, /bbq/);
}

function baseInput(over: Partial<ScoreInput> = {}): ScoreInput {
  return { segment: "SEAFOOD_RESTAURANT", segmentEvidence: "tên có «hai san»", reviewCount: 637, rating: 4.5, businessStatus: "OPERATIONAL", phoneKind: "MOBILE", hasWebsite: true, hasOtherChannel: false, provinceKey: "da nang", provinceLabel: "Đà Nẵng", siblingCount: 0, branchHint: false, hasAddress: true, hasName: true, ...over };
}

function testScoring() {
  const areas = DEFAULT_LEAD_HUNTER_CONFIG.serviceAreas;
  const a = scoreLead(baseInput(), { areas });
  const b = scoreLead(baseInput(), { areas });
  assert.deepEqual(a, b, "cùng dữ liệu ⇒ cùng điểm, cùng lý do (xác định)");
  assert.ok(a.score >= 80 && a.grade === "A", JSON.stringify(a));
  assert.match(a.summary, /637 đánh giá/);
  assert.match(a.summary, /có SĐT di động/);
  // Sao KHÔNG quyết định: quán cà phê 5★ nhiều đánh giá vẫn dưới nhà hàng hải sản 3.6★.
  const cafe = scoreLead(baseInput({ segment: "OTHER_FOOD", rating: 5, reviewCount: 5000 }), { areas });
  const seafood = scoreLead(baseInput({ rating: 3.6, reviewCount: 120 }), { areas });
  assert.ok(seafood.score > cafe.score, `${seafood.score} > ${cafe.score}`);
  assert.equal(scoreLead(baseInput({ businessStatus: "CLOSED_PERMANENTLY" }), { areas }).grade, "D", "đóng cửa ⇒ không bao giờ A/B");
  const noPhone = scoreLead(baseInput({ phoneKind: null }), { areas });
  assert.ok(noPhone.components.find((c) => c.key === "contactability")!.reason.includes("chưa có SĐT"));
  const unknownReviews = scoreLead(baseInput({ reviewCount: null }), { areas });
  assert.match(unknownReviews.components.find((c) => c.key === "scale")!.reason, /chưa có số đánh giá/, "chưa biết ⇒ nói chưa biết, không in 0");
  for (const c of a.components) assert.ok(c.points <= c.max && c.points >= 0, c.key);
  // Hồ sơ «vừa và nhỏ» (chưa xuất hoá đơn): nơi vừa > nơi rất đông > chuỗi; lý do nói vì sao.
  const sm = (over: Partial<ScoreInput>) => scoreLead(baseInput(over), { areas, sizeProfile: "SMALL_MEDIUM" });
  const mid = sm({ reviewCount: 637 });
  const huge = sm({ reviewCount: 8000 });
  const chain = sm({ reviewCount: 637, siblingCount: 3 });
  assert.ok(mid.score > huge.score && mid.score > chain.score, `${mid.score} ${huge.score} ${chain.score}`);
  assert.match(huge.components.find((c) => c.key === "scale")!.reason, /hoá đơn/);
  assert.match(chain.components.find((c) => c.key === "scale")!.reason, /chuỗi/);
  assert.ok(scoreLead(baseInput({ reviewCount: 8000 }), { areas, sizeProfile: "ANY" }).score > huge.score, "hồ sơ «mọi quy mô» giữ luật cũ");
  assert.equal(gradeOf(80), "A");
  assert.equal(gradeOf(79), "B");
  assert.equal(gradeOf(65), "B");
  assert.equal(gradeOf(45), "C");
  assert.equal(gradeOf(44), "D");
  const few = learnedAdjustment("BUFFET", [{ segment: "BUFFET", resolved: 3, won: 3 }]);
  assert.equal(few.points, 0, "dưới mẫu tối thiểu ⇒ không học");
  const good = learnedAdjustment("BUFFET", [
    { segment: "BUFFET", resolved: 40, won: 20 },
    { segment: "PUB_BEER", resolved: 60, won: 3 },
  ]);
  const bad = learnedAdjustment("PUB_BEER", [
    { segment: "BUFFET", resolved: 40, won: 20 },
    { segment: "PUB_BEER", resolved: 60, won: 3 },
  ]);
  assert.ok(good.points > 0 && bad.points < 0 && Math.abs(good.points) <= 5, `${good.points} ${bad.points}`);
}

function testPlanAndCost() {
  const custom = parseCustomAreas("Đà Nẵng: Hải Châu, Sơn Trà\nNghệ An: Vinh\nlinh tinh dài quá ".concat("x".repeat(80)));
  assert.equal(custom.provinces.length, 2);
  assert.equal(custom.invalid.length, 1);
  assert.notEqual(areaCode("Vũng Tàu"), areaCode("Bà Rịa"), "hai khu vực không được gộp vì bí danh tỉnh");
  const plan = planTextCells(["nhà hàng hải sản", "buffet", "Buffet"], custom.provinces);
  assert.equal(plan.cells.length, 3 * 2, "3 khu vực × 2 từ khoá («buffet» / «Buffet» là MỘT ô)");
  assert.equal(new Set(plan.cells.map((c) => c.cellKey)).size, plan.cells.length);
  assert.equal(cellKeyOf("TEXT", "Nhà hàng hải sản", "da nang", "hai-chau"), "TEXT|nha-hang-hai-san|da-nang|hai-chau");
  assert.equal(queryTextOf("buffet", "Hải Châu", "Đà Nẵng"), "buffet Hải Châu Đà Nẵng");
  assert.equal(queryTextOf("buffet", "TP Thanh Hóa", "Thanh Hóa"), "buffet TP Thanh Hóa");
  const cfg = DEFAULT_LEAD_HUNTER_CONFIG;
  const e = estimateCost({ cellCount: 100, freshCount: 40, mode: "TEXT", tier: "PRO", maxLeads: 500 }, cfg);
  assert.equal(e.cellsToScan, 60);
  assert.equal(e.minMicros, 60 * skuCostMicros("TEXT_SEARCH_PRO", cfg));
  assert.ok(e.minMicros <= e.typicalMicros && e.typicalMicros <= e.maxMicros);
  const ent = estimateCost({ cellCount: 100, freshCount: 0, mode: "TEXT", tier: "ENTERPRISE", maxLeads: 500 }, cfg);
  assert.equal(ent.maxMicros, 100 * 3 * skuCostMicros("TEXT_SEARCH_ENTERPRISE", cfg), "Enterprise: không có lượt chi tiết");
  assert.equal(skuCostMicros("TEXT_SEARCH_PRO", cfg), 32_000, "32 US$ / 1.000 lượt = 0,032 US$ = 32.000 micro-USD");
  assert.equal(skuCostMicros("TEXT_SEARCH_IDS", cfg), 0);
}

/** Thứ tự quét chủ shop chốt 04/10/2026: Hà Nội + TP.HCM → không có biển → ven biển (theo tỉnh CŨ của khu vực). */
function testScanPriority() {
  assert.equal(SEARCH_PROVINCES.length, 34, "đủ 34 tỉnh / thành sau sáp nhập 2025");
  assert.equal(new Set(SEARCH_PROVINCES.map((p) => p.key)).size, 34);
  for (const p of SEARCH_PROVINCES) {
    assert.ok(provinceRegion(p.key), `${p.key}: khoá tỉnh phải là khoá chuẩn của vn-regions (điểm vị trí + đọc địa chỉ dùng nó)`);
    assert.equal(new Set(p.areas.map((a) => a.code)).size, p.areas.length, `${p.key}: mã khu vực trùng`);
  }
  const prio = DEFAULT_LEAD_HUNTER_CONFIG.scanPriority;
  const tierOf = (prov: string, area: string) => {
    const p = SEARCH_PROVINCES.find((x) => x.key === prov)!;
    return scanTier(prov, p.areas.find((a) => a.name === area)!, prio);
  };
  assert.equal(tierOf("ha noi", "Cầu Giấy"), 1);
  assert.equal(tierOf("ho chi minh", "Vũng Tàu"), 1, "tỉnh quét trước thắng cờ ven biển");
  assert.equal(tierOf("gia lai", "Pleiku"), 2, "Pleiku thuộc Gia Lai cũ — không có biển dù Gia Lai mới giáp biển");
  assert.equal(tierOf("gia lai", "Quy Nhơn"), 3);
  assert.equal(tierOf("lam dong", "Đà Lạt"), 2);
  assert.equal(tierOf("lam dong", "Phan Thiết"), 3);
  assert.equal(tierOf("quang ngai", "Kon Tum"), 2);
  assert.equal(tierOf("ninh binh", "Phủ Lý"), 2);
  assert.equal(tierOf("ninh binh", "Nam Định"), 3);
  assert.equal(tierOf("hai phong", "TP Hải Dương"), 2);
  assert.equal(tierOf("hai phong", "Đồ Sơn"), 3);
  assert.equal(scanTier("gia lai", { code: "quy-nhon" }, prio), 3, "ảnh chụp cũ không mang cờ ⇒ tra danh sách chuẩn");
  assert.equal(scanTier("gia lai", { code: "quy-nhon" }, { ...prio, inlandBeforeCoastal: false }), 2, "tắt luật biển ⇒ mọi tỉnh còn lại cùng hạng");
  assert.equal(provinceScanTier(SEARCH_PROVINCES.find((p) => p.key === "gia lai")!, prio), 2, "tỉnh có khu vực không biển nằm ở nhóm ②");
  // Hạng quyết định trước, kinh nghiệm từ khoá chỉ xếp TRONG hạng.
  assert.ok(cellScanPriority(1, 0) > cellScanPriority(2, 1e9));
  assert.ok(cellScanPriority(2, 0) > cellScanPriority(3, 1e9));
  assert.ok(cellScanPriority(2, 7) > cellScanPriority(2, 3));
  assert.equal(cellScanPriority(3, Number.NaN), 0);
  // Ba mẫu chia trọn danh sách: mỗi khu vực đúng một đợt.
  const seen = new Map<string, number>();
  for (const t of [1, 2, 3] as const) for (const p of provincesOfTier(t, prio)) for (const a of p.areas) seen.set(`${p.key}|${a.code}`, (seen.get(`${p.key}|${a.code}`) ?? 0) + 1);
  assert.equal(seen.size, SEARCH_PROVINCES.reduce((n, p) => n + p.areas.length, 0));
  assert.ok([...seen.values()].every((n) => n === 1));
  assert.deepEqual(hslcTemplateValues(1).provinces.map((p) => p.key).sort(), ["ha noi", "ho chi minh"]);
  assert.ok(hslcTemplateValues(2).provinces.every((p) => p.areas.every((a) => !a.coastal)));
  assert.ok(hslcTemplateValues(3).provinces.every((p) => p.areas.every((a) => a.coastal)));
  // Khu vực tự khai: có trong danh sách ⇒ mang cờ chuẩn; lạ ⇒ không có biển (không đoán).
  const custom = parseCustomAreas("Gia Lai: Quy Nhơn, Chư Sê");
  assert.deepEqual(custom.provinces[0]!.areas.map((a) => a.coastal), [true, false]);
  // Vùng phục vụ: tỉnh quét trước = ưu tiên; mọi tỉnh khác trong danh sách = giao được.
  const areas = DEFAULT_LEAD_HUNTER_CONFIG.serviceAreas;
  assert.equal(areas["ha noi"], "PRIORITY");
  assert.equal(areas["can tho"], "SERVED");
  assert.equal(Object.keys(areas).length, 34);
  const merged = mergeLeadHunterConfig({ budget: { dailyUsd: 2 } });
  assert.deepEqual(merged.scanPriority, prio, "bản lưu cũ (chưa có khoá) ⇒ lấy mặc định");
  assert.equal(merged.fieldSales.connectorKey, "telegram-bot");
}

function testFieldHandoffMessage() {
  const base = {
    ownName: null,
    ownPhone: null,
    ownAddress: null,
    areaName: "Cầu Giấy",
    provinceLabel: "Hà Nội",
    mapsUrl: mapsLinkOf("ChIJabc", null, "Cầu Giấy"),
    segment: "SEAFOOD_RESTAURANT",
    grade: "A",
    score: 86,
    status: "QUALIFIED",
    lastCall: null,
    response: null,
    nextAction: null,
    nextFollowupAt: null,
    opportunityNote: null,
    senderName: "Chủ shop",
    note: null,
  };
  const cold = fieldHandoffMessage(base);
  assert.match(cold.title, /Cầu Giấy, Hà Nội/);
  assert.match(cold.body, /Chưa gọi xác nhận tên/);
  assert.match(cold.body, /Chưa có SĐT đã xác nhận/);
  assert.match(cold.body, /query_place_id=ChIJabc/, "chưa gọi ⇒ nhân viên mở bản đồ");
  assert.ok(cold.body.includes("hạng A (86 điểm)"), cold.body);
  const warm = fieldHandoffMessage({ ...base, ownName: "Hải Sản Biển Đông", ownPhone: "+84905123456", lastCall: { outcome: "ANSWERED", note: "Muốn xem mẫu tôm", at: new Date("2026-10-04T03:00:00Z") }, nextAction: "Mang mẫu tôm", note: "Ghé trước 10h" });
  assert.ok(warm.body.includes("Hải Sản Biển Đông"));
  assert.ok(warm.body.includes("0905 123 456"), warm.body);
  assert.ok(warm.body.includes("Nghe máy, đã nói chuyện — Muốn xem mẫu tôm"), warm.body);
  assert.ok(warm.body.includes("Lời dặn: Ghé trước 10h"));
  assert.equal(mapsLinkOf(null, null, "x"), null);
  assert.equal(mapsLinkOf("ChIJabc", "https://maps.google.com/?cid=1", null), "https://maps.google.com/?cid=1");
  assert.ok(mapsLinkOf("ChIJabc", "javascript:alert(1)", null)!.startsWith("https://www.google.com/maps/search/"), "link lạ ⇒ tự dựng link chuẩn");
  // Gọi xác nhận ⇒ tên + SĐT thành của shop; địa chỉ chỉ khi tích; ô nhân viên đã sửa không bị đè.
  const lead = { businessName: null, address: null, normalizedPhone: null, staffEditedFields: [] as string[] };
  const snap = { displayName: "Biển Đông", formattedAddress: "12 Bạch Đằng", normalizedPhone: "+84905123456" };
  assert.deepEqual(verifiedCallPatch(lead, snap, "ANSWERED", false), { businessName: "Biển Đông", normalizedPhone: "+84905123456" });
  assert.deepEqual(verifiedCallPatch(lead, snap, "CALLBACK", true), { businessName: "Biển Đông", normalizedPhone: "+84905123456", address: "12 Bạch Đằng" });
  assert.deepEqual(verifiedCallPatch(lead, snap, "NO_ANSWER", true), {}, "không nghe máy ⇒ chưa xác nhận gì");
  assert.deepEqual(verifiedCallPatch({ ...lead, staffEditedFields: ["businessName"] }, snap, "ANSWERED", false), { normalizedPhone: "+84905123456" });
  assert.deepEqual(verifiedCallPatch(lead, null, "ANSWERED", true), {}, "dữ liệu Google đã xoá ⇒ không có gì để chép");
}

function testCallOutcomes() {
  // Người bán chọn KẾT QUẢ; máy suy ra trạng thái — không bao giờ lùi lead đã đi xa.
  assert.equal(callOutcomeEffect("NEW", "INTERESTED").to, "INTERESTED");
  assert.equal(callOutcomeEffect("NEGOTIATING", "NO_ANSWER").to, "NEGOTIATING", "không nghe máy không lùi lead đang thương lượng");
  assert.equal(callOutcomeEffect("NEW", "NO_ANSWER").to, "NO_ANSWER");
  const cb = callOutcomeEffect("NEW", "CALLBACK");
  assert.ok(cb.to === "CONTACTED" && cb.followupRequired && cb.followupDays === 1);
  assert.equal(callOutcomeEffect("QUALIFIED", "PRICE_REQUESTED").nextAction, PRICE_REQUEST_ACTION);
  assert.equal(callOutcomeEffect("NEW", "CONSIDERING").followupRequired, true);
  const lost = callOutcomeEffect("NEGOTIATING", "NOT_INTERESTED");
  assert.ok(lost.to === "LOST" && (lost.lostReason ?? "").length >= 3, "LOST luôn kèm lý do (ràng buộc CSDL)");
  assert.equal(callOutcomeEffect("NEW", "WRONG_NUMBER").to, "LOST");
  assert.match(callOutcomeEffect("NEW", "WRONG_CONTACT").nextAction ?? "", /người phụ trách/);
  assert.equal(callOutcomeEffect("CONTACTED", "DO_NOT_CONTACT").to, "DO_NOT_CONTACT");
  assert.equal(followupAt(new Date("2026-10-05T16:30:00Z"), 1).toISOString(), "2026-10-06T02:00:00.000Z", "23:30 giờ VN ngày 05 ⇒ «mai» là 9 giờ ngày 06");
  assert.equal(followupAt(new Date("2026-10-05T17:30:00Z"), 1).toISOString(), "2026-10-07T02:00:00.000Z", "00:30 giờ VN ngày 06 (vẫn là ngày 05 theo UTC) ⇒ «mai» là ngày 07 — ngày tính theo giờ VN");
}

/** Kịch bản đo chi phí / trần chi tiêu bằng tiền: KHÔNG có phần miễn phí, để mỗi lượt mang giá niêm yết. */
const PAID_CFG = {
  ...DEFAULT_LEAD_HUNTER_CONFIG,
  freeTier: { ...DEFAULT_LEAD_HUNTER_CONFIG.freeTier, enabled: false, monthlyCalls: Object.fromEntries(Object.keys(DEFAULT_LEAD_HUNTER_CONFIG.freeTier.monthlyCalls).map((k) => [k, 0])) as typeof DEFAULT_LEAD_HUNTER_CONFIG.freeTier.monthlyCalls },
};

function testFreeTier() {
  // Tiền THẬT = lượt vượt phần miễn phí × giá. Đo 05/10/2026: 305 chi tiết + 23 tìm nằm trong phần miễn phí mà ERP ghi 5 US$ rồi tự chặn trần ngày.
  const cfg0 = DEFAULT_LEAD_HUNTER_CONFIG;
  assert.deepEqual(paidCostMicros(cfg0, { DETAILS_ENTERPRISE: 305, TEXT_SEARCH_PRO: 23 }, { DETAILS_ENTERPRISE: 305, TEXT_SEARCH_PRO: 23 }).todayMicros, 0);
  const over = paidCostMicros(cfg0, { DETAILS_ENTERPRISE: 1005 }, { DETAILS_ENTERPRISE: 10 });
  assert.equal(over.monthMicros, 5 * 20_000, "chỉ 5 lượt vượt 1.000 lượt miễn phí bị tính tiền");
  assert.equal(over.todayMicros, 5 * 20_000, "5 lượt vượt đều rơi vào hôm nay");
  assert.equal(paidCostMicros(cfg0, { DETAILS_ENTERPRISE: 1200 }, { DETAILS_ENTERPRISE: 100 }).todayMicros, 100 * 20_000, "phần miễn phí đã hết từ hôm trước ⇒ cả 100 lượt hôm nay tính tiền");
  assert.equal(nextCallCostMicros(cfg0, "DETAILS_ENTERPRISE", 999), 0);
  assert.equal(nextCallCostMicros(cfg0, "DETAILS_ENTERPRISE", 1000), 20_000);
  // 429 hạn mức NGÀY ⇒ chờ Google đặt lại (0 giờ giờ Thái Bình Dương ≈ 08:05 UTC), không hỏi lại mỗi 10 phút.
  const daily = "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GetPlaceRequest' and limit 'GetPlaceRequest per day'";
  assert.equal(quotaRetryAt(new Date("2026-10-05T06:00:00Z"), daily).toISOString(), "2026-10-05T08:05:00.000Z");
  assert.equal(quotaRetryAt(new Date("2026-10-05T09:00:00Z"), daily).toISOString(), "2026-10-06T08:05:00.000Z");
  assert.equal(quotaRetryAt(new Date("2026-10-05T09:00:00Z"), "Quota exceeded per minute").toISOString(), "2026-10-05T09:10:00.000Z");

  const cfg = DEFAULT_LEAD_HUNTER_CONFIG;
  assert.equal(cfg.discoveryTier, "ENTERPRISE", "mặc định tìm có SĐT ngay trong lượt tìm — rẻ nhất mỗi lead");
  assert.equal(freeTierLeft(cfg, "TEXT_SEARCH_ENTERPRISE", 0), 950, "1.000 lượt miễn phí, giữ 5% dự phòng");
  assert.equal(freeTierLeft(cfg, "TEXT_SEARCH_ENTERPRISE", 950), 0);
  assert.equal(freeTierLeft(cfg, "TEXT_SEARCH_ENTERPRISE", 2000), 0, "không bao giờ âm");
  assert.equal(freeTierLeft(cfg, "TEXT_SEARCH_PRO", 100), 4650);
  const enabled = DEFAULT_KEYWORD_GROUPS.filter((g) => g.enabled).reduce((n, g) => n + g.keywords.length, 0);
  assert.ok(enabled * 57 <= freeTierLeft(cfg, "TEXT_SEARCH_ENTERPRISE", 0), `từ khoá lõi × 57 khu vực đợt ① (${enabled * 57}) nằm trong lượt miễn phí một tháng`);
  assert.ok(!DEFAULT_KEYWORD_GROUPS.find((g) => g.key === "lon")!.enabled, "nhóm thường đòi hoá đơn để TẮT");
  const merged = mergeLeadHunterConfig({ freeTier: { enabled: false } });
  assert.equal(merged.freeTier.enabled, false);
  assert.equal(merged.freeTier.monthlyCalls.TEXT_SEARCH_ENTERPRISE, 1000, "bản lưu thiếu khoá con ⇒ lấy mặc định");
}

function testDedupeKeys() {
  assert.equal(websiteDomain("https://www.NhaHangABC.vn/lien-he"), "nhahangabc.vn");
  assert.equal(websiteDomain("nhahangabc.vn"), "nhahangabc.vn");
  assert.equal(websiteDomain("https://facebook.com/nhahangabc"), null, "host dùng chung không phải danh tính doanh nghiệp");
  assert.equal(websiteDomain("https://abc.business.site"), null);
  assert.equal(websiteDomain("http://192.168.1.1"), null);
  assert.equal(socialKind("https://m.facebook.com/abc"), "FACEBOOK");
  assert.equal(socialKind("https://zalo.me/0905123456"), "ZALO");
  assert.equal(nameAddressKey("Nhà hàng Hải Sản Biển Đông", "12 Trần Phú, Hải Châu, Đà Nẵng"), nameAddressKey("Hải sản Biển Đông", "12 Tran Phu, Hai Chau"));
  assert.equal(nameAddressKey("Nhà hàng", "12 Trần Phú"), null, "tên chỉ có từ chung ⇒ không đủ chứng cứ");
  assert.equal(nameAddressKey("Hải sản Biển Đông", "Trần Phú"), null, "không có số nhà ⇒ không đủ cụ thể");
  assert.ok(branchHint("Hải sản Biển Đông - Chi nhánh 2"));
  assert.ok(!branchHint("Hải sản Biển Đông"));
}

const PAGE_HTML = `<!doctype html><html><head><meta name="description" content="Nhà hàng hải sản tươi sống bên bờ biển Đà Nẵng"></head>
<body><script>var x="spam@evil.com";</script>
<a href="mailto:datban@biendong.vn?subject=hi">Email</a> <a href="tel:+84905123456">Gọi</a>
<p>Hotline: 0236 3888 999 · logo@2x.png · noreply@biendong.vn</p>
<a href="https://www.facebook.com/haisanbiendong">FB</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
<a href="https://zalo.me/0905123456">Zalo</a> <a href="/lien-he">Liên hệ</a> <a href="https://other.com/contact">khác</a></body></html>`;

function testWebsiteParse() {
  const f = extractFindings(PAGE_HTML, "https://biendong.vn/", { isContactPage: false });
  const by = (k: string) => f.filter((x) => x.kind === k).map((x) => x.value);
  assert.deepEqual(by("EMAIL"), ["datban@biendong.vn"], "bỏ email trong script, ảnh @2x, noreply");
  assert.deepEqual(by("PHONE").sort(), ["+842363888999", "+84905123456"]);
  assert.deepEqual(by("FACEBOOK"), ["https://www.facebook.com/haisanbiendong"], "bỏ link chia sẻ");
  assert.deepEqual(by("ZALO"), ["https://zalo.me/0905123456"]);
  assert.match(by("DESCRIPTION")[0] ?? "", /hải sản/);
  assert.ok(f.every((x) => x.sourceUrl === "https://biendong.vn/"), "mỗi phát hiện mang URL nguồn");
  assert.deepEqual(contactPageCandidates(PAGE_HTML, "https://biendong.vn/"), ["https://biendong.vn/lien-he"], "chỉ trang liên hệ CÙNG host");
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/lien-he"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /admin\nAllow: /", "/lien-he"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /\nAllow: /lien-he", "/lien-he"), true, "Allow dài hơn thắng");
  assert.equal(robotsAllows(null, "/x"), true);
}

async function testWebsiteGuards() {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "113.161.1.1", "2001:4860:4860::8888"]) assert.ok(!isPrivateAddress(ip), ip);

  const calls: string[] = [];
  const fakeFetch = (async (input: string) => {
    calls.push(input);
    const u = new URL(input);
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /private", { status: 200, headers: { "content-type": "text/plain" } });
    if (u.hostname === "redirect.vn") return new Response("", { status: 302, headers: { location: "http://internal.vn/" } });
    if (u.pathname === "/lien-he") return new Response(`<p>Email: lienhe@biendong.vn</p>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const resolve = async (host: string) => (host === "internal.vn" ? ["10.0.0.5"] : ["113.161.1.1"]);
  // Rào SSRF dùng chung (lib/net/public-url.ts): địa chỉ nội bộ / giao thức lạ / cổng lạ ⇒ BLOCKED, không request nào đi.
  for (const bad of ["http://127.0.0.1/admin", "http://localhost:3000", "ftp://x.vn", "https://user:pass@x.vn", "https://x.vn:8443", "https://internal.vn"]) {
    const n = calls.length;
    const r = await enrichFromWebsite(bad, { maxPages: 1 }, { fetch: fakeFetch, resolve });
    assert.equal(r.status, "BLOCKED", bad);
    assert.equal(calls.length, n, `${bad} ⇒ không request nào`);
  }
  const ok = await enrichFromWebsite("https://biendong.vn", { maxPages: 3 }, { fetch: fakeFetch, resolve });
  assert.equal(ok.status, "DONE");
  assert.equal(ok.pagesRead, 2);
  assert.ok(ok.findings.some((f) => f.value === "lienhe@biendong.vn" && f.sourceUrl === "https://biendong.vn/lien-he"));
  const blocked = await enrichFromWebsite("https://redirect.vn", { maxPages: 2 }, { fetch: fakeFetch, resolve });
  assert.equal(blocked.status, "BLOCKED", "chuyển hướng về địa chỉ nội bộ ⇒ chặn");
  assert.ok(!calls.some((c) => c.includes("internal.vn")), "không một request nào tới host nội bộ");
  const robots = await enrichFromWebsite("https://biendong.vn/private/menu", { maxPages: 1 }, { fetch: fakeFetch, resolve });
  assert.equal(robots.status, "BLOCKED", "robots.txt cấm ⇒ không đọc");
}

type Seen = { url: string; method: string; key: string; mask: string; body: Record<string, unknown> | null };

/** Google Places API (New) GIẢ. `fail` = số lượt đầu trả lỗi (5xx / 403 / 429) theo khoá «op». */
function fakePlaces(seen: Seen[], world: { places: Record<string, PlaceRecord & { details?: Partial<PlaceRecord> }>; search: (q: string) => string[]; fail?: { status: number; times: number } }) {
  let failures = world.fail?.times ?? 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const toApi = (p: Partial<PlaceRecord> & { placeId: string }, mask: string) => {
    const want = (f: string) => mask.includes(f);
    const out: Record<string, unknown> = { id: p.placeId };
    if (want("displayName") && p.name) out.displayName = { text: p.name, languageCode: "vi" };
    if (want("formattedAddress") && p.address) out.formattedAddress = p.address;
    if (want("types")) out.types = p.types ?? [];
    if (want("primaryType") && p.primaryType) out.primaryType = p.primaryType;
    if (want("businessStatus") && p.businessStatus) out.businessStatus = p.businessStatus;
    if (want("googleMapsUri")) out.googleMapsUri = `https://maps.google.com/?cid=${p.placeId}`;
    if (want("nationalPhoneNumber") && p.nationalPhone) out.nationalPhoneNumber = p.nationalPhone;
    if (want("internationalPhoneNumber") && p.internationalPhone) out.internationalPhoneNumber = p.internationalPhone;
    if (want("websiteUri") && p.website) out.websiteUri = p.website;
    if (want("rating") && p.rating != null) out.rating = p.rating;
    if (want("userRatingCount") && p.reviewCount != null) out.userRatingCount = p.reviewCount;
    return out;
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const h = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    seen.push({ url: url.href, method: init?.method ?? "GET", key: h.get("x-goog-api-key") ?? "", mask: h.get("x-goog-fieldmask") ?? "", body });
    if (url.hostname !== "places.googleapis.com") return json({ error: { message: "sai máy chủ" } }, 400);
    if (h.get("x-goog-api-key") !== API_KEY) return json({ error: { code: 403, status: "PERMISSION_DENIED", message: `API key not valid ${h.get("x-goog-api-key")}` } }, 403);
    if (failures > 0) {
      failures--;
      return json({ error: { code: world.fail!.status, status: world.fail!.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE", message: "thử lại" } }, world.fail!.status);
    }
    const mask = h.get("x-goog-fieldmask") ?? "";
    if (url.pathname === "/v1/places:searchText") {
      const q = String(body?.textQuery ?? "");
      const ids = world.search(q);
      return json({ places: ids.map((id) => toApi(world.places[id]!, mask)) });
    }
    const m = /^\/v1\/places\/(.+)$/.exec(url.pathname);
    if (m) {
      const p = world.places[decodeURIComponent(m[1]!)];
      if (!p) return json({ error: { code: 404, status: "NOT_FOUND", message: "not found" } }, 404);
      return json(toApi({ ...p, ...(p.details ?? {}) }, mask));
    }
    return json({ error: { message: "không biết đường này" } }, 404);
  }) as typeof fetch;
}

function place(id: string, name: string, extra: Partial<PlaceRecord> & { details?: Partial<PlaceRecord> } = {}): PlaceRecord & { details?: Partial<PlaceRecord> } {
  return { placeId: id, name, address: `${10 + id.length} Trần Phú, Hải Châu, Đà Nẵng, Việt Nam`, types: ["restaurant", "food"], primaryType: "restaurant", businessStatus: "OPERATIONAL", lat: 16.06, lng: 108.22, mapsUrl: null, nationalPhone: null, internationalPhone: null, website: null, rating: null, reviewCount: null, ...extra };
}

async function testPlacesClient() {
  const seen: Seen[] = [];
  const world = { places: { ChIJplace0000001: place("ChIJplace0000001", "Nhà hàng Hải Sản Biển Đông", { details: { nationalPhone: "0905 123 456", rating: 4.5, reviewCount: 637 } }) }, search: () => ["ChIJplace0000001"], fail: { status: 503, times: 1 } };
  const f = fakePlaces(seen, world) as (i: string, init: RequestInit) => Promise<Response>;
  const sleeps: number[] = [];
  const r = await textSearch({ apiKey: API_KEY, timeoutMs: 5000, maxRetries: 2 }, { textQuery: "nhà hàng hải sản Hải Châu Đà Nẵng", tier: "PRO" }, { fetch: f, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.meta.attempts, 2, "503 ⇒ thử lại một lần");
  assert.equal(sleeps[0], 1000, "lùi dần 1 giây ở lần đầu");
  assert.equal(r.places[0]?.name, "Nhà hàng Hải Sản Biển Đông");
  assert.equal(r.places[0]?.nationalPhone, null, "mức PRO không xin SĐT");
  for (const s of seen) {
    assert.ok(!s.url.includes(API_KEY), "khoá KHÔNG nằm trong URL");
    assert.equal(s.key, API_KEY, "khoá trong tiêu đề X-Goog-Api-Key");
  }
  assert.equal(seen[0]!.mask, searchFieldMask("PRO"));
  assert.ok(!seen[0]!.mask.includes("nationalPhoneNumber") && !seen[0]!.mask.includes("rating"), "bước tìm không xin trường Enterprise");
  assert.equal(searchFieldMask("IDS_ONLY"), "places.id,nextPageToken");
  assert.ok(searchFieldMask("ENTERPRISE").includes("places.nationalPhoneNumber"));
  const d = await placeDetails({ apiKey: API_KEY, timeoutMs: 5000, maxRetries: 0 }, { placeId: "ChIJplace0000001", full: false }, { fetch: f });
  assert.ok(d.ok && d.place.nationalPhone === "0905 123 456" && d.place.reviewCount === 637);
  assert.equal(seen.at(-1)!.mask, detailsFieldMask(false));
  // 403: không thử lại, câu lỗi đã che khoá.
  const n = seen.length;
  const bad = await textSearch({ apiKey: `${API_KEY}X`, timeoutMs: 5000, maxRetries: 3 }, { textQuery: "x", tier: "PRO" }, { fetch: f, sleep: async () => undefined });
  assert.ok(!bad.ok && bad.kind === "AUTH");
  assert.equal(seen.length - n, 1, "403 ⇒ đúng một request, không thử lại");
  assert.ok(!bad.message.includes(API_KEY), "câu lỗi không lộ khoá");
  assert.ok(!bad.meta.billable, "lỗi không tính tiền");
  const t = await testGooglePlaces({ secrets: { apiKey: API_KEY } }, { fetch: f });
  assert.ok(t.ok, t.message);
  assert.equal(seen.at(-1)!.mask, "places.id,nextPageToken", "kiểm tra kết nối dùng SKU chỉ-Place-ID (miễn phí)");
  assert.ok(!(await testGooglePlaces({ secrets: { apiKey: "khoá có khoảng trắng" } }, { fetch: f })).ok);
  // 403 chung «The caller does not have permission» ⇒ in lý do máy đọc được (details[].reason) + đúng một chỗ phải sửa.
  const denied = (reason: string) => (async () =>
    new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] } }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
  const ip = await testGooglePlaces({ secrets: { apiKey: API_KEY } }, { fetch: denied("API_KEY_IP_ADDRESS_BLOCKED") });
  assert.ok(!ip.ok && ip.message.includes("IP máy chủ ERP") && ip.message.includes("reason: API_KEY_IP_ADDRESS_BLOCKED"), ip.message);
  const odd = await testGooglePlaces({ secrets: { apiKey: API_KEY } }, { fetch: denied("SOMETHING_NEW") });
  assert.ok(!odd.ok && odd.message.includes("reason: SOMETHING_NEW"), "lý do lạ vẫn được in nguyên, không bị nuốt");

  // ── Trạm chuyển tiếp Cloud Run (Google chặn Places khi gọi từ IP Việt Nam, đo 04/10/2026) ──
  const RELAY = "https://places-relay-abc123-as.a.run.app";
  const RELAY_SECRET = "mat-khau-tram-0123456789abcdef";
  const viaRelay: { url: string; secret: string | null; key: string | null }[] = [];
  const relayFetch = (async (input: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    viaRelay.push({ url: input, secret: h.get("x-relay-secret"), key: h.get("x-goog-api-key") });
    return f(input.replace(RELAY, "https://places.googleapis.com"), init);
  }) as typeof fetch;
  const viaT = await testGooglePlaces({ secrets: { apiKey: API_KEY, relaySecret: RELAY_SECRET }, settings: { relayUrl: RELAY } }, { fetch: relayFetch });
  assert.ok(viaT.ok && viaT.message.includes("qua trạm"), viaT.message);
  assert.equal(viaRelay.at(-1)!.url, `${RELAY}/v1/places:searchText`, "đi tới trạm, giữ nguyên đường dẫn của Google");
  assert.equal(viaRelay.at(-1)!.secret, RELAY_SECRET);
  assert.equal(viaRelay.at(-1)!.key, API_KEY, "khoá Google vẫn đi trong tiêu đề — trạm không giữ khoá");
  const dRelay = await placeDetails({ apiKey: API_KEY, timeoutMs: 5000, maxRetries: 0, relay: { url: `${RELAY}/`, secret: RELAY_SECRET } }, { placeId: "ChIJplace0000001", full: false }, { fetch: relayFetch });
  assert.ok(dRelay.ok);
  assert.ok(viaRelay.at(-1)!.url.startsWith(`${RELAY}/v1/places/ChIJplace0000001?`), viaRelay.at(-1)!.url);
  // Ô địa chỉ trạm do người quản trị tổ chức gõ ⇒ chỉ nhận *.run.app; thiếu mật khẩu ⇒ không gửi gì.
  const n2 = viaRelay.length;
  for (const bad of ["http://places-relay.a.run.app", "https://evil.example.com", "https://169.254.169.254", "https://x.run.app.evil.com"]) {
    const r = await textSearch({ apiKey: API_KEY, timeoutMs: 5000, maxRetries: 0, relay: { url: bad, secret: RELAY_SECRET } }, { textQuery: "x", tier: "IDS_ONLY" }, { fetch: relayFetch });
    assert.ok(!r.ok && r.kind === "INVALID", bad);
  }
  assert.ok(!(await testGooglePlaces({ secrets: { apiKey: API_KEY }, settings: { relayUrl: RELAY } }, { fetch: relayFetch })).ok, "khai trạm mà thiếu mật khẩu ⇒ từ chối");
  assert.equal(viaRelay.length, n2, "địa chỉ / mật khẩu trạm sai ⇒ không một request nào rời máy");
  // Phía trạm: sai mật khẩu ⇒ 401; chỉ ba đường dẫn; chỉ chuyển tiếp tới places.googleapis.com, chỉ hai tiêu đề của Google.
  const upstream: { url: string; headers: Headers }[] = [];
  const upFetch = (async (input: string, init: RequestInit) => {
    upstream.push({ url: input, headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ places: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const req = (o: Partial<{ method: string; url: string; headers: Record<string, string>; body: string }>) => ({ method: "POST", url: "/v1/places:searchText", headers: { "x-relay-secret": RELAY_SECRET, "x-goog-api-key": API_KEY, "x-goog-fieldmask": "places.id", cookie: "a=b" }, body: "{}", ...o });
  assert.equal((await relayHandle(req({ headers: { "x-relay-secret": "sai" } }), { secret: RELAY_SECRET, fetchImpl: upFetch })).status, 401);
  assert.equal((await relayHandle(req({}), { secret: "ngan", fetchImpl: upFetch })).status, 401, "mật khẩu cấu hình < 16 ký tự ⇒ trạm đóng");
  assert.equal((await relayHandle(req({ url: "/v1/places:autocomplete" }), { secret: RELAY_SECRET, fetchImpl: upFetch })).status, 404);
  assert.equal((await relayHandle(req({ method: "GET", url: "/http://169.254.169.254/" }), { secret: RELAY_SECRET, fetchImpl: upFetch })).status, 404);
  assert.equal(upstream.length, 0, "yêu cầu bị từ chối không chạm Google");
  const ok = await relayHandle(req({}), { secret: RELAY_SECRET, fetchImpl: upFetch });
  assert.equal(ok.status, 200);
  assert.equal(upstream[0]!.url, "https://places.googleapis.com/v1/places:searchText");
  assert.equal(upstream[0]!.headers.get("x-goog-api-key"), API_KEY);
  assert.equal(upstream[0]!.headers.get("cookie"), null, "không chuyển tiếp tiêu đề lạ");
  assert.equal(upstream[0]!.headers.get("x-relay-secret"), null, "mật khẩu trạm không đi tiếp tới Google");
  assert.ok(relayAllowed("GET", "/v1/places/ChIJplace0000001") && !relayAllowed("DELETE", "/v1/places/ChIJplace0000001"));
}

function testOpenerAndConfig() {
  const cfg = mergeLeadHunterConfig({ outreach: { ...DEFAULT_LEAD_HUNTER_CONFIG.outreach, promotionNote: "Giảm 5% đơn đầu" } });
  const text = templateOpener(cfg, { businessName: "Nhà hàng ABC", segment: "HOTPOT", areaName: "Hải Châu", provinceLabel: "Đà Nẵng" });
  assert.match(text, /^Em chào Nhà hàng ABC, bên em là Hải Sản Làng Chài/);
  assert.match(text, /lẩu ở Hải Châu, Đà Nẵng/);
  assert.match(text, /Giảm 5% đơn đầu\.$/);
  assert.equal(openerLooksInvented("Bên em giảm 20% cho anh/chị", "Khuyến mãi: Giảm 5% đơn đầu"), "có con số «20» không có trong dữ kiện");
  assert.equal(openerLooksInvented("Em chào anh/chị, bên em giảm 5% đơn đầu", "Khuyến mãi: Giảm 5% đơn đầu"), null);
  assert.ok(openerLooksInvented("Xem https://abc.vn", "không link"));
  assert.equal(channelAction("PHONE_CALL", { phone: "+84905123456", email: null, facebookUrl: null, zaloUrl: null }, "x")?.href, "tel:0905123456");
  assert.equal(channelAction("EMAIL", { phone: null, email: null, facebookUrl: null, zaloUrl: null }, "x"), null, "thiếu kênh ⇒ không có nút");
  // Bản lưu hỏng / thiếu khoá ⇒ mặc định, không ném; ghi đè thưa giữ khoá khác.
  assert.deepEqual(mergeLeadHunterConfig(null), DEFAULT_LEAD_HUNTER_CONFIG);
  assert.equal(mergeLeadHunterConfig({ budget: { dailyUsd: 2 } }).budget.monthlyUsd, DEFAULT_LEAD_HUNTER_CONFIG.budget.monthlyUsd);
  assert.equal(mergeLeadHunterConfig({ budget: { dailyUsd: 2 } }).budget.dailyUsd, 2);
  assert.deepEqual(mergeLeadHunterConfig({ gradeThresholds: { A: 50, B: 60, C: 10 } }), DEFAULT_LEAD_HUNTER_CONFIG, "ngưỡng sai thứ tự ⇒ bỏ cả bản, không sửa hộ");
}

// ─────────────────────────── 2. TỔ CHỨC THẬT ───────────────────────────

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const P = {
  seafood: place("ChIJseafood0000001", "Nhà hàng Hải Sản Biển Đông", { primaryType: "seafood_restaurant", types: ["seafood_restaurant", "restaurant"], details: { nationalPhone: "0905 123 456", website: "https://biendong.vn", rating: 4.5, reviewCount: 637 } }),
  hotpot: place("ChIJhotpot00000001", "Lẩu Dê 404", { details: { internationalPhone: "+84 905 222 333", rating: 4.1, reviewCount: 210 } }),
  cafe: place("ChIJcafe0000000001", "Cà phê Sáng", { primaryType: "cafe", types: ["cafe"] }),
  closed: place("ChIJclosed00000001", "Nhà hàng Đã Đóng", { businessStatus: "CLOSED_PERMANENTLY" }),
  branch: place("ChIJbranch00000001", "Hải Sản Biển Đông - Chi nhánh 2", { address: "99 Võ Nguyên Giáp, Sơn Trà, Đà Nẵng, Việt Nam", details: { nationalPhone: "0905123456", website: "https://biendong.vn/chi-nhanh-2", rating: 4.2, reviewCount: 80 } }),
  nophone: place("ChIJnophone0000001", "Buffet Hải Sản Sóng", { details: { rating: 4.4, reviewCount: 300 } }),
  pub: place("ChIJpub00000000001", "Quán Nhậu Cây Dừa", { details: { nationalPhone: "0236 3555 777", website: "https://www.facebook.com/caydua", rating: 3.9, reviewCount: 95 } }),
};

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser>, modules: string[]): SessionUser {
  return { id: u.id, email: u.email, name: "Người thử", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử sỉ", isHome: false }, modules, ...over };
}

async function leadByPlace(placeId: string) {
  return (await getDb()).query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.placeId, placeId) });
}

async function testDb() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử sỉ", plan: "standard", modules: ["customers", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "HaiSan@12345" }, source: "TEST", actor: null });
  const home = await getHomeOrganization();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedFetch = globalThis.fetch;
  const seen: Seen[] = [];
  const world = { places: { ...Object.fromEntries(Object.values(P).map((p) => [p.placeId, p])) } as Record<string, PlaceRecord & { details?: Partial<PlaceRecord> }>, search: (q: string) => (q.startsWith("nhà hàng hải sản") || q.startsWith("buffet") ? Object.values(P).map((p) => p.placeId) : []) };
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  globalThis.fetch = fakePlaces(seen, world);
  try {
    // ── Tổ chức nhà TẮT module ⇒ job bỏ qua, không request ──
    const nha = (await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: home.code })) as { skipped?: string };
    assert.equal(nha.skipped, "MODULE_DISABLED", JSON.stringify(nha));
    assert.equal(seen.length, 0);

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const modules = [...(await getEnabledModules(ORG))];
      assert.ok(modules.includes("wholesale_leads"));
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = sessionOf(u, {}, modules);
      const [salesRow] = await db.insert(schema.users).values({ email: `sale@${ORG}.local`, name: "Sale Hoa", role: "CS", passwordHash: "x", dataScope: "ASSIGNED" }).returning();
      const sales = sessionOf(salesRow!, { role: "CS", name: "Sale Hoa", permissions: ["wholesale:view", "wholesale:work", "customers:view"], scope: "ASSIGNED" }, modules);
      const manager = sessionOf(u, { role: "MANAGER", permissions: ["wholesale:view", "wholesale:work", "wholesale:assign"] }, modules);

      // ── Quyền ──
      assert.ok(can(admin, "wholesale:config") && can(admin, "wholesale:scan"));
      assert.ok(!can(sales, "wholesale:scan") && !can(sales, "wholesale:assign") && can(sales, "wholesale:work"));
      assert.ok(!can(manager, "wholesale:scan") && !can(manager, "wholesale:config") && can(manager, "wholesale:assign"));
      assert.ok(!can({ ...admin, modules: modules.filter((m) => m !== "wholesale_leads") }, "wholesale:view"), "module tắt ⇒ kể cả ADMIN cũng không");
      const campInput = { name: "Đà Nẵng thử", provinces: [], customAreas: "Đà Nẵng: Hải Châu, Sơn Trà", keywordGroups: DEFAULT_KEYWORD_GROUPS.map((g) => ({ key: g.key, enabled: false })), extraKeywords: "nhà hàng hải sản, hải sản, buffet hải sản, lẩu hải sản, buffet", excludeKeywords: "chay", targetSegments: ["SEAFOOD_RESTAURANT", "HOTPOT", "BUFFET", "PUB_BEER", "RESTAURANT"], maxLeads: 100, requirePhone: true, discoveryTier: "PRO" };
      assert.ok("error" in (await createCampaignCore(sales, campInput)), "Sales không tạo chiến dịch quét");

      // ── Kết nối «google-places»: lưu → kiểm tra (fetch giả) → bật ──
      const fk = fakePlaces(seen, world) as (i: string, init: RequestInit) => Promise<Response>;
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "google-places", settings: {}, secrets: { apiKey: API_KEY } })));
      const t = await testOrgConnection(admin, "google-places", { tester: { fetch: fk } });
      assert.ok("ok" in t, JSON.stringify(t));
      assert.ok("ok" in (await setConnectionStatus(admin, "google-places", "ACTIVE")));
      // Website: tắt ở bài kiểm job thật (không gọi DNS / mạng); phần đọc website đo riêng bằng bộ đọc giả.
      await saveLeadHunterConfig({ ...PAID_CFG, requestIntervalMs: 0, maxRetries: 0, websiteEnrichment: { enabled: false, maxPages: 2 } });

      // ── Xem trước: 2 khu vực × 5 từ khoá = 10 truy vấn, không gọi Google ──
      const before = seen.length;
      const pv = await previewCampaignCore(admin, campInput);
      assert.ok("ok" in pv, JSON.stringify(pv));
      assert.equal(pv.preview.cells, 2 * 5);
      assert.equal(seen.length, before, "xem trước KHÔNG gọi Google");
      const created = await createCampaignCore(admin, campInput);
      assert.ok("ok" in created);
      const campId = created.id;
      const started = await startCampaignCore(admin, campId);
      assert.ok("ok" in started && started.queued === 10, JSON.stringify(started));
      assert.ok("error" in (await startCampaignCore(admin, campId)), "bấm Bắt đầu lần hai không nhân ô");

      // ── Job thật (runJob → kết nối của tổ chức → client → Google giả) ──
      for (let i = 0; i < 4; i++) await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: ORG });
      const search = seen.filter((s) => s.url.endsWith(":searchText"));
      const searchesAfterRun = search.length - 1; // trừ lượt «Kiểm tra kết nối»
      assert.equal(searchesAfterRun, 10, "mỗi ô đúng một lượt tìm (7 kết quả < 20 ⇒ không xin trang 2)");
      for (const s of seen) assert.ok(!s.url.includes(API_KEY));
      const camp = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, campId) });
      assert.equal(camp?.status, "COMPLETED", "hết ô + hết lead chờ ⇒ hoàn tất");
      // Lọc trước chi tiết: cà phê (sai nhóm) và quán đã đóng KHÔNG thành lead, KHÔNG tốn lượt chi tiết.
      assert.equal(await leadByPlace(P.cafe.placeId), undefined);
      assert.equal(await leadByPlace(P.closed.placeId), undefined);
      const details = seen.filter((s) => s.method === "GET" && s.url.includes("/v1/places/"));
      assert.equal(details.length, 5, "chỉ 5 địa điểm qua lọc mới lấy chi tiết");
      const seafoodRow = await leadByPlace(P.seafood.placeId);
      const hotpot = await leadByPlace(P.hotpot.placeId);
      const branchRow = await leadByPlace(P.branch.placeId);
      // Hai địa điểm CÙNG SĐT trên cùng một trang: lead nào bổ sung chi tiết trước là lead gốc, lead sau thành «trùng».
      const [seafood, branch] = seafoodRow?.enrichmentStatus === "READY" ? [seafoodRow, branchRow] : [branchRow, seafoodRow];
      const mainSnap = await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, seafood!.placeId!) });
      const mainName = mainSnap!.displayName!;
      const nophone = await leadByPlace(P.nophone.placeId);
      const pub = await leadByPlace(P.pub.placeId);
      assert.equal(seafood?.enrichmentStatus, "READY");
      assert.equal(branch?.enrichmentStatus, "DUPLICATE", "cùng SĐT 0905 123 456 / 0905123456 với lead đã có ⇒ trùng");
      assert.equal(branch?.duplicateOfLeadId, seafood?.id);
      assert.equal(branch?.filterReason, "DUPLICATE_PHONE");
      assert.equal(nophone?.enrichmentStatus, "FILTERED");
      assert.equal(nophone?.filterReason, "NO_PHONE");
      assert.equal(pub?.facebookUrl, "https://www.facebook.com/caydua", "website là trang Facebook ⇒ thành kênh Facebook");
      assert.equal(seafood?.provinceKey, "da nang");
      assert.equal(seafood?.segment, "SEAFOOD_RESTAURANT", "«Hải sản» trong tên ⇒ nhà hàng hải sản (cả hai địa điểm)");
      assert.equal(seafood?.leadGrade, "A", JSON.stringify(seafood?.scoreReasons));
      assert.equal(seafood?.contactStatus, "QUALIFIED", "≥ 65 điểm + có SĐT ⇒ tự lên «Đủ điều kiện»");
      assert.ok(String(JSON.stringify(seafood?.scoreReasons)).includes("có 2 điểm bán"), "chi nhánh trùng SĐT được ghi vào lý do quy mô của lead gốc (hai điểm vẫn là cơ sở vừa, chưa phải chuỗi)");
      assert.equal(hotpot?.enrichmentStatus, "READY");
      const snap = await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, P.hotpot.placeId) });
      assert.equal(snap?.normalizedPhone, "+84905222333", "SĐT chỉ có dạng quốc tế vẫn chuẩn hoá được");
      assert.equal(hotpot?.normalizedPhone, null, "SĐT nguồn Google KHÔNG chép vào bảng của tổ chức");
      const usage = await db.select({ n: count(), micros: sql<string>`sum(${schema.wholesaleApiUsage.costMicros})` }).from(schema.wholesaleApiUsage).where(eq(schema.wholesaleApiUsage.provider, "GOOGLE_PLACES"));
      assert.equal(Number(usage[0]!.n), 15);
      assert.equal(Number(usage[0]!.micros), 10 * 32_000 + 5 * 20_000, "chi phí ước tính = 10 lượt tìm Pro + 5 lượt chi tiết Enterprise");
      const hits = await db.select({ n: count() }).from(schema.wholesalePlaceHits).where(eq(schema.wholesalePlaceHits.campaignId, campId));
      assert.equal(Number(hits[0]!.n), 7, "70 kết quả trả về, 7 địa điểm khác nhau");
      const runs = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "wholesale-leads"));
      assert.ok(runs.length >= 1 && runs.length <= 4, "có việc ⇒ ghi sync_runs; lượt rỗng không ghi");
      const audits = await db.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(sql`${schema.auditLogs.action} like 'WHOLESALE_%'`);
      for (const a of ["WHOLESALE_CAMPAIGN_CREATE", "WHOLESALE_SCAN_START"]) assert.ok(audits.some((x) => x.action === a), a);

      // ── Quét lại cùng Place ID 10 lần ⇒ vẫn MỘT lead; hai lượt song song ⇒ không nhân đôi ──
      const cc = schema.wholesaleCampaignCells;
      for (let i = 0; i < 10; i++) {
        await db.update(cc).set({ status: "PENDING", pageToken: null }).where(eq(cc.campaignId, campId));
        await db.update(schema.wholesaleCampaigns).set({ status: "RUNNING" }).where(eq(schema.wholesaleCampaigns.id, campId));
        await db.delete(schema.wholesalePlaceHits).where(eq(schema.wholesalePlaceHits.campaignId, campId));
        if (i % 2) await Promise.all([runLeadHunterTick({ budgetMs: 20_000 }), runLeadHunterTick({ budgetMs: 20_000 })]);
        else await runLeadHunterTick({ budgetMs: 20_000 });
      }
      const sameSeafood = await db.select({ n: count() }).from(schema.wholesaleLeads).where(eq(schema.wholesaleLeads.placeId, seafood!.placeId!));
      assert.equal(Number(sameSeafood[0]!.n), 1, "quét cùng Place ID 10 lần ⇒ đúng một lead");
      const total = await db.select({ n: count() }).from(schema.wholesaleLeads);
      assert.equal(Number(total[0]!.n), 5);

      // ── Tạm dừng giữa chừng ⇒ tiếp tục đúng điểm (nhà cung cấp giả bấm «Tạm dừng» sau lượt tìm thứ 2) ──
      let calls = 0;
      const queries: string[] = [];
      const provider: DiscoveryProvider = {
        key: "GOOGLE_PLACES",
        label: "giả",
        role: "DISCOVERY",
        googleSourced: true,
        billable: true,
        async search(req) {
          calls++;
          if (req.mode === "TEXT") queries.push(req.textQuery);
          if (calls === 2) await changeCampaignStateCore(admin, camp2, "pause");
          return { ok: true, places: [], nextPageToken: null, meta: { sku: "TEXT_SEARCH_PRO", httpStatus: 200, durationMs: 1, attempts: 1, billable: true } };
        },
        async details() {
          return { ok: false, kind: "NOT_FOUND", message: "x", meta: { sku: "DETAILS_ENTERPRISE", httpStatus: 404, durationMs: 1, attempts: 1, billable: false } };
        },
      };
      const c2 = await createCampaignCore(admin, { ...campInput, name: "Hải Phòng thử", customAreas: "Hải Phòng: Lê Chân, Ngô Quyền, Hồng Bàng" });
      assert.ok("ok" in c2);
      const camp2 = c2.id;
      assert.ok("ok" in (await startCampaignCore(admin, camp2)));
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider, sleep: async () => undefined });
      const afterPause = await db.select({ status: cc.status }).from(cc).where(eq(cc.campaignId, camp2));
      assert.equal(afterPause.filter((r) => r.status === "DONE").length, 2, "dừng ngay sau lượt đang chạy");
      assert.equal(afterPause.filter((r) => r.status === "PENDING").length, 13);
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider, sleep: async () => undefined });
      assert.equal(calls, 2, "đang tạm dừng ⇒ không gọi thêm");
      assert.ok("ok" in (await changeCampaignStateCore(admin, camp2, "resume")));
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider, sleep: async () => undefined });
      assert.equal(calls, 15, "tiếp tục đúng chỗ: 15 ô, mỗi ô đúng MỘT lượt");
      assert.equal(new Set(queries).size, 15, "không ô nào bị quét lại sau khi tiếp tục");

      // ── Lỗi API ⇒ thử lại ở lượt sau, không nhân đôi ──
      const flaky: DiscoveryProvider = {
        ...provider,
        async search() {
          calls++;
          if (calls === 16) return { ok: false, kind: "SERVER", message: "HTTP 503", meta: { sku: "TEXT_SEARCH_PRO", httpStatus: 503, durationMs: 1, attempts: 3, billable: false } };
          const nhau = place("ChIJnhau000000001", "Hải Sản Cô Ba", { details: { nationalPhone: "0912000111" } });
          return { ok: true, places: [nhau], nextPageToken: null, meta: { sku: "TEXT_SEARCH_PRO", httpStatus: 200, durationMs: 1, attempts: 1, billable: true } };
        },
      };
      const c3 = await createCampaignCore(admin, { ...campInput, name: "Lỗi thử", customAreas: "Quảng Ninh: Hạ Long", keywordGroups: campInput.keywordGroups.map((g) => ({ ...g, enabled: g.key === "hai-san" })) });
      assert.ok("ok" in c3);
      assert.ok("ok" in (await startCampaignCore(admin, c3.id)));
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider: flaky, sleep: async () => undefined });
      const failedCell = await db.select().from(cc).where(and(eq(cc.campaignId, c3.id), eq(cc.attempts, 1)));
      assert.equal(failedCell.length, 1, "ô lỗi giữ lại để thử lại, có hẹn giờ");
      await db.update(cc).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(cc.campaignId, c3.id));
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider: flaky, sleep: async () => undefined });
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider: flaky, sleep: async () => undefined });
      const coBa = await db.select({ n: count() }).from(schema.wholesaleLeads).where(eq(schema.wholesaleLeads.placeId, "ChIJnhau000000001"));
      assert.equal(Number(coBa[0]!.n), 1, "thử lại sau lỗi không sinh lead trùng");

      // ── Trần ngân sách: tự tạm dừng, báo chủ shop, tự mở lại ngày sau ──
      await saveLeadHunterConfig({ ...PAID_CFG, requestIntervalMs: 0, maxRetries: 0, websiteEnrichment: { enabled: false, maxPages: 2 }, budget: { dailyUsd: 0.5, monthlyUsd: 1000, dailyRequestLimit: 100_000 } });
      const c4 = await createCampaignCore(admin, { ...campInput, name: "Trần thử", customAreas: "Thanh Hóa: Sầm Sơn, Hậu Lộc" });
      assert.ok("ok" in c4);
      assert.ok("ok" in (await startCampaignCore(admin, c4.id)));
      const spentBefore = Number((await db.select({ m: sql<string>`coalesce(sum(${schema.wholesaleApiUsage.costMicros}), 0)` }).from(schema.wholesaleApiUsage))[0]!.m);
      assert.ok(spentBefore > 500_000, "đã chi hơn 0,5 US$ hôm nay ⇒ chạm trần ngày ngay lượt gọi đầu");
      const capped = await runLeadHunterTick({ budgetMs: 20_000 }, { provider: flaky, sleep: async () => undefined });
      assert.ok(capped.paused.some((p) => p.campaignId === c4.id && p.reason === "BUDGET_DAILY"), JSON.stringify(capped.paused));
      const c4row = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, c4.id) });
      assert.equal(c4row?.status, "PAUSED");
      assert.equal(c4row?.pauseReason, "BUDGET_DAILY");
      const notes = await db.select().from(schema.notifications).where(sql`${schema.notifications.dedupeKey} like 'wholesale:pause:BUDGET_DAILY:%'`);
      assert.equal(notes.length, 1, "báo chủ shop đúng một tin");
      const spentAfter = Number((await db.select({ m: sql<string>`coalesce(sum(${schema.wholesaleApiUsage.costMicros}), 0)` }).from(schema.wholesaleApiUsage))[0]!.m);
      assert.equal(spentAfter, spentBefore, "chạm trần ⇒ KHÔNG gọi thêm lượt tính tiền nào");
      const tomorrow = new Date(Date.now() + 36 * 3_600_000);
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider: flaky, sleep: async () => undefined, now: () => tomorrow });
      const resumed = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, c4.id) });
      assert.ok(resumed?.status === "RUNNING" || resumed?.status === "COMPLETED" || resumed?.status === "PAUSED", String(resumed?.status));
      assert.notEqual(resumed?.pauseReason, "BUDGET_DAILY", "sang ngày mới (trần ngày mở lại) ⇒ tự chạy lại");
      await saveLeadHunterConfig({ ...PAID_CFG, requestIntervalMs: 0, maxRetries: 0, websiteEnrichment: { enabled: true, maxPages: 2 }, budget: { dailyUsd: 1000, monthlyUsd: 1000, dailyRequestLimit: 100_000 } });

      // ── Đọc website (bộ đọc giả): phát hiện có URL nguồn, chỉ điền ô trống ──
      const enricher: EnrichmentProvider = {
        key: "WEBSITE",
        label: "giả",
        role: "ENRICHMENT",
        googleSourced: false,
        billable: false,
        async enrich(site) {
          return { status: "DONE", pagesRead: 2, note: "Đọc 2 trang", findings: [{ kind: "EMAIL", value: "datban@biendong.vn", sourceUrl: `${site}/lien-he` }, { kind: "FACEBOOK", value: "https://www.facebook.com/haisanbiendong", sourceUrl: site }] };
        },
      };
      await db.update(schema.wholesaleLeads).set({ websiteStatus: "PENDING" }).where(eq(schema.wholesaleLeads.id, seafood!.id));
      await runLeadHunterTick({ budgetMs: 20_000 }, { provider: flaky, enricher, sleep: async () => undefined });
      const enriched = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, seafood!.id) });
      assert.equal(enriched?.email, "datban@biendong.vn");
      assert.equal(enriched?.websiteStatus, "DONE");
      const ers = await db.select().from(schema.wholesaleLeadEnrichments).where(eq(schema.wholesaleLeadEnrichments.leadId, seafood!.id));
      assert.ok(ers.some((e) => e.sourceUrl.endsWith("/lien-he")), "lưu URL nguồn để kiểm lại");
      // Phần còn lại chạy job thật: tắt đọc website để không lượt nào chạm DNS / mạng thật.
      await saveLeadHunterConfig({ ...PAID_CFG, requestIntervalMs: 0, maxRetries: 0, websiteEnrichment: { enabled: false, maxPages: 2 }, budget: { dailyUsd: 1000, monthlyUsd: 1000, dailyRequestLimit: 100_000 } });

      // ── Phạm vi dữ liệu: Sales «Được giao» chỉ thấy / chỉ chạm lead của mình ──
      assert.ok("error" in (await assignLeadsCore(sales, { leadIds: [seafood!.id], userId: salesRow!.id })), "Sales không giao được");
      const assigned = await assignLeadsCore(manager, { leadIds: [seafood!.id], userId: salesRow!.id });
      assert.ok("ok" in assigned && assigned.changed === 1);
      const dSales = await decideScope("WHOLESALE_LEADS", sales);
      assert.equal(dSales.allow, "ROWS");
      const listSales = await listWholesaleLeads(parseListParams({}, { defaultSort: "leadScore", filterKeys: ["view"] }), dSales, sales.id);
      assert.deepEqual(listSales.rows.map((r) => r.id), [seafood!.id], "chỉ lead được giao");
      assert.ok("error" in (await logCallCore(sales, hotpot!.id, { outcome: "ANSWERED", note: "x" })), "lead không được giao ⇒ không ghi được");
      const call = await logCallCore(sales, seafood!.id, { outcome: "ANSWERED", note: "Đang nhập hải sản ở chợ Hàn, muốn xem bảng giá" });
      assert.ok("ok" in call && call.status === "CONTACTED");
      const afterCall = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, seafood!.id) });
      assert.ok(afterCall?.firstContactAt && afterCall.firstResponseAt && afterCall.contactAttemptCount === 1);
      assert.equal(afterCall?.businessName, mainName, "nghe máy ⇒ tên thành dữ liệu của shop");
      assert.equal(afterCall?.normalizedPhone, "+84905123456");
      assert.equal(afterCall?.phoneSource, "VERIFIED_CALL");
      assert.equal(afterCall?.address, null, "chưa tích «khách xác nhận địa chỉ» ⇒ không chép địa chỉ");

      // ── Hàng đợi liên hệ: soạn (mẫu) → duyệt → đã gửi → kết quả ──
      const prep = await prepareOutreachCore(sales, seafood!.id, { channel: "ZALO", useAi: false });
      assert.ok("ok" in prep, JSON.stringify(prep));
      assert.ok("error" in (await prepareOutreachCore(sales, seafood!.id, { channel: "ZALO", useAi: false })), "một kênh một lời chào đang mở");
      const item = await db.query.wholesaleOutreachItems.findFirst({ where: eq(schema.wholesaleOutreachItems.id, prep.id) });
      assert.ok(item!.message.includes(mainName), item!.message);
      assert.ok("ok" in (await approveOutreachCore(sales, prep.id, { message: `${item!.message} Em gửi anh/chị catalog nhé.` })));
      assert.ok("ok" in (await markOutreachSentCore(sales, prep.id)));
      const res = await recordOutreachResultCore(sales, prep.id, { result: "INTERESTED", note: "Xin bảng giá tôm, mực" });
      assert.ok("ok" in res && res.status === "INTERESTED");

      // ── Không liên hệ: chặn mọi đường, không bao giờ quay lại chiến dịch / hàng đợi ──
      const dnc = await updateLeadStatusCore(admin, hotpot!.id, { status: "DO_NOT_CONTACT", note: "Chủ quán từ chối, không gọi nữa" });
      assert.ok("ok" in dnc);
      const sup = await db.select().from(schema.wholesaleSuppressions).where(eq(schema.wholesaleSuppressions.leadId, hotpot!.id));
      assert.deepEqual(sup.map((s) => s.kind).sort(), ["PHONE", "PLACE"]);
      assert.ok("error" in (await updateLeadStatusCore(admin, hotpot!.id, { status: "QUALIFIED" })), "không liên hệ là một chiều");
      const q = await queueOutreachCore(admin, [hotpot!.id], "PHONE_CALL");
      assert.ok("ok" in q && q.queued === 0 && q.skipped === 1);
      const addC = await addLeadsToCampaignCore(admin, { leadIds: [hotpot!.id], campaignId: camp2 });
      assert.ok("ok" in addC && addC.blocked === 1 && addC.added === 0);
      // Địa điểm MỚI mang đúng SĐT bị chặn ⇒ lọc SUPPRESSED, không vào hàng đợi.
      world.places.ChIJhotpot2_000001 = place("ChIJhotpot2_000001", "Lẩu Dê 404 cơ sở 2", { details: { nationalPhone: "0905222333" } });
      const c5 = await createCampaignCore(admin, { ...campInput, name: "Sau chặn", customAreas: "Đà Nẵng: Liên Chiểu" });
      assert.ok("ok" in c5 && "ok" in (await startCampaignCore(admin, c5.id)));
      world.search = (qq: string) => (qq.includes("Liên Chiểu") ? ["ChIJhotpot2_000001", P.hotpot.placeId] : []);
      await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: ORG });
      await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: ORG });
      const lau2 = await leadByPlace("ChIJhotpot2_000001");
      assert.equal(lau2?.filterReason, "SUPPRESSED", JSON.stringify(lau2));
      const hotpotAgain = await db.select().from(schema.wholesaleLeadCampaigns).where(and(eq(schema.wholesaleLeadCampaigns.leadId, hotpot!.id), eq(schema.wholesaleLeadCampaigns.campaignId, c5.id)));
      assert.equal(hotpotAgain.length, 0, "lead không liên hệ không bị kéo vào chiến dịch mới");

      // ── Chuỗi lớn / nơi quá đông (chưa xuất hoá đơn ⇒ chưa phải khách lúc này) ──
      world.places.ChIJkichi000000001 = place("ChIJkichi000000001", "Kichi-Kichi Vincom Đà Nẵng", { details: { nationalPhone: "0905777001", reviewCount: 900 } });
      world.places.ChIJbigsea00000001 = place("ChIJbigsea00000001", "Nhà hàng Hải Sản Khổng Lồ", { details: { nationalPhone: "0905777002", reviewCount: 9000, rating: 4.3 } });
      world.places.ChIJsmall000000001 = place("ChIJsmall000000001", "Quán Hải Sản Cô Ba", { details: { nationalPhone: "0905777003", reviewCount: 140, rating: 4.4 } });
      const c6 = await createCampaignCore(admin, { ...campInput, name: "Loại chuỗi", customAreas: "Đà Nẵng: Thanh Khê" });
      assert.ok("ok" in c6 && "ok" in (await startCampaignCore(admin, c6.id)));
      world.search = (qq: string) => (qq.includes("Thanh Khê") ? ["ChIJkichi000000001", "ChIJbigsea00000001", "ChIJsmall000000001"] : []);
      await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: ORG });
      await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: ORG });
      const kichiHit = await db.query.wholesalePlaceHits.findFirst({ where: eq(schema.wholesalePlaceHits.placeId, "ChIJkichi000000001") });
      assert.equal(kichiHit?.reason, "CHAIN", "tên khớp danh sách chuỗi ⇒ lọc trước khi tốn lượt chi tiết");
      assert.equal(await leadByPlace("ChIJkichi000000001"), undefined);
      assert.ok(!seen.some((x) => x.url.includes("/v1/places/ChIJkichi000000001")), "chuỗi không tốn lượt Place Details");
      assert.equal((await leadByPlace("ChIJbigsea00000001"))?.filterReason, "TOO_LARGE", "9.000 đánh giá > trần 5.000 ⇒ quá lớn");
      assert.equal((await leadByPlace("ChIJsmall000000001"))?.enrichmentStatus, "READY", "quán vừa và nhỏ đi tiếp");
      await changeCampaignStateCore(admin, c6.id, "stop").catch(() => undefined);

      // ── Chế độ chỉ dùng miễn phí: hết lượt miễn phí của SKU ⇒ tự dừng TRƯỚC lượt gọi, không phát sinh tiền ──
      const usedPro = Number((await db.select({ n: count() }).from(schema.wholesaleApiUsage).where(and(eq(schema.wholesaleApiUsage.sku, "TEXT_SEARCH_PRO"), eq(schema.wholesaleApiUsage.billable, true))))[0]?.n ?? 0);
      assert.ok(usedPro > 0);
      const cfgFree = mergeLeadHunterConfig((await db.query.settings.findFirst({ where: eq(schema.settings.key, "wholesale.leadHunter") }))?.value);
      await saveLeadHunterConfig({ ...cfgFree, freeTier: { ...cfgFree.freeTier, enabled: true, monthlyCalls: { ...cfgFree.freeTier.monthlyCalls, TEXT_SEARCH_PRO: usedPro } } });
      const c7 = await createCampaignCore(admin, { ...campInput, name: "Miễn phí", customAreas: "Đà Nẵng: Cẩm Lệ" });
      assert.ok("ok" in c7 && "ok" in (await startCampaignCore(admin, c7.id)));
      const callsBefore = seen.length;
      await runJob("wholesale-leads", { trigger: "CRON", actor: "wl-test", org: ORG });
      const c7row = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, c7.id) });
      assert.equal(c7row?.status, "PAUSED");
      assert.equal(c7row?.pauseReason, "FREE_TIER");
      assert.equal(seen.length, callsBefore, "hết lượt miễn phí ⇒ không gọi Google");
      await changeCampaignStateCore(admin, c7.id, "stop");
      await saveLeadHunterConfig(cfgFree);

      // ── Màn điện thoại: bấm gọi ≠ đã gọi; kết quả ⇒ trạng thái; thứ tự gọi; khách tiếp theo ──
      const dAll = await decideScope("WHOLESALE_LEADS", admin);
      const pubLead = (await leadByPlace(P.pub.placeId))!;
      assert.equal(pubLead.enrichmentStatus, "READY");
      assert.ok("ok" in (await logCallInitiatedCore(admin, pubLead.id)));
      const ini = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, pubLead.id), eq(schema.wholesaleLeadActivities.kind, "CALL_INITIATED")));
      assert.equal(ini.length, 1);
      assert.equal((ini[0]!.meta as { phone?: string }).phone, "+842363555777", "ghi số đã mở");
      const afterIni = (await leadByPlace(P.pub.placeId))!;
      assert.equal(afterIni.contactAttemptCount, pubLead.contactAttemptCount, "bấm gọi KHÔNG phải một lần liên hệ");
      assert.equal(afterIni.contactStatus, pubLead.contactStatus);
      const cb = await logCallCore(admin, pubLead.id, { outcome: "CALLBACK", note: "Gọi lại chiều mai" });
      assert.ok("ok" in cb && cb.status === "CONTACTED" && cb.nextFollowupAt, JSON.stringify(cb));
      assert.equal(new Date(cb.nextFollowupAt!).toISOString().slice(11, 16), "02:00", "hẹn gọi lại mặc định 9 giờ sáng giờ VN");
      // Hẹn đã QUÁ HẠN ⇒ đứng đầu hàng đợi «Cần gọi»; vừa gọi trong 2 giờ ⇒ «khách tiếp theo» bỏ qua.
      await db.update(schema.wholesaleLeads).set({ nextFollowupAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.wholesaleLeads.id, pubLead.id));
      const queue = await mobileQueue(dAll, "call", "");
      assert.equal(queue[0]?.id, pubLead.id, JSON.stringify(queue.map((x) => [x.name, x.rank])));
      assert.equal(queue[0]?.rank, 0);
      assert.notEqual(await nextLeadId(dAll, "call", null), pubLead.id, "vừa gọi xong thì không đưa lại ngay");
      assert.equal((await mobileQueue(dAll, "call", "3555 777"))[0]?.id, pubLead.id, "tìm theo SĐT");
      const smallLead = (await leadByPlace("ChIJsmall000000001"))!;
      const pr = await logCallCore(admin, smallLead.id, { outcome: "PRICE_REQUESTED", note: "Cần bảng giá chả mực" });
      assert.ok("ok" in pr && pr.status === "INTERESTED");
      assert.equal((await leadByPlace("ChIJsmall000000001"))?.nextAction, PRICE_REQUEST_ACTION);
      assert.ok((await mobileQueue(dAll, "price", "")).some((x) => x.id === smallLead.id), "chip «Chờ báo giá»");
      const home = await mobileHome(dAll, admin.id);
      assert.ok(home.priceWaiting >= 1 && home.followupDue >= 1 && home.myCallsToday >= 2, JSON.stringify(home));
      const ni = await logCallCore(admin, smallLead.id, { outcome: "NOT_INTERESTED", note: "Đã có mối" });
      assert.ok("ok" in ni && ni.status === "LOST");
      const lostRow = (await leadByPlace("ChIJsmall000000001"))!;
      assert.match(lostRow.lostReason ?? "", /^Không có nhu cầu — Đã có mối/);
      assert.equal(lostRow.nextFollowupAt, null);
      assert.ok((await mobileQueue(dAll, "done", "")).some((x) => x.id === smallLead.id));
      assert.ok(!(await mobileQueue(dAll, "all", "")).some((x) => x.id === smallLead.id), "đã kết thúc ⇒ ra khỏi danh sách gọi");

      // ── Nhập tệp: +84… trùng 0… đã có ⇒ bỏ qua; số mới ⇒ tạo; số bị chặn ⇒ đếm riêng ──
      const csv = "Tên,SĐT,Địa chỉ,Tỉnh,Website\nHải sản Biển Đông (danh bạ),+84905123456,,Đà Nẵng,\nNhà hàng Sông Hàn,0905 999 888,5 Bạch Đằng,Đà Nẵng,https://songhan.vn\nLẩu Dê nhập tay,0905-222-333,,,\n,0905000000,,,";
      const imp = await importLeadsCore(admin, csv);
      assert.ok("ok" in imp, JSON.stringify(imp));
      assert.equal(imp.report.created, 1);
      assert.equal(imp.report.duplicates, 1, "+84905123456 và 0905123456 là một");
      assert.equal(imp.report.suppressed, 1);
      assert.ok(imp.report.errors.some((e) => /Dòng 5/.test(e)), "dòng thiếu tên báo đúng dòng");
      const songHan = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.businessName, "Nhà hàng Sông Hàn") });
      assert.equal(songHan?.normalizedPhone, "+84905999888");
      assert.equal(songHan?.websiteDomain, "songhan.vn");
      assert.equal(songHan?.source, "MANUAL_IMPORT");

      // ── Chuyển thành khách hàng: qua đúng lõi tạo khách, không tạo bản thứ hai ──
      const conv = await convertLeadCore(sales, seafood!.id, {});
      assert.ok("ok" in conv && !conv.existing, JSON.stringify(conv));
      const cust = await db.query.customers.findFirst({ where: eq(schema.customers.id, conv.customerId) });
      assert.equal(cust?.phone, "0905123456", "khách lưu SĐT dạng nội địa như mọi khách tạo tay");
      assert.equal(cust?.name, mainName, "tên lấy từ lead, không nhập lại");
      const won = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, seafood!.id) });
      assert.equal(won?.contactStatus, "WON");
      assert.equal(won?.customerId, conv.customerId);
      assert.equal(won?.phoneSource, "VERIFIED_CALL", "khách xác nhận ⇒ SĐT thành dữ liệu của tổ chức");
      const again = await convertLeadCore(sales, seafood!.id, {});
      assert.ok("ok" in again && again.customerId === conv.customerId);
      const custCount = await db.select({ n: count() }).from(schema.customers).where(eq(schema.customers.phone, "0905123456"));
      assert.equal(Number(custCount[0]!.n), 1);
      assert.ok("error" in (await updateLeadStatusCore(sales, seafood!.id, { status: "NEGOTIATING" })), "đã thành khách ⇒ không lùi trạng thái");

      // ── Gửi nhân viên thị trường: qua sổ gửi tin (hộp thử), một tin / lead, bấm lại cùng phút không gửi lần hai ──
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "sandbox-messaging", settings: { channelName: "Nhóm thị trường" } })));
      assert.ok("ok" in (await testOrgConnection(admin, "sandbox-messaging")));
      assert.ok("ok" in (await setConnectionStatus(admin, "sandbox-messaging", "ACTIVE")));
      const cfgNow = mergeLeadHunterConfig((await db.query.settings.findFirst({ where: eq(schema.settings.key, "wholesale.leadHunter") }))?.value);
      await saveLeadHunterConfig({ ...cfgNow, fieldSales: { connectorKey: "sandbox-messaging", destinations: [{ label: "NV thị trường Đà Nẵng", chatId: "Nhóm ĐN" }] } });
      const at = new Date();
      const ho = await sendLeadsToFieldCore(sales, { leadIds: [seafood!.id, hotpot!.id], destination: 0, note: "Ghé trước 10h" }, at);
      assert.ok("ok" in ho, JSON.stringify(ho));
      assert.equal(ho.report.sent, 1);
      assert.deepEqual(ho.report.skipped.map((x) => x.reason), ["Ngoài phạm vi dữ liệu của bạn"], "Sales «Được giao» không gửi được lead của người khác");
      const dl = await db.select().from(schema.messagingDeliveries).where(and(eq(schema.messagingDeliveries.subjectType, "WHOLESALE_LEAD"), eq(schema.messagingDeliveries.subjectId, seafood!.id)));
      assert.equal(dl.length, 1);
      assert.equal(dl[0]!.status, "SENT");
      assert.equal(dl[0]!.destination, "Nhóm ĐN");
      assert.ok(dl[0]!.body.includes(mainName) && dl[0]!.body.includes("0905 123 456") && dl[0]!.body.includes("Ghé trước 10h"), dl[0]!.body);
      const twice = await sendLeadsToFieldCore(sales, { leadIds: [seafood!.id], destination: 0, note: "" }, at);
      assert.ok("ok" in twice && twice.report.sent === 0 && twice.report.duplicate === 1, "bấm hai lần cùng phút không đẻ tin thứ hai");
      const dncSend = await sendLeadsToFieldCore(admin, { leadIds: [hotpot!.id], destination: null, note: "" }, at);
      assert.ok("ok" in dncSend && dncSend.report.sent === 0 && /KHÔNG LIÊN HỆ/.test(dncSend.report.skipped[0]?.reason ?? ""), JSON.stringify(dncSend));
      assert.ok("error" in (await sendLeadsToFieldCore(admin, { leadIds: [seafood!.id], destination: 5, note: "" }, at)), "nơi nhận ngoài cấu hình ⇒ từ chối");
      const handoffAct = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, seafood!.id), eq(schema.wholesaleLeadActivities.kind, "ASSIGN")));
      assert.ok(handoffAct.some((x) => x.note.includes("NV thị trường Đà Nẵng")));

      // ── Thứ tự quét: Hà Nội trước, rồi không biển (Pleiku), rồi ven biển (Quy Nhơn) — bất kể thứ tự khai ──
      const order = await createCampaignCore(admin, { ...campInput, name: "Thứ tự", customAreas: ["Gia Lai: Quy Nhơn, Pleiku", "Hà Nội: Cầu Giấy"].join("\n") });
      assert.ok("ok" in order);
      assert.ok("ok" in (await startCampaignCore(admin, order.id)));
      const prioRows = await db
        .select({ area: schema.wholesaleSearchCells.areaCode, priority: schema.wholesaleCampaignCells.priority })
        .from(schema.wholesaleCampaignCells)
        .innerJoin(schema.wholesaleSearchCells, eq(schema.wholesaleSearchCells.id, schema.wholesaleCampaignCells.cellId))
        .where(eq(schema.wholesaleCampaignCells.campaignId, order.id));
      const maxOf = (a: string) => Math.max(...prioRows.filter((r) => r.area === a).map((r) => r.priority));
      const minOf = (a: string) => Math.min(...prioRows.filter((r) => r.area === a).map((r) => r.priority));
      assert.ok(minOf("cau-giay") > maxOf("pleiku") && minOf("pleiku") > maxOf("quy-nhon"), JSON.stringify(prioRows));
      assert.ok("ok" in (await changeCampaignStateCore(admin, order.id, "stop")));

      // ── Bảng hiệu quả chạy được, phễu đếm đúng ──
      const dash = await wholesaleDashboard({ from: null, to: null, dimension: "keyword", decision: { allow: "ALL", explain: "test" } });
      assert.ok(dash.funnel.discovered >= 4);
      assert.equal(dash.funnel.won, 1);
      assert.ok(dash.rows.length >= 1);
      assert.equal(dash.kpi.revenuePer100, null, "dưới 20 lead ⇒ không in doanh thu / 100 lead");

      // ── Tuân thủ: dữ liệu Google hết hạn ⇒ xoá trắng, giữ Place ID; lead đang chăm thì làm mới ──
      await db.update(schema.wholesalePlaceSnapshots).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.wholesalePlaceSnapshots.placeId, P.pub.placeId));
      const purged = await purgeExpiredSnapshots(new Date());
      assert.ok(purged >= 1);
      const pubSnap = await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, P.pub.placeId) });
      assert.equal(pubSnap?.displayName, null);
      assert.equal(pubSnap?.nationalPhone, null);
      assert.ok(pubSnap?.purgedAt);
      assert.ok(await leadByPlace(P.pub.placeId), "lead (dữ liệu của tổ chức) vẫn còn");
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
}

export async function testWholesaleLeadHunter() {
  testPhone();
  testSegments();
  testScoring();
  testPlanAndCost();
  testScanPriority();
  testFreeTier();
  testCallOutcomes();
  testFieldHandoffMessage();
  testDedupeKeys();
  testWebsiteParse();
  await testWebsiteGuards();
  await testPlacesClient();
  testOpenerAndConfig();
  await testDb();
  console.log("✓ Săn khách sỉ: SĐT VN · chấm điểm xác định · ô quét + chi phí · Google giả (khoá trong tiêu đề) · khử trùng 10 lần = 1 lead · tạm dừng/tiếp tục · lỗi API · trần ngân sách · không liên hệ · nhập tệp · chuyển khách · phạm vi dữ liệu · hết hạn lưu · thứ tự quét 34 tỉnh · gửi nhân viên thị trường");
}
