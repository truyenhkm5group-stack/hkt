import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { homeReadiness } from "@/lib/connectors/home-status";
import {
  CONNECTOR_KIND_LABEL,
  CONNECTOR_KINDS,
  CONNECTORS,
  findConnector,
  isOrgConfigurable,
  maskSecret,
  plainFields,
  secretFields,
  type ConnectionStatus,
  type ConnectorSpec,
} from "@/lib/connectors/registry";
import { openSecrets, sealSecrets, secretsKeyState, type SecretsKeyState } from "@/lib/connectors/secrets";
import { ORG_CONNECTION_TESTERS, type TesterDeps } from "@/lib/connectors/testers";
import type { ConnectionActionResult, ConnectionSnapshot, ConnectionsView, ConnectorView } from "@/lib/connectors/types";
import { PLATFORM_MODULES } from "@/lib/constants/platform-modules";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ KẾT NỐI THEO TỔ CHỨC — ĐƯỜNG ĐỌC VÀ ĐƯỜNG GHI DUY NHẤT ═══════════
 *
 * Hợp đồng: docs/platform/phase-9-contracts.md §2. Màn hình `/settings/connections` đọc qua
 * `loadConnectionsView`; ba server action (`lib/actions/connections.ts`) chỉ là vỏ: đọc phiên → hàm ở
 * đây → `revalidatePath`. Bài kiểm gọi thẳng các hàm này với `SessionUser` dựng tay trong ngữ cảnh
 * tổ chức THẬT — cùng hàm action gọi, không nhánh riêng cho kiểm thử.
 *
 * ─── TỔ CHỨC LẤY TỪ NGỮ CẢNH, KHÔNG TỪ ĐẦU VÀO ───
 *
 * `getDb()` và AAD của bản mã đều dùng `currentOrganization()` (phiên do máy chủ ký / ngữ cảnh tường
 * minh). Không tham số nào của client chọn được tổ chức. Người dùng mang tổ chức lệch ngữ cảnh ⇒ từ chối.
 *
 * ─── BÍ MẬT KHÔNG RỜI KHỎI TỆP NÀY Ở DẠNG RÕ ───
 *
 * `openSecrets` chỉ được gọi ở `testOrgConnection` (đưa cho hàm kiểm tra) và ở `saveConnection` (gộp
 * với giá trị mới). Không hàm nào trả chúng ra; nhật ký ghi `secretHints` (`••••` + 4 ký tự), không
 * ghi giá trị; không `console.*` nào ở đây. Công cụ AI không import tệp này (bài kiểm quét).
 *
 * ─── BẬT = NGƯỜI BẤM, SAU KHI KIỂM TRA ĐẠT ───
 *
 * Lưu cấu hình ⇒ về NHÁP và xoá kết quả kiểm tra cũ (kiểm tra cho cấu hình cũ không chứng minh gì cho
 * cấu hình mới). Kiểm tra hỏng trên một kết nối đang bật ⇒ về NHÁP (phía hẹp). CSDL giữ ràng buộc
 * `org_connections_active_tested_check` để không đường ghi nào vòng qua được luật này.
 */

export const CONNECTIONS_PERMISSION = "settings:manage" as const;

type OrgRef = { code: string; name: string; isHome: boolean };
type Row = typeof schema.orgConnections.$inferSelect;

async function resolveOrg(user: SessionUser): Promise<OrgRef | { error: string }> {
  const ctx = await currentOrganization();
  if (user.organization && user.organization.code !== ctx.code) return { error: "Phiên đăng nhập thuộc tổ chức khác với ngữ cảnh đang chạy — tải lại trang." };
  const org = await findOrganization(ctx.code);
  return { code: ctx.code, name: org?.name ?? user.organization?.name ?? ctx.code, isHome: ctx.isHome };
}

function moduleLabel(key: string): string {
  return PLATFORM_MODULES.find((m) => m.key === key)?.label ?? key;
}

