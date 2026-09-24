import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { ADS_WRITE_KILL_KEY, isSpendReducingWrite, killSwitchVerdict, parseAdsKillSwitch } from "@/lib/constants/ads-kill-switch";
import {
  applyAdsWrite,
  assertKillSwitchAllows,
  createAd,
  createAdCreative,
  createTestAdset,
  extendAdset,
  pauseAdset,
  readAdsKillSwitch,
  uploadAdImage,
} from "@/lib/integrations/facebook/ads-write";

/**
 * ═══════════ CÔNG TẮC TẮT KHẨN CẤP ĐƯỜNG GHI QUẢNG CÁO ═══════════
 *
 * Luật: `lib/constants/ads-kill-switch.ts`. Ba điều khoá ở đây:
 *
 *  1. Bảng chân lý của việc ĐỌC công tắc — mọi nhánh lạ (lỗi CSDL, JSON hỏng, `"false"` dạng chuỗi)
 *     rơi về ĐÓNG (AGENTS.md mục 31).
 *  2. Công tắc KÉO ⇒ KHÔNG MỘT lời gọi ghi tạo/tăng chi nào ra tới mạng — đo bằng `fetch` giả đếm
 *     số lần gọi, không tin vào giá trị trả về của hàm.
 *  3. Tạm dừng vẫn đi; và phân loại "tạm dừng" đọc từ NỘI DUNG gửi đi, không từ một cờ nơi gọi khai.
 */

function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function testAdsKillSwitchPure() {
  // ── 1. Đọc công tắc ──
  assert.equal(parseAdsKillSwitch({ ok: true, value: null }).killed, false, "không có dòng = chưa ai kéo = MỞ");
  assert.equal(parseAdsKillSwitch({ ok: true, value: '{"killed":false,"reason":"xong sự cố"}' }).source, "RELEASED");
  assert.equal(parseAdsKillSwitch({ ok: true, value: '{"killed":false}' }).killed, false);
  const keo = parseAdsKillSwitch({ ok: true, value: '{"killed":true,"reason":"máy tạo nhóm lạ","by":"a@shop.vn","at":"2026-09-24T01:00:00Z"}' });
  assert.deepEqual([keo.killed, keo.source, keo.reason, keo.by], [true, "ENGAGED", "máy tạo nhóm lạ", "a@shop.vn"]);
  const loiDoc = parseAdsKillSwitch({ ok: false, error: "connection refused" });
  assert.deepEqual([loiDoc.killed, loiDoc.source], [true, "UNREADABLE"], "KHÔNG đọc được CSDL ⇒ coi như ĐANG KÉO — không biết thì không tiêu tiền");
  for (const hong of ["{", "[]", "null", "42", '"true"', '{"killed":"false"}', '{"killed":0}', "{}", '{"killed":null}']) {
    const s = parseAdsKillSwitch({ ok: true, value: hong });
    assert.equal(s.killed, true, `giá trị ${hong} không phải "mở" tường minh ⇒ phải ĐÓNG`);
    assert.equal(s.source, "MALFORMED");
  }

  // ── 3. Chỉ đúng MỘT hình dạng được coi là giảm chi ──
  assert.equal(isSpendReducingWrite({ status: "PAUSED" }), true);
  assert.equal(isSpendReducingWrite({ status: "ACTIVE" }), false, "bật lại là TĂNG chi");
  assert.equal(isSpendReducingWrite({ status: "PAUSED", daily_budget: "5000000" }), false, "kèm bất kỳ trường nào khác thì không còn là tạm dừng thuần");
  assert.equal(isSpendReducingWrite({ daily_budget: "100" }), false, "hạ ngân sách cũng bị chặn: cổng không tự kiểm được chiều");
  assert.equal(isSpendReducingWrite({ lifetime_budget: "1", end_time: "x" }), false);
  assert.equal(isSpendReducingWrite({}), false);

  const dong = parseAdsKillSwitch({ ok: true, value: '{"killed":true,"reason":"r"}' });
  const mo = parseAdsKillSwitch({ ok: true, value: null });
  assert.equal(killSwitchVerdict(dong, { bytes: "abc" }).allow, false);
  assert.equal(killSwitchVerdict(dong, { status: "PAUSED" }).allow, true, "khi ĐÓNG, tạm dừng vẫn đi để tiền ngừng chảy");
  assert.equal(killSwitchVerdict(mo, { daily_budget: "1" }).allow, true, "công tắc MỞ không tự chặn gì — chốt env và cổng thuần vẫn đứng trước");
  const lyDo = killSwitchVerdict(dong, { bytes: "abc" });
  assert.ok(!lyDo.allow && lyDo.reason.includes(ADS_WRITE_KILL_KEY), "lý do chặn phải nói tên khoá để người trực biết nhả ở đâu");

  // ── Mã nguồn: công tắc đứng TRONG graphPost, trước lời gọi mạng, và không đi qua getSettingJson ──
  const cuaGhi = boChuThich(readFileSync("lib/integrations/facebook/ads-write.ts", "utf8"));
  const than = cuaGhi.slice(cuaGhi.indexOf("async function graphPost"));
  const iKill = than.indexOf("await assertKillSwitchAllows(fields)");
  const iFetch = than.indexOf("fetchJson(");
  assert.ok(iKill > 0 && iFetch > iKill, "graphPost phải đọc lại công tắc TRƯỚC lời gọi fetchJson");
  assert.ok(!cuaGhi.includes("getSettingJson"), "getSettingJson nuốt lỗi CSDL thành 'không có dòng' = MỞ — công tắc không được đọc qua nó");
  assert.ok(!boChuThich(readFileSync("lib/env.ts", "utf8")).includes(ADS_WRITE_KILL_KEY), "công tắc chỉ LÀM HẸP — không được hợp nhất vào chốt env");

  console.log("✓ công tắc khẩn cấp quảng cáo: đọc lỗi/hỏng ⇒ ĐÓNG · chỉ {status: PAUSED} đi qua khi đóng · đứng trong graphPost trước fetch");
}

