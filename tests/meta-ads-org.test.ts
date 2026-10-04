/**
 * ═══════════ CHI TIÊU QUẢNG CÁO FACEBOOK CỦA TỔ CHỨC KHÁCH (kết nối «meta-ads-org» · job `ads-spend-org`) ═══════════
 *
 * Chủ nền tảng chốt 03/10/2026: Hải Sản Làng Chài phải có chi tiêu quảng cáo Facebook tự động vào `ad_spends`, bằng token
 * System User của CHÍNH họ. Bài này đo:
 *
 *  1. THUẦN — đọc ô mã tài khoản, tỷ giá chặt của nhánh tổ chức (VND giữ · USD theo tỷ giá máy chủ · tiền tệ khác KHÔNG
 *     ghi), phán quyết câu trả lời của Graph, hàm kiểm tra kết nối (token trong TIÊU ĐỀ, không trong URL, câu lỗi đã che).
 *  2. TỔ CHỨC THẬT `ma-hslc`: chưa có kết nối ⇒ job bỏ qua có lý do, không gọi mạng, không ghi sync_runs · lưu → kiểm tra
 *     → bật · job ghi ad_spends VÀO CSDL CỦA TỔ CHỨC với khoá `fb:<tk>:…` · chạy lại không thêm dòng · tài khoản EUR không
 *     ghi và báo đúng tên · dòng gõ tay không bị đụng · tổ chức nhà không đổi một dòng nào và job bỏ qua nhà · token không
 *     nằm ở sync_runs / ad_spends / URL nào.
 *  3. CÔ LẬP: trong ngữ cảnh tổ chức khách, đường biến môi trường VẪN bị chặn (assertHomeCredentials) và client của tổ chức
 *     A dùng trong ngữ cảnh khác thì NÉM — cả hai trước khi một request rời máy.
 *
 * Không gọi mạng thật (luật 65): `fetch` là bản giả, trả lại nguyên trạng trong finally. Token là chuỗi BỊA. Mốc ngày đi
 * theo ĐỒNG HỒ THẬT, ghim MỘT lần (luật 50).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, isNull, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { metaAccountVerdict, testMetaAdsOrg } from "@/lib/connectors/testers";
import { normalizeAdAccountId, parseAdAccountIds } from "@/lib/constants/meta-ads-org";
import { env } from "@/lib/env";
import { FacebookAdsClient, getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { orgSpendRate } from "@/lib/integrations/facebook/sync";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { isConnectorUnavailable } from "@/lib/platform/credentials";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { runJob } from "@/lib/sync/jobs";

const ORG = "ma-hslc";
const TOKEN = "EAAFakeSystemUserTokenForTestsOnly0123456789abcdefXYZ";
const ACC_VND = "1110001";
const ACC_USD = "2220002";
const ACC_EUR = "3330003";
const ORG_SECRETS_KEY = "khoa-kiem-thu-meta-ads-org-0123456789abcdefghijklmnopqrstuvwxyz";

/** Ngày giờ Việt Nam (YYYY-MM-DD) — cùng cách bộ đồng bộ tính cửa sổ ngày. */
function vnDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
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
 * Graph API giả: `act_<id>` (tên · tiền tệ · trạng thái) và `act_<id>/insights` ở hai cấp. Tổng cấp mẩu KHỚP cấp chiến
 * dịch ⇒ bộ đồng bộ ghi hạt MẨU, đúng như với tài khoản của nhà.
 */