function moduleEnabled(user: SessionUser, spec: ConnectorSpec): boolean {
  return !user.modules || user.modules.includes(spec.module);
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

function snapshot(row: Row): ConnectionSnapshot {
  return {
    status: row.status as ConnectionStatus,
    settings: asStringMap(row.settings),
    secretHints: asStringMap(row.secretHints),
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Dòng lưu trong CSDL mang mã tổ chức khác ngữ cảnh ⇒ dây bẫy: không đọc, không ghi đè. */
function tripwire(row: Row | undefined, org: OrgRef): string | null {
  if (row && row.orgCode !== org.code) return `Dòng kết nối «${row.connectorKey}» mang mã tổ chức «${row.orgCode}», khác tổ chức đang chạy — không dùng. Báo người vận hành nền tảng.`;
  return null;
}

async function findRow(connectorKey: string): Promise<Row | undefined> {
  const db = await getDb();
  return db.query.orgConnections.findFirst({ where: eq(schema.orgConnections.connectorKey, connectorKey) });
}

function guard(user: SessionUser, connectorKey: string): { spec: ConnectorSpec } | { error: string } {
  if (!can(user, CONNECTIONS_PERMISSION)) return { error: "Không có quyền cấu hình kết nối (cần «Cấu hình hệ thống khác»)." };
  const spec = findConnector(connectorKey);
  if (!spec) return { error: `Không có connector «${connectorKey}» trong sổ.` };
  if (!isOrgConfigurable(spec)) {
    return { error: spec.tenancy === "HOME_ONLY" ? `«${spec.label}» dùng credential của tổ chức nhà ở biến môi trường — màn hình này chỉ đọc, không đổi được.` : `«${spec.label}» cấu hình ở chỗ khác: ${spec.config.where}.` };
  }
  if (!moduleEnabled(user, spec)) return { error: `Module «${moduleLabel(spec.module)}» của «${spec.label}» đang tắt ở tổ chức này.` };
  return { spec };
}

// ───────────────────────────── ĐỌC ─────────────────────────────

export async function loadConnectionsView(user: SessionUser, deps: { keyState?: SecretsKeyState } = {}): Promise<ConnectionsView | { error: string }> {
  if (!can(user, CONNECTIONS_PERMISSION)) return { error: "Không có quyền xem kết nối." };
  const org = await resolveOrg(user);
  if ("error" in org) return org;
  const db = await getDb();
  const rows = await db.select().from(schema.orgConnections);
  const byKey = new Map(rows.filter((r) => r.orgCode === org.code).map((r) => [r.connectorKey, r]));
  // Chỉ tổ chức nhà mới được đọc trạng thái cấu hình hiện hành từ biến môi trường (xem home-status.ts).
  const readiness = org.isHome ? await homeReadiness() : null;
  const keyState = deps.keyState ?? secretsKeyState();

  const view = (spec: ConnectorSpec): ConnectorView => {
    const configurable = isOrgConfigurable(spec);
    const mode: ConnectorView["mode"] = spec.tenancy === "HOME_ONLY" ? (org.isHome ? "HOME_READONLY" : "HOME_ONLY_UNAVAILABLE") : configurable ? "CONFIGURABLE" : "ELSEWHERE";
    const row = byKey.get(spec.key);
    return {
      key: spec.key,
      label: spec.label,
      vendor: spec.vendor,
      kind: spec.kind,
      tenancy: spec.tenancy,
      auth: spec.auth,
      capabilities: [...spec.capabilities],
      moduleKey: spec.module,
      moduleLabel: moduleLabel(spec.module),
      moduleEnabled: moduleEnabled(user, spec),
      why: spec.why,
      configStore: spec.config.store,
      configWhere: spec.config.where,
      hasHealthCheck: spec.health === "testConnection",
      consumers: [...spec.consumers],
      webhook: spec.webhook ? { path: spec.webhook.path, tenantResolution: spec.webhook.tenantResolution } : null,
      mode,
      homeReadiness: mode === "HOME_READONLY" ? (readiness?.[spec.key] ?? { state: "UNKNOWN", detail: "Chưa có cách đọc trạng thái cho connector này" }) : null,
      fields: configurable ? spec.settings.map((f) => ({ key: f.key, label: f.label, type: f.type, secret: f.secret, required: f.required, hint: f.hint })) : [],
      connection: configurable && row ? snapshot(row) : null,
    };
  };

  return {
    organization: org,
    secretsReady: keyState.ok ? { ok: true, reason: null } : { ok: false, reason: keyState.reason },
    groups: CONNECTOR_KINDS.map((kind) => ({ kind, label: CONNECTOR_KIND_LABEL[kind], rows: CONNECTORS.filter((c) => c.kind === kind).map(view) })).filter((g) => g.rows.length > 0),
  };
}

// ───────────────────────── ĐỌC LÚC CHẠY (consumer đã khai) ─────────────────────────

export type ActiveConnection = { ok: true; secrets: Record<string, string>; settings: Record<string, string> } | { ok: false; reason: string };

/**
 * Bí mật của MỘT kết nối ĐANG BẬT của tổ chức NGỮ CẢNH, cho luồng chạy đã khai trong `consumers` của sổ (Phase 8: AI
 * Builder đọc khoá AI của chính tổ chức). Không nhận mã tổ chức — `getDb()` và AAD đều lấy từ ngữ cảnh, nên không có
 * tham số nào đưa khoá của tổ chức A sang B. Connector chưa khai consumer ⇒ từ chối (không có "đọc bí mật tuỳ ý").
 * Không kiểm quyền người: đây là đường MÁY dùng khoá thay tổ chức; nơi gọi đã gác quyền màn hình của nó. Bí mật trả
 * về chỉ được đưa thẳng vào client của nhà cung cấp — không log, không trả về trình duyệt.
 */
export async function openActiveConnection(connectorKey: string, deps: { keyState?: SecretsKeyState } = {}): Promise<ActiveConnection> {
  const spec = findConnector(connectorKey);
  if (!spec || !isOrgConfigurable(spec)) return { ok: false, reason: `«${connectorKey}» không phải kết nối theo tổ chức.` };
  if (spec.consumers.length === 0) return { ok: false, reason: `«${spec.label}» chưa khai luồng nào được đọc lúc chạy.` };
  const ctx = await currentOrganization();
  const row = await findRow(spec.key);
  if (!row) return { ok: false, reason: `Chưa có kết nối «${spec.label}».` };
  if (row.orgCode !== ctx.code) return { ok: false, reason: `Dòng kết nối «${spec.key}» mang mã tổ chức khác ngữ cảnh — không dùng.` };
  if (row.status !== "ACTIVE" || row.lastTestOk !== true) return { ok: false, reason: `Kết nối «${spec.label}» chưa bật (cần Kiểm tra đạt rồi Bật).` };
  if (!row.secretsEnc) return { ok: false, reason: `Kết nối «${spec.label}» chưa có bí mật.` };
  try {
    const secrets = openSecrets(row.secretsEnc, { orgCode: ctx.code, connectorKey: spec.key, keyId: row.secretsKeyId }, deps.keyState ?? secretsKeyState());
    return { ok: true, secrets, settings: asStringMap(row.settings) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Không giải mã được bí mật." };
  }
}

// ───────────────────────────── GHI ─────────────────────────────

export type SaveConnectionInput = { connectorKey: string; settings?: Record<string, unknown>; secrets?: Record<string, unknown> };

function checkValue(spec: ConnectorSpec, key: string, value: string): string | null {
  const field = spec.settings.find((f) => f.key === key);
  if (!field) return `Ô «${key}» không có trong cài đặt của «${spec.label}».`;
  if (field.maxLength && value.length > field.maxLength) return `«${field.label}» dài quá ${field.maxLength} ký tự.`;
  if (field.pattern && !new RegExp(field.pattern).test(value)) return `«${field.label}» không đúng định dạng.${field.hint ? ` ${field.hint}` : ""}`;
  return null;
}

export async function saveConnection(user: SessionUser, input: SaveConnectionInput, deps: { keyState?: SecretsKeyState } = {}): Promise<ConnectionActionResult> {
  const g = guard(user, String(input.connectorKey ?? ""));
  if ("error" in g) return g;
  const { spec } = g;
  const org = await resolveOrg(user);
  if ("error" in org) return org;

  const rawSettings = input.settings && typeof input.settings === "object" ? input.settings : {};
  const rawSecrets = input.secrets && typeof input.secrets === "object" ? input.secrets : {};
  const plainKeys = new Set(plainFields(spec).map((f) => f.key));
  const secretKeys = new Set(secretFields(spec).map((f) => f.key));
  for (const k of Object.keys(rawSettings)) if (!plainKeys.has(k)) return { error: `«${k}» không phải ô cài đặt thường của «${spec.label}».` };
  for (const k of Object.keys(rawSecrets)) if (!secretKeys.has(k)) return { error: `«${k}» không phải ô bí mật của «${spec.label}».` };

  const settings: Record<string, string> = {};
  for (const f of plainFields(spec)) {
    const v = typeof rawSettings[f.key] === "string" ? (rawSettings[f.key] as string).trim() : "";
    if (!v) {
      if (f.required) return { error: `Thiếu «${f.label}».` };
      continue;
    }
    const bad = checkValue(spec, f.key, v);
    if (bad) return { error: bad };
    settings[f.key] = v;
  }
  // Bí mật: ô trống = GIỮ giá trị đã lưu. Chỉ ô có chữ mới là giá trị mới.
  const incoming: Record<string, string> = {};
  for (const f of secretFields(spec)) {
    const v = typeof rawSecrets[f.key] === "string" ? (rawSecrets[f.key] as string).trim() : "";
    if (!v) continue;
    const bad = checkValue(spec, f.key, v);
    if (bad) return { error: bad };
    incoming[f.key] = v;
  }

  const existing = await findRow(spec.key);
  const trip = tripwire(existing, org);
  if (trip) return { error: trip };
  const existingHints = existing ? asStringMap(existing.secretHints) : {};
  for (const f of secretFields(spec)) if (f.required && !incoming[f.key] && !existingHints[f.key]) return { error: `Thiếu «${f.label}».` };

  const keyState = deps.keyState ?? secretsKeyState();
  let secretsEnc: Buffer | null = existing?.secretsEnc ?? null;
  let secretsKeyId: string | null = existing?.secretsKeyId ?? null;
  let hints = existingHints;
  if (Object.keys(incoming).length > 0) {
    // Thiếu khoá ⇒ TỪ CHỐI lưu, không lùi về khoá nào khác, không lưu bản rõ.
    if (!keyState.ok) return { error: keyState.reason };
    let merged: Record<string, string> = {};
    if (existing?.secretsEnc) {
      try {
        merged = openSecrets(existing.secretsEnc, { orgCode: org.code, connectorKey: spec.key, keyId: existing.secretsKeyId }, keyState);
      } catch {
        // Bản mã cũ không giải được (khoá đã đổi): chỉ giữ những ô người dùng vừa nhập lại.
        merged = {};
        hints = {};
      }
    }
    merged = { ...merged, ...incoming };
    for (const f of secretFields(spec)) if (f.required && !merged[f.key]) return { error: `Bí mật cũ không đọc được (khoá máy chủ đã đổi) — nhập lại «${f.label}».` };
    const sealed = sealSecrets(merged, { orgCode: org.code, connectorKey: spec.key }, keyState);
    secretsEnc = sealed.ciphertext;
    secretsKeyId = sealed.keyId;
    hints = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, maskSecret(v)]));
  }

  const db = await getDb();
  const values = {
    orgCode: org.code,
    connectorKey: spec.key,
    status: "DRAFT",
    settings,
    secretsEnc,
    secretsKeyId,
    secretHints: hints,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    activatedAt: null,
    activatedBy: null,
    updatedBy: user.email,
    updatedAt: new Date(),
  };
  if (existing) await db.update(schema.orgConnections).set(values).where(eq(schema.orgConnections.id, existing.id));
  else await db.insert(schema.orgConnections).values({ ...values, createdBy: user.email });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORG_CONNECTION_SAVE",
    entity: "org_connection",
    entityId: spec.key,
    before: existing ? { status: existing.status, settings: existing.settings, secretFieldsSet: Object.keys(existingHints) } : null,
    after: { status: "DRAFT", settings, secretFieldsSet: Object.keys(hints), secretsChanged: Object.keys(incoming) },
    reason: existing?.status === "ACTIVE" ? "Đổi cấu hình của kết nối đang bật ⇒ về Nháp, phải kiểm tra và bật lại" : undefined,
  });
  return { ok: true, status: "DRAFT", message: existing?.status === "ACTIVE" ? "Đã lưu — kết nối về Nháp: kiểm tra lại rồi bật." : "Đã lưu — bấm Kiểm tra trước khi bật." };
}

