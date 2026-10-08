/*
  ops `ops-signals-check` — TÁM TÍN HIỆU VẬN HÀNH (O1–O8, docs/saas/LAUNCH_GATE.md §4) TÍNH TRÊN PRODUCTION, ĐỂ LẠI VẾT (CHỈ ĐỌC).

  Vì sao có (09/10/2026): PR #692 đưa tám tín hiệu lên production (`lib/platform/ops-signals.ts`, khung «Sự cố 24 giờ / 7 ngày» ở
  `/platform/org/<mã>`), nhưng không có đường ops nào CHẠY phép tính ấy trên production và để lại bằng chứng — nên các dòng O1–O8 của
  cổng ra mắt không lên được «✅ PROD». Script này gọi ĐÚNG hàm của khung (`loadOpsSignalsForOrgs` → `buildOpsSignalLines`) cho MỌI tổ
  chức trong sổ; KHÔNG có công thức SQL thứ hai cho tín hiệu nào (AGENTS §8.12).

  NGƯỜI VẬN HÀNH MÁY: hàm đọc hỏi `platformOperatorDenial` (người của tổ chức NHÀ có `platform:operate`). Script không bịa quyền: nó hỏi
  ĐÚNG bộ tính quyền của phiên đăng nhập (`activeUserIdsWhoCan("platform:operate")`) xem tài khoản ĐANG BẬT nào của tổ chức nhà có quyền
  ấy, rồi dựng người dùng của tài khoản đó y như `scripts/ai-check.ts` / `scripts/check-integrations.ts` (vai trò + quyền đã phân giải,
  tổ chức nhà). Không ai có quyền ⇒ FAIL, không lùi về một người dựng tay. Danh tính ấy CHỈ dùng để đọc.

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên); `main` hỏi lại (`platformReadOnlyConfirmed`) rồi dừng nếu
  không phải. Không INSERT / UPDATE / DELETE, không gửi job, không gửi tin (tests/ops-signals-check.test.ts quét mã nguồn).

  ĐẦU RA:
   · phần MÃ HOÁ (dòng không tiền tố): từng tổ chức — mã · trạng thái · tám dòng (mức, đếm, lần cuối, lý do, id tương quan, chi tiết đã che).
   · kênh công khai `[ops:tom-tat] `: CHỈ số đếm + mã lý do. Mỗi tín hiệu: số tổ chức ở từng mức + số lượt tính hỏng; workspace nghiệm
     thu `cdt-nghiem-thu` (sổ khai công khai): mức + mã lý do + đếm của từng tín hiệu, và dòng bằng chứng O1. Không tên, email, SĐT,
     tên page, token, tiền; không mã tổ chức khách nào khác.
   · PASS = cả tám tín hiệu tính được cho MỌI tổ chức, 0 lượt hỏng. UNKNOWN KHÔNG phải hỏng (chưa biết vẫn là chưa biết — luật 42) nhưng
     được đếm riêng. Mã thoát: 0 PASS · 1 FAIL · 64 arg sai · 70 CSDL không chỉ đọc.

  arg: không nhận arg nào.
  ops lấy SCRIPT này từ `main` nhưng `lib/` từ IMAGE đang chạy — cần image mang #692.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("ops-signals-check.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan, loadPermissionSnapshots, loadRoleTemplates, type SessionUser } from "@/lib/auth/session";
import { resolvePermissions } from "@/lib/auth/permissions";
import { AUTH_FAILURE_FLOW_LABEL, AUTH_FAILURE_FLOWS, type AuthFailureFlow } from "@/lib/constants/auth-failures";
import { OPS_LEVELS, OPS_SIGNAL_KEYS, type OpsLevel, type OpsSignalKey, type OpsSignalLine } from "@/lib/constants/ops-signals";
import { ACCEPTANCE_WORKSPACES } from "@/lib/constants/saas-acceptance-registry";
import { platformReadOnlyConfirmed } from "@/lib/pricing/migration";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { loadOpsSignalsForOrgs, OPS_SIGNALS_MAX_ORGS } from "@/lib/platform/ops-signals";
import { getHomeOrganization, listOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Trần của kênh tóm tắt (cùng số với `ma_hoa_ket_qua`: 60 dòng × 300 ký tự). */
export const SUMMARY_MAX_LINES = 60;
export const SUMMARY_MAX_CHARS = 300;