function fakeGraph(seen: Seen[], days: { today: string; yesterday: string }): typeof fetch {
  const accounts: Record<string, { name: string; currency: string }> = {
    [ACC_VND]: { name: "HSLC Chính", currency: "VND" },
    [ACC_USD]: { name: "HSLC Đô", currency: "USD" },
    [ACC_EUR]: { name: "HSLC Euro", currency: "EUR" },
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    seen.push({ url: url.href, auth: headers.get("authorization") ?? "" });
    if (url.hostname !== "graph.facebook.com") return json({ error: { message: "sai máy chủ" } }, 400);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: { message: `Invalid OAuth access token ${headers.get("authorization") ?? ""}`, code: 190 } }, 400);
    const m = /\/act_(\d+)(\/insights)?$/.exec(url.pathname);
    if (!m) return json({ error: { message: "không biết đường này", code: 100 } }, 400);
    const acc = accounts[m[1]];
    if (!acc) return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
    if (!m[2]) return json({ id: `act_${m[1]}`, account_id: m[1], name: acc.name, currency: acc.currency, account_status: 1 });
    const level = url.searchParams.get("level");
    const row = (date: string, spend: string, extra: Record<string, string>) => ({ date_start: date, date_stop: date, spend, impressions: "1000", clicks: "20", ...extra });
    if (m[1] === ACC_VND) {
      if (level === "campaign")
        return json({
          data: [row(days.today, "150000", { campaign_id: "c-a1", campaign_name: "Chả mực T10" }), row(days.yesterday, "90000", { campaign_id: "c-a1", campaign_name: "Chả mực T10" })],
        });
      return json({
        data: [
          row(days.today, "100000", { campaign_id: "c-a1", campaign_name: "Chả mực T10", adset_id: "as-a1", adset_name: "Nhóm 1", ad_id: "ad-a1", ad_name: "Mẩu 1" }),
          row(days.today, "50000", { campaign_id: "c-a1", campaign_name: "Chả mực T10", adset_id: "as-a1", adset_name: "Nhóm 1", ad_id: "ad-a2", ad_name: "Mẩu 2" }),
          row(days.yesterday, "90000", { campaign_id: "c-a1", campaign_name: "Chả mực T10", adset_id: "as-a1", adset_name: "Nhóm 1", ad_id: "ad-a1", ad_name: "Mẩu 1" }),
        ],
      });
    }
    if (m[1] === ACC_USD) {
      if (level === "campaign") return json({ data: [row(days.today, "2.5", { campaign_id: "c-b1", campaign_name: "Tôm hùm" })] });
      return json({ data: [row(days.today, "2.5", { campaign_id: "c-b1", campaign_name: "Tôm hùm", adset_id: "as-b1", adset_name: "Nhóm B", ad_id: "ad-b1", ad_name: "Mẩu B" })] });
    }
    return json({ error: { message: "tài khoản EUR không được hỏi insights", code: 100 } }, 400);
  }) as typeof fetch;
}

function testPure() {
  assert.equal(normalizeAdAccountId("act_1234567"), "1234567");
  assert.equal(normalizeAdAccountId(" 1234567 "), "1234567");
  assert.equal(normalizeAdAccountId("act_12"), null, "quá ngắn ⇒ không nhận");
  assert.equal(normalizeAdAccountId("act_12a456"), null, "có chữ ⇒ không đoán");
  assert.deepEqual(parseAdAccountIds("act_1110001, 2220002;act_1110001\n3330003"), { ids: ["1110001", "2220002", "3330003"], invalid: [] }, "bỏ trùng, giữ thứ tự, nhận nhiều dấu phân cách");
  assert.deepEqual(parseAdAccountIds("act_1110001, abc"), { ids: ["1110001"], invalid: ["abc"] });
  assert.deepEqual(parseAdAccountIds(undefined), { ids: [], invalid: [] });

  // Tỷ giá CHẶT của nhánh tổ chức — nhánh nhà giữ luật cũ (không đổi hành vi).
  assert.equal(orgSpendRate("VND", 25_500), 1);
  assert.equal(orgSpendRate("usd", 25_500), 25_500);
  assert.equal(orgSpendRate("USD", 0), null, "tỷ giá hỏng ⇒ không ghi");
  assert.equal(orgSpendRate("EUR", 25_500), null, "tiền tệ chưa có tỷ giá ⇒ không ghi (không × 1)");
  assert.equal(orgSpendRate("", 25_500), null, "chưa biết tiền tệ ⇒ không ghi");

  assert.deepEqual(metaAccountVerdict(200, { id: "act_1", name: "A", currency: "vnd", account_status: 1 }), { ok: true, name: "A", currency: "VND", status: 1 });
  const het = metaAccountVerdict(400, { error: { message: "Error validating access token", code: 190 } });
  assert.ok(!het.ok && /hết hạn/.test(het.reason));
  const quyen = metaAccountVerdict(403, { error: { message: "(#200) Missing permissions", code: 200 } });
  assert.ok(!quyen.ok && /ads_read/.test(quyen.reason));
  assert.ok(!metaAccountVerdict(200, { data: [] }).ok, "không có mã tài khoản ⇒ không đạt");
}

