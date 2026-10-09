/**
 * BỘ HỘI THOẠI VÀNG (M1 · docs/productization/MIGRATION_PLAN.md) — lưới an toàn cho mọi thay đổi engine / công cụ / lời nhắc
 * / kênh của chatbot bán hàng: phát lại `GOLDEN_CASES` qua `chatTurn` với model giả, so với ảnh chụp đã duyệt trong
 * `tests/sales-agent-golden/snapshots/`. Đỏ ⇒ in ĐƯỜNG DẪN khác đầu tiên + giá trị cũ / mới. Thay đổi cố ý ⇒
 * `npx tsx tests/sales-agent-golden/update.ts`, đọc diff ảnh chụp, đưa cùng PR.
 *
 * Ngoài so ảnh chụp còn khẳng định TRỰC TIẾP vài bất biến (để một lần cập nhật ảnh chụp ẩu không «hợp thức hoá» được chúng):
 * giá đọc từ ERP, chốt khi khách chưa đồng ý bị chặn, khung thử không ghi, chữ nội bộ không tới khách, gói ngành đúng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GOLDEN_CASES } from "./cases";
import { firstDiff, normalizer, runGoldenCases, type GoldenTranscript } from "./harness";

export const GOLDEN_SNAPSHOT_DIR = path.join("tests", "sales-agent-golden", "snapshots");

const SEAFOOD = /hải sản|chả cá|chả mực|cá thu/i;

function invariants(t: Map<string, GoldenTranscript>) {
  const get = (k: string) => {
    const x = t.get(k);
    assert.ok(x, `thiếu hội thoại ${k}`);
    return x;
  };
  const quote = get("bao-gia");
  assert.match(quote.turns[0].shown.join(" "), /400\.000 ₫/, "giá báo khách đọc từ ERP");

  const full = get("len-don-chot");
  assert.equal(full.final.order?.stage, "CONFIRMED", "trọn vòng web ⇒ đơn chốt thật");
  assert.equal(full.final.order?.total, 1_150_000, "2 × 400.000 + 1 × 350.000 — đơn giá do ERP điền");
  assert.deepEqual(full.final.order?.items.map((i) => [i.sku, i.quantity, i.price]), [["CHA-MUC", 2, 400_000], ["RUOC-TOM", 1, 350_000]]);

  const early = get("chot-khi-chua-dong-y");
  assert.notEqual(early.final.order?.stage, "CONFIRMED", "máy chủ không chốt khi câu cuối của khách không phải lời đồng ý");
  assert.equal(early.final.confirmed, null);

  const handoff = get("khach-si-chuyen-nguoi");
  assert.equal(handoff.final.status, "HANDOFF");
  assert.equal(handoff.turns[1].rounds.length, 0, "đã chuyển người ⇒ lượt sau KHÔNG gọi model");

  assert.ok(handoff.turns[0].shown.length > 0, "web: chuyển người ⇒ khách nhận câu chuyển người, không im");
  const fb = get("fanpage-chuyen-nguoi-im-lang");
  assert.equal(fb.final.status, "HANDOFF");
  assert.deepEqual(fb.turns[0].shown, [], "fanpage: chuyển người ⇒ bot IM, nhân viên trả lời trực tiếp (chủ shop chốt 01/10/2026)");

  const leak = get("ro-ri-chu-noi-bo");
  assert.ok(!leak.turns[0].shown.some((s) => /customer_confirmation|variant_id/.test(s)), "tên trường nội bộ không tới khách");
  assert.ok(leak.turns[0].shown.length > 0, "chữ bị lọc hết ⇒ khách vẫn nhận câu dự phòng, không im");
  assert.ok(early.turns[1].shown.length > 0, "máy chủ từ chối chốt ⇒ khách vẫn nhận một câu, không im");

  const test = get("khung-thu-khong-ghi");
  assert.equal(test.final.order, null, "khung THỬ không tạo đơn");
  assert.ok(test.final.customer?.simulated, "khung THỬ không tạo khách");

  const fashion = get("thoi-trang-goi-nganh");
  assert.ok(fashion.prompts.length > 0 && fashion.prompts.every((p) => !SEAFOOD.test(p)), "shop thời trang: lời nhắc không có chữ hải sản");
  assert.ok(quote.prompts.some((p) => SEAFOOD.test(p)), "shop thực phẩm: lời nhắc dùng gói thực phẩm");

  for (const x of t.values())
    for (const turn of x.turns) assert.ok(!turn.rounds.some((r) => r.text === "[HẾT KỊCH BẢN]"), `[${x.key}] engine hỏi model nhiều vòng hơn kịch bản ở lượt «${turn.customer}»`);
}

/**
 * Hồi quy bom ngày 10/10/2026: ảnh chụp ghi ĐÚNG ngày trùng một ngày cố định trong chữ tĩnh của lời nhắc («MỤC TIÊU (chủ shop
 * 09/10/2026)») — chữ tĩnh phải giữ nguyên; chỉ ngày ở ngữ cảnh động («gần nhất …») thành nhãn. AGENTS.md mục 50.
 */