/** Mã của workspace nghiệm thu — sổ khai công khai (lib/constants/saas-acceptance-registry.ts), nên mã in ra log được. */
export const ACCEPTANCE_CODES: readonly string[] = ACCEPTANCE_WORKSPACES.map((w) => w.code);

/** Một mã lý do in ra kênh công khai phải là MÃ (cùng hình CHECK của gương) — chuỗi khác in «(khác)», không bao giờ in nguyên văn. */
const REASON_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
export function publicReasonCode(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return REASON_CODE.test(v) ? v : "(khác)";
}

/** Số đếm in ra: `null` ⇒ `—` (CHƯA BIẾT, luật 42), 0 thật ⇒ `0`. */
const dem = (n: number | null | undefined): string => (typeof n === "number" && Number.isFinite(n) ? String(n) : "—");

/**
 * Luồng của lỗi đăng nhập cuối (LOGIN · RESET_LINK · INVITE) — đọc NGƯỢC từ nhãn đầu của `detail` mà `authFailureWho` dựng
 * («<nhãn luồng> · <định danh đã che>»). Chỉ trả MÃ trong sổ khai; phần định danh không bao giờ đi tiếp. HÀM THUẦN.
 */
export function loginFlowOf(detail: string | null | undefined): AuthFailureFlow | null {
  if (!detail) return null;
  const head = detail.split(" · ")[0]?.trim();
  return AUTH_FAILURE_FLOWS.find((f) => AUTH_FAILURE_FLOW_LABEL[f] === head) ?? null;
}

/** Kết quả tính tám tín hiệu cho MỘT tổ chức: dòng của khung, hoặc lỗi (câu lỗi chỉ ở phần mã hoá). */
export type OrgSignalsOutcome = { code: string; status: string; result: { ok: true; lines: readonly OpsSignalLine[] } | { ok: false; error: string } };

export type SignalTally = { levels: Record<OpsLevel, number>; threw: number };

export type OpsSignalsCheckReport = {
  verdict: "PASS" | "FAIL";
  orgs: number;
  perSignal: Record<OpsSignalKey, SignalTally>;
  /** Tín hiệu có ít nhất một tổ chức tính hỏng — rỗng khi PASS. */
  failedSignals: OpsSignalKey[];
  unknownCells: number;
  publicLines: string[];
};

const emptyLevels = (): Record<OpsLevel, number> => Object.fromEntries(OPS_LEVELS.map((l) => [l, 0])) as Record<OpsLevel, number>;

/** Số thứ tự O1–O8 theo đúng thứ tự `OPS_SIGNAL_KEYS` (LAUNCH_GATE §4). */
const oNum = (k: OpsSignalKey) => `O${OPS_SIGNAL_KEYS.indexOf(k) + 1}`;

/**
 * Gom kết quả MỌI tổ chức ⇒ phán quyết + các dòng công khai. HÀM THUẦN.
 *  · Tổ chức tính hỏng (hàm đọc ném / từ chối) ⇒ cả tám tín hiệu của nó tính là HỎNG.
 *  · Tổ chức tính được nhưng thiếu dòng / mức lạ ⇒ đúng tín hiệu ấy HỎNG (không đoán mức).
 *  · UNKNOWN / NA là mức hợp lệ — đếm, không làm FAIL.
 *  · Không tổ chức nào ⇒ FAIL (không có gì được chứng minh).
 */
