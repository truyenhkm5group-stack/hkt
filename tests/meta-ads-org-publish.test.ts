/**
 * ═══════════ ĐĂNG QUẢNG CÁO BẰNG TOKEN CỦA TỔ CHỨC KHÁCH ═══════════
 *
 * Chủ nền tảng chốt 04/10/2026 (Hải Sản Làng Chài): «Đăng camp» của tổ chức khách lên Facebook TỰ ĐỘNG như nhà, bằng
 * token System User của CHÍNH BM họ, KHÔNG bắt buộc luật tắt; trần cứng và công tắc khẩn cấp giữ nguyên. Bài này đo:
 *
 *  1. THUẦN — `parseOrgAdsWrite` chỉ nhận ĐÚNG `{ enabled: true }`; `orgAccountPathProblem` chặn `act_<id>` ngoài
 *     danh sách đã khai, cho qua đường dẫn không phải tài khoản.
 *  2. TỔ CHỨC THẬT `ma-hslc-dang`, kết nối «meta-ads-org» đang bật, Graph GIẢ:
 *     · công tắc TẮT ⇒ lời ghi bị chặn TRƯỚC mạng (0 lời gọi), «Đăng camp» nêu lý do; không có câu «luật TẮT»;
 *     · chỉ `settings:manage` bật được, có nhật ký;
 *     · BẬT ⇒ lời ghi đi bằng token CỦA TỔ CHỨC trong tiêu đề — không trong URL, không trong thân form;
 *     · tài khoản ngoài danh sách ⇒ chặn trước mạng; công tắc khẩn cấp (CSDL của tổ chức) vẫn chặn;
 *     · danh sách fanpage và quyền token hỏi bằng token của tổ chức;
 *     · job `creative-publish-org`: không lô nào mở ⇒ bỏ qua có lý do; nhà ⇒ HOME_USES_CREATIVE_LOOP.
 *  3. NHÀ KHÔNG ĐỔI: lời ghi của nhà vẫn mang token môi trường, «Đăng camp» của nhà vẫn đòi luật tắt; tổ chức khác
 *     (không có kết nối) không ghi được.
 *
 * Không gọi mạng thật (luật 65): `fetch` là bản giả, trả lại nguyên trạng trong finally. Token là chuỗi BỊA.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { ADS_WRITE_KILL_KEY } from "@/lib/constants/ads-kill-switch";
import { DEFAULT_CREATIVE_CONFIG } from "@/lib/constants/creative-loop";
import { META_ADS_ORG_WRITE_KEY, orgAccountPathProblem, parseOrgAdsWrite } from "@/lib/constants/meta-ads-org";
import { instantPublishBlockers } from "@/lib/creative/manual-gen";
import { uploadAdImage } from "@/lib/integrations/facebook/ads-write";
import { orgAdsWriteBlocker, readOrgAdsWrite, saveOrgAdsWriteCore } from "@/lib/marketing/meta-ads-org-write";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { getFbTokenScopes } from "@/lib/queries/fb-token-scopes";
import { readTokenPages } from "@/lib/queries/facebook-pages";
import { runJob } from "@/lib/sync/jobs";

const ORG = "ma-hslc-dang";
const ORG_KHAC = "ma-hslc-khac";
const TOKEN = "EAAFakeSystemUserTokenForPublishTests0123456789abcdefXYZ";
const HOME_TOKEN = "fake-home-token-for-org-publish-test";
const ACC = "4440005";
const ACC_LA = "9990008";
const PAGE = "555000222";
const ORG_SECRETS_KEY = "khoa-kiem-thu-meta-ads-org-dang-0123456789abcdefghijklmnopqrstuvwxyz";

type Seen = { url: string; method: string; auth: string; body: string };

function fakeGraph(seen: Seen[]): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    seen.push({ url: url.href, method: init?.method ?? "GET", auth: headers.get("authorization") ?? "", body: typeof init?.body === "string" ? init.body : "" });
    if (url.hostname !== "graph.facebook.com") return json({ error: { message: "sai máy chủ" } }, 400);
    const parts = url.pathname.split("/").filter(Boolean);
    const node = parts[1] ?? "";
    const edge = parts[2] ?? "";
    if (node === `act_${ACC}` && !edge) return json({ id: `act_${ACC}`, account_id: ACC, name: "HSLC Chính", currency: "VND", account_status: 1 });
    if (edge === "adimages") return json({ images: { a: { hash: "hash-1" } } });
    if (node === "me" && edge === "accounts") return json({ data: [{ id: PAGE, name: "Hải Sản Làng Chài", tasks: ["ADVERTISE", "CREATE_CONTENT"] }] });
    if (node === "me" && edge === "permissions") return json({ data: [{ permission: "ads_management", status: "granted" }, { permission: "ads_read", status: "granted" }] });
    return json({ id: "1", success: true });
  }) as typeof fetch;
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function testPure() {
  assert.equal(parseOrgAdsWrite('{"enabled":true}').enabled, true);
  assert.equal(parseOrgAdsWrite({ enabled: true }).enabled, true);
  for (const x of ['{"enabled":"true"}', '{"enabled":1}', "true", "{hỏng", null, undefined, { enabled: false }, '"bật"']) assert.equal(parseOrgAdsWrite(x).enabled, false, `${JSON.stringify(x)} không phải BẬT`);
  assert.equal(orgAccountPathProblem(`act_${ACC}/adimages`, [ACC]), null);
  assert.equal(orgAccountPathProblem(`/act_${ACC}`, [ACC]), null);
  assert.match(orgAccountPathProblem(`act_${ACC_LA}/campaigns`, [ACC]) ?? "", /không nằm trong danh sách/);
  assert.equal(orgAccountPathProblem("120000000011", [ACC]), null, "id nhóm / chiến dịch không phải tài khoản ⇒ Graph tự chặn theo quyền token");
  assert.equal(orgAccountPathProblem("me/accounts", [ACC]), null);
}

export async function testMetaAdsOrgPublish() {
  testPure();
  await cleanupOrg(ORG);
  await cleanupOrg(ORG_KHAC);
  await provisionOrganization({ code: ORG, name: "Hải sản thử đăng camp", plan: "standard", modules: ["customers", "products", "orders", "marketing"], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "HaiSan@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: ORG_KHAC, name: "Tổ chức khác", plan: "standard", modules: ["customers", "products", "orders", "marketing"], admin: { email: `admin@${ORG_KHAC}.local`, name: "QT khác", password: "HaiSan@12345" }, source: "TEST", actor: null });
  const home = await getHomeOrganization();

  const saved = { key: process.env.PLATFORM_SECRETS_KEY, enabled: process.env.ADS_WRITE_ENABLED, mode: process.env.ADS_WRITE_MODE, token: process.env.FACEBOOK_ACCESS_TOKEN };
  const savedFetch = globalThis.fetch;
  const seen: Seen[] = [];
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  process.env.ADS_WRITE_ENABLED = "true";
  process.env.ADS_WRITE_MODE = "COPILOT";
  process.env.FACEBOOK_ACCESS_TOKEN = HOME_TOKEN;
  globalThis.fetch = fakeGraph(seen);
  const cfg = { ...DEFAULT_CREATIVE_CONFIG, pageId: PAGE, adAccountId: ACC, testCampaignId: "120000000001", templateAdId: "120000000101", budgetPerVariantVnd: 100_000, killRules: [] };
  const writeEnv = { env: { hardEnabled: true, mode: "COPILOT" as const } };
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Hải sản thử đăng camp", isHome: false };
      const modules = [...(await getEnabledModules(ORG))];
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org, modules };
      const sales: SessionUser = { ...admin, id: `${u.id}-sales`, email: `sales@${ORG}.local`, role: "CS" };

      // Chưa có kết nối ⇒ lý do nói đúng thứ thiếu.
      assert.match((await orgAdsWriteBlocker()) ?? "", /chưa bật «Cho ERP đăng/);
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "meta-ads-org", settings: { adAccountIds: `act_${ACC}` }, secrets: { accessToken: TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "meta-ads-org", { tester: { fetch: fakeGraph(seen) as (i: string, init: RequestInit) => Promise<Response> } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "meta-ads-org", "ACTIVE")));

      // ── CÔNG TẮC TẮT ⇒ chặn TRƯỚC mạng ──
      seen.length = 0;
      assert.equal((await readOrgAdsWrite()).enabled, false, "mặc định TẮT");
      await assert.rejects(uploadAdImage(ACC, "abc"), /đường ghi quảng cáo đang đóng — tổ chức chưa bật/);
      assert.equal(seen.length, 0, "công tắc tắt ⇒ không một lời gọi nào ra mạng");
      const chan = await instantPublishBlockers(db, cfg, "2026-10-04", writeEnv);
      assert.ok(chan.some((x) => /Đăng quảng cáo của tổ chức đang đóng/.test(x)), JSON.stringify(chan));
      assert.ok(!chan.some((x) => /luật TẮT/.test(x)), "tổ chức khách KHÔNG bị bắt khai luật tắt (chủ nền tảng 04/10/2026)");

      // ── Quyền bật ──
      assert.ok("error" in (await saveOrgAdsWriteCore(sales, true)), "chỉ settings:manage bật được");
      assert.equal((await readOrgAdsWrite()).enabled, false);
      const on = await saveOrgAdsWriteCore(admin, true);
      assert.ok("ok" in on && on.enabled);
      const nk = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORG_ADS_WRITE_TOGGLE"));
      assert.equal(nk.length, 1, "bật có nhật ký");
      assert.equal(await orgAdsWriteBlocker(), null);
      assert.deepEqual(await instantPublishBlockers(db, cfg, "2026-10-04", writeEnv), [], "đủ điều kiện ⇒ không lý do chặn nào, kể cả khi 0 luật tắt");

      // ── BẬT ⇒ token của tổ chức, trong tiêu đề ──
      seen.length = 0;
      assert.equal(await uploadAdImage(ACC, "abc"), "hash-1");
      assert.equal(seen.length, 1);
      const g = seen[0];
      assert.equal(g.method, "POST");
      assert.ok(g.url.includes(`/act_${ACC}/adimages`), g.url);
      assert.equal(g.auth, `Bearer ${TOKEN}`, "token của TỔ CHỨC, trong tiêu đề");
      assert.ok(!g.url.includes(TOKEN) && !g.url.includes("access_token"), "token không vào URL");
      assert.ok(!g.body.includes(TOKEN) && !new URLSearchParams(g.body).has("access_token"), "token không vào thân form");
      assert.ok(!JSON.stringify(seen).includes(HOME_TOKEN), "token của nhà không bao giờ đi trong ngữ cảnh tổ chức khách");

      // Tài khoản ngoài danh sách ⇒ chặn trước mạng.
      seen.length = 0;
      await assert.rejects(uploadAdImage(ACC_LA, "abc"), /không nằm trong danh sách/);
      assert.equal(seen.length, 0);

      // Công tắc khẩn cấp trong CSDL của tổ chức vẫn chặn.
      await db.insert(schema.settings).values({ key: ADS_WRITE_KILL_KEY, value: JSON.stringify({ killed: true, reason: "kiểm thử" }) });
      await assert.rejects(uploadAdImage(ACC, "abc"), /đường ghi quảng cáo đang đóng/);
      assert.equal(seen.length, 0, "công tắc khẩn cấp kéo ⇒ 0 lời gọi");
      await db.delete(schema.settings).where(eq(schema.settings.key, ADS_WRITE_KILL_KEY));

      // Fanpage + quyền: hỏi bằng token của tổ chức.
      const pages = await readTokenPages();
      assert.equal(pages.error, null, pages.error ?? "");
      assert.deepEqual(pages.pages.map((p) => p.id), [PAGE]);
      assert.equal((await getFbTokenScopes()).state, "READY");
      assert.ok(seen.length >= 2 && seen.every((s) => s.auth === `Bearer ${TOKEN}` && !s.url.includes(TOKEN)), JSON.stringify(seen.map((s) => [s.url, s.auth.slice(0, 12)])));

      // Tắt lại ⇒ đóng ở lời gọi KẾ TIẾP.
      assert.ok("ok" in (await saveOrgAdsWriteCore(admin, false)));
      seen.length = 0;
      await assert.rejects(uploadAdImage(ACC, "abc"), /tổ chức chưa bật/);
      assert.equal(seen.length, 0);
      assert.ok("ok" in (await saveOrgAdsWriteCore(admin, true)));
      assert.equal((await db.select().from(schema.settings).where(eq(schema.settings.key, META_ADS_ORG_WRITE_KEY)))[0]?.value, JSON.stringify({ enabled: true }));
    });

    // Job đăng tiếp: không lô nào mở ⇒ bỏ qua, không sync_runs; nhà ⇒ đi creative-loop.
    const r = (await runJob("creative-publish-org", { trigger: "CRON", actor: "ma-test", org: ORG })) as { skipped?: string };
    assert.equal(r.skipped, "NOTHING_OPEN", JSON.stringify(r));
    await withOrganization(ORG, async () => {
      const runs = await (await getDb()).select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "creative-publish-org"));
      assert.equal(runs.length, 0, "không việc ⇒ không đẻ dòng sync_runs mỗi 10 phút");
    });
    const rn = (await runJob("creative-publish-org", { trigger: "CRON", actor: "ma-test", org: home.code })) as { skipped?: string };
    assert.equal(rn.skipped, "HOME_USES_CREATIVE_LOOP", JSON.stringify(rn));

    // Tổ chức khác (không kết nối, không công tắc) ⇒ không ghi được, không lời gọi nào.
    await withOrganization(ORG_KHAC, async () => {
      seen.length = 0;
      await assert.rejects(uploadAdImage(ACC, "abc"), /đường ghi quảng cáo đang đóng/);
      assert.equal(seen.length, 0);
    });

    // NHÀ KHÔNG ĐỔI: token môi trường trong thân form; «Đăng camp» vẫn đòi luật tắt.
    await withOrganization(home.code, async () => {
      seen.length = 0;
      assert.equal(await uploadAdImage(ACC, "abc"), "hash-1");
      assert.equal(new URLSearchParams(seen[0].body).get("access_token"), HOME_TOKEN);
      assert.equal(seen[0].auth, "");
      const chanNha = await instantPublishBlockers(await getDb(), cfg, "2026-10-04", { ...writeEnv, killSwitch: async () => ({ killed: false, source: "UNSET", reason: null, at: null, by: null }) });
      assert.ok(chanNha.some((x) => /luật TẮT/.test(x)), "nhà vẫn bắt khai luật tắt (quyết định 27/09/2026)");
      assert.ok(!chanNha.some((x) => /tổ chức đang đóng/.test(x)), "nhà không có công tắc của tổ chức");
    });

    console.log(
      "  ✓ đăng quảng cáo bằng token của tổ chức khách: công tắc riêng (chỉ {enabled:true}, chỉ settings:manage, có nhật ký) · tắt ⇒ chặn trước mạng · bật ⇒ token của tổ chức trong tiêu đề, không URL / thân form · tài khoản ngoài danh sách bị chặn · công tắc khẩn cấp vẫn chặn · fanpage + quyền hỏi bằng token tổ chức · «Đăng camp» không bắt luật tắt ở tổ chức khách, nhà vẫn bắt · job creative-publish-org bỏ qua khi không việc · tổ chức khác không ghi được",
    );
  } finally {
    globalThis.fetch = savedFetch;
    for (const [k, v] of [["PLATFORM_SECRETS_KEY", saved.key], ["ADS_WRITE_ENABLED", saved.enabled], ["ADS_WRITE_MODE", saved.mode], ["FACEBOOK_ACCESS_TOKEN", saved.token]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await cleanupOrg(ORG);
    await cleanupOrg(ORG_KHAC);
  }
}
