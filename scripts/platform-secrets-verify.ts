/*
  ops `platform-secrets-verify` — KIỂM `PLATFORM_SECRETS_KEY` TRÊN PRODUCTION, KHÔNG CẦN ĐĂNG NHẬP GIAO DIỆN.

  Checklist sau khi chủ nền tảng đặt khoá (docs/platform/launch-gates.md A.5, V1–V7) cần trả lời tám câu trên ĐÚNG khoá
  và ĐÚNG CSDL của production. Nút «Tự kiểm khoá bí mật» ở /platform chỉ kiểm trong bộ nhớ và cần một phiên người vận
  hành; script này chạy trong container `erp-app` với chính biến môi trường của ứng dụng:

    · `seal --apply`   — niêm một CANARY ngẫu nhiên bằng đúng `sealSecrets` (AES-256-GCM, AAD gắn tổ chức + connector,
                         khoá của production) rồi LƯU bản mã vào `settings` của CSDL nhà (khoá `platform.secrets.canary`).
                         Không lưu, không in bản rõ — chỉ sha256 của nó để lượt sau đối chiếu.
    · (không arg)      — CHỈ ĐỌC: giải lại canary đã lưu (qua deploy / khởi động lại ⇒ khoá bền), đòi giải CHÉO tổ chức /
                         connector phải bị TỪ CHỐI, quét bản mã trong CSDL không chứa bản rõ, và (nếu stdin có log)
                         quét log không chứa bản rõ nào lẫn giá trị khoá gốc. KHÔNG đọc `org_connections` — bí mật kết
                         nối thật chỉ có một đường giải mã (`lib/connectors/service.ts`).
    · `rotate --apply` — «cập nhật bí mật»: giải canary cũ, niêm giá trị MỚI, lưu đè, rồi chứng minh bản mã cũ không còn
                         trong CSDL và giá trị mới giải đúng.

  KHÔNG in: bản rõ, khoá, khoá dẫn xuất, bản mã. In: ✓/✗, số đếm, 8 ký tự đầu của MÃ khoá (HMAC — đã công khai ở
  /api/health), mốc thời gian, commit. Mọi dòng người vận hành cần thấy đi qua kênh `[ops:tom-tat] `.

  KHÔNG chạm `org_connections` và không đổi credential của VNX (VNX dùng biến môi trường, không dùng
  bảng này). Canary mang tổ chức GIẢ `__canary__` — không phải mã tổ chức hợp lệ, không trùng tổ chức thật nào.

  CHỈ import tệp `lib/` ĐÃ CÓ trên ảnh đang chạy (ops lấy script từ `main`, `lib/` từ container).
  Thoát khác 0 khi bất kỳ phép kiểm nào HỎNG.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("platform-secrets-verify.ts"));
const ARGS = process.argv.slice(2);
export type VerifyMode = "verify" | "seal" | "rotate";
const CLI_MODE: VerifyMode = ARGS.includes("seal") ? "seal" : ARGS.includes("rotate") ? "rotate" : "verify";
if (CHAY_THANG && CLI_MODE === "verify") process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { openSecrets, sealSecrets, secretsKeyHealth, secretsKeyState, SecretsDecryptError } from "@/lib/connectors/secrets";
import { integrationStatus } from "@/lib/env";

export const CANARY_SETTING_KEY = "platform.secrets.canary";
export const CANARY_ORG = "__canary__";
export const CANARY_CONNECTOR = "platform-canary";

export type CanaryRecord = {
  v: 1;
  ciphertext: string; // base64 của bản mã (định dạng của sealSecrets)
  keyId: string;
  digest: string; // sha256 hex của bản rõ — KHÔNG phải bản rõ
  sealedAt: string;
  sealCommit: string | null;
  generation: number;
  previousCipherDigest: string | null; // sha256 của bản mã đời trước (lượt rotate) — để chứng minh nó không còn
};

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

type Line = { ok: boolean | null; text: string };
let lines: Line[] = [];
const report = (ok: boolean | null, text: string) => lines.push({ ok, text });

/** Chuỗi kim cần tìm khi quét: bản rõ + các dạng mã hoá phổ biến của nó (base64, hex). Bỏ kim ngắn hơn 8 ký tự. */
export function needlesOf(values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v || v.length < 8) continue;
    out.add(v);
    out.add(Buffer.from(v, "utf8").toString("base64").replace(/=+$/, ""));
    out.add(Buffer.from(v, "utf8").toString("hex"));
  }
  return [...out].filter((n) => n.length >= 8);
}