export async function testAdsKillSwitchDb(db: Db) {
  // Lỗi đọc settings ⇒ chặn — cả khi bộ đọc NÉM lẫn khi nó báo ok:false.
  await assert.rejects(
    assertKillSwitchAllows({ bytes: "abc" }, async () => {
      throw new Error("pool exhausted");
    }),
    /đang đóng/,
    "bộ đọc ném lỗi ⇒ phải CHẶN, không được cho đi",
  );
  await assert.rejects(assertKillSwitchAllows({ daily_budget: "1" }, async () => ({ ok: false, error: "timeout" })), /Không đọc được/);
  await assertKillSwitchAllows({ status: "PAUSED" }, async () => ({ ok: false, error: "timeout" }));

  const envTruoc = { e: process.env.ADS_WRITE_ENABLED, m: process.env.ADS_WRITE_MODE, t: process.env.FACEBOOK_ACCESS_TOKEN };
  const fetchTruoc = globalThis.fetch;
  const goi: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    goi.push({ url, body });
    const payload = url.includes("/adimages") ? { images: { a: { hash: "h1" } } } : { id: "1", success: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  process.env.ADS_WRITE_ENABLED = "true";
  process.env.ADS_WRITE_MODE = "COPILOT";
  process.env.FACEBOOK_ACCESS_TOKEN = "fake-token-for-test";
  const xoa = () => db.delete(schema.settings).where(eq(schema.settings.key, ADS_WRITE_KILL_KEY));
  try {
    await xoa();
    assert.equal((await readAdsKillSwitch()).source, "UNSET");

    // Công tắc MỞ: lời gọi ghi đi ra thật (để chứng minh fetch giả đang đo đúng chỗ).
    assert.equal(await uploadAdImage("act_123", "abc"), "h1");
    assert.equal(goi.length, 1, "công tắc mở thì lời gọi ghi đi ra — nếu không, bài kiểm dưới đây xanh vì lý do sai");

    // KÉO công tắc.
    await db.insert(schema.settings).values({ key: ADS_WRITE_KILL_KEY, value: JSON.stringify({ killed: true, reason: "kiểm thử" }) });
    goi.length = 0;
    const template = { targeting: { geo_locations: {} }, optimizationGoal: "CONVERSATIONS", billingEvent: "IMPRESSIONS", bidStrategy: null, bidAmount: null, promotedObject: null, destinationType: null, attributionSpec: null };
    const tao: [string, () => Promise<unknown>][] = [
      ["tải ảnh", () => uploadAdImage("act_123", "abc")],
      ["tạo bài", () => createAdCreative("act_123", { name: "n", objectStorySpec: { page_id: "1" } })],
      ["tạo nhóm", () => createTestAdset("act_123", { name: "n", campaignId: "c", lifetimeBudgetMinor: 200000, startTime: new Date(Date.now() + 3_600_000), endTime: new Date(Date.now() + 90_000_000), template })],
      ["tạo mẩu", () => createAd("act_123", { name: "n", adsetId: "a", creativeId: "cr" })],
      ["tiêu thêm", () => extendAdset("a", { lifetimeBudgetMinor: 400000, endTime: new Date(Date.now() + 90_000_000) })],
    ];
    for (const [ten, f] of tao) await assert.rejects(f(), /đường ghi quảng cáo đang đóng/, `${ten}: công tắc kéo thì phải bị chặn`);
    const doiNganSach = await applyAdsWrite({ campaignId: "c", action: "SET_DAILY_BUDGET", nextBudgetVnd: 1_000_000, currency: "VND" });
    assert.equal(doiNganSach.ok, false, "đổi ngân sách ngày phải bị chặn");
    assert.equal(goi.length, 0, `công tắc KÉO ⇒ KHÔNG một lời gọi ghi nào ra tới mạng (đã ra ${goi.length})`);

    // Tạm dừng vẫn đi — và đúng một trường status=PAUSED (cộng token do cửa ghi gắn).
    await pauseAdset("adset-1");
    const dung = await applyAdsWrite({ campaignId: "c", action: "PAUSE_CAMPAIGN", nextBudgetVnd: null, currency: "VND" });
    assert.equal(dung.ok, true);
    assert.equal(goi.length, 2, "tạm dừng vẫn phải đi khi công tắc kéo — tiền cần NGỪNG chảy");
    for (const g of goi) {
      const f = new URLSearchParams(g.body);
      assert.deepEqual([...f.keys()].sort(), ["access_token", "status"]);
      assert.equal(f.get("status"), "PAUSED");
    }

    // Dữ liệu hỏng ⇒ vẫn chặn.
    await db.update(schema.settings).set({ value: '{"killed":"false"}' }).where(eq(schema.settings.key, ADS_WRITE_KILL_KEY));
    goi.length = 0;
    await assert.rejects(uploadAdImage("act_123", "abc"), /hỏng/);
    assert.equal(goi.length, 0, 'chuỗi "false" không phải "mở"');

    // Nhả tường minh ⇒ đi lại, ở ĐÚNG lời gọi kế tiếp (không đệm).
    await db.update(schema.settings).set({ value: '{"killed":false,"reason":"hết sự cố"}' }).where(eq(schema.settings.key, ADS_WRITE_KILL_KEY));
    assert.equal(await uploadAdImage("act_123", "abc"), "h1");
    assert.equal(goi.length, 1);

    // Chốt env vẫn đứng trước: công tắc mở không mở được đường ghi đang đóng ở env.
    process.env.ADS_WRITE_ENABLED = "false";
    goi.length = 0;
    await assert.rejects(pauseAdset("adset-1"), /ADS_WRITE_ENABLED/);
    assert.equal(goi.length, 0);
  } finally {
    globalThis.fetch = fetchTruoc;
    const khoiPhuc = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    khoiPhuc("ADS_WRITE_ENABLED", envTruoc.e);
    khoiPhuc("ADS_WRITE_MODE", envTruoc.m);
    khoiPhuc("FACEBOOK_ACCESS_TOKEN", envTruoc.t);
    await xoa();
  }
  console.log("✓ công tắc khẩn cấp quảng cáo (CSDL): kéo ⇒ 0 lời gọi tạo/tăng chi ra mạng · tạm dừng vẫn đi · lỗi đọc ⇒ chặn · nhả ⇒ lời gọi kế tiếp đi");
}
