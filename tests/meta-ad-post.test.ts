import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  classifyMetaError,
  normalizeAdIdInput,
  parseAdIdList,
  AD_PREVIEW_LINK_REASON,
  isAdPreviewShareLink,
  parseAdsManagerParents,
  parseObjectStoryId,
  pickStoryFromCreative,
  postOpenUrl,
  TRANSIENT_META_ERRORS,
  type AdPostResolution,
  type MetaGraphErrorInfo,
} from "@/lib/constants/meta-ad-post";
import { graphErrorInfo, type FbAdInfo, type GraphNodeResult } from "@/lib/integrations/facebook/client";
import { AD_POST_FIELDS, AD_POST_FIELDS_FLAT, CREATIVE_STORY_FIELDS, expandAdParents, resolveAdPosts, type AdParentGraph, type MetaAdPostGraph } from "@/lib/integrations/facebook/ad-post-resolver";
import { loadAdPostErpContext, saveAdPostResolutions } from "@/lib/integrations/facebook/ad-post-store";
import { fbAdRowFromInfo } from "@/lib/integrations/facebook/ads-index";
import { IntegrationError } from "@/lib/integrations/http";

/**
 * ═══════════ MẨU QUẢNG CÁO → CREATIVE → BÀI VIẾT ═══════════
 *
 * Meta được GIẢ LẬP hoàn toàn (`fakeGraph`): bộ kiểm thử không gọi mạng, không cần token. Giả lập
 * đứng ở đúng ranh giới mà mã thật dùng (`readNodes` / `readNode` của `FacebookAdsClient`), nên mọi
 * nhánh của bộ tra — lô, lùi về từng mã, đọc creative riêng, bổ sung tên trang — chạy mã thật.
 */

const PAGE = "1089070007619448";
const POST = "122104683968493325";
const STORY = `${PAGE}_${POST}`;
const AD1 = "120248409213230618";
const AD2 = "120248409213230619";
const AD3 = "120248409213230620";
const AD4 = "120248409213230621";

const err = (e: Partial<MetaGraphErrorInfo>): GraphNodeResult => ({ kind: "error", error: { httpStatus: 400, code: null, subcode: null, type: "", message: "", fbtraceId: "tr", ...e } });
const node = (n: Record<string, unknown>): GraphNodeResult => ({ kind: "node", node: n });
const adNode = (id: string, creative: Record<string, unknown> | undefined) => node({ id, name: `QC ${id}`, status: "ACTIVE", effective_status: "ACTIVE", account_id: "555", adset_id: "777", campaign_id: "888", campaign: { id: "888", name: "Linh Tây Luxury CS1" }, ...(creative ? { creative } : {}) });

/**
 * Graph giả: `batch` trả lời lời gọi lô theo từng mã; `single` trả lời lời gọi một nút theo (mã, bộ
 * trường). Ghi lại mọi lời gọi để khẳng định bộ tra KHÔNG gọi thừa (token hết hạn thì dừng sớm).
 */
function fakeGraph(batch: Record<string, GraphNodeResult>, single: Record<string, GraphNodeResult> = {}, extra: Record<string, Record<string, GraphNodeResult>> = {}) {
  const calls: string[] = [];
  const graph: MetaAdPostGraph = {
    async readNodes(ids, fields) {
      calls.push(`nodes:${fields}:${ids.join(",")}`);
      const table = fields === AD_POST_FIELDS ? batch : (extra[fields] ?? {});
      return new Map(ids.map((id) => [id, table[id] ?? ({ kind: "absent" } as GraphNodeResult)]));
    },
    async readNode(id, fields) {
      calls.push(`node:${fields}:${id}`);
      return single[`${id}|${fields}`] ?? { kind: "absent" };
    },
  };
  return { graph, calls };
}

const NOW = () => new Date("2026-09-29T03:00:00Z");
const SHARE_CODE = "1Wr9bkydwWe8kt3";

