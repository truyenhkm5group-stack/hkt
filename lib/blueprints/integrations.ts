import { findConnector } from "@/lib/connectors/registry";
import { moduleDef, type ModuleKey } from "@/lib/constants/platform-modules";

/**
 * ═══════════ «GỢI Ý KẾT NỐI» CỦA MỘT MẪU — TRỎ VÀO ĐÂU (F3 · docs/verticals/fashion-cod.md) ═══════════
 *
 * `Blueprint.integrations[].connectorKey` nhận HAI loại khoá:
 *  · module connector (`connector_meta`, …) — loại cũ, credential môi trường của tổ chức NHÀ: tổ chức khách không bật được,
 *    nên mẫu cho tổ chức khách gợi ý nó là gợi ý một thứ họ không dùng được;
 *  · kết nối THEO TỔ CHỨC trong sổ connector (`pancake-pos-org`, `viettelpost-org`, `meta-ads-org`, `lark-webhook`, …) —
 *    tổ chức tự khai ở /settings/connections. Phụ thuộc = module mà kết nối thuộc về.
 * Bốn nơi đọc trường này (kiểm mẫu, trang mẫu, cắt mẫu ở /start, vòng đời pilot) đi qua ĐÚNG hàm này.
 */
export type IntegrationTarget = { key: string; label: string; kind: "HOME_MODULE" | "ORG_CONNECTION"; dependsOn: readonly ModuleKey[] };

export function integrationTarget(key: string): IntegrationTarget | null {
  const m = moduleDef(key);
  if (m && m.category === "CONNECTOR") return { key, label: m.label, kind: "HOME_MODULE", dependsOn: m.dependsOn };
  const c = findConnector(key);
  if (c && c.tenancy === "PER_ORG") return { key, label: c.label, kind: "ORG_CONNECTION", dependsOn: [c.module] };
  return null;
}

/** Gợi ý này còn ý nghĩa với tập module đang bật không (mọi module nó phụ thuộc đều bật). Khoá lạ ⇒ không. */
export function integrationApplies(key: string, enabled: { has(k: string): boolean } | null): boolean {
  const t = integrationTarget(key);
  if (!t) return false;
  return !enabled || t.dependsOn.every((d) => enabled.has(d));
}
