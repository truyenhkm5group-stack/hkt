/**
 * ═══════════ THẺ "BẮT ĐẦU" CỦA TỔ CHỨC MỚI (Phase 10 · §3) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 * Tổ chức mới không được trông như "ERP của VNX bị xoá dữ liệu": trang chủ của tổ chức KHÔNG phải nhà thay các thẻ
 * KPI bằng danh sách bước khởi đầu. Mỗi bước ĐO TỪ DỮ LIỆU THẬT của CSDL tổ chức (có sản phẩm chưa, có khách chưa, có
 * người thứ hai chưa…) — không có ô "đánh dấu đã xong" nào để bấm cho đẹp.
 *
 * Bước KHÔNG đo được thì `done: null` và KHÔNG tính vào tiến độ (chưa biết ≠ chưa làm, luật 42): ERP không ghi ai đã
 * mở một trang tuỳ biến, nên "xem trang của mẫu" chỉ là lối vào, không phải một ô tiến độ.
 * Bước thuộc module đang tắt thì không hiện.
 */
import { and, count, eq, gt, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getBranding } from "@/lib/branding/service";
import { loadConnectionsView } from "@/lib/connectors/service";
import { planKeyOf, resolvePlan } from "@/lib/entitlements/check";
import { findOrganization } from "@/lib/platform/organizations";

export type GettingStartedStep = { key: string; label: string; detail: string; href: string; cta: string; done: boolean | null };
export type GettingStarted = { steps: GettingStartedStep[]; done: number; measurable: number; pages: { slug: string; name: string }[]; planName: string | null };

async function n(q: Promise<{ n: number }[]>): Promise<number> {
  const [r] = await q;
  return Number(r?.n ?? 0);
}

/** Số kết nối ĐANG CHẠY — đọc qua đường đọc duy nhất của `org_connections`; thiếu quyền xem ⇒ `null` (chưa biết). */
async function activeConnections(user: SessionUser): Promise<number | null> {
  const view = await loadConnectionsView(user);
  if ("error" in view) return null;
  return view.groups.flatMap((g) => g.rows).filter((r) => r.connection?.status === "ACTIVE").length;
}

export async function getGettingStarted(user: SessionUser): Promise<GettingStarted> {
  const db = await getDb();
  const on = (m: string) => !user.modules || user.modules.includes(m);
  const [products, customers, people, connections, branding, pages] = await Promise.all([
    on("products") ? n(db.select({ n: count() }).from(schema.products)) : Promise.resolve(-1),
    on("customers") ? n(db.select({ n: count() }).from(schema.customers)) : Promise.resolve(-1),
    n(db.select({ n: count() }).from(schema.users).where(eq(schema.users.active, true))),
    activeConnections(user),
    getBranding(),
    db
      .select({ slug: schema.metaPages.slug, name: schema.metaPages.name })
      .from(schema.metaPages)
      .where(and(ne(schema.metaPages.status, "ARCHIVED"), gt(schema.metaPages.publishedVersion, 0)))
      .orderBy(schema.metaPages.name),
  ]);

  const steps: GettingStartedStep[] = [];
  if (products >= 0) {
    steps.push({
      key: "products",
      label: "Nhập sản phẩm",
      detail: products > 0 ? `${products.toLocaleString("vi-VN")} sản phẩm đã có` : "Chưa có sản phẩm nào — sản phẩm vào ERP qua kết nối bán hàng của tổ chức.",
      href: "/products",
      cta: "Mở danh sách sản phẩm",
      done: products > 0,
    });
  }
  if (customers >= 0) {
    steps.push({ key: "customers", label: "Tạo khách hàng đầu tiên", detail: customers > 0 ? `${customers.toLocaleString("vi-VN")} khách hàng` : "Chưa có khách hàng nào.", href: "/customers/new", cta: "Tạo khách hàng", done: customers > 0 });
  }
  steps.push({ key: "people", label: "Mời người vào tổ chức", detail: people > 1 ? `${people} tài khoản đang hoạt động` : "Mới có tài khoản quản trị của bạn.", href: "/settings/users", cta: "Thêm người dùng", done: people > 1 });
  steps.push({ key: "branding", label: "Đặt tên hiển thị, màu và logo", detail: branding.displayName || branding.accent || branding.logoFileId ? "Đã đặt thương hiệu" : "Đang dùng tên tổ chức, chưa có logo.", href: "/settings/branding", cta: "Mở thương hiệu", done: Boolean(branding.displayName || branding.accent || branding.logoFileId) });
  steps.push({
    key: "connections",
    label: "Kết nối dịch vụ ngoài",
    detail: connections === null ? "Bạn chưa có quyền xem kết nối — bước này không tính vào tiến độ." : connections > 0 ? `${connections} kết nối đang chạy` : "Chưa có kết nối nào đang chạy.",
    href: "/settings/connections",
    cta: "Mở kết nối",
    done: connections === null ? null : connections > 0,
  });
  steps.push({
    key: "pages",
    label: "Xem trang của mẫu",
    detail: pages.length > 0 ? `${pages.length} trang đã xuất bản — ERP không ghi lượt mở trang tuỳ biến nên bước này không tính vào tiến độ.` : "Tổ chức chưa có trang tuỳ biến nào.",
    href: pages.length > 0 ? `/p/${pages[0].slug}` : "/settings/pages",
    cta: pages.length > 0 ? "Mở trang" : "Soạn trang",
    done: null,
  });

  const org = user.organization ? await findOrganization(user.organization.code) : null;
  const plan = org ? await resolvePlan({ isHome: org.isHome, plan: org.plan }) : null;
  const measurable = steps.filter((s) => s.done !== null);
  return { steps, done: measurable.filter((s) => s.done).length, measurable: measurable.length, pages, planName: plan?.name ?? (org ? planKeyOf(org) : null) };
}
