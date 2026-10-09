/**
 * ═══════════ NGHIỆM THU BẢO MẬT TRÊN PRODUCTION — LUẬT THUẦN (LAUNCH_GATE §3 · S1 / S2 / S3 · docs/saas/ACCEPTANCE.md §11) ═══════════
 *
 * Ops `security-acceptance` (lõi lib/saas/security-acceptance.ts) đi tìm BẰNG CHỨNG production cho ba dòng của cổng ra mắt:
 *  · S1 CÔ LẬP TỔ CHỨC — phiên của workspace nghiệm thu mở id bản ghi của tổ chức NHÀ (và ngược lại) qua HTTP thật: chỉ được ra
 *    «không tìm thấy» / bị chặn / bị đưa đi chỗ khác, KHÔNG BAO GIỜ một trang 200 dựng bản ghi của tổ chức kia.
 *  · S2 BÍ MẬT KHÔNG LỘ — HTML + gói RSC của trang vỏ và trang công khai không mang khoá / token / chuỗi kết nối nào.
 *  · S3 TOKEN MÃ HOÁ KHI NẰM YÊN — mọi ô bí mật kết nối (kết nối + token từng page) đúng phong bì AES-GCM mà
 *    lib/connectors/secrets.ts viết (`[1 byte phiên bản = 1][12 nonce][16 thẻ][bản mã]` + mã khoá 16 hex).
 *
 * Tệp THUẦN, client-safe: lõi, script, bài kiểm đọc cùng một bản. Không chữ nào của bản ghi / bí mật đi ra kênh công khai —
 * chỉ TÊN mẫu và SỐ ĐẾM (mọi dòng công khai dựng ở `securityPublicLines`).
 */

// ─────────────────────────── S2 · máy quét bí mật ───────────────────────────

/**
 * Mẫu bí mật — mỗi mẫu một TÊN (in ra) và một biểu thức (KHÔNG BAO GIỜ in chỗ khớp). Cùng họ với các mẫu che của kho
 * (`GOOGLE_KEY_FRAGMENT_RE` ở scripts/org-ai-cutover.ts, che_log của ops-vps, `scrubSecrets`) nhưng siết cho đúng HÌNH khoá thật
 * để trang HTML bình thường không khớp nhầm.
 *
 * CỐ Ý KHÔNG dùng `LONG_RANDOM_RUN_RE` (/[0-9A-Za-z_-]{30,}/) làm phép đạt / trượt: tên chunk của Next, id RSC, băm tệp tĩnh đều là
 * chuỗi ngẫu nhiên dài — mẫu ấy khớp MỌI trang, nên nó không phân biệt được rò với không rò. Thay vào đó là phép mạnh hơn và không
 * bao giờ khớp nhầm: GIÁ TRỊ THẬT của biến môi trường bí mật (`envSecretValues`) có nằm trong trang không.
 */
