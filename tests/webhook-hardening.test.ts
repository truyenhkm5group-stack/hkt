import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";
import {
  PANCAKE_WEBHOOK_MAX_BODY_BYTES,
  SEPAY_WEBHOOK_MAX_BODY_BYTES,
  VTP_STATEMENT_MAX_BODY_BYTES,
  VTP_STATEMENT_MAX_UNAUTHENTICATED_READS,
  VTP_WEBHOOK_MAX_BODY_BYTES,
} from "@/lib/constants/webhook-limits";
import { concurrencyGate, readBodyCapped } from "@/lib/http/body-limit";
import { POST as vtpPost } from "@/app/api/webhooks/viettelpost/route";
import { POST as statementPost } from "@/app/api/webhooks/vtp-statement/route";

/**
 * ═══════════ WEBHOOK: TRẦN BODY + XÁC THỰC TRƯỚC KHI ĐỌC ═══════════
 *
 * Trước đây `/api/webhooks/viettelpost` và `/api/webhooks/vtp-statement` đọc + parse TOÀN BỘ body của
 * bất kỳ ai rồi mới hỏi bí mật. Khối này khoá:
 *  1. `readBodyCapped` từ chối theo `content-length` mà KHÔNG kéo một byte, và cắt luồng chunked vượt trần.
 *  2. Route trả 413 / 401 / 429 đúng lúc — kể cả khi body là một luồng KHÔNG BAO GIỜ KẾT THÚC.
 *  3. `deploy/Caddyfile` khai đúng các trần của `lib/constants/webhook-limits.ts` và che bí mật trong log.
 */

const SECRET = "bi-mat-kiem-thu-0123456789";

/** Bỏ chú thích trước khi quét: một đoạn GIẢI THÍCH về cái bẫy không phải là cái bẫy. */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Luồng mà nếu bị đọc sẽ làm bài kiểm biết (đếm số lần kéo). */
function streamOf(chunks: Uint8Array[], counter: { pulls: number }, endless = false): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      counter.pulls += 1;
      if (endless) {
        ctrl.enqueue(new Uint8Array(64 * 1024));
        return;
      }
      if (i < chunks.length) ctrl.enqueue(chunks[i++]);
      else ctrl.close();
    },
  });
}