async function testTester(days: { today: string; yesterday: string }) {
  const seen: Seen[] = [];
  const graph = fakeGraph(seen, days);
  const tot = await testMetaAdsOrg({ secrets: { accessToken: TOKEN }, settings: { adAccountIds: `act_${ACC_VND}, ${ACC_USD}` } }, { fetch: graph as (i: string, init: RequestInit) => Promise<Response> });
  assert.ok(tot.ok, tot.message);
  assert.match(tot.message, /2\/2 tài khoản/);
  assert.match(tot.message, /HSLC Chính/);
  assert.equal(seen.length, 2, "hỏi ĐÚNG mỗi tài khoản một lần");
  for (const s of seen) {
    assert.equal(s.auth, `Bearer ${TOKEN}`, "token đi trong tiêu đề Authorization");
    assert.ok(!s.url.includes(TOKEN) && !s.url.includes("access_token"), "token KHÔNG nằm trong URL");
    assert.ok(s.url.startsWith(`https://graph.facebook.com/${env.facebook.apiVersion}/act_`), "đúng phiên bản Graph API mà client dùng");
  }

  // Một tài khoản không đọc được ⇒ KHÔNG đạt, nêu đúng tài khoản đó.
  const mot = await testMetaAdsOrg({ secrets: { accessToken: TOKEN }, settings: { adAccountIds: `${ACC_VND}, 9990009` } }, { fetch: graph as (i: string, init: RequestInit) => Promise<Response> });
  assert.ok(!mot.ok && /1\/2 tài khoản không đọc được/.test(mot.message) && /act_9990009/.test(mot.message), mot.message);

  // Graph dội lại token trong câu lỗi ⇒ câu lỗi đã che.
  const sai = "EAAWrongTokenEchoedBackByGraph0123456789abcdefghij";
  const loi = await testMetaAdsOrg({ secrets: { accessToken: sai }, settings: { adAccountIds: ACC_VND } }, { fetch: graph as (i: string, init: RequestInit) => Promise<Response> });
  assert.ok(!loi.ok && /hết hạn|190/.test(loi.message), loi.message);
  assert.ok(!loi.message.includes(sai), "token không bao giờ nằm trong câu kết quả kiểm tra");

  // Sai dạng ⇒ không gọi mạng.
  const truoc = seen.length;
  assert.ok(!(await testMetaAdsOrg({ secrets: { accessToken: "token-ca-nhan" }, settings: { adAccountIds: ACC_VND } }, { fetch: graph as (i: string, init: RequestInit) => Promise<Response> })).ok);
  assert.ok(!(await testMetaAdsOrg({ secrets: { accessToken: TOKEN }, settings: { adAccountIds: "act_xyz" } }, { fetch: graph as (i: string, init: RequestInit) => Promise<Response> })).ok);
  assert.equal(seen.length, truoc, "đầu vào sai dạng ⇒ 0 request");
}

