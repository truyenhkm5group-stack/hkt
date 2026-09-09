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

/** Hết kiên nhẫn với MỘT trang. Trang treo là lỗi thật, nhưng phải phân biệt với trang lỗi. */
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);

/**
 * NGƯỠNG "CHẬM" — trang trả 200 nhưng lâu hơn mức này là vấn đề HIỆU NĂNG, không phải lỗi ứng dụng.
 *
 * Hai chuyện khác hẳn nhau và phải xử lý khác nhau: một trang hỏng thì KHÔNG được lên production;
 * một trang chậm thì phải sửa, nhưng chặn deploy vì nó là chặn nhầm — bản mới có khi còn nhanh hơn
 * bản đang chạy. Deploy #172 đã đỏ đúng vì gộp hai thứ này làm một.
 */
const SLOW_MS = Number(process.env.SMOKE_SLOW_MS ?? 2_000);

/** Các màn hình phải mở được. Thêm route mới vào đây khi bổ sung màn hình quan trọng. */
const ROUTES = [
  "/",
  "/orders",
  "/shipments",
  "/import-vtp",
  "/cod",
  "/cod?recon=unproven",
  "/cod?recon=stale",
  "/reports",
  "/reports/returns",
  "/reports/scenario",
  "/products",
  "/inventory",
  "/inventory/receipts",
  "/inventory/returns",
  "/inventory/planning",
  "/inventory/purchasing",
  "/customers",
  "/customers/retention",
  "/ads",
  "/payroll",
  "/expenses",
  "/alerts",
  "/data-quality",
  "/data-quality?issue=unlinked-shipment",
  "/data-quality?issue=return-not-received",
];

/**
 * LƯỢT LÀM NÓNG — đo riêng, KHÔNG tính vào kết quả đạt/không đạt.
 *
 * Đo 09/09/2026 trên production: `/` nằm đầu danh sách nên nó gánh toàn bộ chi phí NGUỘI (mở pool
 * kết nối, mọi `memo()` còn trống, JIT chưa nóng) và vượt 60 giây, trong khi 24 trang còn lại đều
 * dưới 310 ms. Một lần đo duy nhất ở vị trí đầu KHÔNG phân biệt được "trang chủ chậm thật" với
 * "trang đầu tiên nào cũng phải trả giá nguội".
 *
 * Nên tách hẳn: gọi trước một lần để nuốt chi phí nguội và IN RA con số đó (người đầu tiên vào
 * sau mỗi lần deploy phải chờ đúng chừng ấy — vẫn là việc phải sửa, nhưng sửa bằng làm nóng đệm,
 * không phải bằng viết lại truy vấn). Sau đó mọi phép đo đều là trạng thái nóng, và deploy không
 * bị chặn chỉ vì lần chạy đầu tiên.
 */
const WARMUP_ROUTE = "/";

/**
 * Dấu hiệu trang ĐÃ render thật (khung dashboard có mặt).
 * Cố ý KHÔNG dò chuỗi lỗi trong nội dung: Next.js nhúng sẵn nội dung not-found vào bundle của
 * mọi trang, nên dò "This page could not be found" báo lỗi giả cho cả trang tốt.
 * Mã HTTP mới là tín hiệu đáng tin (200 = ổn, 404/500 = hỏng).
 *
 * Chuỗi này đến từ nhãn thương hiệu ở sidebar (`components/brand.tsx` — aria-label của BrandWordmark),
 * nên chỉ có mặt khi khung dashboard đã dựng xong.
 */
const RENDER_MARKER = "VNXcommerce";

/**
 * ═══════════ PHÂN LOẠI KẾT QUẢ — MỘT CHỮ "LỖI" KHÔNG ĐỦ ═══════════
 *
 * Sự cố thật 09/09/2026: bộ smoke báo "13/21 màn hình LỖI" và deploy bị đánh dấu thất bại,
 * trong khi cả 13 đều là HTTP 307 (chuyển hướng đăng nhập) do phiếu ký hết hạn giữa chừng —
 * ứng dụng hoàn toàn bình thường. Một phép kiểm gộp "trang hỏng" với "phép kiểm tự hỏng" vào
 * cùng một nhãn thì tín hiệu đỏ của nó mất hết ý nghĩa, và lần sau không ai tin nó nữa.
 *
 * Nên mỗi kết quả phải tự khai nó thuộc loại nào:
 *   SUCCESS      — trang mở được và dựng xong khung ứng dụng.
 *   APP_ERROR    — trang trả 4xx/5xx, hoặc 200 mà không dựng nổi khung. LỖI THẬT của ứng dụng.
 *   AUTH_EXPIRED — bị đá về đăng nhập vì phiếu ký đã quá hạn. Lỗi CỦA PHÉP KIỂM, không phải của app.
 *   REDIRECT     — bị đá về đăng nhập trong khi phiếu ký còn mới ⇒ quyền/cấu hình sai. Lỗi thật.
 *   SLOW         — trang MỞ ĐƯỢC nhưng lâu hơn ngưỡng. Vấn đề hiệu năng, KHÔNG chặn deploy.
 *   TIMEOUT      — trang không trả lời trong hạn. Lỗi thật (nhưng khác bản chất với APP_ERROR).
 */
