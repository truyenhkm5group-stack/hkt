/**
 * ═══════ MỌI WEBHOOK MANG BÍ MẬT TRÊN ĐƯỜNG DẪN PHẢI ĐƯỢC CHE TRONG LOG CADDY ═══════
 *
 * `tests/webhook-hardening.test.ts` (mục 3) kiểm biểu thức che log của `deploy/Caddyfile` bằng một danh sách
 * GÕ TAY (`pancake-org`, `viettelpost-org`, `zalo-oa`). Danh sách thứ hai ấy không lớn theo cây route: ngày
 * `app/api/webhooks/ghn-org/[token]` và `ghtk-org/[token]` ra đời, không ai thêm chúng vào Caddyfile, và cũng
 * không bài kiểm nào đỏ — token webhook theo tổ chức của GHN / GHTK đi thẳng vào log truy cập.
 *
 * Bài này DẪN XUẤT danh sách từ chính cây `app/api/webhooks`: mọi đoạn động tên `[token]` / `[secret]` (hoặc
 * chứa `key`) là bí mật. Với mỗi route, dựng một URL mẫu mang chuỗi CANH (canary) ở đúng vị trí bí mật, chạy
 * qua CHÍNH biểu thức trong Caddyfile, và đòi chuỗi canh không còn trong kết quả. Thêm route webhook mới mang
 * token trên đường dẫn mà quên Caddyfile ⇒ bài này đỏ, kèm tên route.
 *
 * Chỉ dùng module có sẵn của Node (không import mã ứng dụng), nên chạy được cả trong cây chưa `npm ci`:
 *   node tests/webhook-log-redaction.test.ts        (Node ≥ 23.6 tự bỏ kiểu TS)
 *   npx tsx tests/webhook-log-redaction.test.ts
 *
 * Ghi chú cú pháp: Caddy dùng RE2. Giống `webhook-hardening.test.ts`, cờ nội tuyến `(?i:` được đổi thành nhóm
 * thường + cờ `i` cho cả biểu thức — phép đổi này làm phần đường dẫn cũng không phân biệt hoa thường, tức là
 * bài kiểm có thể XANH hơn Caddy thật ở chỗ hoa thường, không bao giờ đỏ hơn.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const WEBHOOK_ROOT = path.join("app", "api", "webhooks");
const CANARY = "CANARY_tok3n_Zx9";
const SECRET_SEGMENT = /^\[(?:token|secret|[a-z]*key[a-z]*)\]$/i;

/** Mọi thư mục chứa `route.ts` dưới `app/api/webhooks`, dạng đoạn đường dẫn (luôn `/`, kể cả trên Windows). */
function webhookRoutes(): string[][] {
  const out: string[][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") out.push(path.relative(WEBHOOK_ROOT, dir).split(path.sep).join("/").split("/").filter(Boolean));
    }
  };
  walk(WEBHOOK_ROOT);
  return out.sort((a, b) => a.join("/").localeCompare(b.join("/")));
}

/** URL mẫu: đoạn bí mật ⇒ chuỗi canh; đoạn động khác (`[[...event]]`, `[id]`) ⇒ chữ thường vô hại. */
function sampleUrl(segments: string[]): string {
  const parts = segments.map((s) => (SECRET_SEGMENT.test(s) ? `hslc.${CANARY}` : s.startsWith("[") ? "orders" : s));
  return `/api/webhooks/${parts.join("/")}?x=1`;
}

function caddyRedactor(caddyfile: string): (uri: string) => string {
  const line = /request>uri regexp "([^"]+)" "([^"]+)"/.exec(caddyfile);
  assert.ok(line, "deploy/Caddyfile phải có bộ lọc `request>uri regexp` cho log truy cập");
  const re = new RegExp(line[1].replace("(?i:", "(?:"), "gi");
  return (uri) => uri.replace(re, (_m, a: string | undefined, b: string | undefined) => `${a ?? ""}${b ?? ""}REDACTED`);
}

export function testWebhookLogRedaction(): void {
  const redact = caddyRedactor(readFileSync(path.join("deploy", "Caddyfile"), "utf8"));
  const routes = webhookRoutes();
  const secretRoutes = routes.filter((segs) => segs.some((s) => SECRET_SEGMENT.test(s)));

  // Lá chắn của chính bài kiểm: dò route rỗng thì mọi khẳng định bên dưới xanh vô nghĩa.
  assert.ok(routes.length >= 5, `phải tìm thấy route webhook dưới ${WEBHOOK_ROOT} (thấy ${routes.length})`);
  assert.ok(secretRoutes.length >= 3, `phải tìm thấy route webhook mang bí mật trên đường dẫn (thấy ${secretRoutes.length})`);

  // Bí mật trên QUERY vẫn được che (hợp đồng cũ, giữ để bài này đứng một mình được).
  assert.equal(redact("/api/webhooks/viettelpost?token=abc&x=1"), "/api/webhooks/viettelpost?token=REDACTED&x=1");
  assert.equal(redact(`/api/webhooks/sepay?SECRET=${CANARY}`), "/api/webhooks/sepay?SECRET=REDACTED");

  const leaks: string[] = [];
  for (const segs of secretRoutes) {
    const url = sampleUrl(segs);
    const logged = redact(url);
    if (logged.includes(CANARY)) leaks.push(`${segs.join("/")}  →  ${logged}`);
  }
  assert.deepEqual(
    leaks,
    [],
    `Caddyfile KHÔNG che token trên đường dẫn của ${leaks.length}/${secretRoutes.length} route webhook (token lọt vào log truy cập):\n  ${leaks.join("\n  ")}\n` +
      "Sửa: thêm tiền tố của route vào nhóm `(/api/webhooks/(?:…))` trong `request>uri regexp` của deploy/Caddyfile.",
  );
  console.log(`✓ log Caddy che token trên đường dẫn của cả ${secretRoutes.length} route webhook mang bí mật (dẫn xuất từ cây route, không gõ tay)`);
}

if (/webhook-log-redaction\.test\.ts$/.test(process.argv[1] ?? "")) {
  try {
    testWebhookLogRedaction();
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
