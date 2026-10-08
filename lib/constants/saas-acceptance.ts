/**
 * ═══════════ NGHIỆM THU KHÁCH CHỐT ĐƠN TRÊN PRODUCTION — SỔ KHAI + LUẬT THUẦN (docs/saas/ACCEPTANCE.md) ═══════════
 *
 * Launch sprint 08/10/2026: «sẵn sàng bán» đòi một lượt đi trọn vòng của MỘT khách Chốt Đơn trên production — cấp phát qua job
 * «Tạo khách» → kích hoạt → đăng nhập email KHÔNG mã tổ chức → vỏ app 8 mục → chat web → AI → đơn — và smoke sau deploy
 * (`scripts/smoke.ts`) chỉ đi vai NGƯỜI NHÀ. Ops `saas-acceptance` (lõi `lib/saas/acceptance.ts`) là lượt đi vai KHÁCH.
 *
 * ─── LÁ CHẮN «KHÔNG DÙNG DỮ LIỆU KHÁCH THẬT THEO CÁCH PHÁ HUỶ» ───
 *
 * Ops này đặt lại mật khẩu, đăng nhập và nhắn bot — trên tài khoản NÓ TỰ TẠO. Nên nó chỉ chạm tổ chức có tên trong
 * `ACCEPTANCE_WORKSPACES` dưới đây: mã ngoài sổ ⇒ TỪ CHỐI trước mọi lượt đọc (`acceptanceWorkspaceOf`), và đường phát liên kết của
 * máy (`createAcceptanceResetLink`) hỏi lại CHÍNH sổ này. Thêm một mục = một quyết định có lý do, không phải một tham số dòng lệnh.
 *
 * Tệp THUẦN (không CSDL, không mạng): lõi, script, bài kiểm và tài liệu đọc cùng một bản.
 */
import { RESERVED_ORG_CODES } from "@/lib/onboarding/shared";
import { domainSlugProblem } from "@/lib/platform/host";
import { DEFAULT_CHOTDON_DOMAIN, DEFAULT_SITE_DOMAIN } from "@/lib/platform/site-host";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";

/** Nhãn của MÁY trong mọi nhật ký ops này ghi (`actor = null` — AGENTS 34: máy làm, khác hẳn «chưa biết ai»). */
export const ACCEPTANCE_ACTOR_LABEL = "Nghiệm thu tự động";

/** Câu từ chối khi mã không nằm trong sổ khai — không lặp lại mã đã gõ (nó có thể đi ra kênh tóm tắt công khai). */
export const ACCEPTANCE_REGISTRY_REFUSAL = "Mã tổ chức không có trong sổ khai nghiệm thu (lib/constants/saas-acceptance.ts) — ops nghiệm thu chỉ chạm workspace THỬ của chính nó.";

export type AcceptanceWorkspace = {
  /** Mã tổ chức — BẤT BIẾN (nằm trong JWT, tên CSDL). Đúng dạng mã tổ chức, không trùng tên dành riêng. */
  code: string;
  /** Tên hiển thị — nói thẳng đây KHÔNG phải khách thật (người vận hành đọc danh sách khách thấy ngay). */
  name: string;
  /** Mã tài khoản khách (`platform_accounts.code`) — cố định để lượt chạy lại gắn đúng tài khoản. */
  accountCode: string;
  /** Chủ shop yêu cầu đúng «external customer test account»: đi đúng luật của khách NGOÀI (gói niêm yết, dùng thử). */
  accountType: "EXTERNAL";
  /** Thương hiệu của workspace — vỏ app Chốt Đơn (lib/constants/saas-nav.ts). */
  brand: "chotdon";
  /** Email quản trị — thuộc tên miền CỦA CHÍNH nền tảng, không phải hộp thư của khách nào. Không có thư nào được gửi tới nó. */
  ownerEmail: string;
  ownerName: string;
  /** Tên miền con cố định khi xuất bản (`<slug>.<PLATFORM_BASE_DOMAIN>`). */
  domainSlug: string;
  /** Vì sao có workspace này. */
  reason: string;
};

