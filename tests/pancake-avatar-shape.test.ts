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
import { avatarishLines, describeProbe, describeString, maskKey, maskUrlPath, parseShapeArgs, shapeLines, walkShape, type Shape } from "@/scripts/pancake-avatar-shape";

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
  assert.deepEqual(parseShapeArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", limit: 5 });
  assert.ok("error" in parseShapeArgs(["hslc", "--limit=6"]) && "error" in parseShapeArgs([]) && "error" in parseShapeArgs(["HSLC"]));

  // Mã nguồn: chỉ đọc, chỉ GET, không Graph / facebook.com, không in câu lỗi vào tóm tắt.
  const sc = readFileSync("scripts/pancake-avatar-shape.ts", "utf8");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.doesNotMatch(sc, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.doesNotMatch(sc, /method: "(POST|PUT|PATCH|DELETE)"/, "chỉ GET");
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
