import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AI_INCIDENT_RULE, aiIncidentTitle, classifyAiError, shouldOpenAiIncident } from "@/lib/constants/ai-incidents";
import { AI_SELFTEST_ROUTE } from "@/lib/constants/ai-selftest";
import { watchAiProviderHealth } from "@/lib/tech/ai-incident-watch";

/**
 * ═══════════ KHOÁ AI HỎNG KIỂU KHÔNG TỰ KHỎI → SỰ CỐ ═══════════
 *
 * ─── ĐÃ XẢY RA THẬT, VÀ KHÔNG GÌ BÁO (20/09/2026) ───
 *
 * 21:48 VN, lượt chạy agent thứ 10 dừng: *"Your credit balance is too low to access the Anthropic
 * API."* Lượt gọi Copilot thành công cuối cùng đo được là 21:19 — credit cạn đâu đó giữa hai mốc,
 * nhiều khả năng do chính bốn lượt chạy agent trước đó tiêu hết.
 *
 * Không màn hình nào báo: `tech-incident-watch` chỉ nhìn `sync_runs`, còn thẻ sức khoẻ AI chỉ
 * biết sau khi đã có người dùng đâm vào tường.
 *
 * Bài này chạy bộ canh THẬT trên CSDL thật và gieo đúng hình dạng ấy.
 */

const goc = path.resolve(__dirname, "..");
const TIEN_TO = "ai-inc-";

/* ═════════════ 1 · XẾP LỚP — BA LỚP, BA VIỆC PHẢI LÀM KHÁC NHAU ═════════════ */

