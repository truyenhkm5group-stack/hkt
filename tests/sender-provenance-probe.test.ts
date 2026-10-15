/**
 * ═══════════ OPS `sender-provenance-probe` — TIN PHÍA PAGE MANG DẤU NGƯỜI GỬI GÌ (11/10/2026) ═══════════
 *
 * Đo rủi ro số 1 của P0 response-ownership trước khi deploy: tin nhân viên gõ trên Pancake mà KHÔNG mang uid sẽ thành UNKNOWN (không
 * nhường) ⇒ AI có thể chen vào cuộc chat của người. Bài kiểm khoá: phân loại đúng mười nhóm (bản đo — nguồn sự thật là
 * response-ownership.ts), bối cảnh của tin không dấu (giữa chuỗi người ±10′ · sau câu bot · đầu phiên), mã app ẩn 4 số cuối, tóm tắt
 * không bao giờ nhận chữ tin / token / mã hội thoại; script chỉ đọc (Postgres ép + hỏi lại), chỉ GET, có nghỉ + dừng khi 429; ops-vps
 * khai đủ bốn chỗ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appIdOf, appishKeyPaths, classifyProbeMessage, maskAppId, noneContext, parseProbeArgs, pct, probeTemplateKeys, type ProbeMessage } from "@/scripts/sender-provenance-probe";

const MIN = 60_000;

export function testSenderProvenanceProbe() {
  console.log("Ops sender-provenance-probe (dấu người gửi của tin phía page):");
  assert.deepEqual(parseProbeArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", days: 7, threads: 40 });
  assert.deepEqual(parseProbeArgs(["hslc", "--days=14", "--threads=80"]), { code: "hslc", days: 14, threads: 80 });
  for (const bad of [[], ["HSLC"], ["hslc", "--days=15"], ["hslc", "--threads=0"], ["hslc", "--days=1.5"]]) assert.ok("error" in parseProbeArgs(bad), JSON.stringify(bad));
  assert.equal(maskAppId("263902037430900"), "26390203743****");
  assert.equal(maskAppId("123"), "****");
  assert.equal(pct(3, 4), "3/4 (75.0%)");
  assert.equal(pct(0, 0), "0/0 (—)", "mẫu số 0 ⇒ chưa biết, không phải 0%");

  // Tin mẫu: ≥ 40 ký tự, cùng khoá (bỏ dấu, gộp khoảng trắng) ở ≥ 3 hội thoại — đúng cách audit.
  const TPL = "Dạ em chào anh/chị! Chả cá thu bên em: 1kg 279k · 2kg giảm còn 539k, em miễn ship";
  const tpl = probeTemplateKeys([
    { thread: "a", text: TPL },
    { thread: "b", text: TPL.replace(/ /g, "  ") },
    { thread: "c", text: TPL.normalize("NFD") },
    { thread: "a", text: "Dạ chị đợi em kiểm kho nhé, em báo lại ngay ạ chị ơi" },
    { thread: "b", text: "Dạ chị đợi em kiểm kho nhé, em báo lại ngay ạ chị ơi" },
  ]);
  assert.equal(tpl.size, 1, "chỉ câu lặp ở ≥ 3 hội thoại là tin mẫu");

  const m = (p: Partial<ProbeMessage>): ProbeMessage => ({ id: "m1", thread: "t1", at: 0, text: "Dạ chị cho em xin địa chỉ", uid: false, automated: false, appId: null, fromPage: true, ...p });
  const ctx = { botIds: new Set(["bot-1"]), botTexts: ["Dạ chả cá thu bên em 280k/kg chị lấy mấy kg ạ"], erpStaffTexts: new Set(["Dạ em gửi chị bảng giá"]), templates: tpl };
  assert.equal(classifyProbeMessage(m({ id: "bot-1", uid: true }), ctx), "BOT_ECHO", "tiếng vọng bot thắng uid");
  assert.equal(classifyProbeMessage(m({ text: "Bạn đang phản hồi bình luận của người dùng. Dạ chả cá thu bên em 280k/kg chị lấy mấy kg ạ" }), ctx), "BOT_ECHO", "tiếng vọng tin riêng có chữ hệ thống chèn trước");
  assert.equal(classifyProbeMessage(m({ text: "Dạ em gửi chị  bảng giá" }), ctx), "ERP_STAFF");
  assert.equal(classifyProbeMessage(m({ text: "" }), ctx), "AUTO_NOTE");
  assert.equal(classifyProbeMessage(m({ text: "Đã đặt giai đoạn của khách hàng tiềm năng thành Đủ tiêu chuẩn" }), ctx), "AUTO_NOTE");
  // «ĐẶT» và «ĐẠT» khác nhau đúng một dấu nặng, và chỗ này cố ý nhận CẢ HAI: bỏ sót một ghi chú tự động thì ERP
  // coi nó là PAGE ĐÃ TRẢ LỜI ⇒ bot nhường và im đúng lúc khách sắp chốt (đã trả giá 03/10/2026, «Thủy Nguyễn»).
  assert.equal(classifyProbeMessage(m({ text: "Đã đạt giai đoạn của khách hàng tiềm năng thành Đủ tiêu chuẩn" }), ctx), "AUTO_NOTE", "cách viết «đạt» cũng là ghi chú tự động — một dấu nặng không được làm bot im");
  // Nhưng KHÔNG nới rộng hơn: cụm «của khách hàng» vẫn bắt buộc, để câu của người thật không bao giờ rơi vào đây.
  assert.notEqual(classifyProbeMessage(m({ text: "Dạ chị đặt giai đoạn nào cũng được ạ" }), ctx), "AUTO_NOTE", "câu bán hàng của người không được nhận nhầm là ghi chú tự động");
  assert.equal(classifyProbeMessage(m({ text: "Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận." }), ctx), "META_COMMENT_SYSTEM");
  assert.equal(classifyProbeMessage(m({ uid: true }), ctx), "STAFF_UID");
  assert.equal(classifyProbeMessage(m({ uid: true, automated: true }), ctx), "AUTO_FLAG");
  assert.equal(classifyProbeMessage(m({ appId: "263902037430900" }), ctx), "META_INBOX_APP");
  assert.equal(classifyProbeMessage(m({ appId: "1122334455" }), ctx), "OTHER_APP");
  assert.equal(classifyProbeMessage(m({ text: TPL }), ctx), "TEMPLATE");
  assert.equal(classifyProbeMessage(m({}), ctx), "NONE", "không dấu nào ⇒ sau bản vá là UNKNOWN");

  // Bối cảnh tin không dấu.
  const T = 1_000 * MIN;
  const th = { verifiedAt: [T - 8 * MIN], botAt: [T - 5 * MIN], customerAt: [T - 30 * MIN] };
  assert.deepEqual(noneContext({ at: T }, th), { inHumanChain: true, afterBot: true, sessionStart: false });
  assert.deepEqual(noneContext({ at: T + 20 * MIN }, th), { inHumanChain: false, afterBot: false, sessionStart: false }, "lẻ loi");
  assert.equal(noneContext({ at: T - 30 * MIN + 20_000 }, { verifiedAt: [], botAt: [], customerAt: [T - 30 * MIN] }).sessionStart, true, "quanh tin mở phiên ⇒ tin chào");
  assert.equal(noneContext({ at: T }, { verifiedAt: [], botAt: [T + MIN], customerAt: [] }).afterBot, false, "câu bot SAU tin không tính");

  // Mã app + đường khoá: không giá trị.
  assert.equal(appIdOf({ app_id: 263902037430900 }), "263902037430900");
  assert.equal(appIdOf({ from: { app_id: "77" } }), "77");
  assert.equal(appIdOf({ message: "x" }), null);
  assert.deepEqual([...appishKeyPaths({ id: "1", from: { app_id: "999", name: "Lan" }, attachments: [{ application: { id: "5" } }] })].sort(), ["attachments[].application", "from.app_id"]);

  // Mã nguồn: chỉ đọc, chỉ GET, nghỉ + dừng khi 429, tóm tắt không nhận token / chữ tin / mã hội thoại.
  const sc = readFileSync("scripts/sender-provenance-probe.ts", "utf8");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.doesNotMatch(sc, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.doesNotMatch(sc, /method: "(POST|PUT|PATCH|DELETE)"/, "chỉ GET");
  assert.match(sc, /res\.status === 429/, "dừng khi Pancake giới hạn tốc độ");
  assert.match(sc, /setTimeout\(r, 600\)/, "nghỉ giữa các lượt gọi");
  assert.match(sc, /const secrets = \[token, pageId\]/);
  assert.doesNotMatch(sc, /tomTat\([^\n]*\$\{(token|q|secrets|pageId|e\.message|m\.text|m\.thread|th\.threadId|r\.text)\b/, "tóm tắt không nhận token / mã page / chữ tin / mã hội thoại");
  assert.doesNotMatch(sc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""), /graph\.facebook|facebook\.com/, "không Graph");
  // Chuỗi ghép từ hai mảnh để máy quét import của repo-integrity không đọc nhầm nó là một dòng import.
  assert.ok(!sc.includes(["@/lib/sales-chatbot", "response-ownership"].join("/")), "không nhập lib chưa có trên main (ops lấy lib từ image)");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- sender-provenance-probe\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bsender-provenance-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bsender-provenance-probe\b/, "làn ĐỌC nặng");
  assert.match(ops, /sender-provenance-probe\)\n[\s\S]*?scripts\/sender-provenance-probe\.ts ;;/, "nhánh chạy");
  console.log("  ✓ mười nhóm dấu người gửi (bản đo) · bối cảnh tin không dấu (chuỗi người ±10′ · sau bot · đầu phiên) · mã app ẩn · chỉ đọc, chỉ GET, dừng khi 429 · tóm tắt không chữ tin / token · ops khai đủ bốn chỗ");
}

if (process.argv[1] && /sender-provenance-probe.test.ts$/.test(process.argv[1])) {
  testSenderProvenanceProbe();
}
