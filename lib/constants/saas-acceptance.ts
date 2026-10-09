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
 * `ACCEPTANCE_WORKSPACES` (tệp lá lib/constants/saas-acceptance-registry.ts): mã ngoài sổ ⇒ TỪ CHỐI trước mọi lượt đọc
 * (`acceptanceWorkspaceOf`). Đường phát liên kết của máy (`createAcceptanceResetLink`) hỏi lại sổ, hỏi workspace có đúng do
 * ops tạo không (`lib/saas/acceptance-guard.ts`) và từ chối trong máy chủ ứng dụng. Mã + tên miền con của sổ được GIỮ CHỖ ở mọi
 * đường tự đăng ký / đặt tên miền. Thêm một mục = một quyết định có lý do, không phải một tham số dòng lệnh.
 *
 * Tệp THUẦN (không CSDL, không mạng): lõi, script, bài kiểm và tài liệu đọc cùng một bản.
 */
import { RESERVED_ORG_CODES } from "@/lib/onboarding/shared";
import { domainSlugProblem } from "@/lib/platform/host";
import { DEFAULT_CHOTDON_DOMAIN, DEFAULT_SITE_DOMAIN } from "@/lib/platform/site-host";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { OPS_SIGNAL_KEYS, type OpsSignalKey } from "@/lib/constants/ops-signals";
import { ACCEPTANCE_ACTOR_LABEL, ACCEPTANCE_WORKSPACES, type AcceptanceWorkspace } from "@/lib/constants/saas-acceptance-registry";

// Sổ khai + vị ngữ sống ở tệp LÁ (giữ chỗ / loại trừ đọc được mà không kéo đồ thị phụ thuộc) — xuất lại để mọi nơi đọc một bản.
export { ACCEPTANCE_ACTOR_LABEL, ACCEPTANCE_RESERVED_MESSAGE, ACCEPTANCE_WORKSPACES, acceptanceReservedName, acceptanceWorkspaceOf, type AcceptanceWorkspace } from "@/lib/constants/saas-acceptance-registry";

/** Câu từ chối khi mã không nằm trong sổ khai — không lặp lại mã đã gõ (nó có thể đi ra kênh tóm tắt công khai). */
export const ACCEPTANCE_REGISTRY_REFUSAL = "Mã tổ chức không có trong sổ khai nghiệm thu (lib/constants/saas-acceptance.ts) — ops nghiệm thu chỉ chạm workspace THỬ của chính nó.";

/** Tên miền mà email quản trị thử được phép thuộc về — tên miền GỐC của hai thương hiệu của chính nền tảng. */
export const PLATFORM_OWNED_EMAIL_DOMAINS: readonly string[] = [DEFAULT_CHOTDON_DOMAIN, DEFAULT_SITE_DOMAIN];

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

export type AcceptanceArgs = { ok: true; mode: AcceptanceMode; orgCode: string | null; drills: boolean } | { ok: false; error: string };

/**
 * `(rỗng)` = CHỈ ĐỌC · `--apply` = thêm cấp phát + kích hoạt + đăng nhập · `--apply --e2e` = thêm chat → AI → đơn · `--apply --drills` =
 * thêm bước F diễn tập tín hiệu vận hành (không bao giờ chạy mặc định) · `--org=<mã>` khi sổ có nhiều mục. Cờ lạ / lặp / sai cặp ⇒ lỗi
 * cách dùng (gõ nhầm `--aply` mà vẫn chạy là ghi mù). THUẦN; câu lỗi chỉ nói VỊ TRÍ / LOẠI lỗi, không chép nội dung ô arg (nó đi ra kênh
 * tóm tắt công khai).
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
    } else if (key !== "--apply" && key !== "--e2e" && key !== "--drills") return { ok: false, error: `từ thứ ${i + 1}: không phải cờ đã biết (--apply · --e2e · --drills · --org=<mã>)` };
  }
  if (seen.has("--e2e") && !seen.has("--apply")) return { ok: false, error: "--e2e chỉ đi cùng --apply (bước E2E GHI vào workspace thử)" };
  if (seen.has("--drills") && !seen.has("--apply")) return { ok: false, error: "--drills chỉ đi cùng --apply (diễn tập GHI tín hiệu cho workspace thử)" };
  return { ok: true, mode: seen.has("--e2e") ? "E2E" : seen.has("--apply") ? "APPLY" : "READ", orgCode, drills: seen.has("--drills") };
}

// ─────────────────────────── Kết quả từng bước + dòng tóm tắt ───────────────────────────

/** Thứ tự CHẠY: A → B1 → C → D → E → B2 (xoay mật khẩu luôn chạy CUỐI, kể cả khi bước giữa hỏng). */
export const ACCEPTANCE_STEPS = ["A", "B1", "C", "D", "E", "B2"] as const;
/** Bước F (diễn tập tín hiệu) chỉ có mặt khi `--drills` — lượt thường giữ nguyên sáu bước và nguyên dòng tóm tắt cũ. */
export type AcceptanceStepKey = (typeof ACCEPTANCE_STEPS)[number] | "F";

/** Thứ tự chạy của MỘT lượt: F chen TRƯỚC B2 (xoay mật khẩu vẫn CUỐI). THUẦN. */
export function acceptanceStepsFor(drills: boolean): readonly AcceptanceStepKey[] {
  return drills ? ["A", "B1", "C", "D", "E", "F", "B2"] : ACCEPTANCE_STEPS;
}

