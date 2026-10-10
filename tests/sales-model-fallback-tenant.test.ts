/**
 * ═══════ LỖI MODEL CỦA KHOÁ BYOK TỔ CHỨC A KHÔNG ĐƯỢC ĐẨY TỔ CHỨC B SANG MODEL KHÁC ═══════
 *
 * `withModelFallback` (lib/sales-chatbot/engine.ts) nhớ "model bị nhà cung cấp từ chối" trong một Map MỨC MODULE
 * (`unavailableModels`). Trước 10/10/2026 khoá là `${primary.name}:${primary.model}` — KHÔNG có tổ chức, KHÔNG có
 * kết nối. Lỗi «không có model» thật ra là lỗi CỦA MỘT KHOÁ (sự cố gốc 03/10/2026: khoá Gemini mới của HSLC không gọi
 * được dòng 2.5), nên một tổ chức khai khoá hỏng làm MỌI tổ chức khác dùng cùng nhà cung cấp + model bị lùi IM LẶNG về
 * model mặc định trong 1 giờ — và họ không được báo (`onFallback` chỉ chạy ở lượt hỏng đầu tiên, của tổ chức A).
 * Nay khoá là `modelFallbackKey(scope, provider)` = `tổ chức:kết nối:nhà cung cấp:model` (Team Premium F2).
 *
 * Bài kiểm có ba phần:
 *   1. HỢP ĐỒNG ĐÃ CÓ: trong CÙNG một tổ chức + kết nối, sau lượt hỏng thì đi thẳng model mặc định.
 *   2. HỒI QUY: tổ chức B dùng model của chính mình, không bị tính là "đã lùi"; và khi khoá của B hỏng thật thì B
 *      tự tốn một lời gọi và được báo lỗi CỦA MÌNH.
 *   3. CÙNG tổ chức, KHÁC kết nối (khoá nền tảng vs khoá riêng của shop): lỗi của kết nối này không làm lùi kết nối kia.
 *
 * Không gọi mạng, không đọc khoá thật: provider là đối tượng giả trong bộ nhớ.
 * Chạy: npx tsx --tsconfig tsconfig.json tests/sales-model-fallback-tenant.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AiProvider, AiRequest } from "@/lib/ai/provider";
import { modelFallbackKey, withModelFallback, type ModelFallbackScope } from "@/lib/sales-chatbot/engine";

const MODEL = "gemini-2.5-flash-lite";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Đúng câu lỗi của sự cố thật (tests/self-service-journey.test.ts dùng cùng câu này).
const MODEL_GONE = `Gemini trả lỗi HTTP 404: models/${MODEL} is no longer available to new users.`;

const okRes = (model: string) => ({
  content: [{ type: "text" as const, text: "Dạ" }],
  stopReason: "end_turn" as const,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model,
  latencyMs: 1,
});
const req: AiRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "giá?" }] }], tools: [] };

/**
 * Một tổ chức với khoá BYOK riêng: `primaryWorks = false` ⇒ khoá này không gọi được model đã khai. `scope` mặc định là
 * khoá riêng Gemini của tổ chức mang tên `label` — đúng thứ `resolveConnector` truyền vào.
 */
function tenant(label: string, primaryWorks: boolean, clock: () => number, scope: ModelFallbackScope = { orgCode: label, connector: "gemini-byok" }) {
  const calls = { primary: 0, fallback: 0, notified: [] as string[] };
  // Tên provider giống hệt nhau giữa các tổ chức — đúng như ByokGeminiProvider dựng cho mỗi tổ chức.
  const primary: AiProvider = {
    name: "gemini",
    model: MODEL,
    schemaDialect: "openai",
    complete: async () => {
      calls.primary += 1;
      if (!primaryWorks) throw new Error(MODEL_GONE);
      return okRes(MODEL);
    },
  };
  const fallback: AiProvider = {
    name: "gemini",
    model: DEFAULT_MODEL,
    schemaDialect: "openai",
    complete: async () => {
      calls.fallback += 1;
      return okRes(DEFAULT_MODEL);
    },
  };
  const wrapped = withModelFallback(primary, fallback, (m) => calls.notified.push(`${label}:${m}`), clock, scope);
  return { wrapped, calls };
}