export const ACCEPTANCE_WORKSPACES: readonly AcceptanceWorkspace[] = [
  {
    code: "cdt-nghiem-thu",
    name: "Kiểm thử nghiệm thu — không phải khách thật",
    accountCode: "cdt-nghiem-thu",
    accountType: "EXTERNAL",
    brand: "chotdon",
    ownerEmail: "nghiem-thu@chotdontudong.com",
    ownerName: ACCEPTANCE_ACTOR_LABEL,
    domainSlug: "cdt-nghiem-thu",
    reason:
      "Launch sprint 08/10/2026: chứng minh trên production một khách Chốt Đơn đi trọn vòng (cấp phát → kích hoạt → đăng nhập email → vỏ app → chat → AI → đơn) sau mỗi deploy chạm vỏ / danh tính / cấp phát / bot / đơn.",
  },
];

/** Tên miền mà email quản trị thử được phép thuộc về — tên miền GỐC của hai thương hiệu của chính nền tảng. */
export const PLATFORM_OWNED_EMAIL_DOMAINS: readonly string[] = [DEFAULT_CHOTDON_DOMAIN, DEFAULT_SITE_DOMAIN];

/** LÁ CHẮN: mục của sổ khai đúng mã này, hoặc `null`. So khớp CHÍNH XÁC (chữ thường, bỏ khoảng trắng) — không tiền tố, không đoán. */
export function acceptanceWorkspaceOf(code: string | null | undefined): AcceptanceWorkspace | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  return ACCEPTANCE_WORKSPACES.find((w) => w.code === c) ?? null;
}

/** Sổ khai tự kiểm (bài kiểm gọi): mỗi câu là một chỗ sai — rỗng ⇒ sổ hợp lệ. */
export function acceptanceRegistryProblems(list: readonly AcceptanceWorkspace[] = ACCEPTANCE_WORKSPACES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of list) {
    if (seen.has(w.code)) out.push(`${w.code}: mã trùng trong sổ`);
    seen.add(w.code);
    if (!ORGANIZATION_CODE_PATTERN.test(w.code)) out.push(`${w.code}: không đúng dạng mã tổ chức`);
    if ((RESERVED_ORG_CODES as readonly string[]).includes(w.code)) out.push(`${w.code}: trùng mã dành riêng của nền tảng`);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(w.accountCode)) out.push(`${w.code}: mã tài khoản sai dạng`);
    const slug = domainSlugProblem(w.domainSlug);
    if (slug) out.push(`${w.code}: tên miền con — ${slug.message}`);
    if ((RESERVED_ORG_CODES as readonly string[]).includes(w.domainSlug)) out.push(`${w.code}: tên miền con trùng tên dành riêng`);
    const domain = w.ownerEmail.split("@")[1] ?? "";
    if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/.test(w.ownerEmail) || !PLATFORM_OWNED_EMAIL_DOMAINS.includes(domain)) out.push(`${w.code}: email quản trị phải thuộc tên miền của nền tảng (${PLATFORM_OWNED_EMAIL_DOMAINS.join(" · ")})`);
    if (!/không phải khách thật/i.test(w.name)) out.push(`${w.code}: tên hiển thị phải nói rõ «không phải khách thật»`);
    if (w.reason.trim().length < 20) out.push(`${w.code}: thiếu lý do`);
  }
  return out;
}

/** Khoá idempotent của job «Tạo khách» cho workspace thử — CỐ ĐỊNH: lượt chạy lại trả đúng job cũ, không tạo khách thứ hai. */
export function acceptanceIdempotencyKey(code: string): string {
  return `saas-acceptance:${code}`;
}

// ─────────────────────────── Dữ liệu MẪU cho bước E2E (chuẩn bị một lần trên UI — ACCEPTANCE.md §3) ───────────────────────────

/** Sản phẩm MẪU: tên tiền tố «Mẫu ·», SKU + giá cố định. Người làm MỘT lần ở vỏ app (Sản phẩm → Tạo sản phẩm, rồi Nhập hàng). */
export const ACCEPTANCE_SAMPLE_PRODUCTS = [{ sku: "NT-AO-01", name: "Mẫu · Áo thun nghiệm thu", priceVnd: 150_000, minStock: 10 }] as const;

/** Đơn thử: SĐT dạng thử (đầu số hợp lệ, không phải số của ai), địa chỉ ghép được tới cấp xã (`normalizeVnAddress` ⇒ MATCHED). */
export const ACCEPTANCE_ORDER = { sku: ACCEPTANCE_SAMPLE_PRODUCTS[0].sku, quantity: 2, recipient: "Nguyễn Văn Nghiệm Thu", phone: "0900000001", address: "12 Lê Lợi, Phường Bến Thành, Thành phố Hồ Chí Minh" } as const;

