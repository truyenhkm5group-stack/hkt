/**
 * ═══════ LÀM ẤM CÁC TRANG NẶNG NGAY SAU KHI CONTAINER APP LÊN — TRƯỚC SMOKE ═══════
 *
 * Danh sách, trần song song và hạn chờ nằm ở `lib/constants/deploy-warm.ts` (vì sao, kèm số đo). Script chỉ mở
 * từng trang bằng một phiên quản trị ký tại chỗ (cùng cách smoke.ts), đọc hết thân để Next dựng xong, và in thời
 * gian. KHÔNG BAO GIỜ thoát mã lỗi: làm ấm là tối ưu — một trang lỗi là việc của smoke, ngay sau bước này.
 *
 * Chạy (install-vps.sh): docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/warm-pages.ts
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";

// Chỉ đọc (tra tài khoản quản trị) — Postgres ép, đặt TRƯỚC lần mở kết nối đầu tiên.
process.env.ERP_READ_ONLY = "1";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";

async function main() {
  const { DEPLOY_WARM_CONCURRENCY, DEPLOY_WARM_ROUTES, DEPLOY_WARM_TIMEOUT_MS } = await import("@/lib/constants/deploy-warm");
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) {
    console.log("⚠ làm ấm: bỏ qua — thiếu AUTH_SECRET, không ký được phiên");
    return;
  }
  const { getDb, schema } = await import("@/db");
  const db = await getDb();
  const [admin] = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
  if (!admin) {
    console.log("⚠ làm ấm: bỏ qua — chưa có tài khoản quản trị");
    return;
  }
  const key = new TextEncoder().encode(secret);
  const mint = () => new SignJWT({ email: admin.email, name: admin.name, role: "ADMIN" }).setProtectedHeader({ alg: "HS256" }).setSubject(admin.id).setIssuedAt().setExpirationTime("10m").sign(key);

  const t0 = Date.now();
  const hangDoi = [...DEPLOY_WARM_ROUTES];
  const ket: string[] = [];
  const chay = async () => {
    for (let route = hangDoi.shift(); route !== undefined; route = hangDoi.shift()) {
      const bd = Date.now();
      try {
        const r = await fetch(`${BASE}${route}`, { headers: { cookie: `erp_session=${await mint()}` }, redirect: "manual", signal: AbortSignal.timeout(DEPLOY_WARM_TIMEOUT_MS) });
        const dau = Date.now() - bd;
        await r.arrayBuffer();
        ket.push(`  HTTP ${r.status} · đầu phản hồi ${String(dau).padStart(5)} ms · thân ${String(Date.now() - bd).padStart(6)} ms · ${route}`);
      } catch (e) {
        ket.push(`  ⚠ ${route}: ${e instanceof Error ? e.message : String(e)} sau ${Date.now() - bd} ms`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DEPLOY_WARM_CONCURRENCY, DEPLOY_WARM_ROUTES.length) }, chay));
  console.log(`── làm ấm ${DEPLOY_WARM_ROUTES.length} trang nặng (song song ${DEPLOY_WARM_CONCURRENCY}) xong sau ${Date.now() - t0} ms ──`);
  for (const k of ket) console.log(k);
}

main()
  .catch((e) => console.log(`⚠ làm ấm lỗi (không chặn deploy): ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => process.exit(0));
