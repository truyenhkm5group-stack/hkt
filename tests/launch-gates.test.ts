import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════════ CỔNG MỞ BÁN A — `PLATFORM_SECRETS_KEY` ĐI ĐỦ BA CHẶNG, KHÔNG BAO GIỜ IN RA, RỖNG KHÔNG ĐÈ ═══════════
 *
 * docs/platform/launch-gates.md mục A. Trước bản này khoá CHỈ có đường tay (gõ vào `.env` trên VPS): chủ nền tảng thêm
 * secret GitHub `PLATFORM_SECRETS_KEY` rồi deploy thì… không có gì xảy ra — workflow không đọc nó, bootstrap không ghi
 * nó, và `/settings/connections` vẫn nói "chưa có khoá". Kiểu hỏng im lặng: người khai không có cách nào biết.
 *
 * Ba chặng + đích:
 *   1. `.github/workflows/deploy-vps.yml` — env của bước SSH đọc `secrets.PLATFORM_SECRETS_KEY`, tên có trong `envs`
 *      (appleboy chỉ chở biến có tên ở đó) VÀ trong `export` của script chạy trên VPS.
 *   2. `scripts/bootstrap.sh` — `exec bash scripts/install-vps.sh`: môi trường đi nguyên, không `env -i`, không `unset`.
 *   3. `scripts/install-vps.sh` — ghi vào `.env` CHỈ khi khác rỗng; rỗng ⇒ giữ nguyên giá trị cũ, không dòng rỗng.
 *   ⇒ `docker-compose.prod.yml` nạp `.env` vào container (`env_file: .env`).
 *
 * Phần hành vi của chặng 3 CHẠY THẬT dưới `bash -euo pipefail` (trích đúng `upsert_env` + khối khoá ra khỏi tệp), như
 * `tests/deploy-script.test.ts` — không mô phỏng bằng lời.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/launch-gates.test.ts
 */

const KEY = "PLATFORM_SECRETS_KEY";
const PREV = "PLATFORM_SECRETS_KEY_PREVIOUS";
const KEYS = [KEY, PREV] as const;
const goc = path.resolve(__dirname, "..");
const doc = (f: string) => readFileSync(path.join(goc, f), "utf8").replace(/\r\n/g, "\n");

