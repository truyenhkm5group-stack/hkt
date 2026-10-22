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
 *  6. Công tắc tổ chức `address.resolver` {"enabled": false} ⇒ lượt không đọc / ghi gì; `perTick` = trần số đơn một lượt. Đơn chốt TRƯỚC
 *     khi có `raw.addressText` (đơn bản #966 — ca #A4FA1734 · #E63E4D6E): máy đọc lại tin KHÁCH tới lúc đơn tạo (tin gửi sau không tính),
 *     vết `textSource = CONVERSATION`.
 *  7. Phạm vi ghi: có vận đơn chưa huỷ · đã khép (DELIVERED) · quá 14 ngày ⇒ máy KHÔNG chạm (không vết), kể cả khi gọi thẳng đường ghi
 *     lúc đã có vận đơn; số còn treo cờ đếm theo lý do (`countOutOfScope`, 2B). Về lại trong phạm vi ⇒ máy xét bình thường.
 * Không gọi mạng thật (Google giả qua chỗ cắm `deps`). Dữ liệu dựng, không PII.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ADDRESS_RESOLVER_SETTING_KEY, ADDRESS_RESOLVER_USAGE_KEY, countOutOfScope, resolvePendingAddresses } from "@/lib/address/resolve-job";
import { resolveAddress } from "@/lib/address/resolver";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { orderReviewLogOf, orderReviewOf } from "@/lib/constants/order-review";
import type { textSearch } from "@/lib/integrations/google-places/client";
import { applyAddressResolutionAsAgent } from "@/lib/records/order-create";
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
  { key: "res-pham-vi", title: "Có vận đơn · đã giao · quá 14 ngày ⇒ máy không chạm, đếm «ngoài phạm vi»; về lại phạm vi ⇒ máy xét", shop: "food", channel: "WEB", turns: [turn("Cho chị 1 hộp ruốc bông tôm, Lan 0961007205, Số 12 Nguyễn Trãi, Hà Nội", "0961007205", "Số 12 Nguyễn Trãi, Hà Nội")] },
  { key: "res-cu", title: "Đơn bản #966 (không có raw.addressText) ⇒ công tắc tắt thì không chạm; bật lại thì đọc tin khách tới lúc đơn tạo", shop: "food", channel: "WEB", turns: [turn("Cho chị 1 hộp ruốc bông tôm, Lan 0961007204, Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội", "0961007204", "Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội")] },
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
      if (c.key === "res-pham-vi") {
        const touched = async () => "addressResolution" in ((await orderOf()).raw as object);
        const QUERY = "Số 12 Nguyễn Trãi";
        const run = async () => {
          const calls: FakeCall[] = [];
          await resolvePendingAddresses(now, { openPlaces, textSearch: fakeOk(calls, ["12 P. Nguyễn Trãi, Khương Trung, Thanh Xuân, Hà Nội, Việt Nam", "12 Nguyễn Trãi, P. Quang Trung, Hà Đông, Hà Nội, Việt Nam"]) });
          return calls.filter((x) => x.query.includes(QUERY)).length;
        };
        // (1) Có vận đơn chưa huỷ ⇒ không chọn, không gọi Google, không vết; gọi THẲNG đường ghi cũng bị chặn trong giao dịch.
        const [ship] = await db.insert(schema.shipments).values({ orderId: before.id, vtpOrderNumber: "RES-PV-1", trackingCode: "RES-PV-1", stage: "PENDING" as never }).returning({ id: schema.shipments.id });
        assert.ok((await countOutOfScope(now)).SHIPMENT >= 1, "có vận đơn ⇒ đếm SHIPMENT (nhánh CÓ của câu con)");
        assert.equal(await run(), 0, "có vận đơn ⇒ máy không xét");
        const direct = await applyAddressResolutionAsAgent({ name: "Máy ánh xạ địa chỉ", source: "test" }, before.id, before.shipAddress, { status: "SURE", source: "TEXT", ward: "Phường Khương Đình", province: HN, candidates: [], reason: "thử", textAt: null, places: false, placesError: null, attempts: 1, at: now.toISOString() }, now);
        assert.equal(direct.applied, false, "đường ghi tự chặn khi đơn đã có vận đơn");
        assert.equal((await orderOf()).shipCommune, "");
        assert.equal(await touched(), false, "ngoài phạm vi ⇒ không vết");
        await db.delete(schema.shipments).where(eq(schema.shipments.id, ship.id));
        // (2) Quá 14 ngày ⇒ TOO_OLD, không chạm.
        await db.update(schema.orders).set({ createdAt: new Date(now.getTime() - 20 * 24 * 3_600_000) }).where(eq(schema.orders.id, before.id));
        assert.ok((await countOutOfScope(now)).TOO_OLD >= 1, "quá tuổi ⇒ TOO_OLD");
        assert.equal(await run(), 0, "quá 14 ngày ⇒ máy không xét");
        await db.update(schema.orders).set({ createdAt: before.createdAt }).where(eq(schema.orders.id, before.id));
        // (3) Đã khép (giao) ⇒ CLOSED, không chạm.
        await db.update(schema.orders).set({ stage: "DELIVERED" as never }).where(eq(schema.orders.id, before.id));
        const closedN = (await countOutOfScope(now)).CLOSED;
        assert.ok(closedN >= 1, "đã giao ⇒ CLOSED");
        assert.equal(await run(), 0, "đã giao ⇒ máy không xét");
        assert.equal(await touched(), false);
        const day = await collectAddressResolverDay(new Date(now.getTime() - 3_600_000), new Date(now.getTime() + 3_600_000), now);
        assert.ok((day.outOfScope?.CLOSED ?? 0) >= 1, `2B đếm ngoài phạm vi: ${JSON.stringify(day.outOfScope)}`);
        // (4) Về lại phạm vi ⇒ máy xét (Google hai nơi ⇒ không chắc ⇒ việc nhân viên, có vết).
        await db.update(schema.orders).set({ stage: before.stage }).where(eq(schema.orders.id, before.id));
        assert.equal((await countOutOfScope(now)).CLOSED, closedN - 1, "về lại phạm vi ⇒ không còn đếm");
        assert.equal(await run(), 1, "trong phạm vi ⇒ máy xét, gọi Google một lần");
        assert.equal(await touched(), true);
        assert.equal(addressReviewOpenOf((await orderOf()).raw), true, "Google hai nơi ⇒ cờ còn mở cho nhân viên");
      }
      if (c.key === "res-cu") {
        // Dựng lại hình dạng đơn bản #966: không có raw.addressText.
        const { addressText: _drop, ...legacyRaw } = (before.raw ?? {}) as Record<string, unknown>;
        void _drop;
        await db.update(schema.orders).set({ raw: legacyRaw }).where(eq(schema.orders.id, before.id));
        // Tin khách gửi SAU lúc đơn tạo mang một địa chỉ khác (đủ xã) — không thuộc đơn này, máy không được dùng.
        await db.insert(schema.salesChatMessages).values({ conversationId: ctx.conversationId, seq: 9_000, role: "user", content: [{ type: "text", text: "Số 1 Tràng Tiền, Phường Hoàn Kiếm, Hà Nội" }], createdAt: new Date(before.createdAt.getTime() + 60_000) });
        try {
          await setSettingJson(ADDRESS_RESOLVER_SETTING_KEY, { enabled: false });
          const tat: FakeCall[] = [];
          const off = await resolvePendingAddresses(now, { openPlaces, textSearch: fakeOk(tat, ["x"]) });
          assert.ok(off.off && off.checked === 0 && tat.length === 0, `công tắc tắt ⇒ không đọc, không gọi: ${JSON.stringify(off)}`);
          assert.ok(!("addressResolution" in ((await orderOf()).raw as object)), "công tắc tắt ⇒ không ghi vết");
          await setSettingJson(ADDRESS_RESOLVER_SETTING_KEY, { perTick: 1 });
          const calls: FakeCall[] = [];
          const r = await resolvePendingAddresses(now, { openPlaces, textSearch: fakeOk(calls, ["8 ngõ 2, Khương Trung, Thanh Xuân, Hà Nội, Việt Nam"]) });
          assert.ok(r.checked === 1 && r.sure === 1 && !r.error, `perTick 1 ⇒ đúng một đơn: ${JSON.stringify(r)}`);
          const o = await orderOf();
          assert.equal(o.shipCommune, "Phường Khương Đình", "đọc tin khách tới lúc đơn tạo, không dùng tin gửi sau («Hoàn Kiếm»)");
          const res = (o.raw as { addressResolution?: { textSource?: string; source?: string } }).addressResolution;
          assert.ok(res?.textSource === "CONVERSATION" && res.source === "PLACES", JSON.stringify(res));
          assert.ok(calls.length === 1 && !/Lan|ruốc|0961007204|Tràng Tiền/.test(calls[0].query), `chỉ vế địa chỉ của tin trước đơn: ${JSON.stringify(calls)}`);
          assert.equal(addressReviewOpenOf(o.raw), false);
        } finally {
          await setSettingJson(ADDRESS_RESOLVER_SETTING_KEY, {});
        }
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ job: chắc ⇒ điền xã + gỡ cờ (ADDRESS_SETTLED nguồn PLACES) · Google lỗi xác thực ⇒ ghi lỗi + lý do vào cờ, không ném · Google treo ⇒ dừng đúng trần · chạy lại không gọi lại · 2B đếm · công tắc tắt ⇒ không chạm · perTick · đơn bản #966 đọc tin khách tới lúc đơn tạo · có vận đơn / đã giao / quá 14 ngày ⇒ không chạm, đếm ngoài phạm vi");
}

export async function testAddressResolver(): Promise<void> {
  testAddressResolverPure();
  await testAddressResolverJob();
  console.log("✓ Máy ánh xạ địa chỉ nền: thang chữ khách → C360 → Google (đọc lại bằng danh mục ERP, giao các bậc) · chắc ⇒ điền + gỡ cờ · không chắc ⇒ một việc · lỗi / treo không chạm lượt chat · 2B đếm");
}
