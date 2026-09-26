import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_ACTION_LABEL, auditActionLabel, auditEntityLabel } from "@/lib/constants/audit";

/**
 * ═══════════ HÀNH ĐỘNG COMPANY OS PHẢI CÓ NHÃN TRÊN TRANG NHẬT KÝ ═══════════
 *
 * `MODEL_STATE_CHANGE`, `MODEL_OWNER_CHANGE`, `MODEL_REGISTER`, `MODEL_REGISTRY_SYNC` vào kho cùng sổ mẫu
 * nhưng không vào `lib/constants/audit.ts`, nên `/audit` in mã thô — người đọc nhật ký phải đoán
 * "MODEL_STATE_CHANGE" là gì đúng ở chỗ họ cần truy nguyên ai đã khai một mẫu là "Đang bán".
 *
 * Bài này QUÉT MÃ NGUỒN: mọi chuỗi hành động ghi qua `audit({…})` (hoặc `ghi({…})` — bọc `audit` của cổng
 * duyệt hai bước) trong các tệp Company OS phải có nhãn. Hành động ghép `approval.<bước>:${việc}` thì
 * BƯỚC phải có nhãn (`auditActionLabel` đọc bước rồi kèm việc). Thêm một hành động mới mà quên nhãn là đỏ
 * ngay ở máy người viết, không phải ở trang nhật ký ba tuần sau.
 */

const goc = path.resolve(__dirname, "..");

function tepQuet(): string[] {
  const actions = fs.readdirSync(path.join(goc, "lib/actions")).filter((f) => /^production.*\.ts$/.test(f)).map((f) => `lib/actions/${f}`);
  const approvals = fs.readdirSync(path.join(goc, "lib/approvals")).filter((f) => f.endsWith(".ts")).map((f) => `lib/approvals/${f}`);
  return [
    "lib/actions/models.ts",
    ...actions,
    "lib/actions/return-dispositions.ts",
    "lib/actions/returns-unidentified.ts",
    "lib/actions/owner-decisions.ts",
    "lib/actions/slow-moving.ts",
    ...approvals,
  ];
}

/** Thân object của mỗi lời gọi `audit({` / `ghi({` — đếm ngoặc, đủ cho `${…}` trong chuỗi mẫu. */
function thanLoiGoi(src: string): string[] {
  const ra: string[] = [];
  for (const m of src.matchAll(/\b(?:audit|ghi)\(\{/g)) {
    const batDau = (m.index ?? 0) + m[0].length - 1;
    let sau = 0;
    for (let i = batDau; i < src.length; i++) {
      if (src[i] === "{") sau += 1;
      else if (src[i] === "}") {
        sau -= 1;
        if (sau === 0) {
          ra.push(src.slice(batDau, i + 1));
          break;
        }
      }
    }
  }
  return ra;
}

/** Biểu thức giá trị của một thuộc tính — dừng ở dấu phẩy / ngoặc đóng NGOÀI chuỗi và ngoài ngoặc lồng. */
function bieuThuc(s: string): string {
  let sau = 0;
  let nhay: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (nhay) {
      if (c === "\\") i += 1;
      else if (c === nhay) nhay = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") nhay = c;
    else if (c === "(" || c === "[" || c === "{") sau += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (sau === 0) return s.slice(0, i).trim();
      sau -= 1;
    } else if ((c === "," || c === "\n") && sau === 0) return s.slice(0, i).trim();
  }
  return s.trim();
}

export type AuditActionSite = { file: string; kind: "EXACT" | "PREFIX"; value: string };

/** Mọi chuỗi hành động (đích danh hoặc tiền tố `bước:`) mà các tệp Company OS ghi vào nhật ký. */
export function companyOsAuditActions(): AuditActionSite[] {
  const ra: AuditActionSite[] = [];
  for (const file of tepQuet()) {
    const src = fs.readFileSync(path.join(goc, file), "utf8");
    for (const than of thanLoiGoi(src)) {
      const m = /\baction:\s*/.exec(than);
      if (!m) continue;
      const bt = bieuThuc(than.slice((m.index ?? 0) + m[0].length));
      if (bt.startsWith("`")) {
        const tienTo = /^`([^`$]*?):\$\{/.exec(bt);
        assert.ok(tienTo, `${file}: hành động dạng chuỗi mẫu phải là \`<bước>:\${việc}\` — gặp ${bt}`);
        ra.push({ file, kind: "PREFIX", value: tienTo[1] });
        continue;
      }
      // `điều kiện ? "A" : "B"` — chỉ lấy các nhánh, không lấy chuỗi đứng trong điều kiện.
      const nhanh = bt.includes("?") ? bt.slice(bt.indexOf("?")) : bt;
      for (const s of nhanh.matchAll(/"([^"]+)"/g)) ra.push({ file, kind: "EXACT", value: s[1] });
    }
  }
  return ra;
}

