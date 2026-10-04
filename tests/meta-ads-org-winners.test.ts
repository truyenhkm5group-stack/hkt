/**
 * ═══════════ QUẢNG CÁO CỦA TỔ CHỨC KHÁCH: SỔ MẨU + MẪU THẮNG LÀM NGUỒN ẢNH ═══════════
 *
 * Chủ nền tảng chốt 04/10/2026 (Hải Sản Làng Chài): dữ liệu ĐỌC Meta của tổ chức khách phải đủ như nhà, và thư viện
 * mẫu phải lấy được ảnh của những mẩu THẮNG của chính shop — «chi phí / tin nhắn rẻ, số tiền đã chi tiêu nhiều, có nhiều
 * lượt mua, chi phí lượt mua rẻ (theo Meta)». Bài này đo:
 *
 *  1. THUẦN — `rankOwnAds`: thứ tự đúng theo bốn chỉ số · mẩu ít sự kiện mang nhãn CHƯA ĐỦ DỮ LIỆU (không điểm, không
 *     phải "kém") · KHÔNG ngưỡng tuyệt đối (nhân mọi số chi lên 1.000 lần, thứ tự và điểm không đổi; mẩu 10.000đ / tin
 *     vẫn đứng đầu nếu các mẩu khác đắt hơn) · chỉ số cả nhóm bằng nhau bị bỏ và nêu tên · `decideOwnAdMode`.
 *  2. TỔ CHỨC THẬT `ma-hslc-thang`, kết nối «meta-ads-org» đang bật, Graph GIẢ: job `ads-spend-org` ghi chi tiêu RỒI
 *     điền sổ mẩu `fb_ads` (trạng thái · post_id · story_id · creative_id · page_id) VÀO CSDL CỦA TỔ CHỨC, có dòng
 *     sync_runs `ad_index_org`; CSDL nhà không đổi.
 *  3. Ứng viên: tổ chức không có đơn quy về `ad_id` ⇒ nhánh RANK; luật cũ (ngưỡng thời trang) ra 0 mẩu trên cùng dữ
 *     liệu. Nhập mẩu thắng bằng client của tổ chức: ảnh vào thư viện, mã hàng NGƯỜI CHỌN, ảnh chụp thứ hạng; mẩu
 *     video bị bỏ kèm lý do; mẩu Graph báo thuộc tài khoản lạ bị bỏ («chỉ ảnh của shop»); mẩu không chọn mã ⇒ noProduct.
 *  4. CÔ LẬP: khoá của tổ chức chạy trong ngữ cảnh tổ chức khác ⇒ ném TRƯỚC khi request rời máy; getter của nhà vẫn ném
 *     cho tổ chức khách; `openOrgMetaAdsClient` ở nhà ⇒ HOME_USES_ENV.
 *
 * Không gọi mạng thật (luật 65): `fetch` là bản giả, trả lại nguyên trạng trong finally. Token là chuỗi BỊA. Mốc ngày
 * đi theo ĐỒNG HỒ THẬT, ghim MỘT lần (luật 50).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { parseOwnAdMetrics } from "@/lib/constants/creative-loop";
import { decideOwnAdMode, rankOwnAds } from "@/lib/constants/own-ad-ranking";
import { importOwnAds, type OwnAdGraph } from "@/lib/creative/import";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { openOrgMetaAdsClient } from "@/lib/marketing/meta-ads-org";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { isConnectorUnavailable } from "@/lib/platform/credentials";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { hasErpAdAttribution, listOwnAdCandidates } from "@/lib/queries/creative-own-ads";
import { runJob } from "@/lib/sync/jobs";

const ORG = "ma-hslc-thang";
const TOKEN = "EAAFakeSystemUserTokenForWinnerTests0123456789abcdefXYZ";
const ACC = "4440004";
const ACC_LA = "9990009";
const PAGE = "555000111";
const CAMP = "120000000001";
const ADSET = "120000000011";
const ORG_SECRETS_KEY = "khoa-kiem-thu-meta-ads-org-thang-0123456789abcdefghijklmnopqrstuvwxyz";

/** Năm mẩu. Chi / tin của MỌI mẩu đều trên 4.000đ — luật thời trang của nhà sẽ không nhận mẩu nào. */
const AD = { win: "120000000101", mid: "120000000102", video: "120000000103", foreign: "120000000104", thin: "120000000105" } as const;
const SO: Record<string, { name: string; spend: number; messages: number; purchases: number }> = {
  [AD.win]: { name: "Ghẹ sống — ảnh mâm", spend: 3_000_000, messages: 300, purchases: 30 },
  [AD.mid]: { name: "Tôm hùm — ảnh bếp", spend: 1_500_000, messages: 100, purchases: 10 },
  [AD.video]: { name: "Mực — video", spend: 600_000, messages: 20, purchases: 1 },
  [AD.foreign]: { name: "Ốc — ảnh mượn", spend: 900_000, messages: 60, purchases: 5 },
  [AD.thin]: { name: "Cua — mới chạy", spend: 40_000, messages: 2, purchases: 0 },
};
const IMG = (adId: string) => `https://scontent.example.test/${adId}.jpg`;

function vnDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 7, 7, 7, 7, 7, 7, 7, 7, 9, 9]);
}

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

type Seen = { url: string; auth: string };

/**
 * Graph API giả: tài khoản · insights hai cấp (tổng cấp mẩu KHỚP cấp chiến dịch ⇒ hạt MẨU) · tra mẩu theo lô
 * (`?ids=…`, creative có bài viết) · nội dung quảng cáo của một mẩu (ảnh / video / tài khoản lạ).
 */
function fakeGraph(seen: Seen[], today: string): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    seen.push({ url: url.href, auth: headers.get("authorization") ?? "" });
    if (url.hostname !== "graph.facebook.com") return json({ error: { message: "sai máy chủ" } }, 400);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
    const parts = url.pathname.split("/").filter(Boolean); // [phiên bản, ...]
    const node = parts[1] ?? "";
    const edge = parts[2] ?? "";
    if (node === `act_${ACC}` && !edge) return json({ id: `act_${ACC}`, account_id: ACC, name: "HSLC Chính", currency: "VND", account_status: 1 });
    if (node === `act_${ACC}` && edge === "insights") {
      const metric = (x: { spend: number; messages: number; purchases: number }) => ({
        date_start: today,
        date_stop: today,
        spend: String(x.spend),
        impressions: "10000",
        clicks: "200",
        actions: [
          { action_type: "onsite_conversion.messaging_conversation_started_7d", value: String(x.messages) },
          ...(x.purchases ? [{ action_type: "omni_purchase", value: String(x.purchases) }] : []),
        ],
        action_values: x.purchases ? [{ action_type: "omni_purchase", value: String(x.purchases * 450_000) }] : [],
      });
      if (url.searchParams.get("level") === "campaign") {
        const tong = Object.values(SO).reduce((t, x) => ({ spend: t.spend + x.spend, messages: t.messages + x.messages, purchases: t.purchases + x.purchases }), { spend: 0, messages: 0, purchases: 0 });
        return json({ data: [{ ...metric(tong), campaign_id: CAMP, campaign_name: "Hải sản T10" }] });
      }
      return json({ data: Object.entries(SO).map(([id, x]) => ({ ...metric(x), campaign_id: CAMP, campaign_name: "Hải sản T10", adset_id: ADSET, adset_name: "Nhóm HN", ad_id: id, ad_name: x.name })) });
    }
    // getAdsByIds: GET /<phiên bản>/?ids=a,b&fields=…
    if (!node && url.searchParams.get("ids")) {
      const out: Record<string, unknown> = {};
      for (const id of (url.searchParams.get("ids") ?? "").split(",")) {
        if (!SO[id]) continue;
        out[id] = { id, name: SO[id].name, adset_id: ADSET, campaign_id: CAMP, account_id: ACC, status: "ACTIVE", campaign: { id: CAMP, name: "Hải sản T10" }, creative: { id: `9${id}`, effective_object_story_id: `${PAGE}_7${id.slice(-3)}` } };
      }
      return json(out);
    }
    // getAdCreativeContent: GET /<phiên bản>/<ad_id>?fields=name,account_id,creative{…}
    if (SO[node] && !edge) {
      if (node === AD.video) return json({ name: SO[node].name, account_id: ACC, creative: { id: `9${node}`, object_type: "VIDEO", video_id: "77001" } });
      const acc = node === AD.foreign ? ACC_LA : ACC;
      return json({ name: SO[node].name, account_id: acc, creative: { id: `9${node}`, image_url: IMG(node), body: `Câu chữ của ${SO[node].name}`, title: "Hải sản tươi" } });
    }
    return json({ error: { message: `không biết đường này: ${url.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
}

/** Máy chủ ảnh giả cho bước tải ảnh của lượt nhập — tách khỏi Graph giả, đếm số lần gọi. */
function fakeImages() {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const id = Object.values(AD).find((a) => url === IMG(a));
    if (!id) return new Response("không có", { status: 404 });
    const bytes = fakeJpeg(Number(id.slice(-3)));
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Response(copy.buffer, { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  return { impl, calls };
}

// ───────────────────────────── hàm thuần ─────────────────────────────

export function testOwnAdRankingPure() {
  assert.equal(decideOwnAdMode(true), "CLASSIFY", "có đơn quy về ad_id ⇒ luật cũ của nhà");
  assert.equal(decideOwnAdMode(false), "RANK", "không có ⇒ xếp hạng tương đối");

  const base = Object.entries(SO).map(([id, x]) => ({ id, spendVnd: x.spend, messages: x.messages, metaPurchases: x.purchases }));
  const r = rankOwnAds(base);
  assert.deepEqual(r.order, [AD.win, AD.mid, AD.foreign, AD.video, AD.thin], "chi nhiều + tin rẻ + mua nhiều + mua rẻ đứng đầu; chưa đủ dữ liệu đứng cuối");
  const win = r.byId.get(AD.win);
  assert.ok(win && win.status === "RANKED" && win.score === 100 && win.rank === 1, "tốt nhất ở cả bốn chỉ số ⇒ 100 điểm, hạng 1");
  assert.equal(r.byId.get(AD.video)?.score, 0, "kém nhất ở cả bốn chỉ số trong NHÓM ⇒ 0 điểm (tương đối, không phải ngưỡng)");
  const thin = r.byId.get(AD.thin);
  assert.ok(thin && thin.status === "INSUFFICIENT_DATA" && thin.score === null && thin.rank === null, "2 tin + 0 lượt mua ⇒ chưa đủ dữ liệu, không điểm");
  assert.match(thin.insufficientReason ?? "", /dưới 5/);
  assert.equal(r.ranked, 4);
  assert.equal(r.insufficient, 1);
  assert.deepEqual(r.metricsUsed, ["spend", "costPerMessage", "metaPurchases", "costPerMetaPurchase"]);
  assert.equal(r.byId.get(AD.mid)?.percentiles.costPerMessage, 0.5, "hoà (15.000đ / tin) ⇒ cùng phần trăm");
  assert.equal(r.byId.get(AD.foreign)?.percentiles.costPerMessage, 0.5);
  assert.equal(win.values.costPerMessageVnd, 10_000, "chi / tin là 10.000đ — luật thời trang (< 4.000đ) loại, xếp hạng vẫn để nó đứng đầu");
  assert.equal(win.values.costPerMetaPurchaseVnd, 100_000);
  assert.equal(thin.values.costPerMessageVnd, null, "dưới sàn cỡ mẫu ⇒ chi / tin CHƯA BIẾT, không phải một con số may rủi");
  assert.equal(thin.values.costPerMetaPurchaseVnd, null, "0 lượt mua ⇒ chi / lượt mua không áp dụng, không phải 0");

  // KHÔNG ngưỡng tuyệt đối: nhân mọi số chi lên 1.000 lần ⇒ cùng thứ tự, cùng điểm.
  const x1000 = rankOwnAds(base.map((b) => ({ ...b, spendVnd: b.spendVnd * 1000 })));
  assert.deepEqual(x1000.order, r.order, "thứ hạng không đổi khi đổi thang tiền");
  for (const id of Object.values(AD)) assert.equal(x1000.byId.get(id)?.score, r.byId.get(id)?.score, `${id}: điểm không phụ thuộc mức tiền tuyệt đối`);

  // Thứ tự đầu vào không đổi được kết quả; hai mẩu giống hệt ⇒ cùng điểm.
  assert.deepEqual(rankOwnAds([...base].reverse()).order, r.order);
  const twin = rankOwnAds([
    { id: "a", spendVnd: 100, messages: 10, metaPurchases: 0 },
    { id: "b", spendVnd: 100, messages: 10, metaPurchases: 0 },
    { id: "c", spendVnd: 50, messages: 10, metaPurchases: 0 },
  ]);
  assert.equal(twin.byId.get("a")?.score, twin.byId.get("b")?.score);
  assert.ok(
    twin.metricsSkipped.some((s) => s.metric === "metaPurchases") && twin.metricsSkipped.some((s) => s.metric === "costPerMetaPurchase"),
    "cả nhóm 0 lượt mua ⇒ hai chỉ số mua bị BỎ và nêu tên, không chấm ai bằng chúng",
  );

  // Một mẩu đủ dữ liệu, không ai để so ⇒ chưa đủ dữ liệu (không tự phong hạng 1).
  const solo = rankOwnAds([{ id: "x", spendVnd: 500_000, messages: 40, metaPurchases: 3 }]);
  assert.equal(solo.byId.get("x")?.status, "INSUFFICIENT_DATA");
  assert.match(solo.byId.get("x")?.insufficientReason ?? "", /Chưa có mẩu khác/);

  // Mẩu chỉ có lượt mua (chiến dịch chuyển đổi, 0 tin) vẫn đủ dữ liệu; chi / tin của nó vắng, không bị phạt thành 0.
  const conv = rankOwnAds([
    { id: "m", spendVnd: 300_000, messages: 30, metaPurchases: 0 },
    { id: "p", spendVnd: 300_000, messages: 0, metaPurchases: 6 },
  ]);
  assert.equal(conv.byId.get("p")?.status, "RANKED");
  assert.equal(conv.byId.get("p")?.percentiles.costPerMessage, null);

  // Ảnh chụp số đo: trường mới đọc lại được; JSON cũ (trước trường mới) ⇒ null, không phải 0.
  const old = parseOwnAdMetrics({ reason: "GOOD", spendVnd: 1, productBasis: "ORDERS" });
  assert.equal(old.selectionMode, null);
  assert.equal(old.rankScore, null);
  assert.equal(old.metaPurchases, null);
  const moi = parseOwnAdMetrics({ selectionMode: "RANK", rankScore: 88, rankPosition: 2, rankedOf: 9, rankStatus: "RANKED", metaPurchases: 4, productBasis: "MANUAL" });
  assert.deepEqual([moi.selectionMode, moi.rankScore, moi.rankPosition, moi.rankedOf, moi.rankStatus, moi.metaPurchases, moi.productBasis], ["RANK", 88, 2, 9, "RANKED", 4, "MANUAL"]);
  console.log("  ✓ xếp hạng mẫu thắng: thứ tự theo bốn chỉ số · chưa đủ dữ liệu không điểm · không ngưỡng tuyệt đối (×1.000 không đổi) · hoà cùng điểm · chỉ số cả nhóm bằng nhau bị bỏ");
}

// ───────────────────────────── tổ chức thật ─────────────────────────────

export async function testMetaAdsOrgWinners() {
  testOwnAdRankingPure();
  const NOW = Date.now();
  const today = vnDay(NOW);

  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử mẫu thắng", plan: "standard", modules: ["customers", "products", "orders", "marketing"], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "HaiSan@12345" }, source: "TEST", actor: null });
  const home = await getHomeOrganization();
  const homeFbAds = async () => withOrganization(home.code, async () => (await (await getDb()).select({ id: schema.fbAds.id }).from(schema.fbAds).where(inArray(schema.fbAds.id, Object.values(AD)))).length);
  assert.equal(await homeFbAds(), 0);

  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedFetch = globalThis.fetch;
  const seen: Seen[] = [];
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  globalThis.fetch = fakeGraph(seen, today);
  try {
    let productId = "";
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử mẫu thắng", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "meta-ads-org", settings: { adAccountIds: `act_${ACC}` }, secrets: { accessToken: TOKEN } })));
      const t = await testOrgConnection(admin, "meta-ads-org", { tester: { fetch: fakeGraph(seen, today) as (i: string, init: RequestInit) => Promise<Response> } });
      assert.ok("ok" in t, JSON.stringify(t));
      assert.ok("ok" in (await setConnectionStatus(admin, "meta-ads-org", "ACTIVE")));
      productId = `hslc-ghe-${NOW}`;
      await db.insert(schema.products).values({ id: productId, name: "Ghẹ xanh sống", customId: "GHE01" });
    });

    // ── Job: chi tiêu RỒI sổ mẩu, cùng lượt, cùng client ──
    seen.length = 0;
    const r = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { run: { status: string }; adIndex?: { run: { status: string }; summary: { updated: number; detail: string } } };
    assert.equal(r.run.status, "SUCCESS", JSON.stringify(r));
    assert.ok(r.adIndex, "lượt ads-spend-org có chạy sổ mẩu");
    assert.equal(r.adIndex.run.status, "SUCCESS", JSON.stringify(r.adIndex));
    assert.equal(r.adIndex.summary.updated, 5, r.adIndex.summary.detail);
    assert.ok(
      seen.some((s) => new URL(s.url).searchParams.get("ids")),
      "có hỏi Graph theo lô mã mẩu",
    );
    for (const s of seen) {
      assert.equal(s.auth, `Bearer ${TOKEN}`, "token đi trong tiêu đề");
      assert.ok(!s.url.includes(TOKEN) && !s.url.includes("access_token"), `token lọt vào URL: ${s.url.slice(0, 80)}`);
    }

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const rows = await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, Object.values(AD)));
      assert.equal(rows.length, 5, "đủ năm mẩu trong CSDL của tổ chức");
      for (const row of rows) {
        assert.equal(row.status, "ACTIVE", `${row.id}: trạng thái`);
        assert.equal(row.creativeId, `9${row.id}`, `${row.id}: creative`);
        assert.equal(row.pageId, PAGE, `${row.id}: fanpage`);
        assert.equal(row.storyId, `${PAGE}_7${row.id.slice(-3)}`, `${row.id}: story_id`);
        assert.equal(row.postId, `7${row.id.slice(-3)}`, `${row.id}: post_id`);
        assert.equal(row.accountId, ACC);
        assert.ok(row.fetchedAt.getTime() > 0, "đã hỏi Facebook thật ⇒ có dấu fetched_at thật");
      }
      const runs = await db.select().from(schema.syncRuns);
      assert.ok(runs.some((x) => x.job === "ad_index_org" && x.status === "SUCCESS"), "sổ mẩu có dòng sync_runs riêng");
      assert.ok(!JSON.stringify(runs).includes(TOKEN), "token không nằm trong sync_runs");
      assert.ok(!JSON.stringify(rows).includes(TOKEN), "token không nằm trong fb_ads");
    });
    assert.equal(await homeFbAds(), 0, "CSDL nhà không có mẩu nào của tổ chức khách");

    // Chạy lại: mẩu đã có bài viết không bị hỏi lại (hàng đợi tự cạn, không gọi Graph mỗi giờ cho cùng mẩu).
    seen.length = 0;
    const r2 = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { adIndex?: { summary: { updated: number } } };
    assert.equal(r2.adIndex?.summary.updated, 0);
    assert.ok(!seen.some((s) => new URL(s.url).searchParams.get("ids")), "lượt sau không tra lại mẩu đã có bài viết");

    // ── Ứng viên + nhập mẫu thắng, bằng client của tổ chức ──
    const images = fakeImages();
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const now = new Date();
      assert.equal(await hasErpAdAttribution(db, now), false, "đơn của tổ chức không mang ad_id");
      const mode = decideOwnAdMode(await hasErpAdAttribution(db, now));
      assert.equal(mode, "RANK");

      const cu = await listOwnAdCandidates(db, { now, winOrdersAbove: 2 });
      assert.equal(cu.rows.length, 0, "luật cũ (ngưỡng tiền của thời trang + đơn ERP) không nhận mẩu nào của hải sản");
      const list = await listOwnAdCandidates(db, { now, winOrdersAbove: 2, mode });
      assert.equal(list.mode, "RANK");
      assert.deepEqual(
        list.rows.map((x) => x.adId),
        [AD.win, AD.mid, AD.foreign, AD.video, AD.thin],
        "xếp theo thứ hạng tương đối, chưa đủ dữ liệu đứng cuối",
      );
      const top = list.rows[0];
      assert.equal(top.rank.score, 100);
      assert.equal(top.metaPurchases, 30, "lượt mua THEO META từ ad_spends.orders");
      assert.equal(top.costPerMetaPurchaseVnd, 100_000);
      assert.equal(top.inferredProduct, null, "không đơn, tên chiến dịch không ghép mã ⇒ không suy được — máy không đoán");
      assert.equal(list.rows[4].rank.status, "INSUFFICIENT_DATA");
      assert.equal(list.ranking.ranked, 4);

      const opened = await openOrgMetaAdsClient();
      assert.ok("ok" in opened, JSON.stringify(opened));
      assert.deepEqual(opened.adAccountIds, [ACC]);
      const graph: OwnAdGraph = { getAdCreativeContent: (id) => opened.client.getAdCreativeContent(id), getAdImageUrls: (acc, h) => opened.client.getAdImageUrls(acc, h) };
      const s = await importOwnAds(db, [AD.win, AD.mid, AD.video, AD.foreign], { id: null, name: "Máy kiểm thử" }, {
        graph,
        now,
        winOrdersAbove: 2,
        mode,
        fetchImpl: images.impl,
        productOverrides: { [AD.win]: productId },
        allowedAccountIds: opened.adAccountIds,
      });
      assert.deepEqual(s.imported.map((x) => x.adId).sort(), [AD.mid, AD.win].sort(), JSON.stringify(s));
      assert.equal(s.imported.find((x) => x.adId === AD.win)?.productId, productId, "mã hàng NGƯỜI CHỌN");
      assert.deepEqual(s.noProduct, [AD.mid], "không chọn mã, không suy được ⇒ nói ra, không đoán");
      assert.match(s.skipped.find((x) => x.adId === AD.video)?.reason ?? "", /video/);
      assert.match(s.skipped.find((x) => x.adId === AD.foreign)?.reason ?? "", /chính shop/);
      assert.deepEqual(images.calls.sort(), [IMG(AD.mid), IMG(AD.win)].sort(), "chỉ tải ảnh của mẩu được nhận");

      const src = await db.query.creativeSources.findFirst({ where: eq(schema.creativeSources.fbAdId, AD.win) });
      assert.ok(src && src.kind === "OWN_AD" && src.productId === productId && src.imageId);
      assert.match(src.note, /người nhập chọn/);
      assert.equal(src.primaryText, `Câu chữ của ${SO[AD.win].name}`);
      const m = parseOwnAdMetrics(src.metrics);
      assert.deepEqual([m.selectionMode, m.rankStatus, m.rankScore, m.rankPosition, m.rankedOf, m.productBasis, m.reason], ["RANK", "RANKED", 100, 1, 4, "MANUAL", null]);
      assert.equal(m.metaPurchases, 30);

      // Bấm lại ⇒ "đã có", không đẻ bản thứ hai.
      const lai = await importOwnAds(db, [AD.win], { id: null, name: "Máy kiểm thử" }, { graph, now, winOrdersAbove: 2, mode, fetchImpl: images.impl, allowedAccountIds: opened.adAccountIds });
      assert.deepEqual(lai.existing.map((x) => x.adId), [AD.win]);
      // Mã hàng chọn bừa (không có trong sổ) ⇒ bỏ mẩu ấy kèm lý do, không lặng lẽ để trống mã.
      const sai = await importOwnAds(db, [AD.thin], { id: null, name: "Máy kiểm thử" }, { graph, now, winOrdersAbove: 2, mode, fetchImpl: images.impl, productOverrides: { [AD.thin]: "khong-co-ma-nay" }, allowedAccountIds: opened.adAccountIds });
      assert.match(sai.skipped[0]?.reason ?? "", /không có trong sổ/);

      // ── Cô lập: getter của nhà vẫn ném cho tổ chức khách ──
      assert.throws(() => getFacebookAdsClient(), (e: unknown) => isConnectorUnavailable(e), "getFacebookAdsClient không có nhánh cho tổ chức khách");
    });

    // ── Khoá của tổ chức không chạy được ở tổ chức khác; nhà không mở được kết nối của khách ──
    const openedAgain = await withOrganization(ORG, () => openOrgMetaAdsClient());
    assert.ok("ok" in openedAgain);
    seen.length = 0;
    await withOrganization(home.code, async () => {
      await assert.rejects(openedAgain.client.getAdCreativeContent(AD.win), (e: unknown) => (e as { code?: string }).code === "CREDENTIAL_OWNER_MISMATCH", "khoá của khách bị chặn trong ngữ cảnh tổ chức khác");
      const nha = await openOrgMetaAdsClient();
      assert.ok(!("ok" in nha) && nha.skipped === "HOME_USES_ENV", "tổ chức nhà không đi đường kết nối của khách");
    });
    assert.equal(seen.length, 0, "lời chặn xảy ra TRƯỚC khi request rời máy");

    console.log(
      "  ✓ quảng cáo tổ chức khách: job ads-spend-org điền sổ mẩu (trạng thái · bài viết · creative · fanpage) vào CSDL của tổ chức, sync_runs ad_index_org, lượt sau không tra lại · nhánh RANK khi không có đơn quy về ad_id (luật cũ ra 0 mẩu) · nhập mẫu thắng bằng client của tổ chức, mã hàng người chọn, ảnh chụp thứ hạng · video và tài khoản lạ bị bỏ · khoá không chạy ở tổ chức khác · nhà không đổi",
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
}