type Verdict = "SUCCESS" | "SLOW" | "APP_ERROR" | "AUTH_EXPIRED" | "REDIRECT" | "TIMEOUT";

/** Hạn của phiếu ký. Quá mốc này mà bị 307 thì nguyên nhân là hết hạn, không phải phân quyền. */
const TOKEN_TTL_MS = 10 * 60 * 1000;
/** Chừa biên: gần hết hạn cũng tính là hết hạn, vì thời điểm máy chủ kiểm có thể lệch vài giây. */
const TOKEN_NEAR_EXPIRY_MS = TOKEN_TTL_MS - 30_000;

type Result = { route: string; verdict: Verdict; detail: string; ms: number };

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

  /**
   * PHIÊN ĐƯỢC KÝ LẠI TRƯỚC TỪNG TRANG.
   *
   * Sự cố thật 09/09/2026: một phiếu ký duy nhất hạn 10 phút, mà cả lượt smoke trên VPS 2 nhân
   * (lần render đầu của mỗi trang phải dựng báo cáo từ đầu, chưa có bộ nhớ đệm) mất 10 phút 07
   * giây. Đúng phút thứ 10, mọi trang còn lại bị đá về trang đăng nhập — báo cáo ra "13/21 màn
   * hình LỖI" trong khi ứng dụng hoàn toàn bình thường. Một phép kiểm mà hỏng vì chính nó chạy
   * lâu thì nó không đo được cái nó định đo.
   *
   * Ký lại tốn vài chục micro giây và không gọi mạng, nên rẻ hơn nhiều so với việc kéo dài hạn
   * phiếu — kéo dài chỉ đẩy ngưỡng đi chứ không bỏ được ngưỡng.
   */
  const key = new TextEncoder().encode(secret);
  const mint = () =>
    new SignJWT({ email, name, role: "ADMIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);

  const results: Result[] = [];

  // Chi phí nguội: đo và in ra, không tính đạt/không đạt. Hạn chờ nới rộng vì đây chính là lần
  // chậm nhất theo thiết kế — mục đích là BIẾT nó bao lâu, không phải đánh trượt deploy vì nó.
  {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 3);
    try {
      const r = await fetch(`${BASE}${WARMUP_ROUTE}`, {
        headers: { cookie: `erp_session=${await mint()}` },
        redirect: "manual",
        signal: controller.signal,
      });
      await r.text();
      console.log(`  ⏱ làm nóng ${WARMUP_ROUTE} → HTTP ${r.status} (${Date.now() - started}ms) — chi phí NGUỘI, không tính vào kết quả`);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      console.error(`  ⏱ làm nóng ${WARMUP_ROUTE} → ${aborted ? `quá ${Math.round((TIMEOUT_MS * 3) / 1000)}s` : String(error)} (không tính vào kết quả)`);
    } finally {
      clearTimeout(timer);
    }
  }

  const runStarted = Date.now();

  for (const route of ROUTES) {
    const started = Date.now();
    // Phiếu ký được tạo NGAY TRƯỚC lần gọi này, nên tuổi của nó gần bằng thời gian chờ của
    // chính trang này — dùng nó để phân biệt "hết hạn" với "sai quyền".
    const mintedAt = Date.now();
    const cookie = `erp_session=${await mint()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE}${route}`, {
        headers: { cookie },
        redirect: "manual",
        signal: controller.signal,
      });
      const ms = Date.now() - started;

      if (response.status >= 300 && response.status < 400) {
        const tokenAge = Date.now() - mintedAt;
        const expired = tokenAge >= TOKEN_NEAR_EXPIRY_MS;
        results.push({
          route,
          verdict: expired ? "AUTH_EXPIRED" : "REDIRECT",
          detail: expired
            ? `HTTP ${response.status} sau ${Math.round(tokenAge / 1000)}s — phiếu ký hết hạn giữa lần gọi, KHÔNG phải lỗi trang`
            : `HTTP ${response.status} với phiếu ký còn mới (${Math.round(tokenAge / 1000)}s) — kiểm tra quyền của tài khoản quản trị`,
          ms,
        });
        continue;
      }

      if (response.status !== 200) {
        results.push({ route, verdict: "APP_ERROR", detail: `HTTP ${response.status}`, ms });
        continue;
      }

      const body = await response.text();
      if (!body.includes(RENDER_MARKER)) {
        results.push({ route, verdict: "APP_ERROR", detail: "HTTP 200 nhưng không dựng được khung ứng dụng", ms });
        continue;
      }

      // Trang mở được: phân biệt NHANH với CHẬM. Chậm là việc phải sửa, không phải cớ chặn deploy.
      results.push({
        route,
        verdict: ms > SLOW_MS ? "SLOW" : "SUCCESS",
        detail: `${Math.round(body.length / 1024)}kB${ms > SLOW_MS ? ` · CHẬM, ngưỡng ${Math.round(SLOW_MS / 1000)}s` : ""}`,
        ms,
      });
    } catch (error) {
      const ms = Date.now() - started;
      const aborted = error instanceof Error && error.name === "AbortError";
      results.push({
        route,
        verdict: aborted ? "TIMEOUT" : "APP_ERROR",
        detail: aborted ? `không trả lời trong ${Math.round(TIMEOUT_MS / 1000)}s` : error instanceof Error ? error.message : String(error),
        ms,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const icon: Record<Verdict, string> = {
    SUCCESS: "✓",
    APP_ERROR: "✗",
    AUTH_EXPIRED: "⚠",
    REDIRECT: "✗",
    SLOW: "⚠",
    TIMEOUT: "✗",
  };
  for (const r of results) {
    const line = `  ${icon[r.verdict]} ${r.route} [${r.verdict}] ${r.detail} (${r.ms}ms)`;
    if (r.verdict === "SUCCESS") console.log(line);
    else console.error(line);
  }

  const by = (v: Verdict) => results.filter((r) => r.verdict === v);
  console.log(
    `\n[smoke] ${(by("SUCCESS").length + by("SLOW").length)}/${results.length} đạt · ` +
      `${by("APP_ERROR").length} lỗi ứng dụng · ${by("REDIRECT").length} sai quyền · ` +
      `${by("SLOW").length} chậm · ${by("TIMEOUT").length} quá hạn · ${by("AUTH_EXPIRED").length} hết phiên ` +
      `(cả lượt chạy ${Math.round((Date.now() - runStarted) / 1000)}s)`,
  );

  // HẾT PHIÊN KHÔNG PHẢI LỖI CỦA ỨNG DỤNG nên không đánh trượt deploy — nhưng phải hiện ra, vì
  // với cơ chế ký lại mỗi trang thì nó chỉ xảy ra khi một trang chậm hơn cả hạn phiếu ký.
  if (by("AUTH_EXPIRED").length) {
    console.error(
      `\n[smoke] ⚠ ${by("AUTH_EXPIRED").length} trang không kiểm được vì phiếu ký hết hạn giữa lần gọi ` +
        `(trang chậm hơn ${TOKEN_TTL_MS / 60000} phút). Không tính là lỗi trang, nhưng KHÔNG chứng minh được trang đó tốt.`,
    );
  }

  /**
   * CHỈ LỖI THẬT MỚI CHẶN DEPLOY.
   *
   * `SLOW` cố ý KHÔNG nằm trong danh sách chặn: trang vẫn mở được, và chặn bản mới vì nó chậm có thể
   * đang chặn đúng bản vá làm nó nhanh hơn. Nhưng cũng KHÔNG im lặng — in riêng thành một mục để
   * không ai bỏ qua.
   */
  const slow = by("SLOW");
  if (slow.length) {
    console.error(`
[smoke] ${slow.length} màn hình CHẬM (mở được, không chặn deploy — nhưng phải sửa):`);
    for (const r of slow.sort((a, b) => b.ms - a.ms)) console.error(`  - ${r.route} → ${(r.ms / 1000).toFixed(1)}s`);
  }

  const fatal = [...by("APP_ERROR"), ...by("REDIRECT"), ...by("TIMEOUT")];
  if (fatal.length) {
    console.error(`\n[smoke] ${fatal.length}/${results.length} màn hình LỖI THẬT:`);
    for (const f of fatal) console.error(`  - ${f.route} [${f.verdict}] ${f.detail}`);
    process.exit(1);
  }
  console.log(`[smoke] ✓ Không có lỗi thật.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[smoke] Không chạy được smoke test:", error instanceof Error ? error.message : error);
  process.exit(1);
});
