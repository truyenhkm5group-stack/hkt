/**
 * ops `comment-inbox-link-probe` (P0 HSLC 24/10/2026 — bình luận có SĐT + địa chỉ, Messenger mở hội thoại MỚI rồi hỏi lại). Phần thuần:
 * phán quyết khoá bốn nhánh, dáng mã luồng không lộ chữ số, tham số. Quét mã nguồn: chỉ đọc từ đầu · tóm tắt công khai không mang mã luồng /
 * chữ tin / from_id · ops khai đủ bốn chỗ, làn NẶNG (dựng npx tsx trong container), kết quả MÃ HOÁ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commonPrefix, emptyLegacyTally, idShape, keyVerdict, legacyVerdict, messageText, parseLinkArgs, LEGACY_DEFAULT_DAYS, LEGACY_MAX_DAYS, LINK_MAX_CONVS } from "../scripts/comment-inbox-link-probe";

export function testCommentInboxLinkProbe() {
  // Bốn phán quyết: không dòng dấu ⇒ không biết Pancake trả gì; có dấu chưa có tiếng vọng ⇒ chưa kết luận; còn lại so luồng.
  assert.equal(keyVerdict([], ["p_1"]), "NO_MARKER");
  assert.equal(keyVerdict(["p_1"], []), "NO_ECHO");
  assert.equal(keyVerdict(["p_1"], ["p_1"]), "SAME_THREAD");
  assert.equal(keyVerdict(["p_1"], ["p_2"]), "THREAD_MISMATCH", "tiếng vọng rơi luồng khác ⇒ khoá lệch — ca Ngọc 24/10");
  assert.equal(keyVerdict(["p_1"], ["p_2", "p_1"]), "SAME_THREAD", "một tiếng vọng đúng luồng là đủ");

  // Dáng mã: so được bằng mắt, không lộ chữ số.
  assert.equal(idShape("123456789012345_6789012345678901"), "15d_16d");
  assert.equal(idShape("t_10abcDEF"), "1a_2d6a");
  assert.equal(idShape(null), "—");
  assert.ok(!/\d{3,}/.test(idShape("100093038346_5512")), "dáng không mang chuỗi số của mã");
  assert.equal(commonPrefix("12345_678", "12345_999"), 6);
  assert.equal(commonPrefix(null, "x"), 0);

  assert.equal(messageText([{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }]), "a b");
  assert.equal(messageText("chữ"), "chữ");
  assert.equal(messageText(null), "");

  const ok = parseLinkArgs(["hslc-hmt-shop", "--conv=7a5d4f63-2409-43e5-a920-ddc9536b5a26,CE9EFF3D-D761-4481-967A-55B8E136387A"]);
  assert.ok(!("error" in ok) && ok.convs.length === 2 && ok.convs[1] === "ce9eff3d-d761-4481-967a-55b8e136387a" && ok.days === null);
  const scan = parseLinkArgs(["hslc-hmt-shop", "--days=1"]);
  assert.ok(!("error" in scan) && scan.days === 1 && scan.convs.length === 0);
  for (const bad of [["hslc-hmt-shop"], ["hslc-hmt-shop", "--days=0"], ["hslc-hmt-shop", "--days=15"], ["hslc-hmt-shop", "--conv=khong-phai-uuid"], ["--days=1"], ["hslc-hmt-shop", `--conv=${Array(LINK_MAX_CONVS + 1).fill("7a5d4f63-2409-43e5-a920-ddc9536b5a26").join(",")}`]]) {
    assert.ok("error" in parseLinkArgs(bad), `tham số sai phải bị từ chối: ${bad.join(" ")}`);
  }

  // P2-6 chạy thử khoá «m_…»: một tổ chức hoặc --all; --all chỉ với --legacy-keys; không đi cùng --conv; trần ngày riêng.
  const lg = parseLinkArgs(["--all", "--legacy-keys"]);
  assert.ok(!("error" in lg) && lg.all && lg.legacy && lg.code === null && lg.days === LEGACY_DEFAULT_DAYS, JSON.stringify(lg));
  const lg1 = parseLinkArgs(["hslc-hmt-shop", "--legacy-keys", "--days=45"]);
  assert.ok(!("error" in lg1) && !lg1.all && lg1.code === "hslc-hmt-shop" && lg1.days === 45);
  for (const bad of [["--all"], ["--all", "hslc", "--legacy-keys"], ["hslc", "--legacy-keys", `--days=${LEGACY_MAX_DAYS + 1}`], ["hslc", "--legacy-keys", "--conv=7a5d4f63-2409-43e5-a920-ddc9536b5a26"]]) {
    assert.ok("error" in parseLinkArgs(bad), `tham số sai phải bị từ chối: ${bad.join(" ")}`);
  }
  assert.equal(legacyVerdict("p_1", "conv-x"), "TWO_CONVERSATIONS", "ca Ngọc: tin riêng rơi luồng thật có hội thoại riêng");
  assert.equal(legacyVerdict("p_1", null), "INBOX_NO_CONVERSATION");
  assert.equal(legacyVerdict(null, null), "ECHO_NOT_FOUND", "không có dòng mang đúng mã tin ⇒ không đoán");
  assert.deepEqual(emptyLegacyTally().byVerdict, { TWO_CONVERSATIONS: 0, INBOX_NO_CONVERSATION: 0, ECHO_NOT_FOUND: 0 });

  const src = readFileSync("scripts/comment-inbox-link-probe.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Tìm bằng regex đã thoát (không phải chuỗi literal): bài này KHÔNG đọc môi trường, chỉ đọc mã nguồn của script.
  const readOnlyAt = code.search(/process\.env\.ERP_READ_ONLY = "1";/);
  assert.ok(readOnlyAt >= 0 && readOnlyAt < code.indexOf('from "@/db"'), "chỉ đọc TRƯỚC khi nạp CSDL");
  assert.match(code, /show default_transaction_read_only/, "hỏi lại phiên chỉ đọc");
  assert.match(code, /getDbForInspection\(/, "CSDL tổ chức mở bằng handle chẩn đoán");
  assert.match(code, /eq\(t\.messageId, r\.threadId\)/, "luồng thật của khoá «m_…» tìm bằng CHÍNH mã tin (khoá xác định), không ghép theo chữ");
  assert.match(code, /eq\(t\.messageId, r\.threadId\), ne\(t\.threadId, r\.threadId\), ne\(t\.threadId, PRIVATE_REPLY_THREAD\)/, "dòng DẤU ở luồng __private_reply__ không phải luồng thật (lượt 40090214039: 691/692 bắt nhầm)");
  assert.doesNotMatch(code, /tomTat\(`legacy-keys[^`]*\$\{org\.code/, "tóm tắt chạy thử mọi tổ chức không mang mã tổ chức");
  assert.doesNotMatch(code, /\bdb\s*\.\s*(insert|update|delete)\b|sql`\s*(insert|update|delete)\b/i, "không ghi gì vào CSDL");
  assert.doesNotMatch(code, /fetch\(/, "không gọi Pancake");
  for (const m of code.matchAll(/tomTat\(([\s\S]*?)\);\n/g)) {
    // Cấm NỘI SUY THẲNG một giá trị (cả biểu thức chỉ là một đường thuộc tính / một danh sách); so sánh ra đúng-sai thì được.
    assert.doesNotMatch(m[1], /\$\{\s*[\w.]*\b(?:threadId|text|fromId|senderId|visitorKey|real|inboxIds|echoThreads|from|psids)\s*\}|\b(?:inboxIds|echoThreads|from|psids|comments|markers|echoes)\.join\(/, `tóm tắt công khai không mang mã luồng / chữ / from_id: ${m[1].slice(0, 120)}`);
  }
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- comment-inbox-link-probe\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bcomment-inbox-link-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bcomment-inbox-link-probe\b/, "làn đọc NẶNG (dựng npx tsx)");
  assert.match(ops, /comment-inbox-link-probe\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/comment-inbox-link-probe\.ts ;;/, "nhánh chạy");
  console.log("✓ ops comment-inbox-link-probe: bốn phán quyết khoá · dáng mã không lộ số · tham số soát · chỉ đọc · tóm tắt không mang mã luồng / chữ · khai đủ, làn nặng, mã hoá");
}
