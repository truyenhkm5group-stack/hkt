import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AI_SELFTEST_ROUTE } from "@/lib/constants/ai-selftest";
import { aiSignalFor } from "@/lib/queries/tech-health";

/**
 * ═══════════ BỘ ĐO SỨC KHOẺ AI KHÔNG ĐƯỢC ĐẾM LỖI CỦA CHÍNH NÓ ═══════════
 *
 * ─── ĐO THẬT TRÊN PRODUCTION (20/09/2026) ───
 *
 * `ops ai-check` CỐ Ý gây một timeout giả và một `429 ... quota (simulated)` để chứng minh "lỗi có
 * để lại dấu vết". Cả hai đi qua `runCopilot()` nên cả hai ghi `status = 'ERROR'` vào
 * `ai_interactions` — **đúng bảng mà thẻ sức khoẻ ở `/tech` dùng để kết luận AI khoẻ hay hỏng**.
 *
 * Sổ production hôm ấy: ba cặp lỗi `openai` lúc 08:55 · 10:13 · 13:55 — ba lượt `ai-check`, mỗi
 * lượt đẻ đúng 2 dòng. **Không một lỗi OpenAI THẬT nào trong số đó.** Trong khi ấy production đã
 * chuyển sang `anthropic` (17 lượt OK cùng ngày), nên thẻ vừa đếm lỗi của một nhà cung cấp KHÔNG
 * CÒN DÙNG, vừa đếm lỗi do chính lượt tự kiểm gây ra.
 *
 * Hai lỗi khác nhau, cùng một hậu quả: **bộ đo làm cho thứ nó đo trông ốm.** Một cảnh báo sinh ra
 * từ chính lượt kiểm tra là cảnh báo người ta học cách bỏ qua — và ngày AI hỏng THẬT, nó trông y
 * hệt.
 *
 * Bài này chạy `getTechSystemHealth()` THẬT trên CSDL thật, không mô phỏng bằng lời.
 */

const goc = path.resolve(__dirname, "..");
const TIEN_TO = "ai-sel-";

async function hieu(provider: "openai" | "anthropic") {
  return aiSignalFor(provider);
}

export async function testAiHealthKhongDemLuotTuKiem() {
  const db = await getDb();
  await cleanupAiHealthFixtures();

  /*
    ĐO THEO ĐỘ LỆCH SO VỚI NỀN, KHÔNG ĐO GIÁ TRỊ TUYỆT ĐỐI.

    `ai_interactions` là bảng DÙNG CHUNG của cả bộ kiểm thử — bài Copilot gieo vào đó trước bài
    này. Khẳng định "trạng thái phải đúng bằng UNKNOWN" vì thế chỉ đúng khi bài này chạy một mình,
    và sẽ đỏ ngẫu nhiên theo thứ tự chạy. Tính chất THẬT cần khoá không phải một giá trị tuyệt
    đối, mà là: **gieo thêm lượt tự kiểm KHÔNG được làm đổi kết luận, dù chỉ một bậc.**

    Gọi thẳng `aiSignalFor(provider)` chứ không qua `getTechSystemHealth()`: máy chạy bộ kiểm thử
    không khai khoá AI nào nên đường kia thoát sớm ở `UNKNOWN` và mọi mệnh đề lọc bên dưới không
    bao giờ chạy — bài kiểm sẽ XANH mà chẳng đo gì (AGENTS.md mục 65).
  */
  const [u] = await db.insert(schema.users).values({ email: `${TIEN_TO}a@shop.vn`, name: "ai-sel", passwordHash: "x", role: "ADMIN" }).returning({ id: schema.users.id });
  const chung = { userId: u.id, userEmail: `${TIEN_TO}a@shop.vn`, model: "m", entityType: "", entityId: "" } as const;

  const nenAnthropic = await hieu("anthropic");
  const nenOpenai = await hieu("openai");

  /*
    ───────── 1 · HAI LỖI CỦA CHÍNH BỘ TỰ KIỂM KHÔNG ĐƯỢC TÍNH ─────────
    Gieo đúng hình dạng đã thấy trên production 20/09: một timeout giả + một 429 "(simulated)".
  */
  await db.insert(schema.aiInteractions).values([
    { ...chung, provider: "anthropic", route: AI_SELFTEST_ROUTE, status: "ERROR", error: "Request timed out." },
    { ...chung, provider: "anthropic", route: AI_SELFTEST_ROUTE, status: "ERROR", error: "429 You exceeded your current quota (simulated)" },
  ]);
  const sauTuKiem = await hieu("anthropic");
  assert.equal(sauTuKiem.state, nenAnthropic.state, `lượt tự kiểm KHÔNG được làm đổi kết luận (nền ${nenAnthropic.state} → ${sauTuKiem.state})`);
  assert.equal(sauTuKiem.reason, nenAnthropic.reason, "và cũng không được làm đổi con số in ra");

  /*
    ───────── 2 · LỖI CỦA NHÀ CUNG CẤP KHÔNG CÒN DÙNG KHÔNG ĐƯỢC TÍNH ─────────
    Thẻ in tên nhà cung cấp ĐANG dùng; đếm lỗi của nhà cung cấp đã bỏ là một câu sai về một thứ
    không liên quan. Đo thật 20/09: production đã chuyển sang anthropic nhưng thẻ vẫn đếm openai.
  */
  await db.insert(schema.aiInteractions).values([
    { ...chung, provider: "openai", route: "/shipments", status: "ERROR", error: "loi that cua openai" },
    { ...chung, provider: "openai", route: "/shipments", status: "ERROR", error: "loi that cua openai" },
  ]);
  const vanNhuCu = await hieu("anthropic");
  assert.equal(vanNhuCu.state, nenAnthropic.state, "lỗi THẬT của openai KHÔNG được tính vào sức khoẻ của anthropic");

  /*
    ───────── 3 · …NHƯNG BỘ LỌC KHÔNG ĐƯỢC GIẤU LỖI THẬT ─────────
    Vế này quan trọng ngang vế trên: một bộ lọc lọc quá tay thì cảnh báo im lặng đúng lúc cần kêu.
  */
  const openaiSau = await hieu("openai");
  assert.ok(
    ["DEGRADED", "DOWN"].includes(openaiSau.state),
    `2 lỗi THẬT của openai phải kéo chính openai xuống (nền ${nenOpenai.state} → ${openaiSau.state})`,
  );

  // ───────── 4 · LỖI THẬT CỦA NHÀ CUNG CẤP ĐANG DÙNG VẪN PHẢI KÉO XUỐNG ─────────
  await db.insert(schema.aiInteractions).values([{ ...chung, provider: "anthropic", route: "/shipments", status: "ERROR", error: "loi that" }]);
  const xuong = await hieu("anthropic");
  assert.ok(["DEGRADED", "DOWN"].includes(xuong.state), `một lỗi THẬT phải kéo anthropic xuống, nhận ${xuong.state}`);

  await cleanupAiHealthFixtures();
}

