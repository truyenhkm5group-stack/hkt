/**
 * PANCAKE LÀ KẾT NỐI CŨ / CHUYỂN ĐỔI (lib/connectors/legacy.ts · slice 7) — hàm thuần:
 *  · tổ chức KHÁCH: mọi dòng `pancake*` rời bảng chính về mục cũ; nhóm chỉ có Pancake biến mất khỏi bảng chính; Facebook trực
 *    tiếp / Zalo ở lại; mục cũ MỞ SẴN khi có dòng Pancake đã được khai;
 *  · tổ chức NHÀ (vận hành bằng Pancake): không đổi gì.
 */
import assert from "node:assert/strict";
import { isLegacyConnector, splitLegacyConnectors } from "@/lib/connectors/legacy";
import type { ConnectorView } from "@/lib/connectors/types";

function row(key: string, configured = false): ConnectorView {
  return { key, label: key, connection: configured ? ({ status: "DRAFT" } as ConnectorView["connection"]) : null } as ConnectorView;
}

export function testConnectorsLegacy() {
  assert.ok(isLegacyConnector("pancake-fanpage") && isLegacyConnector("pancake-pos-org") && !isLegacyConnector("facebook-messenger") && !isLegacyConnector("zalo-oa"));
  const groups = [
    { kind: "MESSAGING", label: "Nhắn tin", rows: [row("pancake-fanpage"), row("facebook-messenger"), row("zalo-oa")] },
    { kind: "ORDER_SOURCE", label: "Nguồn đơn", rows: [row("pancake-pos-org")] },
  ] as unknown as Parameters<typeof splitLegacyConnectors>[0]["groups"];
  const guest = splitLegacyConnectors({ organization: { code: "shop", name: "Shop", isHome: false }, groups });
  assert.deepEqual(guest.groups.map((g) => [g.kind, g.rows.map((r) => r.key)]), [["MESSAGING", ["facebook-messenger", "zalo-oa"]]], "nhóm chỉ có Pancake rời bảng chính");
  assert.deepEqual(guest.legacy.map((r) => r.key), ["pancake-fanpage", "pancake-pos-org"]);
  assert.equal(guest.legacyInUse, false, "shop mới: mục cũ gập lại");
  const inUse = splitLegacyConnectors({ organization: { code: "shop", name: "Shop", isHome: false }, groups: [{ ...groups[1], rows: [row("pancake-pos-org", true)] }] });
  assert.equal(inUse.legacyInUse, true, "đang khai Pancake ⇒ mục cũ mở sẵn, không giấu kết nối đang chạy");
  const home = splitLegacyConnectors({ organization: { code: "vnx", name: "VNX", isHome: true }, groups });
  assert.ok(home.groups === groups && home.legacy.length === 0, "tổ chức nhà vận hành bằng Pancake ⇒ không đổi");
  console.log("✓ Pancake là kết nối cũ / chuyển đổi: tổ chức khách thấy Facebook trực tiếp ở bảng chính, Pancake ở mục cuối (mở sẵn khi đang khai); tổ chức nhà không đổi");
}