export function testMetaAdPostPure() {
  // 1 · Ad ID số trần — khoảng trắng, dấu ngăn nghìn do copy từ bảng tính.
  assert.deepEqual(normalizeAdIdInput(`  ${AD1}\n`), { ok: true, adId: AD1, from: "PLAIN" });
  assert.deepEqual(normalizeAdIdInput("120 248 409 213 230 618"), { ok: true, adId: AD1, from: "PLAIN" });
  assert.equal(normalizeAdIdInput("act_555").ok, false, "act_… là TÀI KHOẢN, không phải mẩu");
  assert.equal(normalizeAdIdInput(STORY).ok, false, "PAGE_ID_POST_ID là mã BÀI, không được đem tra như Ad ID");
  assert.equal(normalizeAdIdInput("abc").ok, false);
  assert.equal(normalizeAdIdInput("").ok, false);

  // 2 · Link xem trước `feed_demo_ad=` → Ad ID (ứng viên để TRA, không phải Post ID).
  const url = `https://www.facebook.com/?feed_demo_ad=${AD1}&h=AQDxYz123`;
  assert.deepEqual(normalizeAdIdInput(url), { ok: true, adId: AD1, from: "URL_PARAM", param: "feed_demo_ad" });
  assert.deepEqual(normalizeAdIdInput(`facebook.com/?feed_demo_ad=${AD1}`), { ok: true, adId: AD1, from: "URL_PARAM", param: "feed_demo_ad" });
  assert.equal(normalizeAdIdInput(`https://adsmanager.facebook.com/adsmanager/manage/ads?act=555&selected_ad_ids=${AD1}`).ok, true);
  assert.equal(normalizeAdIdInput(`https://www.facebook.com/${PAGE}/posts/${POST}`).ok, false, "link BÀI VIẾT không được bóc số ra làm Ad ID");
  assert.equal(normalizeAdIdInput(`https://www.facebook.com/?feed_demo_ad=${AD1},${AD2}`).ok, false, "hai mã trong một tham số ⇒ không đoán lấy mã nào");

  // Ô nhiều mã: gộp trùng, đếm dòng hỏng, phần vượt trần được ĐẾM — không cắt im lặng.
  const list = parseAdIdList([AD1, url, AD2, "rác", AD3, AD4].join("\n"), 3);
  assert.deepEqual(list.adIds, [AD1, AD2, AD3]);
  assert.equal(list.duplicates, 1, "link feed_demo_ad trỏ cùng AD1 ⇒ trùng");
  assert.equal(list.invalid.length, 1);
  assert.equal(list.overflow, 1);

  // 6 · PAGE_ID_POST_ID → giữ CẢ chuỗi gốc lẫn hai phần.
  assert.deepEqual(parseObjectStoryId(STORY), { objectStoryId: STORY, pageId: PAGE, postId: POST });
  assert.equal(parseObjectStoryId(POST), null, "Post ID trần không có Page ID ⇒ không nhận");
  assert.equal(parseObjectStoryId("1_2_3"), null);
  assert.equal(parseObjectStoryId("abc_def"), null);

  // 4 + 5 · effective thắng; vắng (hoặc sai hình dạng) mới lùi về object_story_id; không có gì ⇒ null.
  assert.equal(pickStoryFromCreative({ effectiveObjectStoryId: STORY, objectStoryId: `${PAGE}_999999` })?.source, "EFFECTIVE_OBJECT_STORY_ID");
  assert.deepEqual(pickStoryFromCreative({ effectiveObjectStoryId: null, objectStoryId: STORY }), { objectStoryId: STORY, pageId: PAGE, postId: POST, source: "OBJECT_STORY_ID" });
  assert.equal(pickStoryFromCreative({ effectiveObjectStoryId: "hỏng", objectStoryId: STORY })?.source, "OBJECT_STORY_ID");
  assert.equal(pickStoryFromCreative({}), null);
  assert.equal(pickStoryFromCreative(null), null);

  // Link mở bài: permalink của Meta; không có thì link DỰNG (có cờ); URL lạ bị từ chối.
  assert.deepEqual(postOpenUrl({ permalinkUrl: "https://www.facebook.com/x/posts/1", objectStoryId: STORY }), { url: "https://www.facebook.com/x/posts/1", constructed: false });
  assert.deepEqual(postOpenUrl({ permalinkUrl: null, objectStoryId: STORY }), { url: `https://www.facebook.com/${STORY}`, constructed: true });
  assert.deepEqual(postOpenUrl({ permalinkUrl: "javascript:alert(1)", objectStoryId: STORY }), { url: `https://www.facebook.com/${STORY}`, constructed: true });
  assert.equal(postOpenUrl({ permalinkUrl: "https://evil.example/facebook.com/", objectStoryId: null }), null);

  // 8 · 9 · 10 · Phân loại lỗi Graph theo MÃ.
  assert.equal(classifyMetaError({ code: 190, subcode: 463 }), "TOKEN_EXPIRED");
  assert.equal(classifyMetaError({ code: 190 }), "TOKEN_EXPIRED");
  assert.equal(classifyMetaError({ code: 10 }), "MISSING_PERMISSION");
  assert.equal(classifyMetaError({ code: 200 }), "MISSING_PERMISSION");
  for (const c of [4, 17, 32, 613, 80004]) assert.equal(classifyMetaError({ code: c }), "META_RATE_LIMIT", `mã ${c}`);
  assert.equal(classifyMetaError({ httpStatus: 429 }), "META_RATE_LIMIT");
  assert.equal(classifyMetaError({ code: 100, subcode: 33, message: "Unsupported get request. Object with ID '1' does not exist, cannot be loaded due to missing permissions" }), "NO_ACCESS");
  assert.equal(classifyMetaError({ code: 100, message: "(#100) Tried accessing nonexisting field (creative) on node type (AdCampaign)" }), "INVALID_AD_ID");
  assert.equal(classifyMetaError({ code: 803 }), "AD_NOT_FOUND");
  assert.equal(classifyMetaError({ code: 1 }), "META_API_ERROR");
  assert.equal(classifyMetaError(null), "META_API_ERROR");
  assert.ok(TRANSIENT_META_ERRORS.has("TOKEN_EXPIRED") && TRANSIENT_META_ERRORS.has("META_RATE_LIMIT") && !TRANSIENT_META_ERRORS.has("NO_ACCESS"));

  // Lỗi Graph → thông tin ĐÃ CHE: token trong câu lỗi không được lọt ra.
  const leaked = new IntegrationError("Facebook: x", 400, false, { error: { message: "bad https://graph.facebook.com/v21.0/1?access_token=EAABsecretsecretsecret123 and EAABsecretsecretsecret123", code: 190, error_subcode: 463, type: "OAuthException", fbtrace_id: "Abc" } });
  const info = graphErrorInfo(leaked);
  assert.equal(info.code, 190);
  assert.equal(info.subcode, 463);
  assert.equal(info.fbtraceId, "Abc");
  assert.ok(!info.message.includes("EAABsecret"), `token lọt ra câu lỗi: ${info.message}`);

  // Link chia sẻ "Xem trước quảng cáo": KHÔNG tra ngược được (đo 03/10/2026) — nhận ra và nói đúng lý do.
  for (const share of [`https://fb.me/adspreview/facebook/${SHARE_CODE}`, `fb.me/adspreview/managedaccount/${SHARE_CODE}`]) {
    assert.equal(isAdPreviewShareLink(share), true, share);
    const l = parseAdIdList(share);
    assert.deepEqual(l.adIds, []);
    assert.deepEqual(l.parents, []);
    assert.deepEqual(l.invalid, [{ raw: share, reason: AD_PREVIEW_LINK_REASON }], "link chia sẻ ⇒ đúng câu giải thích, không dò");
  }
  assert.equal(isAdPreviewShareLink(`https://fb.me/${SHARE_CODE}`), false, "fb.me trần có thể là link rút gọn của fanpage");
  assert.equal(isAdPreviewShareLink(`https://evil.example/adspreview/facebook/${SHARE_CODE}`), false);

  // Link thanh địa chỉ Trình quản lý: selected_ad_ids thắng; không có thì nhóm (hẹp) trước chiến dịch.
  const CAMP = "120248365301230111";
  const SET = "120248365301230222";
  const am = (q: string) => `https://adsmanager.facebook.com/adsmanager/manage/ads?act=968797992379957&business_id=1&${q}`;
  assert.deepEqual(parseAdIdList(am(`selected_campaign_ids=${CAMP}&selected_ad_ids=${AD1}`)).adIds, [AD1], "đã chọn mẩu ⇒ chỉ mẩu đó");
  assert.deepEqual(parseAdIdList(am(`selected_campaign_ids=${CAMP}`)).parents, [{ kind: "CAMPAIGN", id: CAMP }]);
  assert.deepEqual(parseAdIdList(am(`selected_campaign_ids=${CAMP}&selected_adset_ids=${SET}`)).parents, [{ kind: "ADSET", id: SET }], "nhóm nằm trong chiến dịch — đọc cả hai là tra trùng");
  assert.deepEqual(parseAdsManagerParents(am(`selected_campaign_ids=${CAMP}%2C${AD2}`)), { parents: [{ kind: "CAMPAIGN", id: CAMP }, { kind: "CAMPAIGN", id: AD2 }] }, "nhiều dòng tích chọn, dấu phẩy mã hoá");
  assert.ok("error" in (parseAdsManagerParents(am("selected_campaign_ids=abc")) ?? {}), "giá trị không phải số ⇒ lỗi, không đoán");
  const many = Array.from({ length: 11 }, (_, i) => String(100000 + i)).join(",");
  assert.ok("error" in (parseAdsManagerParents(am(`selected_campaign_ids=${many}`)) ?? {}), "quá trần ⇒ nói ra, không cắt im lặng");
  assert.equal(parseAdsManagerParents(`https://evil.example/?selected_campaign_ids=${CAMP}`), null, "chỉ facebook.com");
  assert.equal(parseAdsManagerParents(am("act=1")), null);
  const twice = parseAdIdList([am(`selected_campaign_ids=${CAMP}`), am(`selected_campaign_ids=${CAMP}`)].join("\n"));
  assert.equal(twice.parents.length, 1);
  assert.equal(twice.duplicates, 1);

  // Mã nguồn: bộ tra / kho ghi / action không tự gọi graph.facebook.com và không chạm access_token.
  for (const f of ["lib/integrations/facebook/ad-post-resolver.ts", "lib/integrations/facebook/ad-post-store.ts", "lib/actions/meta-ad-post.ts", "app/(dashboard)/ads/post-resolver/resolver-panel.tsx", "lib/constants/meta-ad-post.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("graph.facebook.com"), `${f} không được gọi Graph trực tiếp — đi qua FacebookAdsClient`);
    assert.ok(!/access_token|accessToken/.test(src), `${f} không được chạm tới token`);
  }
  // Client component chỉ import phần thuần + server action — không import lib/queries hay integrations.
  const panel = readFileSync("app/(dashboard)/ads/post-resolver/resolver-panel.tsx", "utf8");
  assert.ok(!/from "@\/lib\/(queries|integrations)\//.test(panel), "client component không được import lib/queries / lib/integrations");
}

export async function testMetaAdPostResolver() {
  // 3 · 4 · Creative lồng có effective_object_story_id — dark post của "Tạo quảng cáo".
  {
    const { graph } = fakeGraph({ [AD1]: adNode(AD1, { id: "c1", effective_object_story_id: STORY }) }, {}, { "id,name": { [PAGE]: node({ id: PAGE, name: "Linh Tây Luxury CS1" }) }, "id,permalink_url": { [STORY]: node({ id: STORY, permalink_url: `https://www.facebook.com/${PAGE}/posts/${POST}` }) } });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.creativeId, "c1");
    assert.equal(r.pageId, PAGE);
    assert.equal(r.postId, POST);
    assert.equal(r.objectStoryId, STORY, "chuỗi gốc được giữ nguyên");
    assert.equal(r.rawEffectiveObjectStoryId, STORY);
    assert.equal(r.resolutionSource, "EFFECTIVE_OBJECT_STORY_ID");
    assert.equal(r.adAccountId, "555");
    assert.equal(r.campaignName, "Linh Tây Luxury CS1");
    assert.equal(r.pageName, "Linh Tây Luxury CS1");
    assert.equal(r.pageNameSource, "META");
    assert.equal(r.permalinkUrl, `https://www.facebook.com/${PAGE}/posts/${POST}`);
    assert.equal(r.resolvedAt, "2026-09-29T03:00:00.000Z");
  }

  // 5 · Không có effective ⇒ object_story_id (dự phòng), và nguồn ghi đúng trường đã thắng.
  {
    const { graph } = fakeGraph({ [AD1]: adNode(AD1, { id: "c1", object_story_id: STORY }) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.resolutionSource, "OBJECT_STORY_ID");
    assert.equal(r.rawEffectiveObjectStoryId, null);
    assert.equal(r.permalinkUrl, null, "Meta không trả permalink ⇒ để trống, KHÔNG lưu link dựng");
  }

  // Phần mở rộng lồng không trả trường bài ⇒ đọc thẳng creative (bước 3).
  {
    const { graph, calls } = fakeGraph({ [AD1]: adNode(AD1, { id: "c1" }) }, { [`c1|${CREATIVE_STORY_FIELDS}`]: node({ id: "c1", effective_object_story_id: STORY }) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.ok, true);
    assert.ok(calls.includes(`node:${CREATIVE_STORY_FIELDS}:c1`));
  }

  // Phần mở rộng `creative{…}` hỏng ⇒ đọc lại mẩu KHÔNG mở rộng rồi đọc creative riêng (bước 2).
  {
    const { graph } = fakeGraph({ [AD1]: err({ code: 100, subcode: 33, message: "missing permissions" }) }, { [`${AD1}|${AD_POST_FIELDS_FLAT}`]: adNode(AD1, { id: "c1" }), [`c1|${CREATIVE_STORY_FIELDS}`]: node({ id: "c1", object_story_id: STORY }) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.resolutionSource, "OBJECT_STORY_ID");
  }

  // 7 · Mẩu không có creative ⇒ CREATIVE_NOT_FOUND, nhưng tên / chiến dịch đã đọc vẫn giữ.
  {
    const { graph } = fakeGraph({ [AD1]: adNode(AD1, undefined) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.error, "CREATIVE_NOT_FOUND");
    assert.equal(r.adFound, true);
    assert.equal(r.adName, `QC ${AD1}`);
  }

  // Creative có mà Meta không trả bài nào ⇒ POST_NOT_RESOLVED — KHÔNG đoán.
  {
    const { graph } = fakeGraph({ [AD1]: adNode(AD1, { id: "c1" }) }, { [`c1|${CREATIVE_STORY_FIELDS}`]: node({ id: "c1" }) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.error, "POST_NOT_RESOLVED");
    assert.equal(r.postId, null);
    assert.equal(r.pageId, null);
    assert.equal(r.creativeId, "c1");
  }

  // 8 · Thiếu quyền.
  {
    const { graph } = fakeGraph({ [AD1]: err({ code: 10, message: "(#10) Application does not have permission for this action" }) }, { [`${AD1}|${AD_POST_FIELDS_FLAT}`]: err({ code: 10 }) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.error, "MISSING_PERMISSION");
    assert.match(r.message, /ads_read/);
  }

  // 9 · Token hết hạn: mã đầu hỏng ⇒ mọi mã sau cùng lỗi, và KHÔNG gọi Graph thêm cho từng mã.
  {
    const expired = err({ code: 190, subcode: 463, message: "Error validating access token: Session has expired" });
    const { graph, calls } = fakeGraph({ [AD1]: expired, [AD2]: expired, [AD3]: expired });
    const rows = await resolveAdPosts([AD1, AD2, AD3], { graph, now: NOW });
    assert.deepEqual(rows.map((r) => r.error), ["TOKEN_EXPIRED", "TOKEN_EXPIRED", "TOKEN_EXPIRED"]);
    assert.equal(calls.length, 1, `chỉ một lời gọi lô, không thử lại từng mã (đã gọi: ${calls.join(" | ")})`);
    assert.match(rows[0].message, /hết hạn/);
  }

  // 10 · Giới hạn tần suất.
  {
    const { graph } = fakeGraph({ [AD1]: err({ code: 17, message: "User request limit reached" }) });
    const [r] = await resolveAdPosts([AD1], { graph, now: NOW });
    assert.equal(r.error, "META_RATE_LIMIT");
  }

  // 11 · Lô lỗi một phần: mỗi mã một kết quả RIÊNG, đúng thứ tự dán vào.
  {
    const { graph } = fakeGraph(
      { [AD1]: adNode(AD1, { id: "c1", effective_object_story_id: STORY }), [AD3]: err({ code: 100, subcode: 33, message: "does not exist" }) },
      { [`${AD3}|${AD_POST_FIELDS_FLAT}`]: err({ code: 100, subcode: 33 }) },
    );
    const rows = await resolveAdPosts([AD1, AD2, "abc", AD3], {
      graph,
      now: NOW,
      erpPageNames: async (ids) => new Map(ids.map((id) => [id, `Tên ERP ${id}`])),
    });
    assert.deepEqual(
      rows.map((r) => [r.adId, r.ok, r.error]),
      [
        [AD1, true, null],
        [AD2, false, "AD_NOT_FOUND"],
        ["abc", false, "INVALID_AD_ID"],
        [AD3, false, "NO_ACCESS"],
      ],
    );
    assert.equal(rows[0].pageName, `Tên ERP ${PAGE}`, "Meta không cho đọc tên trang ⇒ lấy tên trong sổ fanpage của ERP");
    assert.equal(rows[0].pageNameSource, "ERP_FANPAGE");
  }
}

function resolution(over: Partial<AdPostResolution>): AdPostResolution {
  return {
    adId: AD1,
    ok: true,
    error: null,
    message: "",
    graphError: null,
    adFound: true,
    adName: "Linh Tây Luxury CS1_ảnh_8_TXT",
    adStatus: "ACTIVE",
    adAccountId: "555",
    adsetId: "777",
    campaignId: "888",
    campaignName: "Linh Tây Luxury CS1",
    creativeId: "c1",
    pageId: PAGE,
    postId: POST,
    objectStoryId: STORY,
    rawEffectiveObjectStoryId: STORY,
    rawObjectStoryId: null,
    resolutionSource: "EFFECTIVE_OBJECT_STORY_ID",
    permalinkUrl: null,
    pageName: "Linh Tây Luxury CS1",
    pageNameSource: "META",
    resolvedAt: "2026-09-29T03:00:00.000Z",
    ...over,
  };
}

export async function testMetaAdPostStoreDb() {
  const db = await getDb();
  const ids = [AD1, AD2, AD3];
  await db.delete(schema.fbAds).where(inArray(schema.fbAds.id, ids));
  try {
    // 12 · Ghi mới rồi ghi lại CÙNG kết quả ⇒ một dòng, lượt hai không đổi gì.
    const first = await saveAdPostResolutions([resolution({})], { db, now: new Date("2026-09-29T03:00:00Z") });
    assert.deepEqual({ i: first.inserted, u: first.updated, n: first.unchanged }, { i: 1, u: 0, n: 0 });
    const second = await saveAdPostResolutions([resolution({})], { db, now: new Date("2026-09-29T04:00:00Z") });
    assert.deepEqual({ i: second.inserted, u: second.updated, n: second.unchanged }, { i: 0, u: 0, n: 1 }, "ghi lại cùng kết quả phải idempotent");
    let [row] = await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, [AD1]));
    assert.equal(row.postId, POST);
    assert.equal(row.storyId, STORY);
    assert.equal(row.pageId, PAGE);
    assert.equal(row.creativeId, "c1");
    assert.equal(row.postResolutionSource, "EFFECTIVE_OBJECT_STORY_ID");
    assert.equal(row.effectiveObjectStoryId, STORY);
    assert.equal(row.pageName, "Linh Tây Luxury CS1");
    assert.equal(row.resolveError, null);

    // Lần tra sau không đọc được tên trang ⇒ tên cũ GIỮ NGUYÊN (không đè điều đã biết bằng chưa biết).
    await saveAdPostResolutions([resolution({ pageName: null, pageNameSource: null })], { db });
    [row] = await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, [AD1]));
    assert.equal(row.pageName, "Linh Tây Luxury CS1");

    // Lần tra sau ra được mẩu nhưng KHÔNG ra bài ⇒ bài đã lưu giữ nguyên, lỗi được ghi có cấu trúc.
    await saveAdPostResolutions([resolution({ ok: false, error: "POST_NOT_RESOLVED", postId: null, pageId: null, objectStoryId: null, resolutionSource: null, rawEffectiveObjectStoryId: null })], { db });
    [row] = await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, [AD1]));
    assert.equal(row.postId, POST, "bài đã biết không bị xoá bởi một lần tra không ra bài");
    assert.equal(row.resolveError?.code, "POST_NOT_RESOLVED");

    // Mẩu Meta không trả về ⇒ KHÔNG ghi dòng nào.
    const skipped = await saveAdPostResolutions([resolution({ adId: AD2, ok: false, adFound: false, error: "NO_ACCESS", message: "không có quyền" })], { db });
    assert.equal(skipped.skipped.length, 1);
    assert.equal((await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, [AD2]))).length, 0);

    // Ngữ cảnh ERP đọc lại đúng dòng đã lưu.
    const ctx = await loadAdPostErpContext([{ adId: AD1, storyId: STORY }, { adId: AD3, storyId: null }], db);
    assert.equal(ctx.get(AD1)?.stored?.storyId, STORY);
    assert.equal(ctx.get(AD3)?.stored, null);

    // Đường TỰ ĐỒNG BỘ: lỗi tạm thời ⇒ không ghi; lượt không đọc creative ⇒ không đụng cột bài.
    const base: FbAdInfo = { id: AD3, name: "x", adsetId: "777", campaignId: "888", campaignName: "c", accountId: "555", status: "ACTIVE", missing: false };
    const now = new Date("2026-09-29T05:00:00Z");
    assert.equal(fbAdRowFromInfo({ ...base, missing: true, errorCode: "TOKEN_EXPIRED" }, now), null, "token hết hạn không được biến mẩu thành missing");
    assert.equal(fbAdRowFromInfo({ ...base, missing: true, errorCode: "META_RATE_LIMIT" }, now), null);
    const flat = fbAdRowFromInfo({ ...base, creativeRead: false }, now);
    assert.ok(flat && !("postId" in flat.set), "không đọc creative ⇒ không ghi đè post_id");
    const full = fbAdRowFromInfo({ ...base, creativeRead: true, postId: POST, storyId: STORY, pageId: PAGE, creativeId: "c9", postResolutionSource: "EFFECTIVE_OBJECT_STORY_ID" }, now);
    assert.equal(full?.values.postId, POST, "nhánh CHÈN MỚI phải mang post_id (trước đây chỉ nhánh cập nhật mang)");
    assert.equal(full?.values.postResolvedAt, now);
    const gone = fbAdRowFromInfo({ ...base, missing: true, errorCode: "NO_ACCESS", graphError: { httpStatus: 400, code: 100, subcode: 33, type: "", message: "m", fbtraceId: "t" } }, now);
    assert.equal(gone?.values.missing, true);
    assert.equal(gone?.values.resolveError?.code, "NO_ACCESS");

    // Ghi qua đường tự đồng bộ rồi qua nút tay: cùng một dòng (khoá ad_id), không nhân đôi.
    await db.insert(schema.fbAds).values(full!.values).onConflictDoUpdate({ target: schema.fbAds.id, set: full!.set });
    await db.insert(schema.fbAds).values(full!.values).onConflictDoUpdate({ target: schema.fbAds.id, set: full!.set });
    assert.equal((await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, [AD3]))).length, 1);
  } finally {
    await db.delete(schema.fbAds).where(inArray(schema.fbAds.id, ids));
  }
}

