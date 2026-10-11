/**
 * ═══════════ OPS `pancake-avatar-shape` — DÁNG PAYLOAD PANCAKE, KHÔNG GIÁ TRỊ (11/10/2026) ═══════════
 *
 * Sau #791 production đo «ref 0 · NO_AVATAR_FIELD 50 · POLL 36»: lõi đọc sai khoá ảnh. Script đo dáng thật trên API Pancake của MỘT
 * tổ chức. Bài kiểm khoá điều duy nhất quan trọng của một script chạy trên dữ liệu thật trong kho PUBLIC: nó KHÔNG in giá trị — tên,
 * SĐT, mã khách / page, chữ tin, token — kể cả trong khoá đối tượng trông như mã; URL chỉ còn host + có/không khoá + đường đã che.
 * Cộng: script chỉ đọc (Postgres ép + hỏi lại), chỉ GET, không dựng facebook.com, không gọi Graph; ops-vps khai đủ bốn chỗ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { avatarishLines, chunkJoin, describeProbe, describeString, groupProbes, maskBodySnippet, maskKey, maskUrlPath, parseShapeArgs, pathsUnder, probeTargets, shapeLines, walkShape, type Shape } from "@/scripts/pancake-avatar-shape";

const TOKEN = "PAGE_TOKEN_BI_MAT_ABCDEF123456";
const NAME = "Nguyễn Thị Lan";
const PHONE = "0912345678";
const PSID = "25000000000000001";
const PAGE = "110000000000001";

export function testPancakeAvatarShape() {
  console.log("Ops pancake-avatar-shape (dáng payload Pancake, không giá trị):");
  assert.equal(maskKey(PSID), "<mã>");
  assert.equal(maskKey("abcdef0123456789xyz"), "<mã>");
  assert.equal(maskKey("page_customer"), "page_customer");
  assert.equal(maskUrlPath(`/api/v1/pages/${PAGE}/avatar/${PSID}`), "/api/v1/pages/<mã>/avatar/<mã>");
  assert.equal(maskUrlPath("/v/t1.30497-1/84628273_176159830277856_n.jpg"), "/v/<mã>/<tệp.jpg>");
  assert.equal(maskUrlPath("/nguyen.thi.lan"), "/<chữ>", "đoạn toàn chữ ngoài từ vựng (có thể là tên người dùng) ⇒ che");
  assert.equal(describeString("2026-10-11T03:00:00"), "mốc");
  assert.equal(describeString(NAME), `chuỗi(${NAME.length})`);
  const tokUrl = `https://pages.fm/api/v1/pages/${PAGE}/avatar/${PSID}?page_access_token=${TOKEN}`;
  assert.equal(describeString(tokUrl), `url(https host=pages.fm khoá=page_access_token dài=${tokUrl.length} đường=/api/v1/pages/<mã>/avatar/<mã>)`);
  assert.match(describeString("https://scontent.xx.fbcdn.net/v/a.jpg?oh=1&oe=2"), /host=scontent\.xx\.fbcdn\.net khoá=không/);

  // Payload đủ PII: không một giá trị nào lọt ra dòng in.
  const conv = {
    id: `${PAGE}_${PSID}`,
    type: "INBOX",
    snippet: "Cho em xin giá chả cá",
    updated_at: "2026-10-11T03:00:00",
    from: { id: PSID, name: NAME, email: "lan@example.com" },
    customers: [{ id: "c-0f1e2d3c4b5a69788796a5b4", fb_id: PSID, name: NAME, phone_numbers: [{ phone_number: PHONE }] }],
    page_customer: { avatar_url: `https://pages.fm/api/v1/pages/${PAGE}/avatar/${PSID}?page_access_token=${TOKEN}`, global_id: "100012345678901" },
    tags: { [PSID]: true },
    recent_phone_numbers: [PHONE],
  };
  const shape: Shape = new Map();
  walkShape(conv, "", shape);
  walkShape(conv, "", shape);
  const lines = shapeLines(shape);
  const all = lines.join("\n");
  for (const secret of [TOKEN, NAME, PHONE, PSID, PAGE, "lan@example.com", "100012345678901", "chả cá", "c-0f1e2d3c4b5a69788796a5b4"]) assert.ok(!all.includes(secret), `không in «${secret.slice(0, 8)}…»`);
  assert.ok(lines.some((l) => l.startsWith("★ page_customer.avatar_url · chuỗi · ×2 · url(https host=pages.fm khoá=page_access_token")), "khoá ảnh lạ vẫn được đánh dấu ★ kèm host + tên tham số khoá");
  assert.ok(lines.some((l) => l.startsWith("tags.<mã> · đúng/sai")), "khoá trông như mã bị che");
  assert.ok(lines.some((l) => l.startsWith("customers[].phone_numbers[].phone_number · chuỗi")));
  assert.deepEqual(avatarishLines(shape).map((l) => l.split(" · ")[0]), ["★ page_customer.avatar_url"]);

  assert.equal(describeProbe(302, "text/html; charset=utf-8", `https://scontent.xx.fbcdn.net/v/a.jpg?oh=${TOKEN}`, "https://pages.fm/a"), "HTTP 302 · kiểu=text/html → chuyển hướng tới host=scontent.xx.fbcdn.net");
  assert.equal(describeProbe(200, "image/jpeg", null, "https://pages.fm/a"), "HTTP 200 · kiểu=image/jpeg");
  // LƯỢT DÒ 2: thân lỗi đã che · biến thể điểm cuối · gộp kết quả · khoá khách trong phản hồi tin.
  const html = `<html><head><style>x{}</style></head><body><h1>406 Not Acceptable</h1><p>page ${PAGE} customer ${PSID} token ${TOKEN} mail lan@example.com sđt ${PHONE} key abcdef0123456789abcdef01</p></body></html>`;
  const snip = maskBodySnippet(html, [TOKEN, PAGE]);
  assert.ok(snip.startsWith("406 Not Acceptable"), snip);
  for (const secret of [TOKEN, PAGE, PSID, PHONE, "lan@example.com", "abcdef0123456789abcdef01"]) assert.ok(!snip.includes(secret), `thân đã che «${secret.slice(0, 6)}…»: ${snip}`);
  assert.ok(maskBodySnippet("x".repeat(500)).length <= 120, "trần 120 ký tự");
  assert.equal(maskBodySnippet('{"success":false,"message":"Not found"}'), '{"success":false,"message":"Not found"}');
  const targets = probeTargets(PAGE, PSID, `page_access_token=${TOKEN}`);
  assert.deepEqual(
    targets.map((t) => `${t.label}|${t.kind}`),
    [
      "api/v1 /pages/<page>/avatar/<id>|image",
      "api/v1 /pages/<page>/customers/<id>/avatar|image",
      "api/v1 /pages/<page>/page_customers/<id>|json",
      "public_api/v1 /pages/<page>/avatar/<id>|image",
      "public_api/v1 /pages/<page>/customers/<id>/avatar|image",
      "public_api/v1 /pages/<page>/page_customers/<id>|json",
    ],
  );
  assert.ok(targets.every((t) => /^https:\/\/pages\.fm\/api\/(v1|public_api\/v1)\/pages\//.test(t.url)), "chỉ hai gốc API của Pancake");
  assert.ok(targets.every((t) => !t.label.includes(PSID) && !t.label.includes(PAGE)), "nhãn không mang mã");
  assert.deepEqual(groupProbes(["a [*/*]: HTTP 406 · kiểu=text/html", "b [json]: HTTP 406 · kiểu=text/html", "c [*/*]: HTTP 302 · kiểu=— → chuyển hướng tới host=scontent.xx.fbcdn.net", "d: cùng giá trị với a — không thử lại"]), [
    "HTTP 406 · kiểu=text/html ×2 ← a [*/*] | b [json]",
    "HTTP 302 · kiểu=— → chuyển hướng tới host=scontent.xx.fbcdn.net ×1 ← c [*/*]",
    "d: cùng giá trị với a — không thử lại",
  ]);
  assert.deepEqual(chunkJoin(["aaaa", "bbbb", "cccc"], 10), ["aaaa, bbbb", "cccc"]);
  const msg: Shape = new Map();
  for (const [k, v] of Object.entries({ conv_customers: [{ fb_id: PSID, name: NAME, avatar: "https://content.pancake.vn/x/a.jpg" }], conv_from: { id: PSID, name: NAME }, customers: [{ id: "x" }], conversation_id: "y" })) walkShape(v, maskKey(k), msg);
  assert.deepEqual(pathsUnder(msg, "conv_customers"), ["conv_customers", "conv_customers[]", "conv_customers[].avatar", "conv_customers[].fb_id", "conv_customers[].name"]);
  assert.deepEqual(pathsUnder(msg, "conv_from"), ["conv_from", "conv_from.id", "conv_from.name"]);
  assert.ok(!pathsUnder(msg, "customers").some((p) => p.startsWith("conv_")), "tiền tố khớp đúng khoá, không khớp lẫn");

  assert.deepEqual(parseShapeArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", limit: 5 });
  assert.ok("error" in parseShapeArgs(["hslc", "--limit=6"]) && "error" in parseShapeArgs([]) && "error" in parseShapeArgs(["HSLC"]));

  // Mã nguồn: chỉ đọc, chỉ GET, không Graph / facebook.com, không in câu lỗi vào tóm tắt.
  const sc = readFileSync("scripts/pancake-avatar-shape.ts", "utf8");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.doesNotMatch(sc, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.doesNotMatch(sc, /method: "(POST|PUT|PATCH|DELETE)"/, "chỉ GET");
  assert.match(sc, /accept: kind === "json" \? "application\/json" : "\*\/\*"/, "lượt dò 2 không gửi accept: image/* (406 ở lượt 1)");
  assert.match(sc, /maskBodySnippet\(text, secrets\)/, "thân lỗi chỉ in bản đã che");
  assert.match(sc, /const secrets = \[token, pageId\]/);
  const code = sc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /graph\.facebook|facebook\.com/, "không Graph, không dựng facebook.com");
  assert.doesNotMatch(sc, /tomTat\([^\n]*\$\{(token|q|secrets|pageId|e\.message)\b/, "tóm tắt không bao giờ nhận token / mã page / câu lỗi");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- pancake-avatar-shape\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bpancake-avatar-shape\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bpancake-avatar-shape\b/, "làn ĐỌC nặng");
  assert.match(ops, /pancake-avatar-shape\)\n[\s\S]*?scripts\/pancake-avatar-shape\.ts ;;/, "nhánh chạy");
  console.log("  ✓ chỉ in đường khoá + kiểu + dạng (host · tên tham số khoá · đường đã che) — không tên / SĐT / mã / token · chỉ đọc, chỉ GET · ops khai đủ bốn chỗ");
}
