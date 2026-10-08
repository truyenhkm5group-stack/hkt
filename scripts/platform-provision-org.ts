/**
 * CẤP MỘT TỔ CHỨC MỚI TRÊN NỀN TẢNG — `npm run platform:provision -- --code demo-wholesale …`
 *
 *   --code <mã>              bắt buộc; `^[a-z][a-z0-9-]{1,30}$`, BẤT BIẾN
 *   --name <tên>             bắt buộc
 *   --template <khoá>        mẫu trong ORG_TEMPLATES (mặc định `wholesale`)
 *   --admin-email <email>    tài khoản quản trị đầu tiên (trong CSDL của CHÍNH tổ chức đó)
 *   --admin-password <mk>    bắt buộc nếu có --admin-email; không in ra
 *   --seed-demo              gieo vài khách / sản phẩm / đơn MẪU (tên có tiền tố "Mẫu ·")
 *   --confirm-production     bắt buộc khi NODE_ENV=production — xem dưới
 *
 * ═══ HUMAN GATE TRÊN PRODUCTION ═══
 *
 * Trên Postgres, cấp tổ chức là `CREATE DATABASE` trên máy chủ Postgres của VPS: thêm hạ tầng, thêm
 * tải, thêm một mục sao lưu (docs/platform/migration-strategy.md mục 6). Chủ shop quyết trước; script
 * từ chối chạy trên production nếu thiếu `--confirm-production`. Máy cục bộ / PGlite thì không hỏi.
 *
 * Idempotent: chạy lại chỉ bổ sung phần còn thiếu, không nhân đôi tổ chức, module hay tài khoản.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { ORG_TEMPLATES } from "@/lib/constants/platform-modules";
import { withOrganization } from "@/lib/platform/context";
import { provisionOrganization } from "@/lib/platform/provision";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Dữ liệu MẪU — tên mang tiền tố để không ai nhầm với dữ liệu thật. Idempotent theo id cố định. */
export async function seedDemoData(orgCode: string) {
  await withOrganization(orgCode, async () => {
    const db = await getDb();
    const customers = [
      { id: `demo-cus-1`, name: "Mẫu · Đại lý Minh Phát", phone: "0900000001" },
      { id: `demo-cus-2`, name: "Mẫu · Cửa hàng Hoa Mai", phone: "0900000002" },
    ];
    for (const c of customers) await db.insert(schema.customers).values(c).onConflictDoNothing();
    const products = [
      { id: `demo-prd-1`, name: "Mẫu · Thùng nước suối 24 chai", customId: "SKU-NS24" },
      { id: `demo-prd-2`, name: "Mẫu · Gạo ST25 bao 10kg", customId: "SKU-G10" },
    ];
    for (const p of products) await db.insert(schema.products).values(p).onConflictDoNothing();
    const orders = [
      { id: `demo-ord-1`, customerId: "demo-cus-1", billFullName: "Mẫu · Đại lý Minh Phát", statusName: "Mới", totalPrice: 2_400_000, totalPriceAfterDiscount: 2_400_000 },
      { id: `demo-ord-2`, customerId: "demo-cus-2", billFullName: "Mẫu · Cửa hàng Hoa Mai", statusName: "Mới", totalPrice: 1_250_000, totalPriceAfterDiscount: 1_250_000 },
    ];
    const insertedAt = new Date();
    for (const o of orders) await db.insert(schema.orders).values({ ...o, insertedAt }).onConflictDoNothing();
    const n = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, "demo-ord-1"));
    console.log(`[platform] Dữ liệu mẫu của "${orgCode}": ${customers.length} khách · ${products.length} sản phẩm · ${orders.length} đơn (đơn demo-ord-1 ${n.length ? "có" : "KHÔNG có"}).`);
  });
}

async function main() {
  const code = arg("code");
  const name = arg("name");
  const templateKey = arg("template") || "wholesale";
  const adminEmail = arg("admin-email");
  const adminPassword = arg("admin-password");
  if (!code || !name) throw new Error("Thiếu --code hoặc --name.");
  const template = ORG_TEMPLATES[templateKey];
  if (!template) throw new Error(`Không có mẫu "${templateKey}". Có: ${Object.keys(ORG_TEMPLATES).join(", ")}.`);
  if (adminEmail && !adminPassword) throw new Error("Có --admin-email thì phải có --admin-password.");
  if (process.env.NODE_ENV === "production" && !flag("confirm-production")) {
    throw new Error("HUMAN GATE: cấp tổ chức trên production tạo một CSDL mới trên máy chủ Postgres. Chủ shop phải quyết trước (docs/platform/migration-strategy.md mục 6), rồi chạy lại kèm --confirm-production.");
  }

  await ensureMigrated();
  const result = await provisionOrganization({
    code,
    name,
    templateKey,
    modules: template.modules,
    admin: adminEmail && adminPassword ? { email: adminEmail, name: `Quản trị ${name}`, password: adminPassword } : undefined,
    source: "SCRIPT",
    actor: null,
    // Cửa cấp phát của người vận hành ⇒ CÙNG luật thương mại với mọi cửa (review #682): tổ chức mới gắn tài khoản khách ngoài, gói
    // mặc định dùng thử, thương hiệu theo bộ sản phẩm của mẫu.
    commercial: {},
  });
  console.log(
    `[platform] Tổ chức "${result.organization.code}" ${result.created ? "đã TẠO" : "đã có sẵn"} · mẫu ${templateKey} (${template.modules.length} module) · quản trị ${result.adminCreated ? "đã tạo" : adminEmail ? "đã có sẵn" : "không yêu cầu"}.`,
  );
  if (flag("seed-demo")) await seedDemoData(result.organization.code);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/platform-provision-org.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[platform]", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