/** Ghi chú khách gửi kèm đơn — mang mã lượt chạy để đối chiếu từng lượt trong OMS. */
export function acceptanceOrderNote(runId: string): string {
  return `${ACCEPTANCE_ACTOR_LABEL} ${runId}`;
}

/** Kịch bản tiếng Việt CỐ ĐỊNH của khách: hỏi giá → đặt hàng kèm SĐT + địa chỉ đầy đủ → đồng ý chốt. */
export function acceptanceChatTurns(runId: string): string[] {
  const p = ACCEPTANCE_SAMPLE_PRODUCTS[0];
  const o = ACCEPTANCE_ORDER;
  return [
    `Chào shop, ${p.name} giá bao nhiêu ạ?`,
    `Cho em đặt ${o.quantity} cái ${p.name}. Người nhận: ${o.recipient}, SĐT ${o.phone}, địa chỉ: ${o.address}. Ghi chú đơn: ${acceptanceOrderNote(runId)}.`,
    "Đúng rồi ạ, em đồng ý, chốt đơn giúp em.",
  ];
}

/** Lượt nhắn thêm (tối đa MỘT) khi sau kịch bản bot vẫn chưa lên / chốt đơn — câu khách thật hay nhắn, không dạy bot cách làm. */
export const ACCEPTANCE_NUDGE_TURN = "Shop lên đơn giúp em luôn nhé, em xác nhận đặt.";

// ─────────────────────────── Dấu hiệu trang lỗi (CÙNG chữ với scripts/smoke.ts) ───────────────────────────

/** Ranh giới lỗi của Next (`app/(dashboard)/error.tsx`) — CÙNG chữ với `ERROR_MARKER` của scripts/smoke.ts (bài kiểm so hai nơi). */
export const PAGE_ERROR_MARKER = "Có lỗi khi tải trang";
/** Mã lỗi máy chủ trong gói RSC (toàn chữ số) — CÙNG biểu thức với `DIGEST_MARKER` của scripts/smoke.ts. */
export const PAGE_ERROR_DIGEST = /\\?"digest\\?"\s*:\s*\\?"\d{3,}\\?"/;

// ─────────────────────────── Ô arg của ops ───────────────────────────

export type AcceptanceMode = "READ" | "APPLY" | "E2E";
export const ACCEPTANCE_MODE_LABEL: Record<AcceptanceMode, string> = { READ: "CHỈ ĐỌC", APPLY: "GHI", E2E: "GHI + E2E" };

export type AcceptanceArgs = { ok: true; mode: AcceptanceMode; orgCode: string | null } | { ok: false; error: string };

/**
 * `(rỗng)` = CHỈ ĐỌC · `--apply` = thêm cấp phát + kích hoạt + đăng nhập · `--apply --e2e` = thêm chat → AI → đơn · `--org=<mã>` khi sổ
 * có nhiều mục. Cờ lạ / lặp / sai cặp ⇒ lỗi cách dùng (gõ nhầm `--aply` mà vẫn chạy là ghi mù). THUẦN; câu lỗi chỉ nói VỊ TRÍ / LOẠI
 * lỗi, không chép nội dung ô arg (nó đi ra kênh tóm tắt công khai).
 */
export function parseAcceptanceArgs(args: readonly string[]): AcceptanceArgs {
  const seen = new Set<string>();
  let orgCode: string | null = null;
  for (const [i, a] of args.entries()) {
    const key = a.startsWith("--org=") ? "--org=" : a;
    if (seen.has(key)) return { ok: false, error: `từ thứ ${i + 1}: cờ lặp lại` };
    seen.add(key);
    if (key === "--org=") {
      orgCode = a.slice("--org=".length).trim().toLowerCase();
      if (!ORGANIZATION_CODE_PATTERN.test(orgCode)) return { ok: false, error: `từ thứ ${i + 1}: mã tổ chức sai dạng` };
    } else if (key !== "--apply" && key !== "--e2e") return { ok: false, error: `từ thứ ${i + 1}: không phải cờ đã biết (--apply · --e2e · --org=<mã>)` };
  }
  if (seen.has("--e2e") && !seen.has("--apply")) return { ok: false, error: "--e2e chỉ đi cùng --apply (bước E2E GHI vào workspace thử)" };
  return { ok: true, mode: seen.has("--e2e") ? "E2E" : seen.has("--apply") ? "APPLY" : "READ", orgCode };
}