export function summarizeOpsSignals(outcomes: readonly OrgSignalsOutcome[], opts: { acceptanceCodes?: readonly string[] } = {}): OpsSignalsCheckReport {
  const acceptance = opts.acceptanceCodes ?? ACCEPTANCE_CODES;
  const perSignal = Object.fromEntries(OPS_SIGNAL_KEYS.map((k) => [k, { levels: emptyLevels(), threw: 0 }])) as Record<OpsSignalKey, SignalTally>;
  let unknownCells = 0;
  for (const o of outcomes) {
    for (const k of OPS_SIGNAL_KEYS) {
      const line = o.result.ok ? o.result.lines.find((l) => l.key === k) : undefined;
      if (!line || !(OPS_LEVELS as readonly string[]).includes(line.level)) {
        perSignal[k].threw += 1;
        continue;
      }
      perSignal[k].levels[line.level] += 1;
      if (line.level === "UNKNOWN") unknownCells += 1;
    }
  }
  const failedSignals = OPS_SIGNAL_KEYS.filter((k) => perSignal[k].threw > 0);
  const totalThrew = OPS_SIGNAL_KEYS.reduce((s, k) => s + perSignal[k].threw, 0);
  const verdict: "PASS" | "FAIL" = outcomes.length > 0 && totalThrew === 0 ? "PASS" : "FAIL";
  const orgsFailed = outcomes.filter((o) => !o.result.ok).length;

  const lines: string[] = [];
  lines.push(
    `ops-signals-check: ${verdict} · ${outcomes.length} tổ chức × ${OPS_SIGNAL_KEYS.length} tín hiệu · ${totalThrew} ô tính hỏng (${orgsFailed} tổ chức hỏng cả lượt)` +
      (outcomes.length === 0 ? " · KHÔNG có tổ chức nào để tính" : "") +
      (failedSignals.length ? ` · tín hiệu hỏng: ${failedSignals.map((k) => `${oNum(k)} ${k}`).join(", ")}` : ""),
  );
  for (const k of OPS_SIGNAL_KEYS) {
    const t = perSignal[k];
    lines.push(`${oNum(k)} ${k}: ${OPS_LEVELS.map((l) => `${l} ${t.levels[l]}`).join(" · ")} · hỏng ${t.threw}`);
  }
  lines.push(`UNKNOWN (CHƯA BIẾT — không phải lỗi, không tính FAIL): ${unknownCells}/${outcomes.length * OPS_SIGNAL_KEYS.length} ô`);

  for (const code of acceptance) {
    const o = outcomes.find((x) => x.code === code);
    if (!o) {
      lines.push(`${code}: chưa có workspace trong sổ tổ chức — chạy saas-acceptance --apply trước`);
      continue;
    }
    if (!o.result.ok) {
      lines.push(`${code}: tính hỏng cả tám tín hiệu (câu lỗi trong phần mã hoá)`);
      continue;
    }
    const got = o.result.lines;
    for (const k of OPS_SIGNAL_KEYS) {
      const l = got.find((x) => x.key === k);
      if (!l) {
        lines.push(`${code} ${oNum(k)} ${k}: KHÔNG có dòng — tính hỏng`);
        continue;
      }
      const flow = k === "LOGIN" ? loginFlowOf(l.detail) : null;
      lines.push(`${code} ${oNum(k)} ${k}: ${l.level} · 24h ${dem(l.count24h)} · 7d ${dem(l.count7d)} · lý do cuối ${publicReasonCode(l.lastReason)}${flow ? ` · luồng ${flow}` : ""}${l.lastAt ? ` · lần cuối ${l.lastAt}` : ""}${l.stale ? " · gương CŨ" : ""}`);
    }
    // Bằng chứng O1 trọn vòng: `saas-acceptance --apply` cố ý dùng lại liên kết đã dùng (bước B1) ⇒ `completePasswordResetCore` ghi
    // RESET_LINK_USED vào platform_auth_failures cho đúng workspace này ⇒ dòng LOGIN phải thấy nó trong 24 giờ.
    const login = got.find((x) => x.key === "LOGIN");
    if (login) {
      const seen = (login.count24h ?? 0) > 0;
      lines.push(
        `O1 bằng chứng ${code}: ${seen ? "CÓ" : "CHƯA"} lỗi đăng nhập ghi trong 24 giờ (24h ${dem(login.count24h)} · lý do cuối ${publicReasonCode(login.lastReason)} · luồng ${loginFlowOf(login.detail) ?? "—"})` +
          (seen ? "" : " — chạy saas-acceptance --apply rồi chạy lại thao tác này"),
      );
    }
  }
  const publicLines = lines.slice(0, SUMMARY_MAX_LINES).map((l) => (l.length > SUMMARY_MAX_CHARS ? `${l.slice(0, SUMMARY_MAX_CHARS - 1)}…` : l));
  return { verdict, orgs: outcomes.length, perSignal, failedSignals, unknownCells, publicLines };
}

