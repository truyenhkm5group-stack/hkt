/**
 * ═══════════ CÂU MÁY CHỦ TỰ SOẠN KHÔNG XIN LẠI ĐỊA CHỈ ĐÃ GỬI · 2B ADDRESS_REASK THEO LUẬT 3.12b (23/10/2026) ═══════════
 *
 * Rà sau #972 (Tech Lead 23/10/2026):
 *  · Điểm chặn của `appendMessage` chỉ lọc khi `turnAddressGiven` = true, mà cờ ấy chỉ được đặt GIỮA `chatTurnCore` ⇒ mọi `reply()` của câu
 *    máy chủ tự soạn trước đó (qtyAck · round-check · huỷ đơn) đi qua điểm chặn với cờ = false. Nay `markAddressGiven` đặt cờ NGAY khi lượt
 *    có tin khách (quét mã nguồn bên dưới).
 *  · qtyAck tin hai ý («2kg, mấy ngày nhận») chèn «mình gửi em địa chỉ, em báo thời gian dự kiến» VÔ ĐIỀU KIỆN — và câu ấy còn lọt CẢ bộ
 *    phát hiện (không dấu hỏi, «gửi em» không thuộc ASK_VERB). Nay: lời xin dạng kể (KHÁCH gửi / nhắn / báo / cho SHOP một phần địa chỉ)
 *    là lời xin; đã có chữ địa chỉ ⇒ tin hai ý nhường model. Hồi quy nhiều lượt ở tests/p0-short-qty-round.test.ts.
 *  · 2B ADDRESS_REASK đếm cả mã REPEAT_ASK (xin LẶP thứ khách CHƯA cho) dưới nhãn «hỏi lại thứ đã cho» ⇒ mở lại sổ tái diễn #972 sai (ca tin
 *    theo dõi 16:24Z 22/10, hslc). Nay: ADDRESS_REASK = vế 3.12b ∨ mã «đã biết»; REPEAT_ASK ⇒ REPEAT_ASK_UNANSWERED (không nối sổ tái diễn).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SALES_QUALITY_CODES, SALES_QUALITY_SPEC } from "@/lib/constants/sales-quality";
import { REGRESSION_WATCH } from "@/lib/constants/regression-watch";
import { addressAskAfterText, asksAnyAddressPart, KNOWN_REASK_CODES } from "@/lib/sales-chatbot/address-memory";
import { DELIVERY_ASK_NEEDS_ADDRESS } from "@/lib/sales-chatbot/round-check";
import { sentencesOf } from "@/lib/sales-chatbot/text";
import { definitionNoteFor } from "@/lib/sales-quality/daily";
import { scanThreadQuality } from "@/lib/sales-quality/detectors";
import { addressAskAfterText as scriptAddressAskAfterText } from "../scripts/conv-money-trace";

const asks = (t: string) => sentencesOf(t).some(asksAnyAddressPart);

export function testAddressReaskQtyAck() {
  // ── Lời xin dạng kể: CẢ HAI phía (Tech Lead 23/10/2026).
  for (const t of [DELIVERY_ASK_NEEDS_ADDRESS, "Dạ mình gửi em địa chỉ nhé.", "Chị nhắn shop địa chỉ giúp em ạ.", "Anh gửi giúp em địa chỉ nhận hàng nhé.", "Mình cho em địa chỉ để em lên đơn nhé.", "Dạ chị báo em tên phường nhé."]) {
    assert.ok(asks(t), `lời xin dạng kể phải bắt: «${t}»`);
  }
  for (const t of ["Dạ em gửi hàng về địa chỉ chị đã cho ạ.", "Dạ em gửi chị mã vận đơn ạ.", "Dạ shop sẽ báo chị khi hàng tới ạ.", "Dạ em ghi nhận địa chỉ của mình rồi ạ.", "Dạ bên em giao 2-3 ngày tới địa chỉ của mình ạ.", "Dạ em gửi shop xác nhận đơn rồi ạ.", "Dạ chị gửi em đường link nhé."]) {
    assert.ok(!asks(t), `KHÔNG phải lời xin: «${t}»`);
  }

  // ── Phép đo 3.12b: MỘT hàm cho engine-đo (2B) và dòng O của conv-money-trace — không trôi xa nhau.
  const t0 = Date.parse("2031-03-01T03:00:00Z");
  const samples: [{ text: string; at: number }[], string, number][] = [
    [[{ text: "Số 12 Nguyễn Trãi, Hà Nội", at: t0 }], "Dạ mình cho em xin tên phường nhé?", t0 + 60_000],
    [[{ text: "Số 12 Nguyễn Trãi, Hà Nội", at: t0 }], DELIVERY_ASK_NEEDS_ADDRESS, t0 + 60_000],
    [[{ text: "ok em", at: t0 }], "Dạ mình cho em xin địa chỉ nhận hàng ạ?", t0 + 60_000],
    [[{ text: "Số 12 Nguyễn Trãi, Hà Nội", at: t0 }], "Dạ em lên đơn cho mình rồi ạ.", t0 + 60_000],
  ];
  for (const [c, b, at] of samples) assert.equal(scriptAddressAskAfterText(c, b, at), addressAskAfterText(c, b, at), `script ≡ lib: «${b}»`);
  assert.equal(addressAskAfterText(samples[1][0], DELIVERY_ASK_NEEDS_ADDRESS, t0 + 60_000), true, "câu hai ý xin địa chỉ sau chữ địa chỉ ⇒ đếm");

  // ── Quét mã nguồn: mọi reply() của chatTurnCore đứng SAU lần đặt cờ đầu tiên; cờ chỉ được đặt qua markAddressGiven.
  const src = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  const a = src.indexOf("async function chatTurnCore(");
  const b = src.indexOf("\nexport ", a + 1);
  assert.ok(a > 0 && b > a, "tìm được thân chatTurnCore");
  const core = src.slice(a, b);
  const firstMark = core.indexOf("markAddressGiven(");
  assert.ok(firstMark > 0, "chatTurnCore đặt cờ địa chỉ");
  const replies = [...core.matchAll(/await reply\(/g)].map((m) => m.index ?? 0);
  assert.ok(replies.length > 5, "đếm được các reply() của lượt");
  assert.ok(replies.every((i) => i > firstMark), `mọi reply() đứng SAU lần đặt cờ đầu tiên (reply sớm nhất @${Math.min(...replies)} · cờ @${firstMark})`);
  assert.equal((src.match(/turnAddressGiven\.set\(/g) ?? []).length, 1, "cờ chỉ được đặt trong markAddressGiven");
  assert.match(core, /\(twoIntents && !addressGivenNow\)/, "qtyAck tin hai ý không chèn câu xin địa chỉ khi đã có chữ địa chỉ");

  // ── 2B: ca theo dõi tự động 16:24Z 22/10 — khách CHƯA từng gửi SĐT / địa chỉ, bot xin lần hai ⇒ KHÔNG phải ADDRESS_REASK.
  const T = Date.parse("2026-10-22T10:00:00Z");
  const msg = (seq: number, role: "user" | "assistant", text: string, at: number) => ({ seq, role, at: new Date(at), content: [{ type: "text" as const, text }] });
  const w = { from: new Date(T - 3_600_000), to: new Date(T + 12 * 3_600_000), templates: [], products: [] };
  const followup = [
    msg(1, "user", "shop ơi", T),
    msg(2, "user", "còn hàng không", T + 30_000),
    msg(3, "user", "chả mực", T + 60_000),
    msg(4, "assistant", "Dạ mình cho em xin SĐT và địa chỉ nhận hàng để em lên đơn nhé.", T + 20 * 60_000),
    msg(5, "assistant", "Dạ chị ơi, mình cho em xin SĐT và địa chỉ nhận hàng để em giữ hàng cho mình nhé.", T + 6 * 3_600_000),
  ];
  const codes = scanThreadQuality(followup, w).hits.map((h) => h.code);
  assert.equal(codes.filter((c) => c === "ADDRESS_REASK").length, 0, `xin lặp thứ CHƯA có ⇒ không phải «hỏi lại thứ đã cho»: ${codes.join(",")}`);
  assert.equal(codes.filter((c) => c === "REPEAT_ASK_UNANSWERED").length, 1, `⇒ mã riêng REPEAT_ASK_UNANSWERED: ${codes.join(",")}`);
  // Khách ĐÃ gửi chữ địa chỉ rồi bot xin (dạng kể) ⇒ ADDRESS_REASK (vế 3.12b).
  const given = [
    msg(1, "user", "Cho chị 2kg chả mực, Số 12 Nguyễn Trãi, Hà Nội", T),
    msg(2, "assistant", `Dạ em ghi nhận mình lấy 2kg ạ. ${DELIVERY_ASK_NEEDS_ADDRESS}`, T + 30_000),
  ];
  assert.ok(scanThreadQuality(given, w).hits.some((h) => h.code === "ADDRESS_REASK"), "đã có chữ địa chỉ mà bot xin (kể cả dạng kể) ⇒ ADDRESS_REASK");

  // ── Sổ mã: REPEAT_ASK_UNANSWERED ở CUỐI danh sách (khoá cũ giữ nguyên), KHÔNG nối vào sổ tái diễn; ADDRESS_REASK khai mốc đổi định nghĩa.
  assert.equal(SALES_QUALITY_CODES[SALES_QUALITY_CODES.length - 1], "REPEAT_ASK_UNANSWERED");
  assert.ok(!REGRESSION_WATCH.some((r) => (r.leakCodes as readonly string[]).includes("REPEAT_ASK_UNANSWERED")), "mã mới không mở lại sổ tái diễn");
  assert.ok(!KNOWN_REASK_CODES.includes("REPEAT_ASK"), "REPEAT_ASK không phải mã «đã biết»");
  const spec = SALES_QUALITY_SPEC.ADDRESS_REASK;
  assert.equal(spec.definitionChangedAt, "2026-10-23");
  assert.match(definitionNoteFor(spec, "2026-10-23"), /Định nghĩa đổi 23\/10\/2026/, "ngày đầu in ghi chú đổi định nghĩa (AGENTS 40)");
  assert.equal(definitionNoteFor(spec, "2026-10-22"), "", "trước mốc không in");
  assert.equal(definitionNoteFor(spec, "2026-11-05"), "", "hết 7 ngày đầu thôi in");
  console.log("✓ Hỏi lại địa chỉ (23/10/2026): lời xin dạng kể bắt đúng hai phía · đo 3.12b một hàm (lib ≡ script) · mọi reply() sau lần đặt cờ · qtyAck hai ý không xin địa chỉ · 2B: xin lặp thứ chưa có ⇒ REPEAT_ASK_UNANSWERED, không ADDRESS_REASK · ghi chú đổi định nghĩa 7 ngày đầu");
}
