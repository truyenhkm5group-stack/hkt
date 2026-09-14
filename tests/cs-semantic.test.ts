import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { FakeProvider, type AiProvider } from "@/lib/ai/provider";
import {
  ACTIONABLE_SPEAKER_INTENTS,
  ACTIONABLE_TEMPORAL_SCOPES,
  CASE_ELIGIBILITY,
  NO_FACTS,
  checkEligibility,
  type CaseFacts,
} from "@/lib/constants/case-semantics";
import type { CsKind } from "@/lib/constants/cs";
import {
  buildPrompt,
  buildTranscript,
  chatDedupeKey,
  classifyConversation,
  decideCase,
  decideWithoutModel,
  episodeKey,
  parseVerdict,
  toRecord,
  type CaseCandidate,
  type ConversationMessage,
  type SemanticVerdict,
} from "@/lib/cs/semantic-case";
import { applyStaleReconciliation, assessOpenCases, staleReport } from "@/lib/cs/stale";

/**
 * ═══════════ MÁY SINH CASE PHẢI HIỂU CÂU, KHÔNG PHẢI ĐẾM CHỮ ═══════════
 *
 * ─── CA GỐC, NGUYÊN VĂN TỪ PRODUCTION ───
 *
 * Case "Trả hàng / hoàn · Yến Ruby". Bằng chứng máy cũ lưu lại:
 *
 *   "Dừng rồi bây giờ chị em mình chốt 3 cái… nếu chị không ưng chị không nhận…
 *    đúng vậy em chuyển hàng cho chị càng nhanh càng tốt…"
 *
 * Khách đang CHỐT ĐƠN và đang GIỤC GỬI HÀNG. "Không nhận" là một GIẢ ĐỊNH ("nếu chị không ưng").
 * Máy cũ tìm thấy chữ, tạo một việc "Trả hàng / hoàn", và CSKH mở ra thấy một việc không tồn tại —
 * còn việc THẬT (gửi hàng nhanh) thì không ai thấy.
 *
 * ─── BÀI KIỂM NÀY KHOÁ BỐN THỨ ───
 *
 *  1. **Bốn cửa, đúng thứ tự.** Phạm vi thời gian → ý định người nói → CHỨNG TỪ NGHIỆP VỤ → tin
 *     cậy. Cửa chứng từ đứng TRƯỚC cửa tin cậy: "POS đã xác nhận" là một sự thật, không phải một
 *     mức tin cậy, nên nó BÁC chứ không hạ bậc.
 *  2. **Bộ đánh giá có nhãn** dựng từ các dạng ca thật, đo bằng độ chính xác / độ phủ / tỷ lệ báo
 *     nhầm / tỷ lệ để người xem. Ưu tiên ĐỘ CHÍNH XÁC: một việc giả tốn một cuộc gọi và làm hỏng
 *     niềm tin vào cả hàng đợi, một việc bỏ sót còn có máy đối chiếu và người trực bắt lại.
 *  3. **Mất AI thì lùi về phía HẸP HƠN**, không lùi về luật từ khoá — đó đúng là thứ vừa bị bỏ.
 *  4. **Một đoạn sự việc, một việc.** Khách nhắc lại không đẻ ra việc thứ hai.
 */

/** Dựng một lượt trả lời của model — đúng hình dạng công cụ mà `classifyConversation` đọc. */
function fakeVerdict(v: Partial<SemanticVerdict> & { caseKind: CsKind | "NONE" }): AiProvider {
  const day: SemanticVerdict = {
    caseKind: v.caseKind,
    actionable: v.actionable ?? true,
    confidence: v.confidence ?? "HIGH",
    temporalScope: v.temporalScope ?? "CURRENT_REQUEST",
    speakerIntent: v.speakerIntent ?? "CUSTOMER_REQUEST",
    supportingEvidence: v.supportingEvidence ?? ["(trích)"],
    contradictoryEvidence: v.contradictoryEvidence ?? [],
    reason: v.reason ?? "kịch bản kiểm thử",
  };
  return new FakeProvider([
    () => ({ content: [{ type: "tool_use", id: "t1", name: "ket_luan_case", input: day }], stopReason: "tool_use" }),
  ]);
}

const facts = (over: Partial<CaseFacts> = {}): CaseFacts => ({ ...NO_FACTS, ...over });
const CO_DON = facts({ orderMatch: "BY_CONVERSATION", orderMaterialized: true, orderStage: "CONFIRMED", orderSystemId: 9001, orderInsertedAt: new Date() });
const DA_GIAO = facts({ orderMatch: "BY_CONVERSATION", orderMaterialized: true, orderStage: "DELIVERED", orderFinal: true, hasShipment: true });