/**
 * CHIẾN DỊCH / NHÓM ĐANG CHỌN → CÁC MẨU. Graph giả trả mã mẩu theo mã cha; mỗi mã cha một kết quả
 * riêng, lỗi của cả kết nối thì dừng, không có mẩu thì nói ra.
 */
export async function testMetaAdParents() {
  const calls: string[] = [];
  const graph = (table: Record<string, string[] | Error>): AdParentGraph => ({
    async listAdIdsUnder(id, max) {
      calls.push(id);
      const v = table[id];
      if (v instanceof Error) throw v;
      const ids = v ?? [];
      return { adIds: ids.slice(0, max), more: ids.length > max };
    },
  });
  const noAccess = new IntegrationError("Facebook: x", 400, false, { error: { code: 100, error_subcode: 33, message: "does not exist" } });
  const r = await expandAdParents(
    [
      { kind: "CAMPAIGN", id: "C1" },
      { kind: "CAMPAIGN", id: "C2" },
      { kind: "ADSET", id: "S1" },
    ],
    graph({ C1: [AD1, AD2, AD3], C2: noAccess, S1: [] }),
    2,
  );
  assert.deepEqual(r[0].adIds, [AD1, AD2]);
  assert.equal(r[0].more, true, "quá trần ⇒ cờ còn nữa, không cắt im lặng");
  assert.equal(r[1].error, "NO_ACCESS", "một chiến dịch hết quyền không kéo cái kia xuống");
  assert.equal(r[2].error, null);
  assert.match(r[2].message, /không có mẩu quảng cáo nào/);

  calls.length = 0;
  const expired = new IntegrationError("Facebook: x", 401, false, { error: { code: 190, message: "expired" } });
  const r2 = await expandAdParents(
    [
      { kind: "CAMPAIGN", id: "C1" },
      { kind: "CAMPAIGN", id: "C2" },
    ],
    graph({ C1: expired, C2: [AD1] }),
  );
  assert.deepEqual(calls, ["C1"], "token hết hạn ⇒ không gọi tiếp");
  assert.deepEqual(r2.map((x) => x.error), ["TOKEN_EXPIRED", "TOKEN_EXPIRED"]);

}
