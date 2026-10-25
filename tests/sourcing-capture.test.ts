/**
 * ═══ SRC-6 · LƯU MẪU TỪ TRANG CHI TIẾT 1688 (tiện ích Chrome + POST /api/sourcing/capture, chủ shop chốt 25/10/2026) ═══
 *
 * Fixture = 3 trang THẬT đo 25/10/2026 trên phiên chủ shop (简体中文 · CNY), đã đi qua `PICK_PATHS_1688` — đúng thân tiện ích gửi:
 *  · 683567693110: giá theo SKU ¥26.00, 500 g, tên size không mang cân nặng ⇒ «không có bảng size».
 *  · 815636568273: tên size «M （建议90~100斤）» ⇒ 45–50 kg (bản dịch của 1688 ghi «90 ~ 100 kg» — sai gấp đôi).
 *  · 835865258913: 新人价 ¥11.28 ≠ giá đặt hàng ¥17.28 ⇒ bậc giá ¥17.28, cờ «khuyến mãi đã bỏ qua»; khối lượng 0 ⇒ CHƯA BIẾT.
 * Khoá: (1) giá chỉ từ trang chi tiết, không bao giờ onHandPrice; (2) bảng size chỉ từ chữ gốc, 斤 ÷ 2; dữ liệu 1688 đã dịch ⇒ không
 * đọc cân nặng; (3) danh sách CHO PHÉP giống hệt ở tiện ích và máy chủ, nhánh người xem không qua; (4) token: sai tổ chức / thu hồi /
 * tài khoản khoá ⇒ 401, mất quyền ⇒ 403; (5) gửi lại cùng mã ⇒ lần chụp MỚI, không đè; (6) hai tổ chức không thấy nhau; (7) không
 * secret trong kho; (8) chưa áp 0260 ⇒ 503, không ghi gì.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/sourcing/capture/route";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { parseCaptureToken, SOURCING_CAPTURE_FLAGS, SOURCING_CAPTURE_PATH, SOURCING_DATA_STATUSES } from "@/lib/constants/sourcing";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { listOfferCaptures } from "@/lib/queries/sourcing";
import { deriveCapture } from "@/lib/sourcing/capture";
import { filterPicks, parse1688Detail, pickFromContext, PICK_PATHS_1688 } from "@/lib/sourcing/capture-1688";
import { createCaptureToken, hashCaptureSecret, revokeCaptureToken } from "@/lib/sourcing/capture-tokens";
import { parseSizeChart } from "@/lib/sourcing/size-chart";

const ORG_A = "cap-a";
const ORG_B = "cap-b";
const IDS = ["683567693110", "815636568273", "835865258913"] as const;

type Fixture = { offerId: string; picks: Record<string, unknown> };
const fixture = (id: string): Fixture => JSON.parse(readFileSync(`tests/fixtures/sourcing-1688/${id}.json`, "utf8")) as Fixture;

function testSizeChart() {
  const s = parseSizeChart("M （建议90~100斤）\nL （建议100~120斤）\nXL （建议120~140斤）");
  assert.deepEqual(s?.rows.map((r) => [r.size, r.minKgX10, r.maxKgX10, r.unit]), [["M", 450, 500, "JIN"], ["L", 500, 600, "JIN"], ["XL", 600, 700, "JIN"]], "斤 ÷ 2 = kg");
  assert.deepEqual(parseSizeChart("S 45-50kg M 50-55公斤")?.rows.map((r) => [r.size, r.minKgX10, r.maxKgX10, r.unit]), [["S", 450, 500, "KG"], ["M", 500, 550, "KG"]], "kg / 公斤 giữ nguyên");
  assert.deepEqual(parseSizeChart("均码 95斤")?.rows.map((r) => [r.size, r.minKgX10, r.maxKgX10]), [["均码", 475, 475]], "một số ⇒ min = max, 95 斤 = 47,5 kg");
  assert.deepEqual(parseSizeChart("M 90-100")?.rows, [], "không có đơn vị ⇒ không đoán");
  assert.deepEqual(parseSizeChart("M （建议500~600斤）")?.rows, [], "ngoài khoảng người lớn ⇒ bỏ dòng");
  assert.equal(parseSizeChart("   "), null, "trống ⇒ không có bảng size (null), khác «có chữ mà không đọc được»");
}

function testParser() {
  const r683 = parse1688Detail(fixture("683567693110").picks, "683567693110");
  assert.ok(r683.ok, JSON.stringify(r683));
  const d683 = deriveCapture(r683.facts, r683.extraFlags);
  assert.deepEqual(d683.tiers, [{ fromQty: 1, priceFen: 2600 }], "giá theo SKU, mọi SKU cùng ¥26.00 ⇒ một bậc từ MOQ");
  assert.equal(r683.facts.weightGrams, 500);
  assert.deepEqual(d683.flags, ["SIZE_CHART_MISSING"], "tên size M / L / XL không mang cân nặng ⇒ không có bảng size");
  assert.equal(r683.facts.supplier.shopUrl, "https://shop9357vm378e316.1688.com", "link shop là tên miền riêng của người bán, không phải link winport?memberId (bỏ tham số là mọi NCC thành một)");
  assert.deepEqual([r683.facts.supplier.repurchaseRateBp, r683.facts.supplier.yearsOnPlatform, r683.facts.supplier.pickup24hBp], [5267, null, null], "52.67% ⇒ 5267; số năm / tỷ lệ lấy hàng không có trong dữ liệu ⇒ null, không 0");

  const r815 = parse1688Detail(fixture("815636568273").picks, "815636568273");
  assert.ok(r815.ok);
  const d815 = deriveCapture(r815.facts, r815.extraFlags);
  assert.deepEqual(d815.sizeChart?.rows.map((r) => [r.size, r.minKgX10, r.maxKgX10]), [["M", 450, 500], ["L", 500, 600], ["XL", 600, 700], ["2XL", 700, 800]], "bảng size 斤 ⇒ M 45–50 kg (bản dịch 1688 ghi 90–100 kg)");
  assert.deepEqual(d815.tiers, [{ fromQty: 1, priceFen: 2400 }]);
  assert.deepEqual(d815.flags, []);

  const polo = parse1688Detail(fixture("835865258913").picks, "835865258913");
  assert.ok(polo.ok);
  const dPolo = deriveCapture(polo.facts, polo.extraFlags);
  assert.deepEqual(dPolo.tiers, [{ fromQty: 1, priceFen: 1728 }], "bậc giá = giá ĐẶT HÀNG ¥17.28");
  assert.ok(!JSON.stringify(dPolo.tiers).includes("1128"), "新人价 ¥11.28 KHÔNG BAO GIỜ là giá mua");
  assert.deepEqual([polo.facts.promoSeen, polo.facts.promoLabel, polo.facts.listPriceFen], [true, "新人价", 2400], "khuyến mãi được NHÌN THẤY và ghi nhãn; giá gạch ngang chỉ tham khảo");
  assert.ok(polo.facts.skus.every((s) => s.priceFen === null), "bậc giá chung ⇒ SKU không có giá riêng (null), không chép giá bậc vào từng dòng");
  assert.equal(polo.facts.weightGrams, null, "unitWeight 0 = KHÔNG KHAI ⇒ null, không phải 0 g");
  assert.deepEqual(dPolo.flags, ["PROMO_PRICE_IGNORED", "SIZE_CHART_MISSING", "WEIGHT_UNKNOWN"]);

  // 1688 dịch ở máy chủ của họ (tài khoản Global / tiếng Việt): tiêu đề + tên size tiếng Việt, đơn vị sai. Giá vẫn lưu, KHÔNG đọc cân nặng.
  const vi = structuredClone(fixture("815636568273").picks) as Record<string, unknown>;
  vi["result.data.gallery.fields.subject"] = "Váy dài quây ngực kiểu Pháp size lớn";
  vi["result.data.Root.fields.dataJson.tempModel.offerTitle"] = "Váy dài quây ngực kiểu Pháp size lớn";
  const props = vi["result.data.Root.fields.dataJson.skuModel.skuProps"] as { prop: string; value: { name: string }[] }[];
  for (const p of props) if (p.prop === "尺码") p.value = p.value.map((v) => ({ name: v.name.replace(/（建议(\d+)~(\d+)斤）/, "(khuyến nghị $1 ~ $2 kg)") }));
  const tr = parse1688Detail(vi, "815636568273");
  assert.ok(tr.ok);
  const dTr = deriveCapture(tr.facts, tr.extraFlags);
  assert.deepEqual([dTr.flags, dTr.sizeChart, tr.facts.titleZh, tr.facts.titleTranslated], [["TRANSLATED_BY_1688"], null, "", "Váy dài quây ngực kiểu Pháp size lớn"], "dữ liệu đã dịch ⇒ cờ, không bảng size, tiêu đề dịch không nằm ở ô chữ Trung");
  assert.deepEqual(dTr.tiers, [{ fromQty: 1, priceFen: 2400 }], "giá là số — không bị dịch, vẫn lưu");

  // Mã trên đường dẫn khác mã trong dữ liệu ⇒ từ chối; không có tiêu đề ⇒ «không đọc được», không lấy gì thay.
  assert.ok(!parse1688Detail(fixture("815636568273").picks, "835865258913").ok, "dữ liệu của trang khác ⇒ từ chối");
  assert.ok(!parse1688Detail({}, "815636568273").ok);
  assert.ok(!parse1688Detail(null, "815636568273").ok);
  for (const f of SOURCING_CAPTURE_FLAGS) assert.ok(typeof f === "string");
  assert.ok(SOURCING_DATA_STATUSES.includes("EXTENSION"));
}

function testAllowlist() {
  // Danh sách cho phép: nhánh người xem không qua, khoá lạ bị bỏ ở máy chủ.
  const ctx = {
    result: {
      data: { gallery: { fields: { subject: "测试" } }, Root: { fields: { dataJson: { offerBaseInfo: { buyerLoginId: "nguoi-xem", sellerWinportUrl: "https://x.1688.com" }, offerSign: "abc" } } } },
      global: { globalData: { parametersMap: { loginId: "nguoi-xem" }, model: { buyerModel: { nick: "nguoi-xem" } } } },
    },
  };
  const picks = pickFromContext(ctx);
  assert.deepEqual(Object.keys(picks).sort(), ["result.data.Root.fields.dataJson.offerBaseInfo.sellerWinportUrl", "result.data.gallery.fields.subject"]);
  assert.ok(!JSON.stringify(picks).includes("nguoi-xem"), "danh tính người xem không rời trang");
  assert.deepEqual(Object.keys(filterPicks({ "result.data.gallery.fields.subject": "x", "result.global.globalData.model.buyerModel": { nick: "x" }, cookie: "a=b" }) ?? {}), ["result.data.gallery.fields.subject"], "máy chủ lọc lại — khoá ngoài danh sách không được lưu");
  // Tiện ích giữ bản sao Y HỆT danh sách của máy chủ.
  const mw = readFileSync("extensions/sourcing-1688/main-world.js", "utf8");
  const block = /const PICK_PATHS = \[([\s\S]*?)\];/.exec(mw)?.[1] ?? "";
  const extList = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(extList, [...PICK_PATHS_1688], "PICK_PATHS của tiện ích = PICK_PATHS_1688 của máy chủ");
  // Fixture trong kho đúng là thứ tiện ích gửi.
  for (const id of IDS) assert.deepEqual(Object.keys(fixture(id).picks).filter((k) => !(PICK_PATHS_1688 as readonly string[]).includes(k)), [], `${id}: fixture chỉ có nhánh được phép`);
}

function testExtensionSource() {
  const dir = "extensions/sourcing-1688";
  const files = readdirSync(dir).filter((f) => /\.(js|json|html)$/.test(f));
  for (const f of files) {
    const s = readFileSync(`${dir}/${f}`, "utf8");
    assert.ok(!/innerText|innerHTML|outerHTML|document\.cookie|chrome\.cookies/.test(s), `${f}: không đọc chữ hiển thị / cookie`);
  }
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as { permissions: string[]; host_permissions?: string[]; content_scripts: { matches: string[] }[] };
  assert.deepEqual(manifest.permissions, ["storage"], "không quyền cookies / tabs / scripting / webRequest");
  assert.equal(manifest.host_permissions, undefined, "không quyền gửi sẵn tới đâu — xin theo từng địa chỉ ERP lúc cài");
  assert.ok(manifest.content_scripts.every((c) => c.matches.length === 1 && c.matches[0] === "https://detail.1688.com/offer/*"), "chỉ chạy trên trang chi tiết");
  const bg = readFileSync(`${dir}/background.js`, "utf8");
  assert.ok(bg.includes('credentials: "omit"') && bg.includes(SOURCING_CAPTURE_PATH) && bg.includes("chrome.storage.local") && !bg.includes("storage.sync"), "không gửi cookie; token ở máy này, không đồng bộ");
  const content = readFileSync(`${dir}/content.js`, "utf8");
  assert.ok(content.includes('addEventListener("click"') && !/setInterval|MutationObserver|location\.(assign|replace)|window\.open\(/.test(content), "chỉ chạy khi người bấm — không lặp, không tự điều hướng");
}

function testNoSecrets() {
  const tokenLike = /vnxs1\.[a-z0-9][a-z0-9-]{0,62}\.[A-Za-z0-9_-]{43}/;
  for (const dir of ["extensions/sourcing-1688", "tests/fixtures/sourcing-1688"]) {
    for (const f of readdirSync(dir)) {
      const s = readFileSync(`${dir}/${f}`, "utf8");
      assert.ok(!tokenLike.test(s), `${dir}/${f}: không có token thật`);
      assert.ok(!/loginId|buyerModel|buyerUserId|memberId"|Sign"|session|cookie"/i.test(f.endsWith(".json") ? s : ""), `${dir}/${f}: không danh tính người xem / chữ ký`);
    }
  }
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const MODULES = ["customers", "products", "orders", "inventory", "production", "sourcing"];

async function provision(code: string) {
  await cleanupOrg(code);
  await provisionOrganization({ code, name: `Shop ${code}`, plan: "trial", modules: MODULES, admin: { email: `chu@${code}.local`, name: "Chủ shop", password: "LuuMau1688@2026!" }, source: "TEST", actor: null });
}

async function post(token: string | null, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new NextRequest(`http://localhost${SOURCING_CAPTURE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const bodyOf = (id: string) => ({ offerId: id, pageUrl: `https://detail.1688.com/offer/${id}.html`, picks: fixture(id).picks });

async function makeUser(code: string, email: string, role: "MANAGER" | "WAREHOUSE") {
  return withOrganization(code, async () => {
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ email, name: `Người ${email}`, passwordHash: "x", role }).returning({ id: schema.users.id });
    return { id: u.id, email };
  });
}

async function testDb() {
  await provision(ORG_A);
  await provision(ORG_B);
  try {
    const a = await makeUser(ORG_A, "tim@cap-a.local", "MANAGER");
    const b = await makeUser(ORG_B, "tim@cap-b.local", "MANAGER");
    const ta = await withOrganization(ORG_A, () => createCaptureToken(a, ORG_A, { label: "Chrome văn phòng" }));
    const tb = await withOrganization(ORG_B, () => createCaptureToken(b, ORG_B, { label: "Chrome kho" }));
    assert.ok(ta.ok && ta.token && tb.ok && tb.token);
    const pa = parseCaptureToken(ta.token)!;
    assert.equal(pa.orgCode, ORG_A, "token mang mã tổ chức");
    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const [row] = await db.select().from(schema.sourcingCaptureTokens).where(eq(schema.sourcingCaptureTokens.id, ta.id));
      assert.equal(row.tokenHash, hashCaptureSecret(pa.secret), "chỉ lưu BĂM");
      assert.ok(!JSON.stringify(row).includes(pa.secret), "bí mật không nằm trong CSDL");
      const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SOURCING_CAPTURE_TOKEN_CREATE"));
      assert.ok(logs.length === 1 && !JSON.stringify(logs).includes(pa.secret), "nhật ký không chứa token");
    });

    // ── Cổng: không token / sai dạng / token A gắn nhãn tổ chức B ⇒ cùng một 401.
    assert.equal((await post(null, bodyOf("815636568273"))).status, 401);
    assert.equal((await post("vnxs1.cap-a.ngan", bodyOf("815636568273"))).status, 401);
    const forged = `vnxs1.${ORG_B}.${pa.secret}`;
    const fr = await post(forged, bodyOf("815636568273"));
    assert.equal(fr.status, 401, "token tổ chức A gắn nhãn tổ chức B không khớp dòng nào ở B");
    await withOrganization(ORG_B, async () => assert.equal((await (await getDb()).select().from(schema.sourcingOffers)).length, 0, "lượt giả không ghi gì ở B"));

    // ── Lưu mẫu 815636568273 ở A; gửi lại ⇒ lần chụp MỚI, không đè.
    const r1 = await post(ta.token, bodyOf("815636568273"));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.created, true);
    const r2 = await post(ta.token, bodyOf("815636568273"));
    assert.equal(r2.status, 200);
    assert.deepEqual([r2.body.created, r2.body.offerPath], [false, r1.body.offerPath], "cùng mã ⇒ cùng mẫu, không tạo mẫu thứ hai");
    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const offers = await db.select().from(schema.sourcingOffers);
      assert.equal(offers.length, 1);
      assert.deepEqual([offers[0].platform, offers[0].offerId, offers[0].dataStatus, offers[0].titleVi, offers[0].createdBy], ["1688", "815636568273", "EXTENSION", "", a.id], "mẫu mới mang nhãn nguồn EXTENSION + khoá người lưu");
      const snaps = await db.select().from(schema.sourcingOfferSnapshots).where(eq(schema.sourcingOfferSnapshots.offerId, offers[0].id));
      assert.equal(snaps.length, 2, "hai lần bấm ⇒ hai ảnh chụp giá");
      assert.ok(snaps.every((s) => s.source === "EXTENSION" && JSON.stringify(s.tiers) === JSON.stringify([{ fromQty: 1, priceFen: 2400 }])));
      const caps = await db.select().from(schema.sourcingOfferCaptures).where(eq(schema.sourcingOfferCaptures.offerId, offers[0].id));
      assert.equal(caps.length, 2, "hai lần chụp, dòng cũ còn nguyên");
      assert.ok(caps.every((c) => c.tokenId === ta.id && c.capturedBy === a.id && c.source === "EXTENSION" && c.parserVersion === 1));
      assert.ok(!JSON.stringify(caps[0].raw).includes("buyer"), "nhánh gốc lưu kèm chỉ là nhánh được phép");
      const weights = await db.select().from(schema.sourcingOfferWeights).where(eq(schema.sourcingOfferWeights.offerId, offers[0].id));
      assert.ok(weights.length === 2 && weights.every((w) => w.grams === 300 && w.source === "EXTENSION"));
      const [sup] = await db.select().from(schema.sourcingSuppliers);
      assert.deepEqual([sup.shopUrl, sup.name, sup.shipFrom, sup.factsSource, sup.yearsOnPlatform], ["https://shop9357vm378e316.1688.com", "深圳市依多客服装有限公司", "广东省揭阳市", "EXTENSION", null], "số năm không đọc được ⇒ để null, không 0");
      const view = await listOfferCaptures(offers[0].id);
      assert.ok(!("unavailable" in view));
      assert.deepEqual(view[0].sizeChart?.rows.map((r) => r.minKgX10), [450, 500, 600, 700], "trang mẫu đọc lại bảng size đã quy kg");
      assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SOURCING_OFFER_CAPTURE"))).length, 2);
      const [tok] = await db.select().from(schema.sourcingCaptureTokens).where(eq(schema.sourcingCaptureTokens.id, ta.id));
      assert.ok(tok.lastUsedAt, "lượt dùng ghi mốc");
    });

    // ── Polo: giá đặt hàng, không bao giờ 新人价; không giá chi tiết ⇒ không chụp bậc giả.
    const rp = await post(ta.token, bodyOf("835865258913"));
    assert.equal(rp.status, 200);
    assert.ok((rp.body.flags as { code: string }[]).some((f) => f.code === "PROMO_PRICE_IGNORED"));
    const noPrice = structuredClone(fixture("683567693110").picks) as Record<string, unknown>;
    delete noPrice["result.data.Root.fields.dataJson.skuModel.skuInfoMap"];
    delete noPrice["result.data.Root.fields.dataJson.skuModel.skuInfoMapOriginal"];
    const rn = await post(ta.token, { ...bodyOf("683567693110"), picks: noPrice });
    assert.equal(rn.status, 200);
    assert.equal(rn.body.hasPrice, false, "không có giá chi tiết ⇒ không chụp bậc nào");
    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const [polo] = await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.offerId, "835865258913"));
      const [snap] = await db.select().from(schema.sourcingOfferSnapshots).where(eq(schema.sourcingOfferSnapshots.offerId, polo.id));
      assert.deepEqual(snap.tiers, [{ fromQty: 1, priceFen: 1728 }], "ảnh chụp giá ¥17.28, không ¥11.28");
      const [o683] = await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.offerId, "683567693110"));
      assert.equal((await db.select().from(schema.sourcingOfferSnapshots).where(eq(schema.sourcingOfferSnapshots.offerId, o683.id))).length, 0, "giá CHƯA BIẾT ⇒ không có ảnh chụp giá");
      const [cap] = await db.select().from(schema.sourcingOfferCaptures).where(eq(schema.sourcingOfferCaptures.offerId, o683.id));
      assert.deepEqual([cap.snapshotId, (cap.flags as string[]).includes("NO_DETAIL_PRICE")], [null, true]);
    });

    // ── Cách ly: B lưu cùng mã ⇒ dòng riêng ở CSDL B; A không thấy, B không thấy A.
    const rb = await post(tb.token, bodyOf("815636568273"));
    assert.equal(rb.status, 200);
    assert.equal(rb.body.created, true, "mẫu ở B là mẫu MỚI của B");
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      assert.deepEqual((await db.select({ id: schema.sourcingOffers.offerId }).from(schema.sourcingOffers)).map((r) => r.id), ["815636568273"], "B chỉ thấy mẫu của B");
      assert.equal((await db.select().from(schema.sourcingOfferCaptures)).length, 1);
    });
    await withOrganization(ORG_A, async () => assert.equal((await (await getDb()).select().from(schema.sourcingOffers)).length, 3, "A giữ đúng 3 mẫu của A"));

    // ── Mất quyền ⇒ 403; tài khoản khoá ⇒ 401; thu hồi ⇒ 401 (hai lần không ghi thêm).
    await withOrganization(ORG_A, async () => (await getDb()).update(schema.users).set({ role: "WAREHOUSE" }).where(eq(schema.users.id, a.id)));
    assert.equal((await post(ta.token, bodyOf("815636568273"))).status, 403, "tài khoản không còn sourcing:write ⇒ 403");
    await withOrganization(ORG_A, async () => (await getDb()).update(schema.users).set({ role: "MANAGER", active: false }).where(eq(schema.users.id, a.id)));
    assert.equal((await post(ta.token, bodyOf("815636568273"))).status, 401, "tài khoản khoá ⇒ token chết theo");
    await withOrganization(ORG_A, async () => (await getDb()).update(schema.users).set({ active: true }).where(eq(schema.users.id, a.id)));
    assert.equal((await post(ta.token, bodyOf("815636568273"))).status, 200, "mở khoá ⇒ dùng lại được");
    const outsider = await makeUser(ORG_A, "khac@cap-a.local", "MANAGER");
    const deny = await withOrganization(ORG_A, () => revokeCaptureToken(outsider, { tokenId: ta.id }, false));
    assert.ok(!deny.ok, "người khác không có quyền duyệt ⇒ không thu hồi token của người ta");
    assert.ok((await withOrganization(ORG_A, () => revokeCaptureToken(a, { tokenId: ta.id }, false))).ok);
    assert.ok((await withOrganization(ORG_A, () => revokeCaptureToken(a, { tokenId: ta.id }, false))).ok);
    await withOrganization(ORG_A, async () => assert.equal((await (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SOURCING_CAPTURE_TOKEN_REVOKE"))).length, 1, "thu hồi hai lần ⇒ một dòng nhật ký"));
    assert.equal((await post(ta.token, bodyOf("815636568273"))).status, 401, "token đã thu hồi ⇒ 401");
    assert.equal((await post(tb.token, bodyOf("835865258913"))).status, 200, "thu hồi token A không đụng token B");

    // ── Trần token mỗi người.
    for (let i = 0; i < 4; i++) assert.ok((await withOrganization(ORG_B, () => createCaptureToken(b, ORG_B, { label: `Máy ${i}` }))).ok);
    assert.ok(!(await withOrganization(ORG_B, () => createCaptureToken(b, ORG_B, { label: "Máy thứ sáu" }))).ok, "tối đa 5 token còn hiệu lực");

    // ── SERVE-COMPAT 0260: bảng token chưa có ⇒ 503, không ghi gì.
    await withOrganization(ORG_B, async () => (await getDb()).execute(sql.raw(`ALTER TABLE sourcing_capture_tokens RENAME TO sourcing_capture_tokens_tam`)));
    try {
      assert.equal((await post(tb.token, bodyOf("683567693110"))).status, 503);
    } finally {
      await withOrganization(ORG_B, async () => (await getDb()).execute(sql.raw(`ALTER TABLE sourcing_capture_tokens_tam RENAME TO sourcing_capture_tokens`)));
    }
    await withOrganization(ORG_B, async () => assert.equal((await (await getDb()).select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.offerId, "683567693110"))).length, 0));
  } finally {
    await cleanupOrg(ORG_A);
    await cleanupOrg(ORG_B);
  }
}

export async function testSourcingCapture() {
  testSizeChart();
  testParser();
  testAllowlist();
  testExtensionSource();
  testNoSecrets();
  await testDb();
  console.log(
    "  ✓ SRC-6 lưu mẫu từ 1688: 3 trang thật (giá SKU ¥26 · 斤 ⇒ 45–50 kg · 新人价 ¥11.28 bỏ, giá đặt ¥17.28) · dữ liệu 1688 đã dịch ⇒ cờ, không đọc cân nặng · danh sách cho phép giống hệt tiện ích ↔ máy chủ · token băm, sai tổ chức / khoá / thu hồi ⇒ 401, mất quyền ⇒ 403 · gửi lại ⇒ lần chụp mới · hai tổ chức không thấy nhau · chưa áp 0260 ⇒ 503",
  );
}
