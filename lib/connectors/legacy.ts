import type { ConnectionsView, ConnectorView } from "@/lib/connectors/types";

/**
 * ═══════════ PANCAKE LÀ KẾT NỐI CŨ / CHUYỂN ĐỔI — KHÔNG PHẢI BƯỚC BẮT BUỘC (docs/pancake-replacement-gap-analysis.md slice 7) ═══════════
 *
 * Shop mới bán qua Facebook nối THẲNG Meta (Messenger + Instagram trực tiếp). Pancake chỉ còn cho shop đang dùng Pancake (đồng
 * bộ đơn POS, bot qua fanpage Pancake) và cho lượt chuyển đổi sang Facebook trực tiếp. Trên trang Kết nối của tổ chức KHÁCH, các
 * dòng Pancake rời khỏi bảng chính về một mục «Kết nối cũ / chuyển đổi» ở cuối — mục đó MỞ SẴN khi tổ chức đang có kết nối Pancake
 * nào được khai (không giấu một kết nối đang chạy). Tổ chức NHÀ vận hành bằng Pancake ⇒ không đổi gì. HÀM THUẦN.
 */

export function isLegacyConnector(key: string): boolean {
  return key.startsWith("pancake");
}

export type LegacySplit = {
  groups: ConnectionsView["groups"];
  legacy: ConnectorView[];
  /** Có dòng Pancake nào đang được khai (đã lưu cấu hình) — mục cũ mở sẵn. */
  legacyInUse: boolean;
};

export function splitLegacyConnectors(view: Pick<ConnectionsView, "organization" | "groups">): LegacySplit {
  if (view.organization.isHome) return { groups: view.groups, legacy: [], legacyInUse: false };
  const legacy: ConnectorView[] = [];
  const groups = view.groups
    .map((g) => {
      const keep = g.rows.filter((r) => !isLegacyConnector(r.key));
      legacy.push(...g.rows.filter((r) => isLegacyConnector(r.key)));
      return { ...g, rows: keep };
    })
    .filter((g) => g.rows.length > 0);
  const legacyInUse = legacy.some((r) => r.connection !== null && r.connection !== undefined);
  return { groups, legacy, legacyInUse };
}