function testRunDateNormalizer() {
  const fixed = "09/10/2026";
  const norm = normalizer(new Set(), new Map(), new Set([fixed])) as (x: unknown) => unknown;
  assert.equal(norm(`MỤC TIÊU (chủ shop ${fixed}): chốt đơn`), `MỤC TIÊU (chủ shop ${fixed}): chốt đơn`, "ngày cố định trong lời nhắc KHÔNG bị nhãn hoá dù trùng ngày chạy");
  assert.equal(norm(`Đã mua 1 đơn, gần nhất ${fixed}: Chả mực`), "Đã mua 1 đơn, gần nhất <NGÀY CHẠY>: Chả mực", "ngày động của khối KHÁCH CŨ vẫn thành nhãn");
  assert.deepEqual(norm({ p: [`(chủ shop ${fixed}) · gần nhất ${fixed}`] }), { p: [`(chủ shop ${fixed}) · gần nhất <NGÀY CHẠY>`] });
}

export async function testSalesAgentGolden() {
  testRunDateNormalizer();
  const keys = GOLDEN_CASES.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "khoá hội thoại vàng không trùng");
  const got = await runGoldenCases(GOLDEN_CASES);
  invariants(got);
  const missing: string[] = [];
  for (const c of GOLDEN_CASES) {
    let expected: unknown;
    try {
      expected = JSON.parse(readFileSync(path.join(GOLDEN_SNAPSHOT_DIR, `${c.key}.json`), "utf8"));
    } catch {
      missing.push(c.key);
      continue;
    }
    const d = firstDiff(expected, JSON.parse(JSON.stringify(got.get(c.key))));
    assert.equal(
      d,
      null,
      d
        ? `Hội thoại vàng «${c.key}» (${c.title}) đổi hành vi tại ${d.path}\n  cũ: ${JSON.stringify(d.expected)}\n  mới: ${JSON.stringify(d.actual)}\nNếu thay đổi là CỐ Ý: npx tsx tests/sales-agent-golden/update.ts rồi đưa diff ảnh chụp vào PR.`
        : "",
    );
  }
  assert.deepEqual(missing, [], "thiếu ảnh chụp — chạy npx tsx tests/sales-agent-golden/update.ts rồi đọc kỹ trước khi đưa vào kho");
  console.log(`  ✓ hội thoại vàng: ${GOLDEN_CASES.length} hội thoại phát lại qua chatTurn khớp ảnh chụp (lời nhắc · chuỗi công cụ · kết quả máy chủ · trạng thái cuối); giá từ ERP, chặn chốt khi chưa đồng ý, chuyển người im model, web không im khách / fanpage chuyển người thì im, khung thử không ghi, lọc chữ nội bộ, gói ngành đúng`);
}