export function testCompanyOsAuditLabels() {
  const cho = companyOsAuditActions();
  assert.ok(cho.length >= 40, `đọc hụt lời gọi audit (chỉ thấy ${cho.length}) — biểu thức quét hỏng?`);
  for (const f of ["lib/actions/models.ts", "lib/actions/production.ts", "lib/actions/returns-unidentified.ts", "lib/approvals/service.ts"]) {
    assert.ok(cho.some((c) => c.file === f), `không thấy lời gọi audit nào ở ${f} — tệp đổi tên hay biểu thức quét hỏng?`);
  }

  const thieu = cho.filter((c) => (c.kind === "EXACT" ? auditActionLabel(c.value) === c.value : !AUDIT_ACTION_LABEL[c.value])).map((c) => `${c.file}: ${c.kind === "PREFIX" ? `${c.value}:…` : c.value}`);
  assert.deepEqual([...new Set(thieu)], [], "hành động Company OS ghi vào nhật ký mà chưa có nhãn tiếng Việt trong lib/constants/audit.ts — /audit sẽ in mã thô");

  // Bốn mã của sổ mẫu — ca đã gây ra bài này.
  for (const a of ["MODEL_STATE_CHANGE", "MODEL_OWNER_CHANGE", "MODEL_REGISTER", "MODEL_REGISTRY_SYNC"]) {
    assert.ok(cho.some((c) => c.value === a), `quét phải thấy ${a} ở lib/actions/models.ts`);
  }

  // Hành động ghép đọc nhãn của BƯỚC rồi kèm việc; việc chưa có nhãn thì giữ nguyên mã để còn tra được.
  assert.equal(auditActionLabel("approval.skip:production.save"), `${AUDIT_ACTION_LABEL["approval.skip"]} · production.save`);
  assert.equal(auditActionLabel("approval.request:MODEL_STATE_CHANGE"), `${AUDIT_ACTION_LABEL["approval.request"]} · ${AUDIT_ACTION_LABEL.MODEL_STATE_CHANGE}`);
  assert.equal(auditActionLabel("khong.co:gi"), "khong.co:gi", "tiền tố lạ ⇒ in nguyên mã, không bịa nhãn");
  assert.equal(auditActionLabel("approval.skip:"), "approval.skip:", "thiếu việc ⇒ in nguyên mã");

  for (const e of ["PRODUCT_MODEL", "PRODUCTION_ORDER", "APPROVAL_REQUEST", "return_unidentified"]) {
    assert.notEqual(auditEntityLabel(e), e, `đối tượng ${e} phải có nhãn tiếng Việt`);
  }

  const dich = new Set(cho.map((c) => c.value)).size;
  console.log(`✓ Nhãn nhật ký Company OS: ${dich} hành động (${cho.filter((c) => c.kind === "PREFIX").length} lời ghi dạng bước:việc) ở ${new Set(cho.map((c) => c.file)).size} tệp — 0 mã thô trên /audit`);
}

if (process.argv[1] && /company-os-audit-labels\.test\.ts$/.test(process.argv[1])) {
  testCompanyOsAuditLabels();
}