export async function testCsSemantic(db: Db) {
  /* ═══════════ 1 · BỐI CẢNH: CẢ ĐOẠN, CÓ PHÂN VAI, ĐÚNG TRÌNH TỰ ═══════════ */

  const t = (m: number) => new Date(Date.UTC(2026, 8, 14, 3, m));
  const yenRuby: ConversationMessage[] = [
    { text: "Chị ơi bộ này bên em còn đủ size ạ", fromPage: true, insertedAt: t(5) },
    { text: "Dừng rồi bây giờ chị em mình chốt 3 cái", fromPage: false, insertedAt: t(9) },
    { text: "Nếu chị không ưng chị không nhận nhé", fromPage: false, insertedAt: t(10) },
    { text: "Dạ vâng ạ, bên em cho kiểm hàng trước khi nhận", fromPage: true, insertedAt: t(11) },
    { text: "Đúng vậy em chuyển hàng cho chị càng nhanh càng tốt", fromPage: false, insertedAt: t(12) },
  ];
  const ban = buildTranscript(yenRuby);
  assert.ok(ban.text.includes("[14/09 10:09 KHÁCH] Dừng rồi"), "bản ghi phải nói rõ AI nói và NÓI LÚC NÀO — không biết ai nói thì lời shop bị đọc thành yêu cầu của khách");
  assert.ok(ban.text.includes("[14/09 10:05 SHOP] Chị ơi"), "lời SHOP phải mang nhãn SHOP — đây là ranh giới đã đẻ ra 181 case “đã chốt · chưa tạo đơn” khi bị bỏ qua");
  assert.ok(ban.text.indexOf("chốt 3 cái") < ban.text.indexOf("không nhận"), "phải đúng trình tự thời gian: câu điều kiện đứng trước mới đọc ra được nó là giả định");
  assert.ok(ban.text.indexOf("không nhận") < ban.text.indexOf("càng nhanh càng tốt"), "và câu sau (giục gửi hàng) là thứ lật ngược nghĩa của câu trước");
  assert.equal(ban.truncated, false);
  // Bản ghi bị cắt phải NÓI RA, không im lặng trông như đã đầy đủ.
  const dai = Array.from({ length: 400 }, (_, i) => ({ text: `câu số ${i} ${"x".repeat(200)}`, fromPage: i % 2 === 0, insertedAt: t(i % 59) }));
  const banDai = buildTranscript(dai);
  assert.equal(banDai.truncated, true, "vượt trần thì phải đánh dấu đã cắt");
  assert.ok(banDai.text.startsWith("(… phần đầu hội thoại đã lược bớt …)"), "cắt phần CŨ, giữ phần MỚI — ý định hiện tại nằm ở cuối hội thoại");
  assert.ok(banDai.text.length <= 12_000 + 120, "bản ghi phải nằm trong trần đã khai");

  const ungVienRuby: CaseCandidate[] = [{ kind: "RETURN", evidence: "nếu chị không ưng chị không nhận", from: "KEYWORD", signal: "khong nhan" }];
  const nhacRuby = buildPrompt({ customerName: "Yến Ruby", tags: [], candidates: ungVienRuby, facts: CO_DON, messages: yenRuby });
  assert.ok(nhacRuby.includes("CHỨNG TỪ NGHIỆP VỤ"), "khối chứng từ phải nằm trong lời nhắc — model không được kết luận trái với nó");
  assert.ok(nhacRuby.includes("Đơn đã tồn tại thật trên POS (Đã xác nhận trở đi): CÓ"));
  assert.ok(nhacRuby.includes("chỉ là ứng viên, có thể sai hoàn toàn"), "dấu hiệu từ khoá phải được giới thiệu ĐÚNG thân phận của nó");

  /* ═══════════ 2 · CA GỐC: GIẢ ĐỊNH KHÔNG PHẢI YÊU CẦU ═══════════ */

  const rubyVerdict = await classifyConversation(
    { customerName: "Yến Ruby", tags: [], candidates: ungVienRuby, facts: CO_DON, messages: yenRuby },
    fakeVerdict({ caseKind: "RETURN", temporalScope: "HYPOTHETICAL", speakerIntent: "CUSTOMER_ACCEPTANCE", reason: "Khách đang chốt 3 sản phẩm và giục gửi hàng; “không nhận” là giả định nếu không ưng.", supportingEvidence: ["em chuyển hàng cho chị càng nhanh càng tốt"], contradictoryEvidence: ["nếu chị không ưng chị không nhận"] }),
  );
  assert.ok(rubyVerdict, "model phải trả về kết luận đọc được");
  const rubyDecision = decideCase(rubyVerdict, CO_DON);
  assert.equal(rubyDecision.action, "SKIP", "CA GỐC: hội thoại Yến Ruby KHÔNG được sinh case trả hàng");
  assert.equal(rubyDecision.blockedBy, "TEMPORAL_SCOPE", "và phải nói rõ bị chặn ở cửa nào — “giả định”, không phải “chưa đủ chắc”");

  /* ═══════════ 3 · BỐN CỬA, TỪNG CỬA MỘT ═══════════ */

  /*
    Nền chung: một yêu cầu ĐANG CÒN HIỆU LỰC của KHÁCH, chắc chắn. Mỗi phép kiểm dưới đây chỉ đổi
    ĐÚNG một biến — nếu lấy `rubyVerdict` (vốn mang phạm vi "giả định") làm nền thì mọi ca đều bị
    chặn ở cửa 1 và ba cửa còn lại không bao giờ được chạy tới.
  */
  const HIEN_TAI: SemanticVerdict = { caseKind: "RETURN", actionable: true, confidence: "HIGH", temporalScope: "CURRENT_REQUEST", speakerIntent: "CUSTOMER_REQUEST", supportingEvidence: [], contradictoryEvidence: [], reason: "nền kiểm thử" };

  // Cửa 1 — phạm vi thời gian. Chỉ yêu cầu ĐANG CÒN HIỆU LỰC mới thành việc.
  for (const scope of ["HYPOTHETICAL", "CONDITIONAL", "PAST_EVENT", "NEGATION", "RESOLVED"] as const) {
    const d = decideCase({ ...HIEN_TAI, temporalScope: scope }, DA_GIAO);
    assert.equal(d.action, "SKIP", `phạm vi ${scope} không phải một việc phải làm`);
  }
  assert.deepEqual([...ACTIONABLE_TEMPORAL_SCOPES], ["CURRENT_REQUEST"], "chỉ MỘT phạm vi sinh ra việc — thêm phạm vi vào đây là một quyết định nghiệp vụ, không phải một dòng tiện tay");

  // Cửa 2 — ai nói. Kịch bản bán hàng của shop là nguồn dương tính giả lớn nhất.
  const shopNoi = decideCase({ ...HIEN_TAI, caseKind: "EXCHANGE_SIZE", speakerIntent: "SHOP_SUGGESTION" }, CO_DON);
  assert.equal(shopNoi.action, "SKIP", "“bên em đổi size trong 7 ngày” là lời SHOP, không phải yêu cầu của khách");
  assert.equal(shopNoi.blockedBy, "SPEAKER_INTENT");
  assert.ok(!ACTIONABLE_SPEAKER_INTENTS.includes("INFORMATION_ONLY"), "thông tin thuần tuý không sinh việc");

  // Cửa 3 — CHỨNG TỪ THẮNG MODEL. Đây là điều chủ shop chốt 14/09/2026.
  const modelSaiChuaTaoDon = decideCase({ ...HIEN_TAI, caseKind: "ORDER_NOT_CREATED" }, CO_DON);
  assert.equal(modelSaiChuaTaoDon.action, "SKIP", "model nói “chưa tạo đơn” mà POS đã “Đã xác nhận” ⇒ BÁC");
  assert.equal(modelSaiChuaTaoDon.blockedBy, "DETERMINISTIC_FACT", "bác bằng CHỨNG TỪ, không phải hạ bậc tin cậy — hai thứ khác hẳn nhau");
  assert.ok(modelSaiChuaTaoDon.reason.includes("POS đã có đơn"), "lý do phải đọc được, vì nó đi thẳng vào báo cáo");

  const coVanDon = decideCase({ ...HIEN_TAI, caseKind: "ORDER_NOT_CREATED" }, facts({ hasShipment: true }));
  assert.equal(coVanDon.blockedBy, "DETERMINISTIC_FACT", "đã có vận đơn thì không thể chưa tạo đơn");

  const traHangChuaMua = decideCase({ ...HIEN_TAI }, NO_FACTS);
  assert.equal(traHangChuaMua.action, "SKIP", "chưa có đơn thì “trả hàng” là câu hỏi chính sách");
  const giucDonDaXong = decideCase({ ...HIEN_TAI, caseKind: "URGE_DELIVERY" }, DA_GIAO);
  assert.equal(giucDonDaXong.action, "SKIP", "đơn đã giao xong thì câu giục là chuyện đã qua — đây là loại case cũ nhiều nhất trước bản này");

  // Việc thuộc bàn KHÁC thì KHÔNG sinh dòng CSKH — một gốc, một việc.
  const kienDangChay = decideCase({ ...HIEN_TAI, caseKind: "WRONG_ADDRESS" }, facts({ orderMaterialized: true, hasShipment: true, hasActiveShipment: true }));
  assert.equal(kienDangChay.action, "SKIP");
  assert.equal(kienDangChay.route, "SHIPMENT_CARE", "phải nói rõ việc đi đâu, không im lặng đánh rơi");

  // Cửa 4 — tin cậy. Cửa này đứng SAU cửa chứng từ, không hoán vị được.
  assert.equal(decideCase({ ...HIEN_TAI }, DA_GIAO).action, "CREATE");
  const giua = decideCase({ ...HIEN_TAI, confidence: "MEDIUM" }, DA_GIAO);
  assert.equal(giua.action, "REVIEW", "chưa chắc thì để người xem, KHÔNG ép thành việc");
  assert.equal(decideCase({ ...HIEN_TAI, confidence: "LOW" }, DA_GIAO).action, "SKIP");
  assert.equal(decideCase({ ...HIEN_TAI, actionable: false }, DA_GIAO).action, "SKIP", "model tự nói không có việc thì không có việc");

  /* ═══════════ 4 · MODEL TRẢ THỨ KHÔNG ĐÚNG BẢN KHAI ⇒ KHÔNG CÓ KẾT LUẬN ═══════════ */

  assert.equal(parseVerdict({ caseKind: "LAM_GIAM_GIA", confidence: "HIGH", temporalScope: "CURRENT_REQUEST", speakerIntent: "CUSTOMER_REQUEST", actionable: true, reason: "x" }), null, "loại không có trong sổ ⇒ từ chối, không vá bằng OTHER");
  assert.equal(parseVerdict({ caseKind: "RETURN", confidence: "RAT_CAO", temporalScope: "CURRENT_REQUEST", speakerIntent: "CUSTOMER_REQUEST", actionable: true, reason: "x" }), null, "mức tin cậy lạ ⇒ từ chối");
  assert.equal(parseVerdict({ caseKind: "RETURN", confidence: "HIGH", temporalScope: "CURRENT_REQUEST", speakerIntent: "CUSTOMER_REQUEST", actionable: true, reason: "   " }), null, "thiếu lý do ⇒ từ chối: một case không giải thích được là một case không kiểm chứng được");
  assert.equal(decideCase(null, CO_DON).action, "SKIP", "không có kết luận ⇒ KHÔNG tạo việc");
  assert.equal(decideCase(null, CO_DON).blockedBy, "NO_MODEL");

  /* ═══════════ 5 · MẤT AI: LÙI VỀ PHÍA HẸP HƠN, KHÔNG LÙI VỀ TỪ KHOÁ ═══════════ */

  const khiTat = decideWithoutModel(
    [
      { kind: "RETURN", evidence: "không nhận", from: "KEYWORD", signal: "khong nhan" },
      { kind: "EXCHANGE_SIZE", evidence: "Thẻ hội thoại: đổi size", from: "TAG", signal: "doi size" },
      { kind: "ORDER_NOT_CREATED", evidence: "SĐT 0912000111 · địa chỉ: “thôn 3, xã An Bình”", from: "DETERMINISTIC" },
    ],
    NO_FACTS,
  );
  assert.deepEqual(khiTat.map((d) => d.action), ["SKIP", "SKIP", "CREATE"], "từ khoá và thẻ KHÔNG tạo việc khi mất tầng ngữ nghĩa; đường XÁC ĐỊNH vẫn chạy");
  assert.equal(khiTat[0].blockedBy, "NO_MODEL");
  // Và đường xác định vẫn phải qua cửa chứng từ.
  assert.equal(decideWithoutModel([{ kind: "ORDER_NOT_CREATED", evidence: "x", from: "DETERMINISTIC" }], CO_DON)[0].action, "SKIP", "POS đã xác nhận thì kể cả đường xác định cũng không tạo việc");

  /* ═══════════ 6 · MỘT ĐOẠN SỰ VIỆC, MỘT VIỆC ═══════════ */

  const duThongTinLuc = new Date("2026-09-12T04:00:00Z");
  const k1 = chatDedupeKey("conv-1", "ORDER_NOT_CREATED", duThongTinLuc, new Date("2026-09-14T09:00:00Z"));
  const k2 = chatDedupeKey("conv-1", "ORDER_NOT_CREATED", duThongTinLuc, new Date("2026-09-16T02:00:00Z"));
  assert.equal(k1, k2, "job quét chạy ngày khác nhau nhưng CÙNG một lần khách đưa thông tin ⇒ CÙNG một việc");
  assert.notEqual(k1, chatDedupeKey("conv-1", "ORDER_NOT_CREATED", new Date("2026-09-16T04:00:00Z")), "khách đưa thông tin lần MỚI ⇒ đoạn mới ⇒ việc mới");
  assert.equal(episodeKey("RETURN", null, new Date("2026-09-14T09:00:00Z")), "2026-09", "loại khác gom theo tháng: khách nhắc lại trong tháng không đẻ ra việc thứ hai");

  // Và CSDL giữ lời hứa đó: khoá trùng thì dòng thứ hai không vào được.
  await db.insert(schema.csCases).values({ id: "sem-c1", kind: "RETURN", status: "OPEN", title: "Trả hàng · Khách A", dedupeKey: k1 });
  const lanHai = await db.insert(schema.csCases).values({ id: "sem-c2", kind: "RETURN", status: "OPEN", title: "Trả hàng · Khách A (lặp)", dedupeKey: k1 }).onConflictDoNothing({ target: schema.csCases.dedupeKey }).returning({ id: schema.csCases.id });
  assert.equal(lanHai.length, 0, "khách nhắc lại cùng một việc KHÔNG được sinh dòng thứ hai");

  /* ═══════════ 7 · BẢN GHI LƯU LẠI: KIỂM CHỨNG ĐƯỢC, KHÔNG PHẢI DÒNG SUY NGHĨ ═══════════ */

  const ghi = toRecord(rubyDecision);
  assert.equal(ghi.engine, "SEMANTIC");
  assert.equal(ghi.temporalScope, "HYPOTHETICAL", "lưu lại ĐÚNG cửa đã chặn, để sáu tháng sau còn trả lời được “vì sao case này không được tạo”");
  assert.deepEqual(ghi.contradictoryEvidence, ["nếu chị không ưng chị không nhận"], "bằng chứng NGHỊCH phải được giữ — nó là thứ lật ngược kết luận");
  const khoa = Object.keys(ghi).sort();
  for (const cam of ["thinking", "chainOfThought", "rawResponse", "prompt", "transcript"]) {
    assert.ok(!khoa.includes(cam), `bản ghi KHÔNG được chứa "${cam}" — dòng suy nghĩ riêng không kiểm chứng được và là chỗ dữ liệu khách rò ra nhiều nhất`);
  }

  /* ═══════════ 8 · BỘ ĐÁNH GIÁ CÓ NHÃN — ĐO, KHÔNG CẢM TÍNH ═══════════ */

  /*
    Mười hai ca dựng theo các DẠNG thật gặp trên hàng đợi. Nhãn `nen` là thứ CON NGƯỜI kết luận khi
    đọc cả đoạn; `model` là thứ máy phân loại trả về (có ca cố tình SAI, để đo xem chứng từ có thật
    sự bác được không).
  */
  type Ca = { ten: string; model: Partial<SemanticVerdict> & { caseKind: CsKind | "NONE" }; facts: CaseFacts; nen: "CREATE" | "REVIEW" | "SKIP"; kindNen?: CsKind };
  const boDanhGia: Ca[] = [
    { ten: "trả hàng THẬT: khách đã nhận, đòi gửi lại", model: { caseKind: "RETURN" }, facts: DA_GIAO, nen: "CREATE", kindNen: "RETURN" },
    { ten: "trả hàng GIẢ ĐỊNH (Yến Ruby)", model: { caseKind: "RETURN", temporalScope: "HYPOTHETICAL", speakerIntent: "CUSTOMER_ACCEPTANCE" }, facts: CO_DON, nen: "SKIP" },
    { ten: "đổi size THẬT: khách yêu cầu đổi sang XL", model: { caseKind: "EXCHANGE_SIZE" }, facts: CO_DON, nen: "CREATE", kindNen: "EXCHANGE_SIZE" },
    { ten: "đổi size CÓ ĐIỀU KIỆN: “nếu không vừa thì đổi được không”", model: { caseKind: "EXCHANGE_SIZE", temporalScope: "CONDITIONAL" }, facts: CO_DON, nen: "SKIP" },
    { ten: "chính sách của shop: “bên em đổi trong 7 ngày”", model: { caseKind: "EXCHANGE_COLOR", speakerIntent: "SHOP_SUGGESTION" }, facts: CO_DON, nen: "SKIP" },
    { ten: "khiếu nại THẬT: hàng nhận về bị lỗi chỉ", model: { caseKind: "COMPLAINT" }, facts: DA_GIAO, nen: "CREATE", kindNen: "COMPLAINT" },
    { ten: "khiếu nại ĐÃ XỬ LÝ XONG ngay trong chat", model: { caseKind: "COMPLAINT", temporalScope: "RESOLVED" }, facts: DA_GIAO, nen: "SKIP" },
    { ten: "giục giao THẬT: đơn đang trên đường", model: { caseKind: "URGE_DELIVERY" }, facts: facts({ orderMatch: "BY_CONVERSATION", orderMaterialized: true, orderStage: "SHIPPED", hasShipment: true, hasActiveShipment: true }), nen: "CREATE", kindNen: "URGE_DELIVERY" },
    { ten: "giục giao CŨ: đơn đã giao xong từ lâu", model: { caseKind: "URGE_DELIVERY" }, facts: DA_GIAO, nen: "SKIP" },
    { ten: "hội thoại TRUNG TÍNH: hỏi giá rồi thôi", model: { caseKind: "NONE", actionable: false }, facts: NO_FACTS, nen: "SKIP" },
    { ten: "đơn ĐÃ được xác nhận nhưng model bảo chưa tạo", model: { caseKind: "ORDER_NOT_CREATED" }, facts: CO_DON, nen: "SKIP" },
    { ten: "mơ hồ: khách nhắn cụt “thôi chị suy nghĩ đã”", model: { caseKind: "RETURN", confidence: "MEDIUM" }, facts: DA_GIAO, nen: "REVIEW" },
  ];

  let dungViec = 0; // tạo việc và ĐÚNG là phải tạo
  let viecGia = 0; // tạo việc mà đáng lẽ không (dương tính giả)
  let boSot = 0; // đáng tạo mà không tạo (âm tính giả)
  let deXem = 0;
  for (const ca of boDanhGia) {
    const v = parseVerdict({ actionable: true, confidence: "HIGH", temporalScope: "CURRENT_REQUEST", speakerIntent: "CUSTOMER_REQUEST", supportingEvidence: [], contradictoryEvidence: [], reason: ca.ten, ...ca.model });
    assert.ok(v, `ca “${ca.ten}”: kịch bản phải dựng được một kết luận hợp lệ`);
    const d = decideCase(v, ca.facts);
    assert.equal(d.action, ca.nen, `ca “${ca.ten}”: mong ${ca.nen}, máy ra ${d.action} (${d.reason})`);
    if (ca.kindNen) assert.equal(d.kind, ca.kindNen, `ca “${ca.ten}”: loại việc phải đúng`);
    if (d.action === "CREATE") {
      if (ca.nen === "CREATE") dungViec += 1;
      else viecGia += 1;
    } else if (ca.nen === "CREATE") {
      boSot += 1;
    }
    if (d.action === "REVIEW") deXem += 1;
  }
  const soTaoViec = dungViec + viecGia;
  const doChinhXac = soTaoViec ? dungViec / soTaoViec : 1;
  const doPhu = dungViec / boDanhGia.filter((c) => c.nen === "CREATE").length;
  const tyLeBaoNham = viecGia / boDanhGia.filter((c) => c.nen !== "CREATE").length;
  /*
    ƯU TIÊN ĐỘ CHÍNH XÁC. Một việc giả tốn một cuộc gọi của nhân viên VÀ dạy người trực rằng hàng
    đợi không đáng đọc — thiệt hại kép. Một việc bỏ sót thì máy đối chiếu và người trực còn bắt lại
    được. Nên ngưỡng ở đây không đối xứng, và cố ý.
  */
  assert.equal(doChinhXac, 1, `độ chính xác phải tuyệt đối trên bộ đánh giá: ${dungViec}/${soTaoViec}`);
  assert.equal(tyLeBaoNham, 0, "không được có việc giả nào");
  assert.ok(doPhu >= 0.9, `độ phủ phải ≥ 90%, đang là ${(doPhu * 100).toFixed(0)}% (${boSot} ca đáng tạo mà không tạo)`);
  assert.ok(deXem <= 2, "để người xem lại là lối thoát, không phải chỗ đổ rác: quá nhiều thì hàng đợi thứ hai lại thành tồn đọng thứ hai");

  /* ═══════════ 9 · KHÔNG CÒN ĐƯỜNG TỪ-KHOÁ-THẲNG-TỚI-CASE ═══════════ */

  const nguonQuet = readFileSync("lib/cs/chat-detect.ts", "utf8");
  const khoiGhi = nguonQuet.slice(nguonQuet.indexOf("const ungVien: CaseCandidate[] = []"), nguonQuet.indexOf("created += inserted.length;"));
  assert.ok(khoiGhi.includes("decideCase(") || khoiGhi.includes("decideWithoutModel("), "đường ghi case phải đi qua tầng quyết định, không đi thẳng từ dấu hiệu");
  assert.match(khoiGhi, /status: d\.action === "REVIEW" \? "NEEDS_REVIEW" : "OPEN"/, "trạng thái phải do QUYẾT ĐỊNH đặt, không gõ cứng OPEN");
  assert.match(khoiGhi, /semantic: toRecord\(d\)/, "kết luận phải được LƯU — máy phân loại chạy trong job, màn hình chỉ đọc");
  // Ứng viên vẫn được phép đến từ chữ; điều bị cấm là chữ tự thành việc.
  assert.ok(khoiGhi.includes('from: "KEYWORD"') && khoiGhi.includes('from: "TAG"'), "từ khoá và thẻ vẫn là nguồn ỨNG VIÊN hợp lệ");
  // Và không nơi nào khác trong kho còn chèn cs_cases thẳng từ một phép so chuỗi.
  const nguonNgheNghia = readFileSync("lib/cs/semantic-case.ts", "utf8");
  assert.ok(!/\.includes\(\s*k\s*\)/.test(nguonNgheNghia), "tầng quyết định không được chứa phép so chuỗi nào");

  /* ═══════════ 10 · SỔ ĐIỀU KIỆN PHẢI KÍN ═══════════ */

  for (const kind of Object.keys(CASE_ELIGIBILITY) as CsKind[]) {
    assert.equal(typeof CASE_ELIGIBILITY[kind], "function", `loại ${kind} phải có bộ gác thật`);
  }
  // Loại CHƯA khai thì rơi về phía HẸP HƠN: không sinh case, thay vì mặc định cho qua.
  const chuaKhai = checkEligibility("DELIVERY_FAILED", CO_DON);
  assert.equal(chuaKhai.ok, false, "loại chưa khai điều kiện thì tầng ngữ nghĩa KHÔNG được tự sinh ra nó");
  assert.equal(decideCase({ ...HIEN_TAI, caseKind: "DELIVERY_FAILED" }, CO_DON).action, "SKIP");

  /* ═══════════ 11 · CASE KHÔNG CÒN LÝ DO TỒN TẠI THÌ TỰ RỜI HÀNG ĐỢI ═══════════ */

  /*
    Bằng chứng bất biến; VIỆC PHẢI LÀM thì không. Bốn dòng dưới đây là bốn dạng thật:

     · giục giao một đơn ĐÃ GIAO XONG      → điều kiện hết, máy đóng được;
     · sai địa chỉ khi kiện ĐANG CHẠY      → việc có thật nhưng ở BÀN KHÁC, không đóng;
     · trả hàng của đơn đã giao            → còn nguyên, giữ mở;
     · giục giao đơn đã xong NHƯNG CÓ NGƯỜI NHẬN → việc của người, máy KHÔNG đóng hộ.
  */
  await db.insert(schema.orders).values([
    { id: "stale-o1", stage: "DELIVERED", status: 3, insertedAt: new Date(Date.now() - 20 * 86_400_000), billFullName: "Khách Cũ", billPhone: "0933000001", totalPriceAfterDiscount: 350_000 },
    { id: "stale-o2", stage: "SHIPPED", status: 3, insertedAt: new Date(Date.now() - 3 * 86_400_000), billFullName: "Khách Đang Giao", billPhone: "0933000002", totalPriceAfterDiscount: 420_000 },
  ]).onConflictDoNothing();
  await db.insert(schema.shipments).values([
    { id: "stale-s1", orderId: "stale-o1", carrier: "Viettel Post", vtpOrderNumber: "STALE1", stage: "DELIVERED", isFinal: true, receiverPhone: "0933000001" },
    { id: "stale-s2", orderId: "stale-o2", carrier: "Viettel Post", vtpOrderNumber: "STALE2", stage: "IN_TRANSIT", isFinal: false, receiverPhone: "0933000002" },
  ]).onConflictDoNothing();
  await db.insert(schema.csCases).values([
    { id: "stale-c1", orderId: "stale-o1", kind: "URGE_DELIVERY", status: "OPEN", source: "PANCAKE_CHAT", title: "Giục giao · đơn đã giao xong", customerPhone: "0933000001", dedupeKey: "test:stale-c1" },
    { id: "stale-c2", orderId: "stale-o2", kind: "WRONG_ADDRESS", status: "OPEN", source: "PANCAKE_CHAT", title: "Sai địa chỉ · kiện đang chạy", customerPhone: "0933000002", dedupeKey: "test:stale-c2" },
    { id: "stale-c3", orderId: "stale-o1", kind: "RETURN", status: "OPEN", source: "PANCAKE_CHAT", title: "Trả hàng · đơn đã giao", customerPhone: "0933000001", dedupeKey: "test:stale-c3" },
    { id: "stale-c4", orderId: "stale-o1", kind: "URGE_DELIVERY", status: "IN_PROGRESS", source: "PANCAKE_CHAT", title: "Giục giao · đã có người nhận", customerPhone: "0933000001", assignee: "Linh CSKH", assigneeUserId: "csq-user", dedupeKey: "test:stale-c4" },
  ]).onConflictDoNothing();

  const danhGia = new Map((await assessOpenCases()).map((a) => [a.id, a]));
  assert.equal(danhGia.get("stale-c1")?.verdict, "AUTO_RESOLVE", "giục giao một đơn đã giao xong là chuyện đã qua");
  assert.ok(danhGia.get("stale-c1")?.reason.includes("đã kết thúc"), "và lý do phải nói được vì sao, vì nó đi thẳng vào resolution");
  assert.equal(danhGia.get("stale-c2")?.verdict, "RECLASSIFY", "kiện đang chạy: việc CÓ THẬT nhưng ở bàn Vận đơn & care — đóng nó là đánh rơi một việc");
  assert.equal(danhGia.get("stale-c3")?.verdict, "KEEP_OPEN", "trả hàng của đơn đã giao vẫn còn nguyên lý do tồn tại");
  assert.equal(danhGia.get("stale-c4")?.verdict, "NEEDS_REVIEW", "case đã có người cầm thì máy KHÔNG đóng hộ — đó là xoá công của người");

  /*
    LOẠI CHƯA KHAI ĐIỀU KIỆN PHẢI GIỮ NGUYÊN.

    Cùng một hàm `checkEligibility` trả `ok: false` cho loại chưa khai, và đó là mặc định ĐÚNG lúc
    SINH case (không đẻ bừa). Lúc ĐÓNG thì mặc định ấy SAI: "chưa ai viết luật" không phải bằng
    chứng rằng việc đã xong.
  */
  await db.insert(schema.csCases).values({ id: "stale-c5", kind: "SIZE_ADVICE", status: "OPEN", source: "PANCAKE_CHAT", title: "Tư vấn size · loại chưa khai điều kiện", dedupeKey: "test:stale-c5" }).onConflictDoNothing();
  const chuaKhaiDG = (await assessOpenCases()).find((a) => a.id === "stale-c5");
  assert.equal(chuaKhaiDG?.verdict, "KEEP_OPEN", "loại chưa khai điều kiện đóng thì GIỮ NGUYÊN — hai phía an toàn ngược nhau, cố ý");

  // CHẠY THỬ KHÔNG ĐƯỢC GHI MỘT DÒNG NÀO.
  const thu = await applyStaleReconciliation({ dryRun: true });
  assert.equal(thu.closed, 0, "chạy thử phải ghi 0 dòng — không có ngoại lệ nào");
  assert.ok(thu.planned >= 1, "nhưng phải nói được nó SẼ đóng bao nhiêu");
  assert.equal((await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "stale-c1") }))?.status, "OPEN", "chạy thử xong dữ liệu phải y nguyên");

  // CHẠY THẬT: đóng MỀM, có lý do từng case, và KHÔNG phải công của người.
  const that = await applyStaleReconciliation({ dryRun: false, actor: "test:cs-stale" });
  assert.ok(that.closed >= 1, "chạy thật phải đóng được case đã hết lý do tồn tại");
  const sauDong = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "stale-c1") });
  assert.equal(sauDong?.status, "AUTO_RESOLVED", "máy đóng thì phải là AUTO_RESOLVED — DONE là công của NGƯỜI");
  assert.ok(sauDong?.resolution.includes("CONDITION_GONE"), "phải nói vì sao đóng");
  assert.ok(sauDong?.resolution.includes("test:cs-stale"), "và ai đóng");
  assert.ok(sauDong?.resolvedAt instanceof Date, "và lúc nào");
  assert.equal((await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "stale-c2") }))?.status, "OPEN", "việc của bàn khác KHÔNG được đóng");
  assert.equal((await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "stale-c3") }))?.status, "OPEN", "việc còn lý do tồn tại KHÔNG được đóng");
  assert.equal((await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "stale-c4") }))?.status, "IN_PROGRESS", "việc có người cầm KHÔNG được đóng");
  assert.equal((await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "stale-c5") }))?.status, "OPEN", "loại chưa khai điều kiện KHÔNG được đóng");

  // CHẠY LẦN HAI KHÔNG ĐƯỢC ĐÓNG THÊM GÌ — nếu không, mỗi lượt chạy lại là một lượt ghi mới.
  const lanHaiDong = await applyStaleReconciliation({ dryRun: false, actor: "test:cs-stale" });
  assert.equal(lanHaiDong.closed, 0, "chạy lại phải là không-thao-tác");
  assert.equal(lanHaiDong.planned, 0, "và không còn gì để đóng");

  // Báo cáo phải đưa MẪU THẬT để người đọc kiểm chứng, không chỉ một con số.
  const bc = await staleReport(20);
  assert.ok(bc.openTotal >= 1, "báo cáo phải đếm được hàng đợi đang mở");
  assert.ok(bc.byKind.every((k) => k.total === Object.values(k.counts).reduce((a, b) => a + b, 0)), "tổng theo loại phải bằng tổng các kết luận của chính loại đó — bảng không được tự mâu thuẫn");
  assert.ok(Object.hasOwn(bc.orderNotCreated.closed, "POS_CONFIRMED"), "báo cáo phải gộp cả máy riêng của “chưa tạo đơn”");

  console.log(
    `✓ Máy sinh case hiểu câu: ca gốc “Yến Ruby” (giả định) KHÔNG sinh việc trả hàng · bốn cửa theo đúng thứ tự (thời gian → người nói → CHỨNG TỪ → tin cậy) · chứng từ BÁC model (POS đã xác nhận / đã có vận đơn / đơn đã xong) · mất AI thì từ khoá KHÔNG tạo việc còn đường xác định vẫn chạy · bộ đánh giá ${boDanhGia.length} ca: độ chính xác ${(doChinhXac * 100).toFixed(0)}% · độ phủ ${(doPhu * 100).toFixed(0)}% · báo nhầm ${(tyLeBaoNham * 100).toFixed(0)}% · ${deXem} ca để người xem · một đoạn sự việc một việc · bản ghi không chứa dòng suy nghĩ · case hết lý do tồn tại tự rời hàng đợi (đóng MỀM có lý do, việc bàn khác và việc có người cầm thì KHÔNG, chạy lại là không-thao-tác)`,
  );
}