export async function testOrgConnection(user: SessionUser, connectorKey: string, deps: { keyState?: SecretsKeyState; tester?: TesterDeps } = {}): Promise<ConnectionActionResult> {
  const g = guard(user, connectorKey);
  if ("error" in g) return g;
  const { spec } = g;
  const org = await resolveOrg(user);
  if ("error" in org) return org;
  const row = await findRow(spec.key);
  const trip = tripwire(row, org);
  if (trip) return { error: trip };
  if (!row) return { error: `Chưa lưu cấu hình cho «${spec.label}».` };
  const tester = ORG_CONNECTION_TESTERS[spec.key];
  if (!tester) return { error: `«${spec.label}» chưa có hàm kiểm tra.` };

  let passed = false;
  let message: string;
  if (!row.secretsEnc) message = "Chưa có bí mật nào được lưu cho kết nối này.";
  else {
    let secrets: Record<string, string> | null = null;
    try {
      secrets = openSecrets(row.secretsEnc, { orgCode: org.code, connectorKey: spec.key, keyId: row.secretsKeyId }, deps.keyState ?? secretsKeyState());
    } catch (e) {
      message = e instanceof Error ? e.message : "Không giải mã được bí mật.";
    }
    if (secrets) {
      const r = await tester({ secrets, settings: asStringMap(row.settings), orgName: org.name }, deps.tester);
      passed = r.ok;
      message = r.message;
    } else message ??= "Không giải mã được bí mật.";
  }
  const nextStatus: ConnectionStatus = !passed && row.status === "ACTIVE" ? "DRAFT" : (row.status as ConnectionStatus);
  const db = await getDb();
  await db
    .update(schema.orgConnections)
    .set({ lastTestAt: new Date(), lastTestOk: passed, lastTestMessage: message, status: nextStatus, ...(nextStatus !== row.status ? { activatedAt: null, activatedBy: null } : {}), updatedAt: new Date() })
    .where(eq(schema.orgConnections.id, row.id));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORG_CONNECTION_TEST",
    entity: "org_connection",
    entityId: spec.key,
    before: { status: row.status, lastTestOk: row.lastTestOk },
    after: { status: nextStatus, lastTestOk: passed },
    reason: message,
  });
  if (!passed) return { error: nextStatus !== row.status ? `${message} — kết nối đang bật đã về Nháp.` : message };
  return { ok: true, status: nextStatus, message };
}

