/**
 * ═══════════ THANH TAB BÁN SỈ — THEO THỨ TỰ CÔNG VIỆC ═══════════
 *
 * Chủ shop 30/10/2026: «rối rắm quá, khó dùng». Tám tab ngang hàng thành NĂM bước theo đúng thứ tự làm việc + nút bánh răng:
 *
 *   Săn khách → Khách tiềm năng → Liên hệ (Hàng đợi liên hệ · Hộp thư đi) → Báo giá → Hiệu quả (Hiệu quả · Sẵn sàng bán sỉ)
 *   ⚙ Cấu hình & chi phí
 *
 * Route cũ GIỮ NGUYÊN (không 404) — chỉ đổi cách nhóm. Quyền từng tab GIỮ NHƯ CŨ: tab con mang đúng quyền của trang nó mở;
 * tab mẹ hiện khi người xem mở được ít nhất một tab con, và trỏ tới tab con đầu tiên họ mở được. Tệp THUẦN (bài kiểm gọi
 * thẳng), không đọc phiên — người gọi truyền hàm kiểm quyền.
 */

export type WholesaleTabKey = "leads" | "outreach" | "outbox" | "quotations" | "hunter" | "dashboard" | "readiness" | "settings";
export type WholesalePerm = "wholesale:view" | "wholesale:work" | "wholesale:scan" | "wholesale:config";

type Leaf = { key: WholesaleTabKey; href: string; label: string; perm: WholesalePerm };
type Group = { key: string; label: string; children: Leaf[] };

/** Năm bước, đúng thứ tự công việc. Bánh răng (Cấu hình) đứng riêng bên phải. */
export const WHOLESALE_NAV: readonly Group[] = [
  { key: "hunt", label: "Săn khách", children: [{ key: "hunter", href: "/wholesale/lead-hunter", label: "Săn khách", perm: "wholesale:scan" }] },
  { key: "leads", label: "Khách tiềm năng", children: [{ key: "leads", href: "/wholesale/leads", label: "Khách tiềm năng", perm: "wholesale:view" }] },
  {
    key: "contact",
    label: "Liên hệ",
    children: [
      { key: "outreach", href: "/wholesale/outreach", label: "Hàng đợi liên hệ (Zalo · gọi)", perm: "wholesale:work" },
      { key: "outbox", href: "/wholesale/outbox", label: "Hộp thư đi (Email)", perm: "wholesale:work" },
    ],
  },
  { key: "quote", label: "Báo giá", children: [{ key: "quotations", href: "/wholesale/quotations", label: "Báo giá", perm: "wholesale:view" }] },
  {
    key: "perf",
    label: "Hiệu quả",
    children: [
      { key: "dashboard", href: "/wholesale/dashboard", label: "Hiệu quả", perm: "wholesale:view" },
      { key: "readiness", href: "/wholesale/readiness", label: "Sẵn sàng bán sỉ", perm: "wholesale:view" },
    ],
  },
];

export const WHOLESALE_GEAR: Leaf = { key: "settings", href: "/wholesale/settings", label: "Cấu hình & chi phí", perm: "wholesale:config" };

export type WholesaleNavModel = {
  tabs: { key: string; label: string; href: string; active: boolean }[];
  /** Tab con của nhóm đang mở — chỉ khi nhóm có từ hai tab con người xem mở được. */
  subTabs: { key: WholesaleTabKey; label: string; href: string; active: boolean }[];
  gear: { href: string; label: string; active: boolean } | null;
};

export function wholesaleNavModel(allowed: (perm: WholesalePerm) => boolean, active: WholesaleTabKey): WholesaleNavModel {
  const tabs: WholesaleNavModel["tabs"] = [];
  let subTabs: WholesaleNavModel["subTabs"] = [];
  for (const g of WHOLESALE_NAV) {
    const open = g.children.filter((c) => allowed(c.perm));
    if (!open.length) continue;
    const isActive = open.some((c) => c.key === active);
    tabs.push({ key: g.key, label: g.label, href: open[0]!.href, active: isActive });
    if (isActive && open.length > 1) subTabs = open.map((c) => ({ key: c.key, label: c.label, href: c.href, active: c.key === active }));
  }
  const gear = allowed(WHOLESALE_GEAR.perm) ? { href: WHOLESALE_GEAR.href, label: WHOLESALE_GEAR.label, active: active === "settings" } : null;
  return { tabs, subTabs, gear };
}
