/**
 * Smoke test sau deploy: mở thật các màn hình chính bằng một phiên đăng nhập hợp lệ.
 *
 * Vì sao cần: `/api/health` chỉ chứng minh tiến trình còn sống và CSDL kết nối được.
 * Nó KHÔNG phát hiện trang lỗi runtime (truy vấn hỏng, cột thiếu, lỗi render) — đúng loại
 * lỗi mà một checkpoint dữ liệu dễ gây ra nhất. Script này chạy TRONG container app nên
 * dùng được AUTH_SECRET và DATABASE_URL thật, không cần mở cổng hay biết mật khẩu quản trị.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/smoke.ts
 */
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";

/** Các màn hình phải mở được. Thêm route mới vào đây khi bổ sung màn hình quan trọng. */
const ROUTES = [
  "/",
  "/orders",
  "/shipments",
  "/cod",
  "/cod?recon=unproven",
  "/cod?recon=stale",
  "/reports",
  "/reports/returns",
  "/products",
  "/inventory",
  "/inventory/receipts",
  "/inventory/planning",
  "/customers",
  "/ads",
  "/payroll",
  "/expenses",
  "/alerts",
  "/data-quality",
  "/data-quality?issue=unlinked-shipment",
  "/data-quality?issue=return-not-received",
];

/**
 * Dấu hiệu trang ĐÃ render thật (khung dashboard có mặt).
 * Cố ý KHÔNG dò chuỗi lỗi trong nội dung: Next.js nhúng sẵn nội dung not-found vào bundle của
 * mọi trang, nên dò "This page could not be found" báo lỗi giả cho cả trang tốt.
 * Mã HTTP mới là tín hiệu đáng tin (200 = ổn, 404/500 = hỏng).
 */
const RENDER_MARKER = "Shop Control";

async function main() {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) throw new Error("Thiếu AUTH_SECRET — không mint được phiên đăng nhập để smoke test");

  // SMOKE_USER_ID cho phép chạy mà không mở CSDL (PGlite chỉ cho một tiến trình mở thư mục dữ liệu,
  // nên khi thử tại máy dev thì server đang giữ khoá). Trên production luôn là PostgreSQL nên tra thẳng.
  let userId = (process.env.SMOKE_USER_ID ?? "").trim();
  let email = "smoke@erp.local";
  let name = "Smoke test";
  if (!userId) {
    const db = await getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
    if (!user) throw new Error("Chưa có tài khoản quản trị nào để smoke test");
    userId = user.id;
    email = user.email;
    name = user.name;
  }

  const token = await new SignJWT({ email, name, role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));

  const failures: string[] = [];
  for (const route of ROUTES) {
    const started = Date.now();
    try {
      const response = await fetch(`${BASE}${route}`, {
        headers: { cookie: `erp_session=${token}` },
        redirect: "manual",
      });
      const ms = Date.now() - started;
      if (response.status !== 200) {
        failures.push(`${route} → HTTP ${response.status}`);
        console.error(`  ✗ ${route} → HTTP ${response.status} (${ms}ms)`);
        continue;
      }
      const body = await response.text();
      if (!body.includes(RENDER_MARKER)) {
        failures.push(`${route} → không render được khung ứng dụng`);
        console.error(`  ✗ ${route} → không thấy khung ứng dụng (${ms}ms)`);
        continue;
      }
      console.log(`  ✓ ${route} (${ms}ms, ${Math.round(body.length / 1024)}kB)`);
    } catch (error) {
      failures.push(`${route} → ${error instanceof Error ? error.message : String(error)}`);
      console.error(`  ✗ ${route} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    console.error(`\n[smoke] ${failures.length}/${ROUTES.length} màn hình LỖI:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[smoke] ✓ ${ROUTES.length}/${ROUTES.length} màn hình mở được.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[smoke] Không chạy được smoke test:", error instanceof Error ? error.message : error);
  process.exit(1);
});