export async function setConnectionStatus(user: SessionUser, connectorKey: string, status: string): Promise<ConnectionActionResult> {
  const g = guard(user, connectorKey);
  if ("error" in g) return g;
  const { spec } = g;
  if (status !== "ACTIVE" && status !== "DISABLED") return { error: "Trạng thái chỉ nhận Bật hoặc Tắt." };
  const org = await resolveOrg(user);
  if ("error" in org) return org;
  const row = await findRow(spec.key);
  const trip = tripwire(row, org);
  if (trip) return { error: trip };
  if (!row) return { error: `Chưa lưu cấu hình cho «${spec.label}».` };
  if (row.status === status) return { ok: true, status };
  if (status === "ACTIVE" && row.lastTestOk !== true) return { error: "Chỉ bật được sau khi Kiểm tra ĐẠT với cấu hình hiện tại." };
  const db = await getDb();
  await db
    .update(schema.orgConnections)
    .set(status === "ACTIVE" ? { status, activatedAt: new Date(), activatedBy: user.email, updatedBy: user.email, updatedAt: new Date() } : { status, updatedBy: user.email, updatedAt: new Date() })
    .where(eq(schema.orgConnections.id, row.id));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: status === "ACTIVE" ? "ORG_CONNECTION_ACTIVATE" : "ORG_CONNECTION_DISABLE",
    entity: "org_connection",
    entityId: spec.key,
    before: { status: row.status },
    after: { status },
  });
  return { ok: true, status, message: status === "ACTIVE" ? `Đã bật «${spec.label}».` : `Đã tắt «${spec.label}».` };
}