export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "GOOGLE_API_KEY", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "OPENAI_ANTHROPIC_KEY", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/g },
  { name: "FB_ACCESS_TOKEN", re: /\bEAA[A-Za-z0-9]{40,}/g },
  { name: "POSTGRES_URL", re: /\bpostgres(?:ql)?:\/\/[^\s"'<>\\]+/g },
  { name: "PRIVATE_KEY_PEM", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "ENV_ASSIGNMENT", re: /\b(?:PLATFORM_SECRETS_KEY(?:_PREVIOUS)?|AUTH_SECRET|DATABASE_URL|[A-Z][A-Z0-9_]*(?:API_KEY|_SECRET|_TOKEN|_PASSWORD))\s*[=:]\s*["']?[A-Za-z0-9+/_.:@-]{12,}/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** Tên biến môi trường mang bí mật — giá trị của chúng là thứ không bao giờ được nằm trong một trang. */
export const SECRET_ENV_NAME_RE = /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE_URL|_KEY$)/;
/** Giá trị ngắn hơn ngần này không đem so (chuỗi ngắn khớp ngẫu nhiên — «true», «production»…). */
export const SECRET_ENV_MIN_LENGTH = 16;

/**
 * Giá trị bí mật của môi trường ⇒ cặp (tên, giá trị) để so. Giá trị CHỈ nằm trong bộ nhớ, không bao giờ in. Biến mang chữ PUBLIC
 * (`NEXT_PUBLIC_*`, khoá VAPID công khai…) CỐ Ý có mặt trong trang — loại ra. THUẦN.
 */
export function envSecretValues(env: Readonly<Record<string, string | undefined>>): { name: string; value: string }[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAME_RE.test(k) && !/PUBLIC/.test(k) && typeof v === "string" && v.trim().length >= SECRET_ENV_MIN_LENGTH)
    .map(([k, v]) => ({ name: `ENV:${k}`, value: (v as string).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Quét MỘT thân trang ⇒ số lần khớp theo TÊN mẫu (không bao giờ trả chỗ khớp). THUẦN. */
export function scanForSecrets(body: string, envValues: readonly { name: string; value: string }[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of SECRET_PATTERNS) {
    const n = (body.match(new RegExp(p.re.source, p.re.flags)) ?? []).length;
    if (n) out[p.name] = n;
  }
  for (const e of envValues) {
    if (!e.value) continue;
    let n = 0;
    for (let i = body.indexOf(e.value); i >= 0; i = body.indexOf(e.value, i + e.value.length)) n += 1;
    if (n) out[e.name] = n;
  }
  return out;
}

// ─────────────────────────── S1 · phán quyết một lượt dò cô lập ───────────────────────────

/** `DETAIL` = trang / API của MỘT bản ghi (phải ra «không tìm thấy» / bị chặn); `LIST` = trang danh sách nhận id qua tham số. */
export type ProbeKind = "DETAIL" | "LIST" | "API";
export type ProbeVerdict = "BLOCKED" | "LEAK" | "UNSURE" | "SESSION_REJECTED" | "SKIPPED";

/** Câu của trang «không tìm thấy» — app/(dashboard)/not-found.tsx và app/not-found.tsx. */
export const NOT_FOUND_MARKERS = ["Không tìm thấy dữ liệu", "Không tìm thấy trang", "NEXT_NOT_FOUND", "NEXT_HTTP_ERROR_FALLBACK;404"] as const;

/** Dấu hiệu nội dung ít nhất bao nhiêu ký tự mới dùng (tên «Lan» khớp ngẫu nhiên ở đâu cũng được). */
export const MARKER_MIN_LENGTH = 6;

/** Dấu hiệu dùng được: chuỗi đủ dài, KHÔNG nằm trong đường dẫn (trang nào cũng lặp lại tham số của chính nó trong gói RSC). THUẦN. */
export function usableMarkers(markers: readonly (string | null | undefined)[], requestedPath: string): string[] {
  return [...new Set(markers.map((m) => (m ?? "").trim()).filter((m) => m.length >= MARKER_MIN_LENGTH && !requestedPath.includes(m) && !requestedPath.includes(encodeURIComponent(m))))];
}

export type ProbeInput = { kind: ProbeKind; requestedPath: string; finalPath: string; status: number; body: string; markers: readonly string[]; loginRedirect: boolean };

/**
 * Một lượt dò ⇒ phán quyết. THUẦN.
 *  · bị đá về /login ⇒ SESSION_REJECTED (phép dò không chứng minh được gì — tính là hỏng).
 *  · thân trang mang dấu hiệu nội dung của bản ghi tổ chức kia ⇒ LEAK, bất kể mã HTTP.
 *  · API: 401/403/404 ⇒ BLOCKED; 200 ⇒ LEAK (trả được tài nguyên của tổ chức khác); còn lại UNSURE.
 *  · trang: 404 / 403 / trang «không tìm thấy» / bị chuyển ra khỏi đường dẫn bản ghi ⇒ BLOCKED.
 *  · LIST 200 không dấu hiệu ⇒ BLOCKED (danh sách mở, bản ghi lạ không hiện); thiếu dấu hiệu để so ⇒ SKIPPED.
 *  · DETAIL 200 ở đúng đường dẫn mà không «không tìm thấy» ⇒ UNSURE (tính là hỏng — không kết luận «an toàn» khi không chứng minh được).
 */
export function classifyIsolationProbe(p: ProbeInput): ProbeVerdict {
  if (p.loginRedirect) return "SESSION_REJECTED";
  if (p.markers.some((m) => p.body.includes(m))) return "LEAK";
  if (p.kind === "API") return p.status === 401 || p.status === 403 || p.status === 404 ? "BLOCKED" : p.status === 200 ? "LEAK" : "UNSURE";
  if (p.status === 404 || p.status === 403) return "BLOCKED";
  if (p.status !== 200) return "UNSURE";
  if (p.kind === "LIST") return p.markers.length ? "BLOCKED" : "SKIPPED";
  if (NOT_FOUND_MARKERS.some((m) => p.body.includes(m))) return "BLOCKED";
  if (p.finalPath.split("?")[0] !== p.requestedPath.split("?")[0]) return "BLOCKED";
  return "UNSURE";
}

// ─────────────────────────── S3 · phong bì bản mã ───────────────────────────

/** Hình phong bì của lib/connectors/secrets.ts: phiên bản 1 · nonce 12 · thẻ 16 · ≥ 1 byte bản mã; mã khoá = 16 hex. */
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_MIN_BYTES = 1 + 12 + 16 + 1;
export const ENVELOPE_KEY_ID_RE = /^[0-9a-f]{16}$/;

export type EnvelopeVerdict = "ENCRYPTED" | "EMPTY" | "PLAINTEXT" | "MALFORMED";

/**
 * MỘT ô bí mật ⇒ phán quyết, KHÔNG giải mã. THUẦN.
 *  · rỗng ⇒ EMPTY (chưa lưu bí mật — không phải lỗi).
 *  · không đúng byte phiên bản / quá ngắn / thiếu mã khoá ⇒ PLAINTEXT nếu các byte đọc được như chữ (JSON, token…), MALFORMED nếu không.
 */
export function classifyEnvelope(bytes: Uint8Array | null | undefined, keyId: string | null | undefined): EnvelopeVerdict {
  if (!bytes || bytes.length === 0) return "EMPTY";
  const shaped = bytes[0] === ENVELOPE_VERSION && bytes.length >= ENVELOPE_MIN_BYTES && ENVELOPE_KEY_ID_RE.test(keyId ?? "");
  if (shaped) return "ENCRYPTED";
  const printable = bytes.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2);
  return printable ? "PLAINTEXT" : "MALFORMED";
}

// ─────────────────────────── Kết quả + dòng công khai ───────────────────────────

export type CheckStatus = "PASS" | "FAIL" | "SKIP";
export type SecurityCheck = { key: "S1" | "S2" | "S3"; status: CheckStatus; counts: Record<string, number>; note: string | null; detail: string[] };

export const SECURITY_CHECK_LABEL: Record<SecurityCheck["key"], string> = { S1: "S1 cô lập tổ chức", S2: "S2 bí mật không lộ trong trang", S3: "S3 token mã hoá khi nằm yên" };

/** Trần kênh tóm tắt (cùng số với các script tóm tắt khác). */
export const SECURITY_SUMMARY_MAX_CHARS = 300;

const COUNT_KEY_RE = /^[A-Za-z0-9_:→.-]{1,60}$/;

/**
 * Dòng công khai: một dòng mỗi S + một dòng phán quyết. Chỉ NHÃN, trạng thái, TÊN đếm (khớp `COUNT_KEY_RE` — tên mẫu / phán quyết,
 * không bao giờ một chuỗi tự do) và SỐ; `note` là câu cố định do lõi chọn (lý do bỏ qua), không mang dữ liệu. THUẦN.
 */
export function securityPublicLines(checks: readonly SecurityCheck[]): string[] {
  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.key);
  const skipped = checks.filter((c) => c.status === "SKIP").map((c) => c.key);
  const verdict = failed.length ? "FAIL" : "PASS";
  const lines = [`security-acceptance: ${verdict}${failed.length ? ` · hỏng ${failed.join(", ")}` : ""}${skipped.length ? ` · CHƯA ĐO ĐƯỢC ${skipped.join(", ")}` : ""}`];
  for (const c of checks) {
    const counts = Object.entries(c.counts)
      .filter(([k, n]) => COUNT_KEY_RE.test(k) && Number.isFinite(n))
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ");
    lines.push(`${SECURITY_CHECK_LABEL[c.key]}: ${c.status === "SKIP" ? "CHƯA ĐO ĐƯỢC" : c.status}${counts ? ` · ${counts}` : ""}${c.note ? ` — ${c.note}` : ""}`);
  }
  return lines.map((l) => (l.length > SECURITY_SUMMARY_MAX_CHARS ? `${l.slice(0, SECURITY_SUMMARY_MAX_CHARS - 1)}…` : l));
}

export function securityVerdict(checks: readonly SecurityCheck[]): "PASS" | "FAIL" {
  return checks.some((c) => c.status === "FAIL") ? "FAIL" : "PASS";
}