export function testAiIncidentPure() {
  /*
    "credit balance" PHẢI RA `CREDIT`, KHÔNG PHẢI `RATE_LIMIT`.

    Đây là ca quan trọng nhất của cả bài: `scripts/agent-runner-check.ts` gộp cả hai vào
    `QUOTA_OR_RATE_LIMIT`, và với mục đích của nó thì đúng. Nhưng với một sự cố thì hết credit
    KHÔNG BAO GIỜ tự khỏi còn quá hạn mức thì tự khỏi sau vài phút — gộp lại là hoặc bỏ sót cái
    thứ nhất, hoặc kêu nhầm ở cái thứ hai.
  */
  assert.equal(classifyAiError('400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), "CREDIT");
  assert.equal(classifyAiError("429 You exceeded your current quota"), "CREDIT", "hết quota của OpenAI cũng là cần-người, không phải chờ");
  assert.equal(classifyAiError("429 rate_limit_error: too many requests"), "RATE_LIMIT", "hạn mức thường thì TỰ KHỎI");
  assert.equal(classifyAiError("529 overloaded_error"), "RATE_LIMIT");
  assert.equal(classifyAiError("401 invalid_api_key"), "AUTH");
  assert.equal(classifyAiError("Request timed out."), "OTHER");
  assert.equal(classifyAiError(null), "OTHER", "không có câu lỗi ⇒ CHƯA BIẾT, không đoán");
  assert.equal(classifyAiError("   "), "OTHER");

  const credit = { status: "ERROR", error: "credit balance is too low" };
  const ok = { status: "OK", error: null };

  // ───────── Dưới ngưỡng thì KHÔNG mở ─────────
  assert.ok(!shouldOpenAiIncident([]).open, "không có lượt nào ⇒ không kết luận");
  assert.ok(!shouldOpenAiIncident([credit]).open, "một lượt chưa đủ");
  const du = shouldOpenAiIncident([credit, credit]);
  assert.ok(du.open && du.lop === "CREDIT" && du.soLuot === 2, "hai lượt liên tiếp là đủ ngưỡng");
  assert.equal(AI_INCIDENT_RULE.consecutiveErrors, 2, "ngưỡng 2 là CÓ Ý — thấp hơn job đồng bộ vì lỗi này tự mô tả và không tự khỏi");

  /*
    MỘT LƯỢT THÀNH CÔNG CẮT CHUỖI — AI vừa trả lời được thì nó chưa chết. Danh sách vào theo thứ
    tự MỚI-TRƯỚC, nên lượt `OK` đứng đầu nghĩa là lần gần nhất đã ổn.
  */
  assert.ok(!shouldOpenAiIncident([ok, credit, credit]).open, "lượt gần nhất OK ⇒ không mở");

  /*
    HẠN MỨC KHÔNG TÍNH, và nó cũng CẮT chuỗi: có lúc AI chỉ bận thì ta chưa đủ căn cứ nói "cần
    người". Mở sự cố ở đây là kêu về một thứ sẽ tự hết trước khi người trực mở máy.
  */
  assert.ok(!shouldOpenAiIncident([{ status: "ERROR", error: "429 rate limit" }, credit, credit]).open, "hạn mức ở đầu chuỗi ⇒ chưa kết luận");
  /*
    VÀ VẾ QUAN TRỌNG HƠN: MỘT CHUỖI HẠN MỨC DÀI BAO NHIÊU CŨNG KHÔNG MỞ SỰ CỐ.

    Ca trên một mình KHÔNG đủ — nó vẫn xanh nếu ai đó thêm `RATE_LIMIT` vào danh sách cần-người,
    vì chuỗi khi ấy đứt ở chỗ đổi lớp. Đã đo bằng kiểm đột biến: thêm `RATE_LIMIT` vào danh sách
    thì cả bài vẫn xanh. Ca dưới đây mới ghim được điều đó.
  */
  const hanMuc = { status: "ERROR", error: "429 rate_limit_error: too many requests" };
  assert.ok(!shouldOpenAiIncident([hanMuc, hanMuc, hanMuc, hanMuc]).open, "bốn lượt hạn mức LIÊN TIẾP vẫn KHÔNG mở sự cố — nó tự khỏi, mở là đổ nhiễu vào sổ");

  /*
    LƯỢT THÀNH CÔNG CẮT CHUỖI VÌ NÓ `OK`, KHÔNG PHẢI VÌ NÓ THIẾU CÂU LỖI.

    Cũng đo bằng đột biến: bỏ hẳn phép kiểm `status !== "ERROR"` mà bài vẫn xanh, vì dòng `OK`
    thường có `error = null` nên phép kiểm LỚP đã chặn hộ. Một dòng `OK` còn sót câu lỗi cũ (lượt
    thử lại thành công sau khi đã ghi) sẽ lọt. Ca này ghim đúng phép kiểm ấy.
  */
  assert.ok(
    !shouldOpenAiIncident([{ status: "OK", error: "credit balance is too low" }, credit, credit]).open,
    "lượt OK phải cắt chuỗi vì nó OK — kể cả khi còn sót câu lỗi cũ",
  );

  /* Chuỗi trộn hai lớp cần-người cũng không tính: hai nguyên nhân khác nhau thì chưa có chuỗi nào thuần. */
  assert.ok(!shouldOpenAiIncident([credit, { status: "ERROR", error: "401 invalid_api_key" }]).open, "đổi lớp giữa chừng ⇒ dừng đếm");

  /* Tiêu đề là KHOÁ — không được mang số lượt hay mốc thời gian, chúng đổi mỗi lượt canh. */
  const t = aiIncidentTitle("anthropic", "CREDIT");
  assert.equal(t, aiIncidentTitle("anthropic", "CREDIT"), "cùng đầu vào ⇒ cùng khoá");
  assert.ok(!/\d{4}|\d+ lượt/.test(t), `tiêu đề KHÔNG được chứa số thay đổi theo lượt: ${t}`);
  assert.notEqual(t, aiIncidentTitle("anthropic", "AUTH"), "hai lớp lỗi là hai sự cố khác nhau");
  assert.notEqual(t, aiIncidentTitle("openai", "CREDIT"), "hai nhà cung cấp là hai sự cố khác nhau");
}

/* ═════════════ 2 · BỘ CANH CHẠY THẬT TRÊN CSDL ═════════════ */

export async function testAiIncidentWatchDb() {
  const db = await getDb();
  await cleanupAiIncidentFixtures();
  const giu = process.env.AI_PROVIDER;
  const giuKhoa = process.env.ANTHROPIC_API_KEY;
  try {
    /*
      Ép nhà cung cấp về `anthropic` để `resolveProviderName()` có câu trả lời xác định. Đây là
      ĐẦU VÀO của thứ đang đo (bộ canh hỏi "nhà cung cấp nào đang dùng"), không phải điều kiện
      của kết luận — AGENTS.md mục 65.
    */
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "khoa-gia-cho-bai-kiem";

    const [u] = await db.insert(schema.users).values({ email: `${TIEN_TO}a@shop.vn`, name: "ai-inc", passwordHash: "x", role: "ADMIN" }).returning({ id: schema.users.id });
    const chung = { userId: u.id, userEmail: `${TIEN_TO}a@shop.vn`, model: "m", entityType: "", entityId: "" } as const;

    // ───────── Chưa có lỗi nào ⇒ không mở ─────────
    const yen = await watchAiProviderHealth({ lookbackHours: 24 });
    assert.equal(yen.opened, 0, `chưa có lỗi thì không mở sự cố: ${yen.reason}`);

    /*
      ───────── LƯỢT TỰ KIỂM KHÔNG ĐƯỢC TÍNH ─────────
      `ops ai-check` CỐ Ý gây hai lỗi. Đếm chúng là mở sự cố cho chính lượt kiểm tra, và người
      trực sẽ học cách bỏ qua bộ canh.
    */
    await db.insert(schema.aiInteractions).values([
      { ...chung, provider: "anthropic", route: AI_SELFTEST_ROUTE, status: "ERROR", error: "credit balance is too low" },
      { ...chung, provider: "anthropic", route: AI_SELFTEST_ROUTE, status: "ERROR", error: "credit balance is too low" },
    ]);
    const tuKiem = await watchAiProviderHealth({ lookbackHours: 24 });
    assert.equal(tuKiem.opened, 0, "hai lỗi GIẢ của bộ tự kiểm KHÔNG được mở sự cố");

    /* ───────── Lỗi THẬT, đủ ngưỡng ⇒ MỞ ───────── */
    await db.insert(schema.aiInteractions).values([
      { ...chung, provider: "anthropic", route: "/shipments", status: "ERROR", error: '400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' },
      { ...chung, provider: "anthropic", route: "/shipments", status: "ERROR", error: '400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' },
    ]);
    const mo = await watchAiProviderHealth({ lookbackHours: 24 });
    assert.equal(mo.opened, 1, `phải mở đúng một sự cố: ${mo.reason}`);

    const sc = await db.query.techIncidents.findFirst({ where: like(schema.techIncidents.title, "Nhà cung cấp AI%") });
    assert.ok(sc, "sự cố phải có thật trong sổ");
    assert.equal(sc.severity, AI_INCIDENT_RULE.severity, "sự cố mở tự động là SEV2 — máy không đo được hậu quả kinh doanh");
    assert.equal(sc.source, "MONITOR");
    /*
      BẰNG CHỨNG PHẢI NÓI ĐƯỢC VIỆC PHẢI LÀM, không chỉ nói "AI hỏng". Người trực đọc lúc 2 giờ
      sáng cần biết: nạp tiền, và ERP vẫn bán hàng bình thường.
    */
    assert.match(sc.evidence ?? "", /nạp tiền/i, "bằng chứng phải nói việc phải làm");
    assert.match(sc.evidence ?? "", /vẫn bán hàng/i, "và phải nói rõ đây KHÔNG phải sự cố kinh doanh");
    assert.match(sc.evidence ?? "", /KHÔNG tự khỏi/i);

    /* ───────── CHẠY LẠI KHÔNG NHÂN ĐÔI ───────── */
    const lai = await watchAiProviderHealth({ lookbackHours: 24 });
    assert.equal(lai.opened, 0, "chạy lại KHÔNG được mở sự cố thứ hai");
    assert.equal(lai.alreadyOpen, 1, "…và phải nói rõ là đã có, không phải lỗi");
    const dem = await db.query.techIncidents.findMany({ where: like(schema.techIncidents.title, "Nhà cung cấp AI%") });
    assert.equal(dem.length, 1, "đúng một dòng trong sổ");
  } finally {
    if (giu === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = giu;
    if (giuKhoa === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = giuKhoa;
    await cleanupAiIncidentFixtures();
  }
}

export async function cleanupAiIncidentFixtures() {
  const db = await getDb();
  const sc = await db.query.techIncidents.findMany({ where: like(schema.techIncidents.title, "Nhà cung cấp AI%"), columns: { id: true } });
  if (sc.length) await db.delete(schema.techIncidents).where(inArray(schema.techIncidents.id, sc.map((x) => x.id)));
  const u = await db.query.users.findMany({ where: like(schema.users.email, `${TIEN_TO}%`), columns: { id: true } });
  if (u.length) {
    await db.delete(schema.aiInteractions).where(inArray(schema.aiInteractions.userId, u.map((x) => x.id)));
    await db.delete(schema.users).where(inArray(schema.users.id, u.map((x) => x.id)));
  }
}

/* ═════════════ 3 · QUÉT MÃ NGUỒN ═════════════ */

export function testAiIncidentSourceGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const w = bo(readFileSync(path.join(goc, "lib/tech/ai-incident-watch.ts"), "utf8"));

  /*
    CHỈ MỞ, KHÔNG BAO GIỜ ĐÓNG — cùng luật với sổ sự cố đồng bộ.

    Một lượt gọi thành công KHÔNG chứng minh credit đã được nạp. Và ràng buộc của kho đòi một câu
    ĐÃ LÀM GÌ trước khi đóng; máy không có câu đó nên tự đóng là bịa.
  */
  assert.ok(!w.includes("setTechIncidentStatus"), "bộ canh KHÔNG được đóng sự cố");
  assert.ok(!/status:\s*"RESOLVED"/.test(w), "…và không được ghi RESOLVED bằng bất kỳ đường nào");
  assert.ok(w.includes("createTechIncident"), "nó chỉ được MỞ");

  /* Lượt tự kiểm phải bị loại bằng CHÍNH hằng số dùng chung, không gõ lại chuỗi. */
  assert.ok(w.includes("AI_SELFTEST_ROUTE"), "phải loại lượt tự kiểm bằng hằng số dùng chung");
  assert.ok(!w.includes('"/ops/ai-check"'), "không gõ lại chuỗi — hai nơi gõ tay là hai nơi để chúng lệch nhau");

  /* Job phải có lịch: một bộ canh không ai gọi thì bằng không có. */
  const sch = readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  assert.ok(sch.includes('job: "ai-incident-watch"'), "bộ canh phải nằm trong bộ lập lịch");

  console.log("✓ Canh khoá AI: hết credit tách khỏi quá hạn mức (hai việc ngược nhau) · lượt tự kiểm không tính · ngưỡng 2 liên tiếp · chỉ MỞ không đóng · chạy lại không nhân đôi · bằng chứng nói được việc phải làm");
}