export const ACCEPTANCE_STEP_LABEL: Record<AcceptanceStepKey, string> = {
  A: "A · workspace nghiệm thu",
  B1: "B · kích hoạt + đăng nhập email",
  C: "C · vỏ app Chốt Đơn",
  D: "D · chat web → AI → đơn",
  E: "E · chat công khai theo tên miền con",
  F: "F · diễn tập tín hiệu vận hành",
  B2: "B · xoay mật khẩu rồi vứt",
};

// ─────────────────────────── F · diễn tập tín hiệu vận hành O1–O8 (LAUNCH_GATE §4) ───────────────────────────

/**
 * DIỄN TẬP = gây MỘT sự cố có kiểm soát trên workspace nghiệm thu qua ĐÚNG đường mã production ghi tín hiệu (đầu vào cố ý sai), để
 * ops `ops-signals-check` thấy tín hiệu ấy đổi mức. KHÔNG bao giờ chèn thẳng một dòng lỗi giả: tín hiệu nào chỉ gây được bằng dòng
 * tổng hợp / bằng gọi dịch vụ ngoài thật / bằng đổi cấu hình thật thì khai «CHƯA ĐO ĐƯỢC» kèm lý do — dưới đây là ĐÚNG lý do đã soi.
 */
export type DrillStatus = "DRILLED" | "SKIPPED" | "UNMEASURABLE" | "FAILED";
export const DRILL_STATUS_LABEL: Record<DrillStatus, string> = { DRILLED: "ĐÃ DIỄN TẬP", SKIPPED: "BỎ QUA", UNMEASURABLE: "CHƯA ĐO ĐƯỢC", FAILED: "HỎNG" };
/** Một dòng kết quả diễn tập: `code` = mã lý do / id dòng tín hiệu (phần MÃ HOÁ); dòng công khai chỉ dùng `key` + `status`. */
export type DrillResult = { key: OpsSignalKey; status: DrillStatus; code: string | null; why: string };

/** Tiền tố id tương quan của lượt diễn tập — dòng tín hiệu tự nói nó là diễn tập (không trỏ tới hội thoại nào của khách). */
export const ACCEPTANCE_DRILL_ID_PREFIX = "nghiem-thu-drill:";

/** Tín hiệu KHÔNG diễn tập được một cách trung thực, kèm lý do — đọc thẳng vào phần mã hoá và tài liệu. */
export const ACCEPTANCE_UNMEASURABLE_DRILLS: Readonly<Partial<Record<OpsSignalKey, string>>> = {
  FB_CONNECTION: "workspace nghiệm thu không nối page Facebook nào — tín hiệu là N/A; gây lỗi token đòi gọi Graph thật",
  WEBHOOK: "đo từ đăng ký webhook page + hàng chờ tin fanpage; chat WEB không đi đường webhook, dead-letter chỉ có ở kênh nhắn tin",
  AI: "dòng ERROR chỉ sinh khi lượt gọi nhà cung cấp AI thật hỏng — gây được bằng đổi khoá / công tắc AI của workspace (đổi cấu hình thật) hoặc gọi AI thật (tốn tiền)",
  SEND: "lỗi gửi chỉ có ở kênh nhắn tin (Pancake / Meta / Zalo — dịch vụ ngoài thật); chat WEB lưu câu trả lời, không gửi đi đâu",
  ORDER_WRITE: "cần lõi đơn NÉM lỗi CSDL; không có đường không phá huỷ — gây được chỉ bằng bịa trạng thái hội thoại (id khách không có) hoặc phá CSDL",
  QUOTA: "cổng gói chỉ chặn khi dùng thử hết hạn / hết lượt / hết số dư — gây được chỉ bằng đổi gói / hạn mức thật của workspace hoặc tiêu hết lượt AI thật",
};

const oNum = (k: OpsSignalKey) => `O${OPS_SIGNAL_KEYS.indexOf(k) + 1}`;

/** Phần diễn tập của dòng tóm tắt công khai — CHỈ số hiệu tín hiệu theo trạng thái, không mã lý do / id / câu chữ. THUẦN. */
export function drillSummaryPart(results: readonly DrillResult[]): string {
  const of = (s: DrillStatus) => results.filter((r) => r.status === s).map((r) => oNum(r.key));
  const parts = (["DRILLED", "FAILED", "SKIPPED", "UNMEASURABLE"] as const).map((s) => (of(s).length ? `${DRILL_STATUS_LABEL[s]} ${of(s).join(",")}` : null)).filter(Boolean);
  return `diễn tập: ${parts.join(" · ") || "—"}`;
}

/** Phán quyết bước F: có diễn tập HỎNG ⇒ FAIL; có ít nhất một ĐÃ DIỄN TẬP ⇒ PASS; còn lại (thiếu điều kiện) ⇒ SKIP. THUẦN. */
export function drillStepStatus(results: readonly DrillResult[]): StepStatus {
  if (results.some((r) => r.status === "FAILED")) return "FAIL";
  return results.some((r) => r.status === "DRILLED") ? "PASS" : "SKIP";
}

/** Dòng chi tiết (phần MÃ HOÁ) của một tín hiệu. THUẦN. */
export function formatDrillLine(r: DrillResult): string {
  return `${oNum(r.key)} ${r.key}: ${DRILL_STATUS_LABEL[r.status]}${r.code ? ` (${r.code})` : ""} — ${r.why}`;
}

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
export function acceptanceSummary(results: readonly StepResult[], ctx: { mode: AcceptanceMode; orgCode: string | null; baseDomain?: string | null; aiCostUsd?: number | null; note?: string; drills?: string }): string {
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
    // Chỉ chuỗi đã dựng bằng `drillSummaryPart` (số hiệu tín hiệu theo trạng thái) — không mã lý do, không id.
    ctx.drills ?? null,
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
