/**
 * ═══════════ ĐƯỜNG NHẬN TIN CANONICAL CỦA PAGE — KIỂU + NHÃN DÙNG CHUNG MÁY CHỦ / TRÌNH DUYỆT (0233) ═══════════
 *
 * Tệp THUẦN (không CSDL): khung «Đường nhận tin» của hộp thư (client) chỉ được `import` từ đây; luật + đọc / ghi ở
 * `lib/sales-chatbot/channel-ownership.ts`.
 */

export type TransportOwner = "PANCAKE" | "MESSENGER";

export const CONNECTION_MODES = ["META_DIRECT", "PANCAKE_WEBHOOK"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];
export const CONNECTION_MODE_LABEL: Record<ConnectionMode, string> = { META_DIRECT: "Meta trực tiếp", PANCAKE_WEBHOOK: "Pancake" };
export const MODE_TRANSPORT: Record<ConnectionMode, TransportOwner> = { META_DIRECT: "MESSENGER", PANCAKE_WEBHOOK: "PANCAKE" };
export const TRANSPORT_MODE: Record<TransportOwner, ConnectionMode> = { MESSENGER: "META_DIRECT", PANCAKE: "PANCAKE_WEBHOOK" };
export type ModeSource = "BACKFILL" | "CONNECT" | "MANUAL";
export const MODE_SOURCE_LABEL: Record<ModeSource, string> = { BACKFILL: "giữ đường đang chạy lúc nâng cấp", CONNECT: "page mới nối Meta trực tiếp", MANUAL: "người chuyển" };

export type PageRouteView = {
  pageId: string;
  mode: ConnectionMode | null;
  source: ModeSource | null;
  reason: string | null;
  updatedAt: string | null;
  live: Record<TransportOwner, boolean>;
  /** Đường đang được kích AI lúc này (`null` = không đường nào). */
  owner: TransportOwner | null;
  /** Câu cảnh báo cho người (đường canonical không chạy · hai đường cùng nối) — `null` = ổn. */
  warning: string | null;
};