/** Phần MÃ HOÁ của một tổ chức — đủ chi tiết để người vận hành soi, chỉ ra hiện vật mã hoá. HÀM THUẦN. */
export function privateLinesOf(o: OrgSignalsOutcome): string[] {
  if (!o.result.ok) return [`${o.code} (${o.status}): TÍNH HỎNG — ${o.result.error.slice(0, 300)}`];
  return [
    `${o.code} (${o.status}):`,
    ...o.result.lines.map(
      (l) =>
        `  ${oNum(l.key)} ${l.key} ${l.level} · 24h ${dem(l.count24h)} · 7d ${dem(l.count7d)} · lần cuối ${l.lastAt ?? "—"} · lý do ${l.lastReason ?? "—"} · tương quan ${l.correlationId ?? "—"} · chi tiết ${l.detail ?? "—"} · đo lúc ${l.measuredAt ?? "—"}${l.stale ? " · CŨ" : ""}${l.note ? ` · ${l.note}` : ""}`,
    ),
  ];
}

// ─────────────────────────── Đọc (chỉ đọc, qua ĐÚNG hàm của khung) ───────────────────────────

export type CollectDeps = {
  load: typeof loadOpsSignalsForOrgs;
  /** `true/false` = tổ chức có / không bật AI bán hàng; `null` = không đọc được (khung in «chưa biết», không N/A). */
  aiSalesEnabled: (code: string) => Promise<boolean | null>;
  now: () => Date;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

const defaultDeps: CollectDeps = {
  load: loadOpsSignalsForOrgs,
  aiSalesEnabled: async (code) => {
    try {
      return (await getEnabledModules(code)).has("ai_sales");
    } catch {
      return null;
    }
  },
  now: () => new Date(),
};

/**
 * Tám tín hiệu của từng tổ chức. Một lượt gom cho mỗi `OPS_SIGNALS_MAX_ORGS` mã (một câu SQL — đúng như khung); lượt gom NÉM ⇒ tính
 * lại TỪNG tổ chức để biết tổ chức nào hỏng (một câu ném làm hỏng cả lượt, không được đổ cho mọi tổ chức). Không ném.
 */
export async function collectOpsSignals(user: SessionUser, orgs: readonly { code: string; status: string }[], deps: Partial<CollectDeps> = {}): Promise<OrgSignalsOutcome[]> {
  const d = { ...defaultDeps, ...deps };
  const now = d.now();
  const ai = new Map<string, boolean | null>();
  for (const o of orgs) ai.set(o.code, await d.aiSalesEnabled(o.code));
  const out: OrgSignalsOutcome[] = [];
  const pick = (o: { code: string; status: string }, value: ReadonlyMap<string, { lines: OpsSignalLine[] }>): OrgSignalsOutcome => {
    const v = value.get(o.code);
    return v ? { ...o, result: { ok: true, lines: v.lines } } : { ...o, result: { ok: false, error: "Hàm đọc không trả dòng cho mã này (mã sai dạng — khung /platform/org cũng không tính được)." } };
  };
  for (let i = 0; i < orgs.length; i += OPS_SIGNALS_MAX_ORGS) {
    const chunk = orgs.slice(i, i + OPS_SIGNALS_MAX_ORGS);
    try {
      const r = await d.load(user, chunk.map((o) => o.code), { now, aiSalesEnabled: ai });
      if (!r.ok) {
        for (const o of chunk) out.push({ ...o, result: { ok: false, error: `${r.code}: ${r.error}` } });
        continue;
      }
      for (const o of chunk) out.push(pick(o, r.value));
    } catch {
      for (const o of chunk) {
        try {
          const r = await d.load(user, [o.code], { now, aiSalesEnabled: ai });
          out.push(r.ok ? pick(o, r.value) : { ...o, result: { ok: false, error: `${r.code}: ${r.error}` } });
        } catch (e) {
          out.push({ ...o, result: { ok: false, error: errText(e) } });
        }
      }
    }
  }
  return out;
}

/**
 * Người vận hành MÁY: tài khoản ĐANG BẬT của tổ chức nhà mà bộ tính quyền của phiên (`activeUserIdsWhoCan`) nói là có
 * `platform:operate` — ưu tiên ADMIN, thứ tự id cố định. Dựng như ai-check / check-integrations; hỏi lại `platformOperatorDenial`.
 */
export async function machineOperator(): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
  const home = await getHomeOrganization();
  const ids = await activeUserIdsWhoCan("platform:operate");
  if (!ids.length) return { ok: false, error: "Tổ chức nhà không có tài khoản đang bật nào có quyền platform:operate." };
  const db = await getDb();
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, permissions: schema.users.permissions })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  rows.sort((a, b) => Number(b.role === "ADMIN") - Number(a.role === "ADMIN") || a.id.localeCompare(b.id));
  const row = rows[0];
  if (!row) return { ok: false, error: "Không đọc lại được tài khoản người vận hành." };
  const [templates, snapshots, modules] = await Promise.all([loadRoleTemplates(), loadPermissionSnapshots(), getEnabledModules(home.code)]);
  const user: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: resolvePermissions(row.role, row.permissions, templates, snapshots[row.id] ?? null),
    scope: "ALL",
    departmentCodes: [],
    positionId: null,
    organization: { code: home.code, name: home.name, isHome: true },
    modules: [...modules],
  };
  const denial = platformOperatorDenial(user);
  return denial ? { ok: false, error: denial } : { ok: true, user };
}

