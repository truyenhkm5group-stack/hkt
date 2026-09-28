import type { ConnectionStatus, ConnectorAuth, ConnectorConfigStore, ConnectorKind, ConnectorTenancy, SettingField } from "@/lib/connectors/registry";

/**
 * Kiểu dữ liệu màn hình `/settings/connections` — THUẦN, client-safe (chỉ `import type`).
 *
 * KHÔNG có trường nào mang bí mật: `secretHints` là `••••` + 4 ký tự cuối (ghi sẵn lúc lưu), ô bí
 * mật của form luôn trống. Bài kiểm `tests/connectors.test.ts` gọi thật đường dựng dữ liệu này và
 * tìm chuỗi bí mật trong JSON trả về.
 */

/**
 *  · `HOME_READONLY` — connector HOME_ONLY, người xem thuộc tổ chức nhà: hiện đã cấu hình hay chưa, CHỈ ĐỌC.
 *  · `HOME_ONLY_UNAVAILABLE` — connector HOME_ONLY, tổ chức khác: chưa mở, không hiện gì của nhà.
 *  · `CONFIGURABLE` — PER_ORG lưu ở `org_connections`: form + kiểm tra + bật / tắt.
 *  · `ELSEWHERE` — PER_ORG nhưng cấu hình ở màn hình nghiệp vụ (vd link Google Sheet ở /landing) hoặc không cần cấu hình.
 */
export type ConnectorViewMode = "HOME_READONLY" | "HOME_ONLY_UNAVAILABLE" | "CONFIGURABLE" | "ELSEWHERE";

export type HomeReadiness = { state: "CONFIGURED" | "NOT_CONFIGURED" | "UNKNOWN"; detail: string };

export type ConnectionSnapshot = {
  status: ConnectionStatus;
  settings: Record<string, string>;
  secretHints: Record<string, string>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  activatedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ConnectorView = {
  key: string;
  label: string;
  vendor: string;
  kind: ConnectorKind;
  tenancy: ConnectorTenancy;
  auth: ConnectorAuth;
  capabilities: string[];
  moduleKey: string;
  moduleLabel: string;
  moduleEnabled: boolean;
  why: string;
  configStore: ConnectorConfigStore;
  configWhere: string;
  hasHealthCheck: boolean;
  consumers: string[];
  webhook: { path: string; tenantResolution: string } | null;
  mode: ConnectorViewMode;
  homeReadiness: HomeReadiness | null;
  fields: Pick<SettingField, "key" | "label" | "type" | "secret" | "required" | "hint">[];
  connection: ConnectionSnapshot | null;
};

export type ConnectionsView = {
  organization: { code: string; name: string; isHome: boolean };
  /** Máy chủ có khoá lưu bí mật không — chỉ có/không + câu giải thích, KHÔNG có gì của khoá. */
  secretsReady: { ok: boolean; reason: string | null };
  groups: { kind: ConnectorKind; label: string; rows: ConnectorView[] }[];
};

export type ConnectionActionResult = { ok: true; status: ConnectionStatus; message?: string } | { error: string };