export async function testMetaAdsOrgSync() {
  testPure();
  const NOW = Date.now();
  const days = { today: vnDay(NOW), yesterday: vnDay(NOW - 86_400_000) };
  await testTester(days);

  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử QC", plan: "standard", modules: ["customers", "products", "orders", "marketing"], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "HaiSan@12345" }, source: "TEST", actor: null });
  const home = await getHomeOrganization();
  const homeCount = async () => withOrganization(home.code, async () => Number((await (await getDb()).select({ n: sql<number>`count(*)::int` }).from(schema.adSpends))[0].n));
  const homeBefore = await homeCount();

  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedFetch = globalThis.fetch;
  const seen: Seen[] = [];
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  globalThis.fetch = fakeGraph(seen, days);
  try {
    // ── Chưa có kết nối ⇒ bỏ qua có lý do: không request, không sync_runs ──
    const bo = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { skipped?: string; detail?: string };
    assert.equal(bo.skipped, "NO_ACTIVE_CONNECTION", JSON.stringify(bo));
    assert.equal(seen.length, 0, "tổ chức chưa bật kết nối ⇒ 0 request");
    await withOrganization(ORG, async () => {
      assert.equal((await (await getDb()).select().from(schema.syncRuns)).length, 0, "bỏ qua ⇒ không ghi sync_runs rác");
    });

    // ── Tổ chức nhà: job này bỏ qua (nhà dùng facebook-ads) ──
    const nha = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: home.code })) as { skipped?: string };
    assert.equal(nha.skipped, "HOME_USES_ENV", JSON.stringify(nha));

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử QC", isHome: false }, modules: [...(await getEnabledModules(ORG))] };

      // ── Lưu → kiểm tra → bật (cùng hàm màn hình /settings/connections gọi) ──
      const graph = fakeGraph(seen, days) as (i: string, init: RequestInit) => Promise<Response>;
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "meta-ads-org", settings: { adAccountIds: `act_${ACC_VND}, act_${ACC_USD}, act_${ACC_EUR}` }, secrets: { accessToken: TOKEN } })));
      assert.ok("error" in (await setConnectionStatus(admin, "meta-ads-org", "ACTIVE")), "chưa kiểm tra ⇒ không bật được");
      const t = await testOrgConnection(admin, "meta-ads-org", { tester: { fetch: graph } });
      assert.ok("ok" in t, JSON.stringify(t));
      assert.ok("ok" in (await setConnectionStatus(admin, "meta-ads-org", "ACTIVE")));

      // Dòng GÕ TAY cùng tài khoản, cùng ngày — đồng bộ không bao giờ được đụng.
      await db.insert(schema.adSpends).values({ platform: "Facebook", campaign: "Gõ tay", spend: 12_345, spendDate: new Date(), accountId: ACC_VND, createdBy: "ma-test", note: "chi phí gõ tay" });
    });

    // ── Lượt đầu ──
    seen.length = 0;
    const r1 = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { run: { status: string }; summary: { imported: number; failed: number; detail: string; warning?: string } };
    assert.equal(r1.run.status, "PARTIAL", "tài khoản EUR không ghi ⇒ lượt chạy PARTIAL, không SUCCESS");
    assert.equal(r1.summary.failed, 1);
    assert.match(r1.summary.detail, /HSLC Euro: tài khoản tính bằng EUR/);
    assert.match(r1.summary.detail, /USD quy đổi theo tỷ giá cấu hình của máy chủ/);
    assert.equal(r1.summary.imported, 4);
    for (const s of seen) {
      assert.equal(s.auth, `Bearer ${TOKEN}`);
      assert.ok(!s.url.includes(TOKEN) && !s.url.includes("access_token"), `token lọt vào URL: ${s.url.slice(0, 80)}`);
    }
    assert.ok(!seen.some((s) => s.url.includes(`act_${ACC_EUR}/insights`)), "tài khoản EUR bị chặn TRƯỚC khi hỏi insights");
    const ins = seen.find((s) => s.url.includes(`act_${ACC_VND}/insights`) && s.url.includes("level=campaign"));
    assert.ok(ins, "có hỏi insights cấp chiến dịch");
    const range = JSON.parse(new URL(ins.url).searchParams.get("time_range") ?? "{}") as { since?: string; until?: string };
    assert.equal(range.until, days.today);
    assert.equal(range.since, vnDay(NOW - 29 * 86_400_000), "lượt ĐẦU TIÊN kéo lùi 30 ngày");

    const docDong = () =>
      withOrganization(ORG, async () => {
        const db = await getDb();
        return db.select({ key: schema.adSpends.externalKey, spend: schema.adSpends.spend, acc: schema.adSpends.accountId, grain: schema.adSpends.grain, note: schema.adSpends.note }).from(schema.adSpends);
      });
    const dong1 = await docDong();
    const tuDong = dong1.filter((d) => d.key);
    assert.deepEqual(tuDong.map((d) => d.key).sort(), [`fb:${ACC_USD}:c-b1:as-b1:ad-b1:${days.today}`, `fb:${ACC_VND}:c-a1:as-a1:ad-a1:${days.today}`, `fb:${ACC_VND}:c-a1:as-a1:ad-a1:${days.yesterday}`, `fb:${ACC_VND}:c-a1:as-a1:ad-a2:${days.today}`].sort());
    assert.equal(tuDong.filter((d) => d.acc === ACC_VND).reduce((t, d) => t + d.spend, 0), 240_000, "VND giữ nguyên số");
    assert.equal(tuDong.find((d) => d.acc === ACC_USD)?.spend, Math.round(2.5 * env.facebook.usdToVnd), "USD × tỷ giá cấu hình của máy chủ");
    assert.ok(tuDong.every((d) => d.grain === "AD"), "tổng cấp mẩu khớp ⇒ hạt MẨU, như nhà");
    assert.ok(!tuDong.some((d) => d.acc === ACC_EUR), "EUR: không một dòng nào");
    assert.equal(dong1.filter((d) => !d.key).length, 1, "dòng gõ tay còn nguyên");

    // ── Chạy lại: không thêm dòng (idempotent theo khoá tự nhiên), lượt sau chỉ kéo 3 ngày ──
    seen.length = 0;
    const r2 = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { summary: { imported: number; updated: number } };
    // Không so `imported` / `updated` riêng: bộ đếm tách chúng theo khoảng createdAt–updatedAt < 2 giây, nên lượt chạy lại
    // NGAY SAU lượt đầu (máy nhanh) vẫn đếm là "mới" — đó là đo đồng hồ, không đo mã (luật 65). Đếm DÒNG mới là đo mã.
    assert.equal(r2.summary.imported + r2.summary.updated, 4, "chạy lại ghi đè đúng 4 khoá");
    const dong2 = await docDong();
    assert.equal(dong2.length, dong1.length, "chạy lại không đẻ thêm dòng");
    const ins2 = seen.find((s) => s.url.includes(`act_${ACC_VND}/insights`));
    assert.ok(ins2);
    assert.equal((JSON.parse(new URL(ins2.url).searchParams.get("time_range") ?? "{}") as { since?: string }).since, vnDay(NOW - 2 * 86_400_000), "lượt thường kéo lùi 3 ngày");

    // ── Token không nằm ở bất kỳ đâu trong CSDL của tổ chức (ngoài bản mã của kết nối) ──
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const runs = await db.select().from(schema.syncRuns);
      // `ad_index_org` (04/10/2026): sổ mẩu chạy ngay sau chi tiêu trong cùng lượt, dòng sync_runs riêng — xem meta-ads-org-winners.test.ts.
      assert.ok(runs.filter((x) => x.job === "ads_insights").length >= 2 && runs.every((x) => x.source === "FACEBOOK" && (x.job === "ads_insights" || x.job === "ad_index_org")), "mỗi lượt có dòng sync_runs trong CSDL của tổ chức");
      assert.ok(!JSON.stringify(runs).includes(TOKEN), "token không nằm trong sync_runs");
      assert.ok(!JSON.stringify(await db.select().from(schema.adSpends)).includes(TOKEN), "token không nằm trong ad_spends");
      assert.ok(!JSON.stringify(await db.select().from(schema.auditLogs)).includes(TOKEN), "token không nằm trong nhật ký");
      const conn = await db.select().from(schema.orgConnections);
      assert.ok(!JSON.stringify(conn).includes(TOKEN), "bí mật kết nối chỉ ở dạng mã hoá");
      assert.equal((await db.select().from(schema.adSpends).where(isNull(schema.adSpends.externalKey))).length, 1);
    });

    // ── Tổ chức nhà: không đổi một dòng nào ──
    assert.equal(await homeCount(), homeBefore, "CSDL của nhà không đổi một dòng chi tiêu nào");
    assert.equal(await withOrganization(home.code, async () => (await (await getDb()).select().from(schema.adSpends).where(like(schema.adSpends.externalKey, `fb:${ACC_VND}:%`))).length), 0);

    // ── Cô lập: đường biến môi trường vẫn bị chặn trong ngữ cảnh khách; client của khách không dùng được ở nơi khác ──
    seen.length = 0;
    await withOrganization(ORG, async () => {
      assert.throws(() => getFacebookAdsClient(), (e: unknown) => isConnectorUnavailable(e), "getter của nhà vẫn ném cho tổ chức khách");
      const envClient = new FacebookAdsClient("EAAFakeEnvTokenOfHome0123456789abcdefghijklmn", "123456789", "v21.0");
      assert.equal(envClient.credentialSource, "HOME_ENV");
      await assert.rejects(envClient.listAdAccounts(), (e: unknown) => isConnectorUnavailable(e), "client dựng kiểu biến môi trường ⇒ assertHomeCredentials chặn");
    });
    const orgClient = FacebookAdsClient.fromOrgConnection({ organization: ORG, accessToken: TOKEN, adAccountIds: [ACC_VND] });
    assert.equal(orgClient.credentialSource, "ORG_CONNECTION");
    await withOrganization(home.code, async () => {
      await assert.rejects(orgClient.listAdAccounts(), (e: unknown) => (e as { code?: string }).code === "CREDENTIAL_OWNER_MISMATCH", "khoá của khách không chạy trong ngữ cảnh tổ chức khác");
    });
    assert.equal(seen.length, 0, "cả hai lần chặn đều xảy ra TRƯỚC khi request rời máy");

    // ── Tắt kết nối ⇒ job lại bỏ qua ──
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử QC", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      assert.ok("ok" in (await setConnectionStatus(admin, "meta-ads-org", "DISABLED")));
    });
    const tat = (await runJob("ads-spend-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { skipped?: string };
    assert.equal(tat.skipped, "NO_ACTIVE_CONNECTION");
    assert.equal(seen.length, 0);

    console.log(
      "  ✓ quảng cáo Facebook của tổ chức: chưa bật ⇒ bỏ qua, 0 request · lưu→kiểm tra→bật · ghi ad_spends vào CSDL của tổ chức (hạt mẩu, khoá fb:…) · lượt đầu 30 ngày, lượt sau 3 ngày · chạy lại 0 dòng mới · USD theo tỷ giá máy chủ, EUR không ghi · dòng gõ tay còn nguyên · nhà không đổi · token chỉ ở tiêu đề, không ở URL/CSDL · biến môi trường vẫn bị chặn · khoá của khách không chạy ở tổ chức khác",
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
}
