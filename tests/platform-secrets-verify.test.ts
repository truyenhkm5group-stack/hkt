/**
 * ops `platform-secrets-verify` — kiểm `PLATFORM_SECRETS_KEY` trên production không cần đăng nhập giao diện
 * (docs/platform/launch-gates.md A.5). Chạy CHÍNH hàm của script trên PGlite với một khoá giả:
 *  1. chưa niêm ⇒ không hỏng, chỉ báo chưa có canary; `seal` thiếu `--apply` ⇒ hỏng, không ghi;
 *  2. `seal --apply` ⇒ lưu đúng một dòng settings, bản rõ KHÔNG nằm trong dòng đó (kể cả base64 / hex);
 *  3. verify ⇒ giải lại được, giải chéo tổ chức / connector bị từ chối, log sạch ⇒ ĐẠT;
 *  4. phép quét log KHÔNG mù: log chứa khoá gốc ⇒ HỎNG;
 *  5. `rotate --apply` ⇒ đời 2, bản mã cũ không còn;
 *  6. khoá đổi (không PREVIOUS) ⇒ canary không giải được ⇒ HỎNG (fail closed, không bao giờ ra bản rõ rác);
 *  7. thiếu khoá ⇒ HỎNG ngay mục 1;
 *  8. mã nguồn: không `console.*` nào ngoài dòng in kết quả; ops-vps khai đúng khuôn (mã hoá, làn đọc nặng, log vào stdin).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { CANARY_SETTING_KEY, countHits, formatLines, needlesOf, runSecretsVerify, type CanaryRecord } from "@/scripts/platform-secrets-verify";

async function canaryRow() {
  const db = await getPlatformDb();
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, CANARY_SETTING_KEY)).limit(1);
  return row ?? null;
}

async function dropCanary() {
  const db = await getPlatformDb();
  await db.delete(schema.settings).where(eq(schema.settings.key, CANARY_SETTING_KEY));
}

const line = (r: Awaited<ReturnType<typeof runSecretsVerify>>, prefix: string) => r.lines.find((l) => l.text.startsWith(prefix));

export async function testPlatformSecretsVerify() {
  // Thuần: kim tìm cả base64 / hex, bỏ kim ngắn.
  assert.deepEqual(needlesOf(["abc"]), [], "kim < 8 ký tự bị bỏ — tránh báo động giả");
  const n = needlesOf(["secret-value-123"]);
  assert.equal(n.length, 3);
  assert.equal(countHits(`x ${Buffer.from("secret-value-123").toString("base64")} y`, n), 1, "bắt được dạng base64");
  assert.equal(countHits(`x ${Buffer.from("secret-value-123").toString("hex")} y`, n), 1, "bắt được dạng hex");

  const saved = { key: process.env.PLATFORM_SECRETS_KEY, prev: process.env.PLATFORM_SECRETS_KEY_PREVIOUS };
  const MASTER = randomBytes(48).toString("base64");
  process.env.PLATFORM_SECRETS_KEY = MASTER;
  delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
  await dropCanary();
  try {
    const r0 = await runSecretsVerify({ mode: "verify", apply: false, logText: null });
    assert.equal(r0.failed, 0, JSON.stringify(r0.lines));
    assert.equal(line(r0, "4 ·")?.ok, null, "chưa niêm ⇒ báo chưa có, không kết luận");

    const noApply = await runSecretsVerify({ mode: "seal", apply: false, logText: null });
    assert.ok(noApply.failed > 0, "seal thiếu --apply ⇒ hỏng");
    assert.equal(await canaryRow(), null, "thiếu --apply ⇒ không ghi dòng nào");

    const sealed = await runSecretsVerify({ mode: "seal", apply: true, logText: null });
    assert.equal(sealed.failed, 0, JSON.stringify(sealed.lines));
    assert.equal(line(sealed, "2 ·")?.ok, true);
    const row = await canaryRow();
    assert.ok(row);
    const rec = JSON.parse(row.value) as CanaryRecord;
    assert.equal(rec.generation, 1);
    assert.ok(!row.value.includes(MASTER), "dòng canary không chứa khoá gốc");
    assert.equal(line(sealed, "3 · CSDL")?.ok, true, "bản rõ không nằm trong dòng canary");

    const again = await runSecretsVerify({ mode: "seal", apply: true, logText: null });
    assert.equal(JSON.parse((await canaryRow())!.value).digest, rec.digest, "niêm lại không đè canary đang có");
    assert.equal(again.failed, 0);

    const clean = await runSecretsVerify({ mode: "verify", apply: false, logText: "GET /api/health 200\nPOST /login 303\n" });
    assert.equal(clean.failed, 0, JSON.stringify(clean.lines));
    assert.equal(line(clean, "4 ·")?.ok, true, "giải lại canary đã lưu");
    assert.equal(line(clean, "5 ·")?.ok, true, "giải chéo bị từ chối");
    assert.equal(line(clean, "8 ·")?.ok, true, "log sạch");

    const dirty = await runSecretsVerify({ mode: "verify", apply: false, logText: `lỡ in: ${MASTER}\n` });
    assert.equal(line(dirty, "8 ·")?.ok, false, "log chứa khoá gốc ⇒ HỎNG — phép quét không mù");
    assert.ok(dirty.failed > 0);

    const rotated = await runSecretsVerify({ mode: "rotate", apply: true, logText: null });
    assert.equal(rotated.failed, 0, JSON.stringify(rotated.lines));
    const rec2 = JSON.parse((await canaryRow())!.value) as CanaryRecord;
    assert.equal(rec2.generation, 2);
    assert.notEqual(rec2.ciphertext, rec.ciphertext, "bản mã cũ không còn");
    assert.notEqual(rec2.digest, rec.digest, "giá trị đã đổi");

    process.env.PLATFORM_SECRETS_KEY = randomBytes(48).toString("base64");
    const wrongKey = await runSecretsVerify({ mode: "verify", apply: false, logText: null });
    assert.equal(line(wrongKey, "4 ·")?.ok, false, "khoá đổi mà không PREVIOUS ⇒ canary không giải được (fail closed)");

    delete process.env.PLATFORM_SECRETS_KEY;
    const missing = await runSecretsVerify({ mode: "verify", apply: false, logText: null });
    assert.equal(line(missing, "1 ·")?.ok, false, "thiếu khoá ⇒ HỎNG ngay mục 1");

    // Không dòng in ra nào mang khoá gốc hay bản mã.
    for (const r of [sealed, clean, rotated]) for (const l of formatLines(r)) assert.ok(!l.includes(MASTER) && !l.includes(rec.ciphertext.slice(0, 24)), l);
  } finally {
    if (saved.key === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = saved.key;
    if (saved.prev === undefined) delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
    else process.env.PLATFORM_SECRETS_KEY_PREVIOUS = saved.prev;
    await dropCanary();
  }

  const src = readFileSync("scripts/platform-secrets-verify.ts", "utf8");
  const consoles = src.match(/console\.\w+\(/g) ?? [];
  assert.equal(consoles.length, 3, "chỉ ba lời in: dòng kết quả đã định dạng + lỗi vào phần mã hoá + một câu lỗi cố định ở kênh tóm tắt");
  assert.ok(!/\[ops:tom-tat\][^\n]*\$\{e/.test(src), "kênh tóm tắt không bao giờ mang nội dung lỗi");
  const yml = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(yml, /^\s+- platform-secrets-verify\s+#/m, "có trong options");
  assert.match(yml, /OPS_THAO_TAC_MA_HOA: "[^"]*\bplatform-secrets-verify\b/, "kết quả mã hoá như mọi thao tác chạm CSDL");
  assert.match(yml, /DOC_NANG="[^"]*\bplatform-secrets-verify\b/, "arg rỗng = làn đọc; seal/rotate mang --apply ⇒ làn GHI");
  assert.match(yml, /docker logs --since 72h erp-app; docker logs --since 72h erp-scheduler; \} 2>&1 \| ma_hoa_ket_qua chay_voi_arg docker exec -i erp-app npx tsx --tsconfig tsconfig\.json scripts\/platform-secrets-verify\.ts/, "log đi vào STDIN của script, không ra log công khai");
  console.log("✓ ops platform-secrets-verify: chưa niêm không kết luận · seal cần --apply · canary lưu không chứa bản rõ / khoá · giải lại + giải chéo bị từ chối · quét log bắt được khoá gốc · rotate đổi đời và xoá bản mã cũ · khoá đổi / thiếu ⇒ HỎNG · không in bí mật");
}