function req(url: string, init: { body?: ReadableStream<Uint8Array> | string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, { method: "POST", body: init.body, headers: init.headers, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
}

/** Đọc số byte của một khai báo `max_size` gắn với matcher có đường dẫn cho trước. */
function caddyMaxSize(caddy: string, pathPrefix: string): number | null {
  const m = new RegExp(String.raw`@(\w+) path ${pathPrefix.replace(/[/*]/g, (c) => "\\" + c)}[^\n]*\n\s*request_body @\1 \{[\s\S]*?max_size (\d+)`).exec(caddy);
  return m ? Number(m[2]) : null;
}

export async function testWebhookHardening() {
  // ── 1. readBodyCapped ──
  {
    const c = { pulls: 0 };
    const r = await readBodyCapped(new Request("http://x/", { method: "POST", body: streamOf([new Uint8Array(10)], c), headers: { "content-length": "999999" }, duplex: "half" } as RequestInit), 1000);
    assert.equal(r.ok, false, "content-length vượt trần ⇒ từ chối");
    assert.ok(c.pulls <= 1, `từ chối theo content-length KHÔNG được đọc body (đã kéo ${c.pulls} lần)`);
  }
  {
    const c = { pulls: 0 };
    const r = await readBodyCapped(new Request("http://x/", { method: "POST", body: streamOf([], c, true), duplex: "half" } as RequestInit), 256 * 1024);
    assert.equal(r.ok, false, "luồng chunked vô tận ⇒ cắt ở trần, không treo");
    assert.ok(c.pulls < 20, `phải dừng ngay sau khi vượt trần (đã kéo ${c.pulls} lần)`);
  }
  {
    const r = await readBodyCapped(new Request("http://x/", { method: "POST", body: "xin chào — tiếng Việt" }), 1000);
    assert.ok(r.ok && r.text === "xin chào — tiếng Việt", "dưới trần ⇒ đọc đủ, giải mã UTF-8 đúng");
  }
  const g = concurrencyGate(2);
  assert.deepEqual([g.tryEnter(), g.tryEnter(), g.tryEnter()], [true, true, false]);
  g.leave();
  assert.equal(g.tryEnter(), true);

  // ── 2. Route ──
  const truoc = process.env.VIETTELPOST_WEBHOOK_SECRET;
  process.env.VIETTELPOST_WEBHOOK_SECRET = SECRET;
  try {
    // VTP: body quá cỡ bị từ chối theo content-length, không đọc.
    {
      const c = { pulls: 0 };
      const r = await vtpPost(req("http://erp.test/api/webhooks/viettelpost", { body: streamOf([new Uint8Array(8)], c), headers: { "content-length": String(VTP_WEBHOOK_MAX_BODY_BYTES + 1) } }));
      assert.equal(r.status, 413);
      assert.ok(c.pulls <= 1, "webhook VTP không được đọc body khai vượt trần");
    }
    // VTP: luồng vô tận của kẻ lạ ⇒ 413, không treo, không cấp phát vô hạn.
    {
      const c = { pulls: 0 };
      const r = await vtpPost(req("http://erp.test/api/webhooks/viettelpost", { body: streamOf([], c, true) }));
      assert.equal(r.status, 413);
      assert.ok(c.pulls * 64 * 1024 <= VTP_WEBHOOK_MAX_BODY_BYTES + 128 * 1024, "đọc không quá trần + một khúc");
    }
    // VTP: sai bí mật (trong body lẫn ngoài) ⇒ 401; đúng TOKEN trong body vẫn là cách Viettel Post gửi.
    {
      const r = await vtpPost(req("http://erp.test/api/webhooks/viettelpost", { body: JSON.stringify({ DATA: { ORDER_NUMBER: "X1" }, TOKEN: "sai" }) }));
      assert.equal(r.status, 401);
      const r2 = await vtpPost(req("http://erp.test/api/webhooks/viettelpost?token=sai", { body: JSON.stringify({ DATA: { ORDER_NUMBER: "X1" } }) }));
      assert.equal(r2.status, 401);
    }

    // Bảng kê: bí mật đúng ở HEADER ⇒ qua xác thực mà body không cần mang token (lượt nhịp tim).
    {
      const r = await statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body: JSON.stringify({ files: [], ping: true, source: "kiem-thu" }), headers: { "x-webhook-secret": SECRET } }));
      assert.equal(r.status, 200, "bí mật ở header phải đủ — script mới không cần token trong body");
    }
    // Bảng kê: script cũ, token trong body ⇒ vẫn chạy.
    {
      const r = await statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body: JSON.stringify({ files: [], ping: true, source: "kiem-thu", token: SECRET }) }));
      assert.equal(r.status, 200, "script Gmail đã cài (token trong body) không được gãy");
    }
    // Bảng kê: khai vượt trần ⇒ 413 trước khi đọc.
    {
      const c = { pulls: 0 };
      const r = await statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body: streamOf([new Uint8Array(8)], c), headers: { "content-length": String(VTP_STATEMENT_MAX_BODY_BYTES + 1), "x-webhook-secret": SECRET } }));
      assert.equal(r.status, 413);
      assert.ok(c.pulls <= 1);
    }
    // Bảng kê: kẻ lạ không có bí mật ngoài body chỉ giữ được N lượt đọc song song; lượt thứ N+1 ⇒ 429 NGAY.
    {
      const treo: { ctrl: ReadableStreamDefaultController<Uint8Array> | null }[] = [];
      const dang: Promise<Response>[] = [];
      for (let i = 0; i < VTP_STATEMENT_MAX_UNAUTHENTICATED_READS; i++) {
        const h: { ctrl: ReadableStreamDefaultController<Uint8Array> | null } = { ctrl: null };
        treo.push(h);
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            h.ctrl = ctrl;
            ctrl.enqueue(new TextEncoder().encode('{"files":[],"token":"'));
          },
        });
        dang.push(statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body })));
      }
      await new Promise((r) => setTimeout(r, 20));
      const thua = await statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body: JSON.stringify({ files: [], token: "sai" }) }));
      assert.equal(thua.status, 429, "quá số lượt đọc chưa xác thực song song ⇒ 429, không xếp hàng giữ kết nối");
      const coHeader = await statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body: JSON.stringify({ files: [], ping: true, source: "kiem-thu" }), headers: { "x-webhook-secret": SECRET } }));
      assert.equal(coHeader.status, 200, "lượt có bí mật ở header không bị kẻ lạ chiếm chỗ");
      for (const h of treo) {
        h.ctrl?.enqueue(new TextEncoder().encode('sai"}'));
        h.ctrl?.close();
      }
      const kq = await Promise.all(dang);
      assert.deepEqual(kq.map((r) => r.status), kq.map(() => 401), "lượt treo xong thì bị 401 vì bí mật sai");
      const sau = await statementPost(req("http://erp.test/api/webhooks/vtp-statement", { body: JSON.stringify({ files: [], token: "sai" }) }));
      assert.equal(sau.status, 401, "chỗ đã được trả lại sau khi lượt treo kết thúc (không rò bộ đếm)");
    }
  } finally {
    if (truoc === undefined) delete process.env.VIETTELPOST_WEBHOOK_SECRET;
    else process.env.VIETTELPOST_WEBHOOK_SECRET = truoc;
  }

  // ── 3. Caddyfile khớp hằng số + che bí mật trong log ──
  const caddy = readFileSync("deploy/Caddyfile", "utf8");
  assert.equal(VTP_STATEMENT_MAX_BODY_BYTES, MAX_LIST_FILES * (MAX_LIST_BASE64 + 1024) + 64 * 1024, "trần bảng kê DẪN XUẤT từ trần nhập tệp");
  assert.equal(caddyMaxSize(caddy, "/api/webhooks/viettelpost"), VTP_WEBHOOK_MAX_BODY_BYTES, "Caddyfile: trần webhook VTP phải khớp hằng số");
  assert.equal(caddyMaxSize(caddy, "/api/webhooks/vtp-statement"), VTP_STATEMENT_MAX_BODY_BYTES, "Caddyfile: trần bảng kê phải khớp hằng số (đổi MAX_LIST_* thì sửa Caddyfile)");
  assert.equal(caddyMaxSize(caddy, "/api/webhooks/pancake/*"), PANCAKE_WEBHOOK_MAX_BODY_BYTES, "Caddyfile: trần webhook Pancake phải khớp hằng số");
  assert.equal(caddyMaxSize(caddy, "/api/webhooks/sepay"), SEPAY_WEBHOOK_MAX_BODY_BYTES, "Caddyfile: trần webhook SePay phải khớp hằng số");
  const regexpLine = /request>uri regexp "([^"]+)" "([^"]+)"/.exec(caddy);
  assert.ok(regexpLine, "log Caddy phải lọc request>uri");
  // Chạy chính biểu thức trong Caddyfile (cú pháp RE2 ⊂ JS, trừ cờ nội tuyến `(?i:` — đổi sang cờ i).
  const re = new RegExp(regexpLine[1].replace("(?i:", "(?:"), "gi");
  const thay = (s: string) => s.replace(re, (_m, a: string | undefined, b: string | undefined) => `${a ?? ""}${b ?? ""}REDACTED`);
  assert.equal(thay("/api/webhooks/pancake/abcSECRET/orders?x=1"), "/api/webhooks/pancake/REDACTED/orders?x=1");
  assert.equal(thay("/api/webhooks/viettelpost?token=abc&x=1"), "/api/webhooks/viettelpost?token=REDACTED&x=1");
  assert.equal(thay("/api/webhooks/vtp-statement?x=1&SECRET=abc"), "/api/webhooks/vtp-statement?x=1&SECRET=REDACTED");
  assert.equal(thay("/orders?page=2"), "/orders?page=2", "URL thường không bị đụng");
  for (const h of ["X-Webhook-Secret", "X-Token", "Token", "Secret", "X-Api-Key", "X-Cron-Secret"]) {
    assert.ok(caddy.includes(`request>headers>${h} delete`), `log Caddy phải xoá header ${h}`);
  }

  // Xác thực TRƯỚC khi đọc: không route webhook nào còn gọi request.text()/json() trần.
  for (const tep of ["app/api/webhooks/viettelpost/route.ts", "app/api/webhooks/vtp-statement/route.ts", "app/api/webhooks/sepay/route.ts", "app/api/webhooks/pancake/[secret]/[[...event]]/route.ts"]) {
    const src = boChuThich(readFileSync(tep, "utf8"));
    assert.ok(!/request\.(text|json|arrayBuffer)\(\)/.test(src), `${tep} phải đọc body qua readBodyCapped, không đọc trần`);
    assert.ok(src.includes("readBodyCapped("), `${tep} phải dùng readBodyCapped`);
  }
  console.log("✓ webhook: trần body (content-length + luồng) · 401/413/429 đúng lúc · bí mật header kiểm trước khi đọc · Caddyfile khớp hằng số và che bí mật trong log");
}