/** Dòng nào CHẠM giá trị của khoá (không tính phép thử rỗng `[ -n "$KEY" ]`) mà lại in ra ⇒ vi phạm. */
function inGiaTri(src: string, tep: string): string[] {
  const pham: string[] = [];
  const thu = /\[\s*-n\s+"\$\{?PLATFORM_SECRETS_KEY(?:_PREVIOUS)?(?::-)?\}?"\s*\]/g;
  for (const [i, dong] of src.split("\n").entries()) {
    if (/^\s*#/.test(dong)) continue;
    // Theo từng LỆNH trên dòng (`;`, `&&`, `||`, `|`): `upsert_env KEY "$KEY"; say "đã ghi"` là hai lệnh, lệnh in không chạm giá trị.
    for (const lenh of dong.replace(thu, "").split(/;|&&|\|\||\|/)) {
      if (/\$\{?PLATFORM_SECRETS_KEY(?:_PREVIOUS)?\b/.test(lenh) && /\b(echo|printf|say|warn|cat|tee|logger)\b/.test(lenh)) pham.push(`${tep}:${i + 1}: ${dong.trim()}`);
    }
  }
  return pham;
}

export function testSecretsKeyPipelineSource() {
  const deploy = doc(".github/workflows/deploy-vps.yml");
  const boot = doc("scripts/bootstrap.sh");
  const install = doc("scripts/install-vps.sh");
  const compose = doc("docker-compose.prod.yml");

  // ── Chặng 1: workflow ──
  const iSsh = deploy.indexOf("- name: SSH vào VPS và chạy bootstrap");
  const iWith = deploy.indexOf("        with:", iSsh);
  const iEnvs = deploy.indexOf("envs: ERP_BRANCH", iWith);
  const iScript = deploy.indexOf("script:", iEnvs);
  const iExport = deploy.indexOf("export ERP_BRANCH", iScript);
  const iSauExport = deploy.indexOf("\n", iExport);
  assert.ok(iSsh > 0 && iWith > iSsh && iEnvs > iWith && iScript > iEnvs && iExport > iScript, "không tìm thấy khối env / envs / script của bước SSH — đổi khối thì đổi luôn mốc ở đây");
  const envs = deploy.slice(iEnvs, deploy.indexOf("\n", iEnvs)).replace("envs:", "").split(",").map((s) => s.trim());
  // Khoá hiện tại VÀ khoá cũ lúc xoay khoá đi CÙNG một khuôn — thiếu chặng nào của PREVIOUS thì deploy khoá mới giết bí mật cũ.
  for (const ten of KEYS) {
    assert.ok(deploy.slice(iSsh, iWith).includes(`${ten}: \${{ secrets.${ten} }}`), `chặng 1a: env của bước SSH phải đọc secrets.${ten}`);
    assert.ok(envs.includes(ten), `chặng 1b: ${ten} phải có trong danh sách envs (appleboy chỉ chở biến có tên ở đó)`);
    assert.ok(deploy.slice(iExport, iSauExport).split(/\s+/).includes(ten), `chặng 1c: ${ten} phải được export trong script chạy trên VPS`);
  }
  // Khoá TUỲ CHỌN: bước "Kiểm tra Secrets bắt buộc" không được chặn deploy vì thiếu nó.
  const iKiem = deploy.indexOf("- name: Kiểm tra Secrets bắt buộc");
  const khoiKiem = deploy.slice(iKiem, deploy.indexOf("- name:", iKiem + 10));
  assert.ok(!/missing="\$missing PLATFORM_SECRETS_KEY/.test(khoiKiem), "thiếu PLATFORM_SECRETS_KEY KHÔNG được chặn deploy — thiếu ⇒ tính năng tắt như hôm nay");
  assert.ok(khoiKiem.includes(`${PREV}: \${{ secrets.${PREV} }}`) && khoiKiem.includes(`echo "${PREV}: $([ -n "$${PREV}" ]`), "bước kiểm nói có / không đặt khoá cũ (không in giá trị)");

  // ── Chặng 2: bootstrap chuyển tiếp môi trường nguyên vẹn ──
  assert.match(boot, /^exec bash scripts\/install-vps\.sh$/m, "chặng 2: bootstrap.sh phải exec sang install-vps.sh (môi trường đi nguyên)");
  assert.ok(!/env\s+-i\b/.test(boot) && !new RegExp(`unset\\s+[^\\n]*${KEY}`).test(boot), "chặng 2: bootstrap.sh không được xoá môi trường / unset khoá");

  // ── Chặng 3: install-vps.sh — chỉ ghi khi khác rỗng ──
  for (const ten of KEYS) {
    assert.ok(install.includes(`if [ -n "\${${ten}:-}" ]; then`), `chặng 3: install-vps.sh phải ghi ${ten} CHỈ khi khác rỗng`);
    assert.equal((install.match(new RegExp(`upsert_env ${ten}(?![A-Z_])`, "g")) ?? []).length, 1, `chặng 3: đúng MỘT chỗ ghi ${ten} vào .env`);
    assert.ok(!new RegExp(`^${ten}=`, "m").test(install) && !install.includes(`${ten}="\${${ten}`), `chặng 3: mẫu .env mới KHÔNG viết dòng ${ten} vô điều kiện (rỗng thì không có dòng)`);
  }
  // ⇒ container
  for (const svc of ["app", "scheduler"]) {
    const i = compose.indexOf(`\n  ${svc}:\n`);
    assert.ok(i >= 0, `không thấy service ${svc} trong docker-compose.prod.yml`);
    const sau = compose.slice(i + svc.length + 5);
    const ke = sau.search(/\n {2}[a-z][\w-]*:\n/);
    assert.ok((ke < 0 ? sau : sau.slice(0, ke)).includes("env_file: .env"), `đích: service ${svc} phải nạp .env vào container`);
  }

  // ── Không bao giờ in giá trị ──
  const pham = [...inGiaTri(deploy, "deploy-vps.yml"), ...inGiaTri(boot, "bootstrap.sh"), ...inGiaTri(install, "install-vps.sh")];
  assert.deepEqual(pham, [], "không dòng nào được in giá trị PLATFORM_SECRETS_KEY (chỉ được nói có / chưa có)");
  assert.ok(!/^\s*set\s+-[a-z]*x/m.test(install) && !/^\s*set\s+-[a-z]*x/m.test(boot), "không bật xtrace (set -x in mọi giá trị ra log)");
}

/** Trích `upsert_env()` + khối khoá rồi chạy thật trong thư mục tạm. */
function chayKhoi(envCu: string | null, giaTri: string, ten: string = KEY): { env: string | null; out: string } {
  const install = doc("scripts/install-vps.sh");
  const iHam = install.indexOf("upsert_env() {");
  const jHam = install.indexOf("\n}\n", iHam);
  const iKhoi = install.indexOf(`if [ -n "\${${ten}:-}" ]; then`);
  const jKhoi = install.indexOf("\nfi\n", iKhoi);
  assert.ok(iHam > 0 && jHam > iHam && iKhoi > 0 && jKhoi > iKhoi, "không trích được upsert_env / khối khoá khỏi install-vps.sh");
  const tmp = mkdtempSync(path.join(tmpdir(), "launch-a-"));
  try {
    const kich = path.join(tmp, "run.sh");
    writeFileSync(
      kich,
      ["#!/usr/bin/env bash", "set -euo pipefail", 'cd "$(dirname "$0")"', "say() { printf 'SAY %s\\n' \"$*\"; }", "warn() { printf 'WARN %s\\n' \"$*\"; }", install.slice(iHam, jHam + 3), install.slice(iKhoi, jKhoi + 4), "echo XONG", ""].join("\n"),
    );
    const envPath = path.join(tmp, ".env");
    if (envCu !== null) writeFileSync(envPath, envCu);
    const out = execFileSync("bash", [kich], { env: { ...process.env, [ten]: giaTri }, encoding: "utf8" });
    let env: string | null = null;
    try {
      env = readFileSync(envPath, "utf8");
    } catch {
      env = null;
    }
    return { env, out };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function testSecretsKeyPipelineRun() {
  // Giá trị BỊA, sinh lúc chạy — không có khoá thật nào trong kho (kho PUBLIC).
  const cu = randomBytes(48).toString("base64");
  const moi = randomBytes(48).toString("base64");
  const envCo = `ERP_DOMAIN="erp.test"\n${KEY}="${cu}"\nAUTH_SECRET="x"\n`;

  const rong = chayKhoi(envCo, "");
  assert.ok(rong.out.includes("XONG"), "khối chạy hết dưới set -euo pipefail khi khoá rỗng");
  assert.equal(rong.env, envCo, "Secret RỖNG ⇒ .env giữ nguyên từng byte (khoá cũ còn, không dòng rỗng)");

  const chuaCo = chayKhoi(`ERP_DOMAIN="erp.test"\n`, "");
  assert.ok(!chuaCo.env?.includes(KEY), "chưa từng có khoá + Secret rỗng ⇒ không sinh dòng khoá nào");

  const ghi = chayKhoi(envCo, moi);
  const dong = (ghi.env ?? "").split("\n").filter((l) => l.startsWith(`${KEY}=`));
  assert.deepEqual(dong, [`${KEY}="${moi}"`], "Secret có giá trị ⇒ thay ĐÚNG một dòng, đúng từng ký tự (base64 có + / = đi qua sed nguyên vẹn)");
  assert.ok(ghi.env?.includes('AUTH_SECRET="x"') && ghi.env.includes('ERP_DOMAIN="erp.test"'), "không đụng dòng khác");
  assert.ok(!ghi.out.includes(moi) && !ghi.out.includes(cu), "log không in giá trị");

  const lanDau = chayKhoi(`ERP_DOMAIN="erp.test"\n`, moi);
  assert.ok(lanDau.env?.endsWith(`${KEY}="${moi}"\n`), "chưa có dòng ⇒ thêm một dòng");

  // `&` là kiểu hỏng IM LẶNG (sed thay nó bằng cả chuỗi khớp ⇒ .env mang một khoá KHÁC, deploy vẫn xanh); `|` làm sed
  // chết ồn ào. Cả hai phải bị từ chối TRƯỚC khi tới sed.
  for (const xau of [`${moi.slice(0, 40)}&x`, `${moi.slice(0, 40)}|x`]) {
    const tuChoi = chayKhoi(envCo, xau);
    assert.equal(tuChoi.env, envCo, `ký tự ngoài base64 («${xau.slice(-2)}») ⇒ KHÔNG ghi — giữ nguyên khoá cũ`);
    assert.ok(/WARN/.test(tuChoi.out) && !tuChoi.out.includes(xau), "nói rõ là từ chối, không in giá trị");
  }

  // ── Khoá CŨ lúc xoay khoá: cùng khuôn, và KHÔNG BAO GIỜ chạm dòng khoá hiện tại ──
  const truoc = randomBytes(48).toString("base64");
  const envXoay = `ERP_DOMAIN="erp.test"\n${KEY}="${moi}"\n`;
  const prevRong = chayKhoi(`${envXoay}${PREV}="${truoc}"\n`, "", PREV);
  assert.equal(prevRong.env, `${envXoay}${PREV}="${truoc}"\n`, "Secret PREVIOUS bị xoá ⇒ .env giữ nguyên (gỡ khoá cũ là việc tay SAU lượt xoay)");
  const prevGhi = chayKhoi(envXoay, cu, PREV);
  const dongs = (prevGhi.env ?? "").split("\n");
  assert.deepEqual(dongs.filter((l) => l.startsWith(`${PREV}=`)), [`${PREV}="${cu}"`], "PREVIOUS có giá trị ⇒ đúng một dòng");
  assert.deepEqual(dongs.filter((l) => l.startsWith(`${KEY}=`)), [`${KEY}="${moi}"`], "ghi PREVIOUS không được đụng dòng khoá hiện tại (tên này là tiền tố của tên kia)");
  assert.ok(!prevGhi.out.includes(cu) && !prevGhi.out.includes(moi), "log không in giá trị khoá cũ");
  const prevXau = chayKhoi(envXoay, `${cu.slice(0, 40)}&x`, PREV);
  assert.equal(prevXau.env, envXoay, "PREVIOUS có ký tự ngoài base64 ⇒ không ghi");
  // Ghi khoá HIỆN TẠI khi .env đã có dòng PREVIOUS: dòng PREVIOUS phải còn nguyên (`^TÊN=` của sed có dấu `=` chặn tiền tố).
  const moi2 = randomBytes(48).toString("base64");
  const hienTai = chayKhoi(`${envXoay}${PREV}="${truoc}"\n`, moi2);
  assert.ok(hienTai.env?.includes(`${PREV}="${truoc}"`) && hienTai.env.includes(`${KEY}="${moi2}"`), "ghi khoá hiện tại không đè dòng PREVIOUS");
}

type HealthBody = { ok: boolean; platform: Record<string, unknown> };

/**
 * `/api/health` (CÔNG KHAI) nói "khoá đã tới container chưa" bằng TRẠNG THÁI + 8 hex đầu của MÃ khoá — không khoá, không mã
 * khoá đầy đủ, không câu lý do. Gọi đúng handler của tuyến, với môi trường giả đặt tạm rồi trả lại nguyên trạng.
 */
export async function testSecretsKeyHealth() {
  const { GET } = await import("@/app/api/health/route");
  const { secretsKeyState } = await import("@/lib/connectors/secrets");
  const saved = { [KEY]: process.env[KEY], [PREV]: process.env[PREV] };
  const master = randomBytes(48).toString("base64");
  const old = randomBytes(48).toString("base64");
  const read = async () => (await (await GET()).json()) as HealthBody;
  try {
    delete process.env[KEY];
    delete process.env[PREV];
    const thieu = await read();
    assert.equal(thieu.platform.secretsKey, "missing", "chưa có khoá ⇒ missing");
    assert.equal(thieu.platform.secretsKeyIdShort, null);
    assert.equal(thieu.ok, true, "thiếu khoá KHÔNG làm health đỏ (tính năng tuỳ chọn)");

    process.env[KEY] = "ngan-qua-chua-du-32-ky-tu";
    const ngan = await read();
    assert.equal(ngan.platform.secretsKey, "invalid", "khoá ngắn ⇒ invalid");
    assert.ok(!JSON.stringify(ngan).includes("ngan-qua"), "không in khoá kể cả khi hỏng");
    assert.ok(!/ký tự|PLATFORM_SECRETS_KEY/.test(JSON.stringify(ngan.platform)), "không có câu lý do (câu đó nói độ dài khoá)");

    process.env[KEY] = master;
    const kid = secretsKeyState();
    assert.ok(kid.ok);
    const co = await read();
    assert.equal(co.platform.secretsKey, "ready");
    assert.equal(co.platform.secretsKeyIdShort, kid.keyId.slice(0, 8), "8 hex đầu của mã khoá — đủ để so hai lượt deploy");
    assert.equal(co.platform.secretsKeyPrevious, "absent");
    const json = JSON.stringify(co);
    assert.ok(!json.includes(master) && !json.includes(kid.keyId) && !json.includes(kid.key.toString("hex")) && !json.includes(kid.key.toString("base64")), "health KHÔNG có khoá, khoá dẫn xuất hay mã khoá đầy đủ");
    assert.equal((await read()).platform.secretsKeyIdShort, co.platform.secretsKeyIdShort, "đọc lại (≈ khởi động lại, cùng .env) ⇒ cùng mã khoá");

    process.env[PREV] = old;
    const xoay = await read();
    assert.equal(xoay.platform.secretsKeyPrevious, "ready");
    assert.ok(!JSON.stringify(xoay).includes(old), "không in khoá cũ");
    process.env[PREV] = master;
    assert.equal((await read()).platform.secretsKeyPrevious, "invalid", "PREVIOUS trùng khoá hiện tại ⇒ invalid (không giả vờ đang xoay)");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function testLaunchGatesPipeline() {
  testSecretsKeyPipelineSource();
  testSecretsKeyPipelineRun();
  await testSecretsKeyHealth();
  console.log("✓ Cổng mở bán A · PLATFORM_SECRETS_KEY (+ _PREVIOUS lúc xoay khoá): secret → env + envs + export của bước SSH → bootstrap exec (môi trường nguyên) → install-vps.sh ghi .env CHỈ khi khác rỗng (chạy thật: rỗng giữ nguyên từng byte, không dòng rỗng; base64 qua sed nguyên vẹn; ký tự lạ ⇒ từ chối; PREVIOUS không đụng khoá hiện tại) → compose env_file; không dòng nào in giá trị, không set -x · /api/health: ready/missing/invalid + 8 hex mã khoá, không khoá, không mã khoá đầy đủ");
}

if (process.argv[1] && /launch-gates\.test\.ts$/.test(process.argv[1])) {
  testLaunchGatesPipeline().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
