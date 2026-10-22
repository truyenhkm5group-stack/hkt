/**
 * ═══════════ MÁY ÁNH XẠ ĐỊA CHỈ NỀN (address-resolver-ladder PR-B · chủ shop chốt 22/10/2026 · AGENTS 3.12b) ═══════════
 *
 * Khoá:
 *  1. Thang thuần: chữ khách CHẮC ⇒ dừng ở (a) · địa chỉ đã xác minh cùng nơi ⇒ (b) · xã cũ bị chia ⇒ ứng viên thu hẹp cho nhân viên ·
 *     GIAO chữ khách ∩ Google còn một xã ⇒ chắc · Google ra nhiều nơi ⇒ không chắc · sai tỉnh của đơn ⇒ loại · không ra ⇒ NONE.
 *  2. Chỉ VẾ địa chỉ đi ra Google (không tên, món, SĐT).
 *  3. Job trên đơn thật (chatTurn): chắc ⇒ điền xã + gỡ cờ máy (vết ADDRESS_SETTLED nguồn PLACES); Google lỗi xác thực ⇒ ghi lỗi, ứng
 *     viên / lý do vào dòng cờ, cờ còn mở, không ném; Google TREO ⇒ lượt job dừng đúng trần, không treo; chạy lại ⇒ không gọi Google lần
 *     hai cho đơn đã xét; mọi kết quả có vết `raw.addressResolution`.
 *  4. Đường trả lời khách KHÔNG import máy ánh xạ (treo / lỗi / chậm không chạm lượt chat); job chỉ chạy kế `sales-followup`.
 *  5. 2B đếm tự ánh xạ / cần nhân viên + lượt Google.
 * Không gọi mạng thật (Google giả qua chỗ cắm `deps`). Dữ liệu dựng, không PII.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ADDRESS_RESOLVER_USAGE_KEY, resolvePendingAddresses } from "@/lib/address/resolve-job";
import { resolveAddress } from "@/lib/address/resolver";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { orderReviewLogOf, orderReviewOf } from "@/lib/constants/order-review";
import type { textSearch } from "@/lib/integrations/google-places/client";
import { addressQueryText } from "@/lib/sales-chatbot/address-memory";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { collectAddressResolverDay } from "@/lib/sales-quality/daily";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { addressReviewOpenOf } from "@/lib/shipping/route";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const HN = "Thành phố Hà Nội";

export function testAddressResolverPure() {
  const r = (lines: string[], address: string, extra: Partial<Parameters<typeof resolveAddress>[0]> = {}) => resolveAddress({ lines, recipient: { address, province: "" }, places: null, ...extra });
  const tach = r(["Số 10 ngõ 5 Lương Định Của, Hà Nội", "Phường Kim Liên"], "Số 10 ngõ 5 Lương Định Của, Hà Nội");
  assert.ok(tach.status === "SURE" && tach.source === "TEXT" && tach.pick?.ward === "Phường Kim Liên", JSON.stringify(tach));
  const c360 = r(["Số 5 ngõ 12 xóm Chùa, Hà Nội"], "Số 5 ngõ 12 xóm Chùa, Hà Nội", { verified: [{ address: "Số 5 ngõ 12 xóm Chùa", province: HN, ward: "Phường Kim Liên" }] });
  assert.ok(c360.status === "SURE" && c360.source === "C360", JSON.stringify(c360));
  assert.equal(r(["Số 5 ngõ 12 xóm Chùa, Hà Nội"], "Số 5 ngõ 12 xóm Chùa, Hà Nội", { verified: [{ address: "Số 99 phố Huế", province: HN, ward: "Phường Hai Bà Trưng" }] }).status, "NONE", "địa chỉ đã xác minh ở NƠI KHÁC ⇒ không dùng");
  const cu = r(["Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội"], "Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội");
  assert.ok(cu.status === "UNSURE" && cu.candidates.length >= 2 && cu.candidates.every((c) => c.province === HN), `xã cũ bị chia ⇒ ứng viên thu hẹp: ${JSON.stringify(cu.candidates.map((c) => c.ward))}`);
  const giao = r(["Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội"], "Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội", { places: ["8 ngõ 2, Khương Trung, Thanh Xuân, Hà Nội, Việt Nam"] });
  assert.ok(giao.status === "SURE" && giao.source === "PLACES" && giao.pick?.ward === "Phường Khương Đình" && /TEXT ∩ PLACES/.test(giao.reason), `chữ khách ∩ Google còn một xã ⇒ chắc: ${JSON.stringify(giao)}`);
  const hai = r(["Số 12 Nguyễn Trãi, Hà Nội"], "Số 12 Nguyễn Trãi, Hà Nội", { places: ["12 P. Nguyễn Trãi, Khương Trung, Thanh Xuân, Hà Nội, Việt Nam", "12 Nguyễn Trãi, P. Quang Trung, Hà Đông, Hà Nội, Việt Nam"] });
  assert.equal(hai.status, "UNSURE", "Google ra hai nơi ⇒ nhân viên chọn, không đoán");
  assert.equal(r(["Số 12 Nguyễn Trãi, Hà Nội"], "Số 12 Nguyễn Trãi, Hà Nội", { places: ["12 Nguyễn Trãi, Phường Bến Thành, Thành phố Hồ Chí Minh"] }).status, "NONE", "kết quả Google SAI TỈNH của đơn ⇒ loại");
  assert.equal(r(["Số 5 ngõ 12 xóm Chùa"], "Số 5 ngõ 12 xóm Chùa", { places: [] }).status, "NONE");
  // Chỉ VẾ địa chỉ đi ra Google.
  const q = addressQueryText(["Cho chị 1 hộp ruốc bông tôm, Lan 0961007100, Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội"]);
  assert.ok(q.includes("Số 8 ngõ 2") && q.includes("Hà Nội") && !/Lan|ruốc|0961007100/.test(q), `chỉ vế địa chỉ: «${q}»`);
  // Đường trả lời khách không import máy ánh xạ; job chỉ chạy kế sales-followup.
  const files = execFileSync("git", ["ls-files", "lib/sales-chatbot", "app/api"], { encoding: "utf8" }).split("\n").filter((f) => /\.tsx?$/.test(f));
  const importers = files.filter((f) => /from "@\/lib\/address\/(?:resolve-job|resolver)"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, [], "đường chat / webhook không bao giờ gọi máy ánh xạ (treo / lỗi / chậm không chạm lượt trả lời)");
  assert.match(readFileSync("lib/sync/jobs.ts", "utf8"), /"sales-followup": \{[\s\S]*?await resolvePendingAddresses\(\)\.catch\(/, "chạy kế sales-followup, không ném");
  console.log("  ✓ thuần: chữ khách · C360 cùng nơi · xã cũ ⇒ ứng viên thu hẹp · giao chữ khách ∩ Google ⇒ chắc · hai nơi / sai tỉnh ⇒ không đoán · chỉ vế địa chỉ ra Google · đường chat không import");
}

type FakeCall = { query: string };
const placeOf = (address: string) => ({ placeId: "pid-1", name: null, address, types: [], primaryType: null, businessStatus: null, lat: 21.0, lng: 105.8, mapsUrl: null, nationalPhone: null, internationalPhone: null, website: null, rating: null, reviewCount: null });
const meta = { sku: "TEXT_SEARCH_PRO" as const, httpStatus: 200, durationMs: 5, attempts: 1, billable: true };
const fakeOk = (calls: FakeCall[], addresses: string[]): typeof textSearch => async (_o, input) => {
  calls.push({ query: input.textQuery });
  return { ok: true, places: addresses.map(placeOf), nextPageToken: null, meta };
};
const openPlaces = async () => ({ apiKey: "khoa-gia", relay: null });

const turn = (said: string, phone: string, address: string) => ({
  say: said,
  ai: [
    () => [tool("create_customer", { name: "Lan", phone, address })],
    ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
    () => [say("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ.")],
  ],
});
const CASES: GoldenCase[] = [
  { key: "res-giao", title: "Xã cũ bị chia + Google ⇒ giao còn một xã ⇒ máy điền xã, gỡ cờ", shop: "food", channel: "WEB", turns: [turn("Cho chị 1 hộp ruốc bông tôm, Lan 0961007201, Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội", "0961007201", "Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội")] },
  { key: "res-auth", title: "Google từ chối khoá ⇒ ghi lỗi, ứng viên / lý do vào cờ, cờ còn mở, không ném", shop: "food", channel: "WEB", turns: [turn("Cho chị 1 hộp ruốc bông tôm, Lan 0961007202, Số 12 Nguyễn Trãi, Hà Nội", "0961007202", "Số 12 Nguyễn Trãi, Hà Nội")] },
  { key: "res-treo", title: "Google treo 30 giây ⇒ lượt job dừng đúng trần, đơn chờ nhân viên", shop: "food", channel: "WEB", turns: [turn("Cho chị 1 hộp ruốc bông tôm, Lan 0961007203, Số 3 ngõ 9 Trần Duy Hưng, Hà Nội", "0961007203", "Số 3 ngõ 9 Trần Duy Hưng, Hà Nội")] },
];

export async function testAddressResolverJob() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-res",
    beforeCase: async () => {
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false, autoUpsellOffer: false });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx: GoldenHookCtx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const orderOf = async () => (await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId)))[0];
      const before = await orderOf();
      assert.ok(before && before.stage === "CONFIRMED" && addressReviewOpenOf(before.raw), `[${c.key}] đơn chốt kèm cờ địa chỉ: ${JSON.stringify(t.turns.map((x) => x.shown))}`);
      const now = new Date();
      if (c.key === "res-giao") {
        const calls: FakeCall[] = [];
        const r = await resolvePendingAddresses(now, { openPlaces, textSearch: fakeOk(calls, ["8 ngõ 2, Khương Trung, Thanh Xuân, Hà Nội, Việt Nam"]) });
        assert.ok(r.sure >= 1 && !r.error, JSON.stringify(r));
        const o = await orderOf();
        assert.equal(o.shipCommune, "Phường Khương Đình");
        assert.equal(o.shipProvince, HN);
        assert.equal(addressReviewOpenOf(o.raw), false, "cờ địa chỉ của máy đã gỡ");
        const log = orderReviewLogOf(o.raw).find((x) => x.action === "ADDRESS_SETTLED");
        assert.ok(log && log.byUserId === null && /nguồn PLACES/.test(log.byName), JSON.stringify(orderReviewLogOf(o.raw)));
        const res = (o.raw as { addressResolution?: { status?: string; source?: string; places?: boolean } }).addressResolution;
        assert.ok(res?.status === "SURE" && res.source === "PLACES" && res.places === true, JSON.stringify(res));
        assert.ok(calls.length === 1 && !/Lan|ruốc|0961007201/.test(calls[0].query), `chỉ vế địa chỉ ra Google: ${JSON.stringify(calls)}`);
        const again: FakeCall[] = [];
        const r2 = await resolvePendingAddresses(new Date(now.getTime() + 60_000), { openPlaces, textSearch: fakeOk(again, ["x"]) });
        assert.equal(again.length, 0, `chạy lại ⇒ không gọi Google cho đơn đã xét: ${JSON.stringify(r2)}`);
      }
      if (c.key === "res-auth") {
        const r = await resolvePendingAddresses(now, { openPlaces, textSearch: async () => ({ ok: false, kind: "AUTH", message: "API key not valid", meta }) });
        assert.ok(r.placesError?.startsWith("AUTH") && !r.error, JSON.stringify(r));
        const o = await orderOf();
        assert.equal(o.shipCommune, "");
        assert.equal(addressReviewOpenOf(o.raw), true, "không chắc ⇒ cờ còn mở (việc nhân viên)");
        assert.match(orderReviewOf(o.raw)?.entries.find((e) => e.code === "ADDRESS_UNRESOLVED")?.note ?? "", / · Máy ánh xạ: .*Google lỗi AUTH/, "lý do nằm trên dòng cờ — một việc");
        const usage = await getSettingJson<{ lastError?: string | null }>(ADDRESS_RESOLVER_USAGE_KEY, {});
        assert.match(usage.lastError ?? "", /^AUTH/, "lỗi Google ghi vào sổ (2B in ra)");
      }
      if (c.key === "res-treo") {
        const t0 = Date.now();
        const r = await resolvePendingAddresses(now, { openPlaces, callTimeoutMs: 300, textSearch: () => new Promise(() => undefined) });
        assert.ok(Date.now() - t0 < 5_000, `Google treo ⇒ lượt dừng đúng trần (${Date.now() - t0} ms)`);
        assert.ok(r.placesError?.startsWith("TIMEOUT") && !r.error, JSON.stringify(r));
        const o = await orderOf();
        assert.equal(addressReviewOpenOf(o.raw), true);
        const day = await collectAddressResolverDay(new Date(now.getTime() - 3_600_000), new Date(now.getTime() + 3_600_000), now);
        assert.ok(day.auto >= 1 && day.staff >= 2 && day.bySource.PLACES >= 1 && day.placesCalls >= 3, `2B đếm ánh xạ: ${JSON.stringify(day)}`);
        // Mọi đơn (chắc · lỗi xác thực · treo) đã xét cùng chữ địa chỉ ⇒ lượt sau KHÔNG gọi Google lần nào (không đốt trần mỗi 5 phút).
        const again: FakeCall[] = [];
        const r2 = await resolvePendingAddresses(new Date(now.getTime() + 300_000), { openPlaces, textSearch: fakeOk(again, ["x"]) });
        assert.equal(again.length, 0, `chạy lại ⇒ 0 lời gọi Google: ${JSON.stringify(r2)}`);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ job: chắc ⇒ điền xã + gỡ cờ (ADDRESS_SETTLED nguồn PLACES) · Google lỗi xác thực ⇒ ghi lỗi + lý do vào cờ, không ném · Google treo ⇒ dừng đúng trần · chạy lại không gọi lại · 2B đếm");
}

export async function testAddressResolver(): Promise<void> {
  testAddressResolverPure();
  await testAddressResolverJob();
  console.log("✓ Máy ánh xạ địa chỉ nền: thang chữ khách → C360 → Google (đọc lại bằng danh mục ERP, giao các bậc) · chắc ⇒ điền + gỡ cờ · không chắc ⇒ một việc · lỗi / treo không chạm lượt chat · 2B đếm");
}