export async function testSalesModelFallbackTenant(): Promise<{ passed: number; failed: string[] }> {
  let clock = 5_000_000_000; // mốc riêng của bài này — đi theo đồng hồ giả của chính hàm, không theo ngày thật
  const now = () => clock;
  const failed: string[] = [];
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed.push(name);
      console.log(`  ✗ ${name}\n      ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
  };

  // ── 1 · Hợp đồng đã có: cùng một tổ chức ──
  const a = tenant("A", false, now);
  assert.equal((await a.wrapped.complete(req)).model, DEFAULT_MODEL);
  await a.wrapped.complete(req);
  check("cùng tổ chức: lượt hỏng đầu báo chủ shop, lượt sau đi thẳng model mặc định", () => {
    assert.deepEqual(a.calls.notified, [`A:${MODEL}`]);
    assert.equal(a.calls.primary, 1, "không tốn thêm lời gọi hỏng trong 1 giờ");
    assert.equal(a.calls.fallback, 2);
  });

  // ── 2 · Hồi quy: tổ chức B, khoá riêng GỌI ĐƯỢC model đã khai ──
  clock += 1_000; // vẫn trong cửa sổ 1 giờ của lượt hỏng của A
  const b = tenant("B", true, now);
  const resB = await b.wrapped.complete(req);
  check("tổ chức B dùng ĐÚNG model đã khai, không bị lỗi khoá của tổ chức A kéo sang model mặc định", () => {
    assert.equal(resB.model, MODEL, `B nhận câu trả lời từ ${resB.model} — bộ đệm lỗi model đang dùng chung giữa các tổ chức`);
  });
  check("khoá của tổ chức B thật sự được gọi", () => {
    assert.equal(b.calls.primary, 1, `primary của B được gọi ${b.calls.primary} lần`);
    assert.equal(b.calls.fallback, 0, `fallback của B bị gọi ${b.calls.fallback} lần`);
  });

  // ── 2b · Khoá của B hỏng THẬT: B tự tốn đúng một lời gọi hỏng và được báo lỗi của chính mình ──
  const bBad = tenant("B", false, now);
  await bBad.wrapped.complete(req);
  await bBad.wrapped.complete(req);
  check("khoá của B hỏng ⇒ B được báo lỗi CỦA MÌNH, một lời gọi hỏng rồi đi thẳng model mặc định", () => {
    assert.deepEqual(bBad.calls.notified, [`B:${MODEL}`], `B nhận thông báo: ${JSON.stringify(bBad.calls.notified)}`);
    assert.equal(bBad.calls.primary, 1);
    assert.equal(bBad.calls.fallback, 2);
  });

  // ── 3 · Cùng tổ chức, khác kết nối: khoá nền tảng vs khoá riêng của shop ──
  const own = tenant("C-riêng", false, now, { orgCode: "C", connector: "gemini-byok" });
  await own.wrapped.complete(req);
  const plat = tenant("C-nền tảng", true, now, { orgCode: "C", connector: "platform" });
  const resPlat = await plat.wrapped.complete(req);
  check("cùng tổ chức: khoá riêng hỏng không làm lùi kết nối khoá nền tảng (cùng nhà cung cấp + model)", () => {
    assert.equal(resPlat.model, MODEL, `kết nối nền tảng nhận câu trả lời từ ${resPlat.model}`);
    assert.equal(plat.calls.primary, 1);
    assert.deepEqual(plat.calls.notified, []);
  });
  check("khoá bộ đệm mang tổ chức + kết nối", () => {
    const p = { name: "gemini", model: MODEL };
    assert.equal(modelFallbackKey({ orgCode: "C", connector: "gemini-byok" }, p), `C:gemini-byok:gemini:${MODEL}`);
    assert.notEqual(modelFallbackKey({ orgCode: "A", connector: "gemini-byok" }, p), modelFallbackKey({ orgCode: "B", connector: "gemini-byok" }, p));
    assert.notEqual(modelFallbackKey({ orgCode: "C", connector: "platform" }, p), modelFallbackKey({ orgCode: "C", connector: "gemini-byok" }, p));
  });

  // ── 4 · Nơi bọc thật (`resolveConnector`) truyền ĐÚNG tổ chức của ngữ cảnh + khoá kết nối — hàm thuần đúng mà chỗ gọi truyền
  // một hằng số thì lỗi cũ quay lại y nguyên. Quét mã nguồn: mọi lời gọi trong engine.ts mang `{ orgCode: org.code, connector: key }`.
  check("resolveConnector bọc với phạm vi tổ chức hiện tại + kết nối", () => {
    const src = readFileSync(path.join(process.cwd(), "lib", "sales-chatbot", "engine.ts"), "utf8");
    const calls = src.split("withModelFallback(").slice(1).filter((x) => !/^primary: AiProvider/.test(x));
    assert.ok(calls.length >= 1, "không tìm thấy chỗ bọc withModelFallback trong engine.ts");
    for (const c of calls) {
      const call = c.slice(0, c.indexOf("), source };"));
      assert.match(call, /\{ orgCode: org\.code, connector: key \}\s*$/, `chỗ bọc không mang tổ chức + kết nối: withModelFallback(${call.slice(0, 160)}`);
    }
  });

  // Dọn trạng thái mức module cho bài kiểm chạy sau trong cùng tiến trình: một lượt thành công của khoá đúng xoá
  // dấu hỏng (`unavailableModels.delete`). Đi qua cửa sổ 1 giờ để chắc lượt này tới được primary.
  clock += 3_600_001;
  await tenant("A", true, now).wrapped.complete(req);
  await tenant("B", true, now).wrapped.complete(req);
  await tenant("C", true, now).wrapped.complete(req);

  return { passed, failed };
}

if (/sales-model-fallback-tenant\.test\.ts$/.test(process.argv[1] ?? "")) {
  testSalesModelFallbackTenant().then(
    (r) => {
      console.log(`sales-model-fallback-tenant: ${r.passed} đạt · ${r.failed.length} không đạt`);
      process.exit(r.failed.length ? 1 : 0);
    },
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
