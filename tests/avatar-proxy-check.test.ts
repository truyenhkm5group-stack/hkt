/**
 * ═══════════ OPS `avatar-proxy-check` — ẢNH QUA PROXY HỎNG Ở BƯỚC NÀO (11/10/2026) ═══════════
 *
 * Sau #796 production: «hộp thư sẽ hiện ảnh 264/300» mà trình duyệt nhận 404 cho mọi ảnh. Script đi lại từng bước của avatarProxyCore.
 * Bài kiểm khoá: (1) phép quyết định token đi ĐÚNG thứ tự `defaultPageToken` của route (hàng page riêng rồi kết nối đơn cũ) và nói ra
 * nhánh dừng; (2) dòng bước không mang id / URL / token; (3) script chỉ đọc, chỉ GET, dùng CHÍNH lib (không chép luật), ops khai đủ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeStep, parseCheckArgs, tokenVerdict } from "@/scripts/avatar-proxy-check";

const ORG = "hslc-hmt-shop";
const PAGE = "110000000000001";
const TOKEN = "PAGE_TOKEN_BI_MAT_ABCDEF123456";

export function testAvatarProxyCheck() {
  console.log("Ops avatar-proxy-check (ảnh qua proxy hỏng ở bước nào):");
  const legacy = { orgCode: ORG, status: "ACTIVE", lastTestOk: true, pageId: PAGE, hasSecrets: true };
  assert.deepEqual(tokenVerdict(ORG, PAGE, { orgCode: ORG, status: "ACTIVE", hasSecrets: true }, legacy, true), { found: true, source: "HÀNG_PAGE_RIÊNG", why: "OK" });
  assert.deepEqual(tokenVerdict(ORG, PAGE, { orgCode: ORG, status: "DISABLED", hasSecrets: true }, legacy, true), { found: false, source: "KHÔNG", why: "HÀNG_PAGE_DISABLED" }, "hàng page tắt ⇒ route DỪNG, không lùi về kết nối cũ");
  assert.deepEqual(tokenVerdict(ORG, PAGE, { orgCode: ORG, status: "ACTIVE", hasSecrets: false }, legacy, true), { found: true, source: "KẾT_NỐI_ĐƠN_CŨ", why: "OK" }, "hàng page không token riêng ⇒ kết nối cũ");
  assert.deepEqual(tokenVerdict(ORG, PAGE, null, legacy, true), { found: true, source: "KẾT_NỐI_ĐƠN_CŨ", why: "OK" });
  assert.equal(tokenVerdict(ORG, PAGE, null, { ...legacy, lastTestOk: false }, true).why, "KẾT_NỐI_ACTIVE_CHƯA_KIỂM_ĐẠT");
  assert.equal(tokenVerdict(ORG, PAGE, null, { ...legacy, pageId: "999" }, true).why, "KẾT_NỐI_KHÁC_PAGE");
  assert.equal(tokenVerdict(ORG, PAGE, null, legacy, false).why, "KẾT_NỐI_KHÔNG_GIẢI_MÃ_ĐƯỢC");
  assert.equal(tokenVerdict(ORG, PAGE, null, null, false).why, "KHÔNG_CÓ_HÀNG_PAGE · KHÔNG_CÓ_KẾT_NỐI");
  assert.equal(tokenVerdict(ORG, PAGE, { orgCode: "khac", status: "ACTIVE", hasSecrets: true }, legacy, true).why, "HÀNG_PAGE_KHÁC_TỔ_CHỨC");

  const s301 = describeStep(301, "text/html; charset=utf-8", `https://content.pancake.vn/2.1-25/avatars/a.jpg?page_access_token=${TOKEN}`, `https://pages.fm/api/v1/pages/${PAGE}/avatar/1`);
  assert.equal(s301, "HTTP 301 · kiểu=text/html · Location=có host=content.pancake.vn https=có bước-sau=được");
  assert.ok(!s301.includes(TOKEN) && !s301.includes(PAGE) && !s301.includes("avatars/"), "không URL / token / mã");
  assert.match(describeStep(302, null, "http://content.pancake.vn/a.jpg", "https://pages.fm/x"), /https=KHÔNG bước-sau=BỊ_CHẶN/);
  assert.match(describeStep(302, null, "https://evil.vn/a.jpg", "https://pages.fm/x"), /host=evil\.vn https=có bước-sau=BỊ_CHẶN/);
  assert.equal(describeStep(200, "image/jpeg", null, "https://content.pancake.vn/a.jpg", 1234), "HTTP 200 · kiểu=image/jpeg · Location=không · 1234B");
  assert.deepEqual(parseCheckArgs([ORG]), { code: ORG, limit: 5 });
  assert.ok("error" in parseCheckArgs([ORG, "--limit=6"]) && "error" in parseCheckArgs([]));

  const sc = readFileSync("scripts/avatar-proxy-check.ts", "utf8");
  const code = sc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.doesNotMatch(code, /\.(insert|update|delete)\(|method: "(POST|PUT|PATCH|DELETE)"|facebook\.com|graph\.facebook/, "chỉ đọc, chỉ GET, không Facebook");
  assert.match(code, /avatarProxyRefFor\(r\.state, r\)/, "ref bằng CÙNG hàm với hộp thư / route");
  assert.match(code, /avatarFetchUrl\(ref, r\.pageId, token\)/, "URL bằng CÙNG hàm với route");
  assert.match(code, /fetchAvatarImage\(first, fetch\)/, "đường thật = lib nguyên vẹn");
  assert.doesNotMatch(code, /tomTat\([^\n]*\$\{(token|first|next|loc|r\.id|r\.threadId|pageId)\b/, "tóm tắt không nhận token / URL / mã");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- avatar-proxy-check\s+#/);
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bavatar-proxy-check\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bavatar-proxy-check\b/);
  assert.match(ops, /avatar-proxy-check\)\n[\s\S]*?scripts\/avatar-proxy-check\.ts ;;/);
  console.log("  ✓ token đi đúng thứ tự route và nói nhánh dừng · dòng bước không URL / token / mã · chỉ đọc, chỉ GET, dùng chính lib · ops khai đủ bốn chỗ");
}