// ─────────────────────────── Kết quả từng bước + dòng tóm tắt ───────────────────────────

/** Thứ tự CHẠY: A → B1 → C → D → E → B2 (xoay mật khẩu luôn chạy CUỐI, kể cả khi bước giữa hỏng). */
export const ACCEPTANCE_STEPS = ["A", "B1", "C", "D", "E", "B2"] as const;
export type AcceptanceStepKey = (typeof ACCEPTANCE_STEPS)[number];

export const ACCEPTANCE_STEP_LABEL: Record<AcceptanceStepKey, string> = {
  A: "A · workspace nghiệm thu",
  B1: "B · kích hoạt + đăng nhập email",
  C: "C · vỏ app Chốt Đơn",
  D: "D · chat web → AI → đơn",
  E: "E · chat công khai theo tên miền con",
  B2: "B · xoay mật khẩu rồi vứt",
};

export type StepStatus = "PASS" | "FAIL" | "SKIP";
export type StepResult = { key: AcceptanceStepKey; status: StepStatus; reason: string; ms: number; detail: string[] };

/** `PASS|FAIL|SKIP <bước> — <lý do cụ thể> (<ms>)` — MỘT dòng mỗi bước (phần MÃ HOÁ của ops). */
export function formatStepLine(r: StepResult): string {
  return `${r.status} ${ACCEPTANCE_STEP_LABEL[r.key]} — ${r.reason} (${r.ms}ms)`;
}

export function acceptanceVerdict(results: readonly StepResult[]): "PASS" | "FAIL" {
  return results.length > 0 && results.every((r) => r.status !== "FAIL") ? "PASS" : "FAIL";
}

/** Trần của kênh tóm tắt công khai (cùng số với các script tóm tắt khác). */
export const ACCEPTANCE_SUMMARY_MAX = 300;

/** Chi phí AI theo USD, kiểu Việt (dấu phẩy thập phân, 4 chữ số — một lượt chat thường dưới 0,01 USD). */
export function formatAcceptanceUsd(usd: number): string {
  return usd.toLocaleString("vi-VN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/**
 * DÒNG CÔNG KHAI DUY NHẤT: `saas-acceptance: <PASS|FAIL> <n đạt>/<n> · …` — `n` = số bước ĐÃ CHẠY (đạt + hỏng), bước bỏ qua nêu
 * riêng (bỏ qua không phải đạt). Chỉ mã workspace THỬ, chế độ, tên miền gốc và chi phí AI — không email, không SĐT, không mã đơn.
 */
export function acceptanceSummary(results: readonly StepResult[], ctx: { mode: AcceptanceMode; orgCode: string | null; baseDomain?: string | null; aiCostUsd?: number | null; note?: string }): string {
  const ran = results.filter((r) => r.status !== "SKIP");
  const passed = ran.filter((r) => r.status === "PASS").length;
  const failed = ran.filter((r) => r.status === "FAIL").map((r) => r.key);
  const skipped = results.filter((r) => r.status === "SKIP").map((r) => r.key);
  const parts = [
    `saas-acceptance: ${acceptanceVerdict(results)} ${passed}/${ran.length}`,
    failed.length ? `hỏng ${failed.join(", ")}` : null,
    skipped.length ? `bỏ qua ${skipped.join(", ")}` : null,
    `chế độ ${ACCEPTANCE_MODE_LABEL[ctx.mode]}`,
    ctx.orgCode ? `workspace ${ctx.orgCode}` : null,
    ctx.baseDomain !== undefined ? `miền chat ${ctx.baseDomain ?? "CHƯA KHAI"}` : null,
    ctx.aiCostUsd !== undefined && ctx.aiCostUsd !== null ? `AI lượt này ≈ ${formatAcceptanceUsd(ctx.aiCostUsd)} USD` : null,
    ctx.note ?? null,
  ].filter((s): s is string => Boolean(s));
  return parts.join(" · ").slice(0, ACCEPTANCE_SUMMARY_MAX);
}

/**
 * CHE BÍ MẬT trước khi in BẤT KỲ chữ nào (kể cả phần mã hoá): mật khẩu sinh trong bộ nhớ, mã liên kết kích hoạt, phiên ký — thay bằng
 * «•••». Bí mật ngắn hơn 8 ký tự không đăng ký (tránh che nhầm chữ thường). THUẦN.
 */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("•••");
  return out;
}
