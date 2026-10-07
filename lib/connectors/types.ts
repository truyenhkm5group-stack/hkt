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
  auth: ConnectorAuth;
  capabilities: string[];
  moduleKey: string;
  moduleLabel: string;
  moduleEnabled: boolean;
  hasHealthCheck: boolean;
  /*
    Phần MÔ TẢ NỘI BỘ của sổ connector — chỉ workspace nhà nhận (`lib/saas/visibility.ts::customerConnectionsView` bỏ hẳn
    các khoá này khỏi DTO của khách, không gửi rồi ẩn). Dòng «cấu hình ở chỗ khác» của khách chỉ còn `configWhere` rút gọn.
  */
  tenancy?: ConnectorTenancy;
  why?: string;
  configStore?: ConnectorConfigStore;
  configWhere?: string;
  consumers?: string[];
  webhook?: { path: string; tenantResolution: string } | null;
  mode: ConnectorViewMode;
  homeReadiness: HomeReadiness | null;
  fields: Pick<SettingField, "key" | "label" | "type" | "secret" | "required" | "hint">[];
  connection: ConnectionSnapshot | null;
};

export type ConnectionsView = {
  organization: { code: string; name: string; isHome: boolean };
  /** Máy chủ có khoá lưu bí mật không — có/không + câu giải thích + 8 ký tự đầu của MÃ khoá (HMAC, không suy ngược), KHÔNG có gì của khoá. */
  secretsReady: { ok: boolean; reason: string | null; keyIdShort: string | null };
  groups: { kind: ConnectorKind; label: string; rows: ConnectorView[] }[];
};

export type ConnectionActionResult = { ok: true; status: ConnectionStatus; message?: string } | { error: string };

/**
 * Kết quả «Tự kiểm khoá bí mật» (`/platform`, người vận hành nền tảng). KHÔNG có khoá, KHÔNG có chuỗi thử (sinh ngẫu
 * nhiên lúc chạy và bỏ đi), KHÔNG có bản mã — chỉ tên từng phép thử + đạt / hỏng, mã khoá rút gọn và TÊN biến nguồn.
 */
export type SecretsSelfTestReport = {
  ok: boolean;
  keyIdShort: string | null;
  keySource: string;
  previous: "absent" | "ready" | "invalid";
  reason: string | null;
  checks: { name: string; ok: boolean }[];
};

/** Kết nối có nút «Tìm chat» (đọc tin mới của bot để lấy mã chat) — khớp `ORG_CONNECTION_CHAT_DISCOVERY` (testers.ts). */
export const CHAT_DISCOVERY_CONNECTORS = ["telegram-bot", "zalo-bot"] as const;
export type DiscoveredChatView = { id: string; type: "PRIVATE" | "GROUP"; name: string; sample: string };
export type ChatDiscoveryResult = { ok: true; chats: DiscoveredChatView[]; message: string } | { error: string };