export function countHits(haystack: string, needles: string[]): number {
  let n = 0;
  for (const k of needles) if (haystack.includes(k)) n++;
  return n;
}

async function readCanary(): Promise<CanaryRecord | null> {
  const db = await getPlatformDb();
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, CANARY_SETTING_KEY)).limit(1);
  if (!row) return null;
  try {
    const rec = JSON.parse(row.value) as CanaryRecord;
    return rec && rec.v === 1 ? rec : null;
  } catch {
    return null;
  }
}

async function writeCanary(rec: CanaryRecord) {
  const db = await getPlatformDb();
  const value = JSON.stringify(rec);
  await db.insert(schema.settings).values({ key: CANARY_SETTING_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

function sealCanary(generation: number, previousCipherDigest: string | null): { rec: CanaryRecord; plaintext: string } {
  const plaintext = randomBytes(32).toString("base64url");
  const { ciphertext, keyId } = sealSecrets({ canary: plaintext }, { orgCode: CANARY_ORG, connectorKey: CANARY_CONNECTOR });
  return {
    plaintext,
    rec: {
      v: 1,
      ciphertext: ciphertext.toString("base64"),
      keyId,
      digest: sha256(plaintext),
      sealedAt: new Date().toISOString(),
      sealCommit: process.env.ERP_COMMIT?.trim() || null,
      generation,
      previousCipherDigest,
    },
  };
}

function openCanary(rec: CanaryRecord, binding: { orgCode: string; connectorKey: string } = { orgCode: CANARY_ORG, connectorKey: CANARY_CONNECTOR }): string {
  return openSecrets(Buffer.from(rec.ciphertext, "base64"), { ...binding, keyId: rec.keyId }).canary ?? "";
}

/** Giải phải BỊ TỪ CHỐI. `true` = đúng là bị từ chối bằng SecretsDecryptError. */
function mustRefuse(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof SecretsDecryptError;
  }
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
}

export type VerifyResult = { failed: number; lines: Line[] };

/** Một lượt kiểm. `logText` = log ứng dụng cần quét (CLI đọc từ stdin); `null` = bỏ qua phép quét log. */
export async function runSecretsVerify(opts: { mode: VerifyMode; apply: boolean; logText: string | null }): Promise<VerifyResult> {
  lines = [];
  const MODE = opts.mode;
  const APPLY = opts.apply;
  // V1/V2 — production nhận được khoá.
  const health = secretsKeyHealth();
  if (health.secretsKey !== "ready") {
    report(false, `1 · Khoá: ${health.secretsKey} — container không có PLATFORM_SECRETS_KEY dùng được. Dừng.`);
    return finish(MODE);
  }
  report(true, `1 · Khoá: ready · mã khoá ${health.secretsKeyIdShort}… · PREVIOUS ${health.secretsKeyPrevious} · commit ${process.env.ERP_COMMIT?.slice(0, 12) || "—"}`);

  if ((MODE === "seal" || MODE === "rotate") && !APPLY) {
    report(false, `Chế độ ${MODE} GHI vào CSDL — thêm --apply (arg: "${MODE} --apply").`);
    return finish(MODE);
  }

  const needles: string[] = [];
  const envKey = process.env.PLATFORM_SECRETS_KEY?.trim();
  if (envKey) needles.push(envKey);

  let rec = await readCanary();

  if (MODE === "seal") {
    if (rec) {
      report(null, `Canary đã có (đời ${rec.generation}, niêm ${rec.sealedAt}) — không niêm lại; dùng "rotate --apply" để thay giá trị.`);
    } else {
      const s = sealCanary(1, null);
      await writeCanary(s.rec);
      const back = await readCanary();
      const ok = !!back && openCanary(back) === s.plaintext && sha256(openCanary(back)) === s.rec.digest;
      report(ok, `2 · Mã hoá + lưu: canary đời 1 niêm bằng khoá ${s.rec.keyId.slice(0, 8)}… và lưu vào settings.${CANARY_SETTING_KEY}; đọc lại từ CSDL giải ${ok ? "ĐÚNG" : "SAI"}`);
      rec = back;
      needles.push(s.plaintext);
    }
  }

  if (MODE === "rotate") {
    if (!rec) {
      report(false, `6 · Chưa có canary để cập nhật — chạy "seal --apply" trước.`);
      return finish(MODE);
    }
    const oldPlain = openCanary(rec);
    const oldCipherDigest = sha256(rec.ciphertext);
    const s = sealCanary(rec.generation + 1, oldCipherDigest);
    await writeCanary(s.rec);
    const back = await readCanary();
    const newOk = !!back && openCanary(back) === s.plaintext;
    const oldGone = !!back && sha256(back.ciphertext) !== oldCipherDigest && back.ciphertext !== rec.ciphertext;
    const differs = oldPlain !== s.plaintext;
    report(newOk && oldGone && differs, `6 · Cập nhật bí mật: đời ${rec.generation} → ${s.rec.generation}; giá trị mới giải ${newOk ? "ĐÚNG" : "SAI"}; bản mã cũ ${oldGone ? "không còn trong CSDL" : "VẪN CÒN"}; giá trị ${differs ? "đã đổi" : "KHÔNG đổi"}`);
    needles.push(oldPlain, s.plaintext);
    rec = back;
  }

  // 4 — giải lại bản mã ĐÃ LƯU (qua deploy / khởi động lại nếu commit lúc niêm khác commit đang chạy).
  if (!rec) {
    report(null, `4 · Chưa có canary — chạy ops với arg "seal --apply" một lần, rồi chạy lại sau deploy để kiểm độ bền của khoá.`);
  } else {
    let plain = "";
    let opened = false;
    try {
      plain = openCanary(rec);
      opened = sha256(plain) === rec.digest;
    } catch {
      opened = false;
    }
    if (plain) needles.push(plain);
    const current = process.env.ERP_COMMIT?.trim() || null;
    const acrossDeploy = rec.sealCommit && current && rec.sealCommit !== current;
    report(
      opened,
      `4 · Giải lại canary đã lưu (đời ${rec.generation}, niêm ${rec.sealedAt}, commit lúc niêm ${rec.sealCommit?.slice(0, 12) ?? "—"}): ${opened ? "ĐÚNG" : "HỎNG"}${acrossDeploy ? " — QUA deploy (commit đang chạy khác commit lúc niêm)" : " — cùng commit lúc niêm (chạy lại sau lượt deploy kế tiếp để kiểm độ bền)"}`,
    );

    // 5 — cô lập: bản mã của «tổ chức» này không giải được dưới tổ chức / connector khác.
    const crossOrg = mustRefuse(() => openCanary(rec!, { orgCode: "__canary_b__", connectorKey: CANARY_CONNECTOR }));
    const crossConnector = mustRefuse(() => openCanary(rec!, { orgCode: CANARY_ORG, connectorKey: "other-connector" }));
    const state = secretsKeyState();
    const a = sealSecrets({ x: randomBytes(16).toString("hex") }, { orgCode: "tenant-a", connectorKey: "lark-webhook" }, state);
    const aOnB = mustRefuse(() => openSecrets(a.ciphertext, { orgCode: "tenant-b", connectorKey: "lark-webhook", keyId: a.keyId }, state));
    report(crossOrg && crossConnector && aOnB, `5 · Cô lập: giải bằng tổ chức khác ${crossOrg ? "bị từ chối" : "LỌT"} · connector khác ${crossConnector ? "bị từ chối" : "LỌT"} · bí mật tenant-a mở dưới tenant-b ${aOnB ? "bị từ chối" : "LỌT"}`);

    // 3 — bản rõ không nằm trong CSDL: dòng settings của canary.
    const db = await getPlatformDb();
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, CANARY_SETTING_KEY)).limit(1);
    const hitsCanary = row ? countHits(row.value, needlesOf(plain ? [plain] : [])) : 0;
    report(hitsCanary === 0, `3 · CSDL: dòng canary chứa bản rõ ${hitsCanary === 0 ? "0 lần" : `${hitsCanary} DẠNG`} (tìm cả base64 / hex)`);
  }

  // Bí mật kết nối THẬT (`org_connections`) chỉ có MỘT đường giải mã — `lib/connectors/service.ts`
  // (`tests/connectors.test.ts` · testNoSecretPathsStatic). Script này không mở đường thứ hai: nó chỉ giải canary
  // tổng hợp của chính nó. Đường lưu / giải của kết nối thật được kiểm ở `tests/connectors.test.ts` (vòng đời bí mật)
  // và `tests/tenant-attack.test.ts` (tổ chức A không đọc được của B), chạy trên CI trước mỗi deploy.
  const st = integrationStatus();
  report(null, `7 · VNX (biến môi trường, không qua bảng này): Pancake ${st.pancake ? "có" : "không"} · Pancake Pages ${st.pancakePages ? "có" : "không"} · Viettel Post ${st.viettelPost ? "có" : "không"} · Facebook ${st.facebook ? "có" : "không"} — so với lượt trước khi đặt khoá; kết nối thật kiểm bằng ops check-integrations`);

  // 8 — log: nếu ops đưa log ứng dụng vào stdin, không được chứa bản rõ nào lẫn khoá gốc.
  const log = opts.logText;
  if (log === null) report(null, `8 · Log: không có log ở stdin — bỏ qua phép quét`);
  else {
    const hits = countHits(log, needlesOf(needles));
    report(hits === 0, `8 · Log ứng dụng: quét ${log.length.toLocaleString("vi-VN")} ký tự · ${needles.length} bí mật (kể cả khoá gốc) · xuất hiện ${hits} lần`);
  }
  return finish(MODE);
}

function finish(mode: VerifyMode): VerifyResult {
  const failed = lines.filter((l) => l.ok === false).length;
  lines.push({ ok: failed === 0, text: `${failed === 0 ? "KẾT LUẬN: ĐẠT" : `KẾT LUẬN: HỎNG ${failed} mục`} (chế độ ${mode})` });
  return { failed, lines };
}

export function formatLines(r: VerifyResult): string[] {
  return r.lines.map((l) => `[ops:tom-tat] ${l.ok === true ? "✓" : l.ok === false ? "✗" : "·"} ${l.text}`);
}

if (CHAY_THANG) {
  (async () => runSecretsVerify({ mode: CLI_MODE, apply: ARGS.includes("--apply"), logText: await readStdin() }))().then(
    (r) => {
      for (const line of formatLines(r)) console.log(line);
      process.exit(r.failed ? 1 : 0);
    },
    (e: unknown) => {
      // Chi tiết lỗi chỉ vào phần kết quả ĐÃ MÃ HOÁ (không đánh dấu tóm tắt); kênh công khai nhận một câu cố định.
      console.error(e);
      console.log("[ops:tom-tat] ✗ Lỗi khi chạy — chi tiết nằm trong kết quả đã mã hoá");
      process.exit(1);
    },
  );
}