export async function cleanupAiHealthFixtures() {
  const db = await getDb();
  const u = await db.query.users.findMany({ where: like(schema.users.email, `${TIEN_TO}%`), columns: { id: true } });
  if (u.length) {
    await db.delete(schema.aiInteractions).where(inArray(schema.aiInteractions.userId, u.map((x) => x.id)));
    await db.delete(schema.users).where(inArray(schema.users.id, u.map((x) => x.id)));
  }
}

/* ═════════════ QUÉT MÃ NGUỒN — HAI MỆNH ĐỀ LỌC PHẢI CÓ MẶT ═════════════ */

export function testAiHealthSourceGuards() {
  const health = readFileSync(path.join(goc, "lib/queries/tech-health.ts"), "utf8");
  const check = readFileSync(path.join(goc, "scripts/ai-check.ts"), "utf8");
  const hang = readFileSync(path.join(goc, "lib/constants/ai-selftest.ts"), "utf8");

  /*
    ───────── 1 · ĐƯỜNG GHI VÀ ĐƯỜNG ĐỌC DÙNG CHUNG MỘT HẰNG SỐ ─────────
    Gõ lại chuỗi ở hai nơi là mở đường cho chúng lệch nhau, và khi lệch thì bên đo lặng lẽ đếm lại
    đúng thứ vừa loại ra — hỏng im lặng, không màn hình nào báo.
  */
  assert.ok(hang.includes('AI_SELFTEST_ROUTE = "/ops/ai-check"'), "hằng số nhãn phải nằm ở lib/constants/ai-selftest.ts");
  assert.ok(check.includes("AI_SELFTEST_CONTEXT"), "ai-check phải gắn nhãn cho lượt gọi của nó");
  assert.ok(health.includes("AI_SELFTEST_ROUTE"), "phép đo phải loại lượt tự kiểm bằng CHÍNH hằng số đó");
  assert.ok(!check.includes('route: "/ops/ai-check"'), "ai-check KHÔNG được gõ lại chuỗi — dùng hằng số");

  /*
    ───────── 2 · BA LƯỢT GỌI GÂY LỖI ĐỀU PHẢI MANG NHÃN ─────────
    Thiếu một lượt là thiếu một dòng lỗi lọt vào phép đo, và nó chỉ lộ ra vào ngày ai đó nhìn thẻ
    sức khoẻ rồi đi tìm một sự cố không tồn tại.
  */
  assert.equal(
    check.split("context: AI_SELFTEST_CONTEXT").length - 1,
    3,
    "cả ba lượt gọi cố ý gây lỗi trong ai-check (timeout · 429 · model sai) đều phải mang nhãn",
  );
  assert.ok(!check.includes('context: { route: "/", entityType: "", entityId: "" }'), "không còn lượt gọi nào của ai-check đi với bối cảnh trống");

  /*
    ───────── 3 · CHỈ ĐẾM NHÀ CUNG CẤP ĐANG DÙNG ─────────
    Thẻ in `detail: provider` nhưng từng đếm lỗi của MỌI nhà cung cấp từng ghi vào bảng. Sau khi
    chuyển sang anthropic, lượt openai hỏng từ trước vẫn bị tính vào "sức khoẻ của anthropic" —
    một câu sai về một thứ không liên quan.
  */
  assert.ok(
    health.includes("eq(schema.aiInteractions.provider, provider)"),
    "phép đo phải lọc theo nhà cung cấp ĐANG DÙNG, không đếm lỗi của nhà cung cấp đã bỏ",
  );

  /*
    ───────── 4 · KHÔNG BACKFILL DÒNG CŨ ─────────
    Dòng ghi trước bản này không có nhãn và KHÔNG được gán ngược (mục 8.8 · 35). Cửa sổ 24 giờ tự
    cuốn chúng ra. Một lệnh `update` ở đây là bịa lại lịch sử để một ô màu đẹp lên.
  */
  assert.ok(!/update\(schema\.aiInteractions\)/.test(health), "phép ĐO không được GHI gì vào bảng nó đang đo");
  assert.ok(!/update\(schema\.aiInteractions\)/.test(check), "ai-check không được sửa lại dòng cũ để làm sạch số liệu");

  console.log("✓ Sức khoẻ AI: lượt tự kiểm mang nhãn và bị loại khỏi phép đo · chỉ đếm nhà cung cấp đang dùng · một hằng số cho cả đường ghi lẫn đường đọc · KHÔNG backfill dòng cũ");
}
