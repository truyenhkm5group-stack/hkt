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
import { publicationOf } from "@/lib/platform/publish";
import { productCreateGate } from "@/lib/records/product-create";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { listRules } from "@/lib/workflow/rules";

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
  // Vỏ Chốt Đơn (C1 #7): câu chữ không «ERP», và không bước nào dẫn tới trang vỏ chặn (`/p/…`, `/settings/pages`).
  const shell = isSalesAgentUser(user);
  if (products >= 0) {
    // Tổ chức tự nhập sản phẩm (không đồng bộ Pancake) ⇒ lối vào là «Nhập từ tệp» (0180); tổ chức đồng bộ ⇒ danh sách.
    const canImport = (await productCreateGate(user)).allowed;
    steps.push({
      key: "products",
      label: "Nhập sản phẩm",
      detail: products > 0 ? `${products.toLocaleString("vi-VN")} sản phẩm đã có` : canImport ? "Chưa có sản phẩm nào — nhập cả danh mục từ tệp CSV / Excel." : shell ? "Chưa có sản phẩm nào — sản phẩm vào cửa hàng qua kết nối bán hàng." : "Chưa có sản phẩm nào — sản phẩm vào ERP qua kết nối bán hàng của tổ chức.",
      href: canImport ? "/products/import" : "/products",
      cta: canImport ? "Nhập từ tệp" : "Mở danh sách sản phẩm",
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
  // Hành trình tự phục vụ (0180): chatbot bán hàng · thông báo nhóm · xuất bản — đo từ cấu hình / luật / sổ tổ chức thật.
  if (on("ai_sales")) {
    const bot = await loadSalesChatbotConfig();
    steps.push({ key: "chatbot", label: "Cấu hình chatbot bán hàng", detail: bot.enabled ? `Bot «${bot.botName}» đang bật` : "Chưa bật — dùng AI có sẵn trong gói (hoặc khoá AI riêng), chạy khung thử rồi bật.", href: "/ai/sales-chatbot", cta: "Mở chatbot", done: bot.enabled });
  }
  const liveNotify = (await listRules()).filter((r) => r.status === "ACTIVE" && r.mode === "LIVE" && r.actions.some((a) => a.kind === "send_message")).length;
  steps.push({ key: "notifications", label: "Báo đơn cho nhóm vận hành", detail: liveNotify > 0 ? `${liveNotify} luật gửi tin nhóm đang chạy` : shell ? "Chưa có — đơn chốt chỉ báo trong ứng dụng." : "Chưa có — đơn chốt chỉ báo trong ERP.", href: "/settings/notifications", cta: "Cấu hình thông báo", done: liveNotify > 0 });
  if (user.organization && !user.organization.isHome) {
    const pub = await publicationOf(user.organization.code);
    if (pub.state !== "UNTRACKED") {
      steps.push({
        key: "publish",
        label: "Chọn tên miền & xuất bản",
        detail: pub.state === "PUBLISHED" ? `Đã xuất bản${pub.url ? ` — ${pub.url.replace(/^https?:\/\//, "")}` : ""}` : pub.slug ? `Tên miền «${pub.slug}» đã giữ — chưa xuất bản` : shell ? "Cửa hàng đang là BẢN NHÁP." : "ERP đang là BẢN NHÁP.",
        href: "/setup",
        cta: pub.state === "PUBLISHED" ? (shell ? "Mở cửa hàng của tôi" : "Mở ERP của tôi") : "Xuất bản",
        done: pub.state === "PUBLISHED",
      });
    }
  }
  // Trang tuỳ biến (`/p/…`) và trình soạn trang là của ERP — vỏ chặn cả hai, một nút dẫn tới đó là lối cụt. Bước này vốn
  // không tính vào tiến độ (`done: null`), nên bỏ ở vỏ không đổi con số nào.
  if (!shell) steps.push({
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