async function main() {
  if (ARGS.some((a) => a.trim())) {
    tomTat("ops-signals-check: FAIL · cách dùng sai — thao tác này không nhận arg (để trống ô arg)");
    process.exit(64);
  }
  if (!(await platformReadOnlyConfirmed())) {
    tomTat("ops-signals-check: FAIL · DỪNG: kết nối CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(70);
  }
  const op = await machineOperator();
  if (!op.ok) {
    console.log(`Người vận hành máy: ${op.error}`);
    tomTat("ops-signals-check: FAIL · không có người vận hành nền tảng để đọc qua cổng platformOperatorDenial (chi tiết trong phần mã hoá)");
    process.exit(1);
  }
  console.log(`Người vận hành máy: tài khoản ${op.user.id} (${op.user.role}) của tổ chức nhà ${op.user.organization?.code ?? "—"} — chỉ dùng để ĐỌC.`);
  const orgs = (await listOrganizations()).map((o) => ({ code: o.code, status: o.status }));
  const outcomes = await collectOpsSignals(op.user, orgs);
  for (const o of outcomes) for (const l of privateLinesOf(o)) console.log(l);
  const report = summarizeOpsSignals(outcomes);
  for (const l of report.publicLines) tomTat(l);
  process.exit(report.verdict === "PASS" ? 0 : 1);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.log(`LỖI: ${errText(e)}`);
    tomTat("ops-signals-check: FAIL · LỖI ngoài phép tính tín hiệu — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
