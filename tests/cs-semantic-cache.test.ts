import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { FakeProvider } from "@/lib/ai/provider";
import { KHOA_TRAN_NGAY } from "@/lib/constants/ai-budget";
import { NO_FACTS } from "@/lib/constants/case-semantics";
import type { CaseContext } from "@/lib/cs/semantic-case";
import { classifyConversationCached, pruneSemanticCache, SEMANTIC_CACHE_RETENTION_DAYS, SEMANTIC_ROUTE, semanticFingerprint } from "@/lib/cs/semantic-cache";

/**
 * ═══════════ MỘT CÂU HỎI Y HỆT KHÔNG TRẢ TIỀN HAI LẦN ═══════════
 *
 * `cs-chat` quét lại cửa sổ 48 giờ mỗi 15 phút. Trước bộ nhớ đệm, một hội thoại có dấu hiệu bị hỏi
 * model ở MỌI lượt dù không có tin mới. Bài kiểm khoá cả hai chiều của lời hứa:
 *
 *  · cùng đầu vào ⇒ KHÔNG gọi model lần hai;
 *  · bất kỳ thứ gì model được đọc thay đổi ⇒ PHẢI hỏi lại — kể cả một câu khách vừa nhắn thêm.
 *
 * Chiều thứ hai quan trọng hơn chiều thứ nhất: bộ nhớ đệm dùng lại kết luận cũ sau khi khách nói
 * "thôi em không lấy nữa" là đổi tiền AI lấy một việc bị bỏ sót.
 */

const HIEN_TAI = {
  caseKind: "EXCHANGE_SIZE",
  actionable: true,
  confidence: "HIGH",
  temporalScope: "CURRENT_REQUEST",
  speakerIntent: "CUSTOMER_REQUEST",
  supportingEvidence: ["đổi giúp chị size L"],
  contradictoryEvidence: [],
  reason: "Khách xin đổi size L cho đơn đang giao.",
};

function model(day: Record<string, unknown> = HIEN_TAI) {
  return new FakeProvider([() => ({ content: [{ type: "tool_use", id: "t1", name: "ket_luan_case", input: day }], stopReason: "tool_use" })]);
}

const t = (m: number) => new Date(Date.UTC(2026, 8, 20, 3, m));

function ctx(over: Partial<CaseContext> = {}): CaseContext {
  return {
    customerName: "Chị Lan",
    tags: ["đổi size"],
    facts: { ...NO_FACTS },
    candidates: [{ kind: "EXCHANGE_SIZE", from: "KEYWORD", signal: "doi size", evidence: "đổi giúp chị size L" }],
    messages: [
      { text: "Em ơi đổi giúp chị size L nhé", fromPage: false, insertedAt: t(1) },
      { text: "Dạ vâng chị", fromPage: true, insertedAt: t(2) },
    ],
    ...over,
  };
}

export async function testCsSemanticCache(db: Db) {
  /** Ghi thẳng giá trị THÔ của một khoá settings — phanh đọc `Number(value)`, không đọc JSON. */
  const setSetting = (key: string, value: string) =>
    db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  /*
    Bộ kiểm dùng chung một CSDL: bài khác có thể đã ghi tiền AI "hôm nay" vượt trần mặc định, và
    khi ấy phanh chặn luôn lượt gọi đầu tiên ở đây. Trần được nâng trong lúc chạy rồi trả lại.
  */
  const tranCu = await db.query.settings.findFirst({ where: eq(schema.settings.key, KHOA_TRAN_NGAY) });
  await setSetting(KHOA_TRAN_NGAY, "1000000");

  /* ═══════════ 1 · DẤU VÂN TAY: ỔN ĐỊNH VỚI THỨ KHÔNG ĐỔI, NHẠY VỚI THỨ ĐỔI ═══════════ */

  const goc = semanticFingerprint(ctx(), "m1");
  assert.equal(semanticFingerprint(ctx(), "m1"), goc, "cùng đầu vào phải ra cùng khoá — nếu không bộ nhớ đệm không bao giờ trúng");

  /*
    Câu trích của ứng viên "đủ SĐT + địa chỉ" mang nhãn "đã chờ N giờ" đổi theo đồng hồ. Nó dựng từ
    chính hội thoại, nên KHÔNG được làm đổi khoá — nếu không, đúng loại hội thoại nằm lâu nhất sẽ bị
    hỏi lại mỗi giờ.
  */
  const choGio = (h: number) => ctx({ candidates: [{ kind: "ORDER_NOT_CREATED", from: "DETERMINISTIC", signal: "0901234567", evidence: `SĐT 0901234567 · đủ thông tin lúc 10:02 · đã chờ ${h} giờ.` }] });
  assert.equal(semanticFingerprint(choGio(3), "m1"), semanticFingerprint(choGio(4), "m1"), "nhãn 'đã chờ N giờ' trôi theo đồng hồ — không được làm hỏng khoá");

  const doi: [string, CaseContext | null, string][] = [
    ["khách nhắn thêm một câu", ctx({ messages: [...ctx().messages, { text: "Thôi em không lấy nữa", fromPage: false, insertedAt: t(9) }] }), "m1"],
    ["chứng từ đổi (đơn đã lên)", ctx({ facts: { ...NO_FACTS, orderMatch: "BY_CONVERSATION", orderMaterialized: true } }), "m1"],
    ["thẻ hội thoại đổi", ctx({ tags: ["trả hàng"] }), "m1"],
    ["ứng viên đổi loại", ctx({ candidates: [{ kind: "RETURN", from: "KEYWORD", signal: "tra hang", evidence: "x" }] }), "m1"],
    ["đổi model", null, "m2"],
  ];
  for (const [ten, c, m] of doi) {
    assert.notEqual(semanticFingerprint(c ?? ctx(), m), goc, `${ten} ⇒ khoá PHẢI đổi, nếu không kết luận cũ được dùng cho một câu hỏi khác`);
  }

  /* ═══════════ 2 · TRÚNG KHOÁ THÌ KHÔNG GỌI MODEL ═══════════ */

  const p = model();
  const lan1 = await classifyConversationCached(db, "conv-cache-1", ctx(), p);
  assert.equal(lan1.cached, false);
  assert.equal(lan1.verdict?.caseKind, "EXCHANGE_SIZE");
  assert.equal(p.calls.length, 1, "lượt đầu phải hỏi model");

  const lan2 = await classifyConversationCached(db, "conv-cache-1", ctx(), p);
  assert.equal(lan2.cached, true, "đầu vào y hệt ⇒ dùng lại kết luận");
  assert.equal(p.calls.length, 1, "lượt hai KHÔNG được gọi model — đây là toàn bộ lý do bộ nhớ đệm tồn tại");
  assert.deepEqual(lan2.verdict, lan1.verdict, "kết luận dùng lại phải đúng kết luận đã trả tiền");

  const [dong] = await db.select().from(schema.csSemanticVerdicts).where(eq(schema.csSemanticVerdicts.conversationId, "conv-cache-1"));
  assert.equal(dong.hits, 1, "số lần dùng lại phải đếm được — đó là con số tiền đã tiết kiệm");

  /*
    SỔ TIỀN: mỗi lượt gọi THẬT một dòng `ai_interactions` — phanh trần ngày chỉ cộng đúng sổ này.
    Lượt trúng bộ nhớ đệm không tốn tiền nên KHÔNG được ghi (ghi là thổi phồng tiền đã tiêu).
  */
  const so = await db.select().from(schema.aiInteractions).where(and(eq(schema.aiInteractions.route, SEMANTIC_ROUTE), eq(schema.aiInteractions.entityId, "conv-cache-1")));
  assert.equal(so.length, 1, "một lượt gọi thật = một dòng sổ; lượt trúng bộ nhớ đệm không ghi");
  assert.ok(!so[0].prompt.includes("size L"), "sổ KHÔNG chép nội dung hội thoại — có SĐT, địa chỉ khách");

  /* PHANH: chạm trần tiền ngày thì KHÔNG gọi model, và nói ra vì sao. */
  const dongTien = "cs-cache-test-spend";
  try {
    await setSetting(KHOA_TRAN_NGAY, "0.01");
    await db.insert(schema.aiInteractions).values({ id: dongTien, provider: "test", model: "test", route: "test.spend", costUsd: "1.000000", status: "OK" });
    const chan = model();
    const r = await classifyConversationCached(db, "conv-cache-phanh", ctx({ customerName: "Chị Phanh" }), chan);
    assert.equal(chan.calls.length, 0, "chạm trần ⇒ KHÔNG được gọi model");
    assert.equal(r.verdict, null);
    assert.ok(r.blocked?.includes("chạm trần"), "phải nói ra là phanh chặn, không im lặng trả null như AI tắt");
  } finally {
    await db.delete(schema.aiInteractions).where(eq(schema.aiInteractions.id, dongTien));
    await setSetting(KHOA_TRAN_NGAY, "1000000");
  }

  /* ═══════════ 3 · CÓ TIN MỚI THÌ HỎI LẠI ═══════════ */

  const moi = ctx({ messages: [...ctx().messages, { text: "Thôi em không lấy nữa", fromPage: false, insertedAt: t(9) }] });
  const lan3 = await classifyConversationCached(db, "conv-cache-1", moi, p);
  assert.equal(lan3.cached, false, "khách vừa nhắn thêm ⇒ PHẢI hỏi lại model");
  assert.equal(p.calls.length, 2);

  /* ═══════════ 4 · KHÔNG NHỚ THẤT BẠI ═══════════ */

  const hong = model({ caseKind: "KHONG_CO_TRONG_SO" });
  const h1 = await classifyConversationCached(db, "conv-cache-2", ctx({ customerName: "Anh Minh" }), hong);
  assert.equal(h1.verdict, null);
  const h2 = await classifyConversationCached(db, "conv-cache-2", ctx({ customerName: "Anh Minh" }), hong);
  assert.equal(h2.cached, false, "model trả thứ không đọc được thì lượt sau PHẢI thử lại, không nhớ một cái null");
  assert.equal(hong.calls.length, 2);

  /* ═══════════ 5 · DỌN DÒNG KHÔNG AI DÙNG ═══════════ */

  await db
    .update(schema.csSemanticVerdicts)
    .set({ lastUsedAt: new Date(Date.now() - (SEMANTIC_CACHE_RETENTION_DAYS + 1) * 86_400_000) })
    .where(eq(schema.csSemanticVerdicts.conversationId, "conv-cache-1"));
  const daDon = await pruneSemanticCache(db);
  assert.equal(daDon, 2, "hai kết luận của conv-cache-1 đã quá hạn giữ ⇒ phải dọn");
  const conLai = await db.select().from(schema.csSemanticVerdicts).where(eq(schema.csSemanticVerdicts.conversationId, "conv-cache-1"));
  assert.equal(conLai.length, 0);

  /* ═══════════ 6 · JOB THẬT ĐI QUA BỘ NHỚ ĐỆM ═══════════ */

  const nguon = readFileSync("lib/cs/chat-detect.ts", "utf8");
  assert.ok(nguon.includes("classifyConversationCached("), "job cs-chat phải gọi model QUA bộ nhớ đệm");
  assert.ok(!/\bclassifyConversation\(/.test(nguon), "job cs-chat không được gọi thẳng model — một đường vòng là quay lại trả tiền mỗi 15 phút");

  // Trả lại trần và dọn sổ tiền của bài kiểm — bài sau đọc sổ này không được thấy lượt gọi giả.
  if (tranCu) await setSetting(KHOA_TRAN_NGAY, String(tranCu.value));
  else await db.delete(schema.settings).where(eq(schema.settings.key, KHOA_TRAN_NGAY));
  await db.delete(schema.aiInteractions).where(eq(schema.aiInteractions.route, SEMANTIC_ROUTE));

  console.log("✓ cs-chat: câu hỏi y hệt không gọi model lần hai; tin mới / chứng từ mới luôn được hỏi lại");
}
