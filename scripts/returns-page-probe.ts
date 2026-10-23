/**
 * ═══════ /reports/returns: VÒNG SỰ KIỆN BỊ CHẶN BAO LÂU, VÀ ĐẦU PHẢN HỒI THẬT (CHỈ ĐỌC) ═══════
 *
 * Câu hỏi (Lead 23/10/2026, docs/tech/odoo-inspired-erp-upgrade.md §7.2):
 *
 *   · Smoke 23/10 đo ĐẦU PHẢN HỒI 3.787 / 3.341 ms cho riêng trang này, trong khi /orders là 465 ms
 *     (thân 8,5 s) và /shipments?view=reconcile 105 ms (thân 20,9 s). Trang có loading.tsx, không
 *     layout riêng, không nhánh middleware nào. Vậy cái gì giữ byte đầu?
 *   · perf-probe thấy câu `settings where key = $1` (tra khoá chính) mất 2,7 s bên trong
 *     getReturnIntelligence, mà bể chỉ chờ 37 ms.
 *
 * Giả thuyết chung cho cả hai: vòng sự kiện Node bị chặn bởi việc ĐỒNG BỘ khi xử lý dòng (intelligence
 * kéo 88.034 dòng). Script này ĐO thay vì đoán:
 *
 *   1. Trong tiến trình: gọi ĐÚNG `loadReturnsPage(returnsPageParams(withDefaultReturnsBasis(…)))` —
 *      cùng hàm trang gọi — nguội (xoá đệm) rồi ấm, và ghi lại MỌI khoảng vòng sự kiện đứng yên
 *      ≥ 50 ms (đồng hồ 10 ms trôi lệch bao nhiêu) + biểu đồ `monitorEventLoopDelay`.
 *   2. Từng nhánh nặng của intelligence, mỗi nhánh nguội riêng, cùng hai số đó.
 *   3. Qua HTTP tới chính máy chủ: đầu phản hồi + thân của /reports/returns (lượt 1, lượt 2, và URL
 *      ghi rõ tham số mặc định), kèm /operations làm đối chứng.
 *
 * Số ở (1)–(2) là của TIẾN TRÌNH SCRIPT, không phải tiến trình Next: cùng mã, cùng dữ liệu, nên nó nói
 * mã đó chặn vòng sự kiện bao lâu; không nói máy chủ đang bận việc gì khác. (3) là số người dùng thật.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/returns-page-probe.ts
 */
import "dotenv/config";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";

// CHỈ ĐỌC do chính Postgres ép (`default_transaction_read_only`) — đặt TRƯỚC lần mở kết nối đầu tiên.
process.env.ERP_READ_ONLY = "1";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";
const BLOCK_MS = 50;

type Khoang = { ms: number; at: number };

/** Đo một việc: thời gian tường + mọi khoảng vòng sự kiện đứng yên ≥ BLOCK_MS + biểu đồ trễ. */
async function doVongSuKien<T>(ten: string, viec: () => Promise<T>): Promise<T> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  const khoang: Khoang[] = [];
  const t0 = performance.now();
  let truoc = t0;
  const dongHo = setInterval(() => {
    const nay = performance.now();
    const tre = nay - truoc - 10;
    if (tre >= BLOCK_MS) khoang.push({ ms: Math.round(tre), at: Math.round(truoc - t0) });
    truoc = nay;
  }, 10);
  h.enable();
  try {
    return await viec();
  } finally {
    const tuong = Math.round(performance.now() - t0);
    clearInterval(dongHo);
    h.disable();
    const tong = khoang.reduce((a, k) => a + k.ms, 0);
    const top = [...khoang].sort((a, b) => b.ms - a.ms).slice(0, 5);
    const ms = (ns: number) => Math.round(ns / 1e6);
    console.log(
      `  ${String(tuong).padStart(6)} ms tường · chặn ≥${BLOCK_MS}ms: ${khoang.length} lần, cộng ${tong} ms (${tuong ? Math.round((tong / tuong) * 100) : 0}%) · trễ vòng sự kiện p99 ${ms(h.percentile(99))} / max ${ms(h.max)} ms · ${ten}`,
    );
    if (top.length) console.log(`         dài nhất: ${top.map((k) => `${k.ms}ms@+${k.at}ms`).join(" · ")}`);
  }
}

async function main() {
  const { getDb, schema } = await import("@/db");
  const db = await getDb();
  // Lời hứa "chỉ đọc" phải do Postgres xác nhận, không do biến môi trường hứa.
  const ro = (await db.execute(sql`show default_transaction_read_only`)) as unknown as { rows: { default_transaction_read_only?: string }[] };
  if (ro.rows?.[0]?.default_transaction_read_only !== "on") {
    console.error("DỪNG: kết nối KHÔNG ở chế độ chỉ đọc — không chạy phép đo trên production");
    process.exit(70);
  }
  const { clearMemo } = await import("@/lib/cache");
  const { canUseModule } = await import("@/lib/platform/capabilities");
  const { loadReturnsPage, returnsPageParams, withDefaultReturnsBasis } = await import("@/lib/queries/returns-report-page");
  const { getReturnReasonReport } = await import("@/lib/queries/return-reason-report");
  const { getProjectedDeliveryMetrics } = await import("@/lib/queries/projected-delivery");
  const { getReturnIntelligence } = await import("@/lib/queries/return-intelligence");

  // Tham số MẶC ĐỊNH của trang, dựng qua đúng hai hàm trang dùng — không gõ lại kỳ / mốc.
  const thamSo = returnsPageParams(withDefaultReturnsBasis({}, await canUseModule("logistics")));
  const { params, basis, giaTriDon, previous, reasonFilterBase, codes, marketerIds, trendGrain } = thamSo;
  console.log(`── /reports/returns · kỳ ${params.period.label} · mốc ${basis} ──`);

  console.log("── 1. CẢ TRANG TRONG TIẾN TRÌNH (loadReturnsPage — cùng hàm trang gọi) ──");
  clearMemo();
  await doVongSuKien("nguội (xoá đệm)", () => loadReturnsPage(thamSo));
  await doVongSuKien("ấm (đệm còn nguyên)", () => loadReturnsPage(thamSo));

  console.log("── 2. TỪNG NHÁNH NẶNG CỦA INTELLIGENCE, mỗi nhánh nguội riêng ──");
  clearMemo();
  const baoCao = await doVongSuKien("getReturnReasonReport · kỳ này (trang truyền sẵn cho intelligence)", () => getReturnReasonReport(reasonFilterBase));
  if (previous) {
    clearMemo();
    await doVongSuKien("getReturnReasonReport · KỲ TRƯỚC (intelligence tự dựng thêm)", () => getReturnReasonReport({ ...reasonFilterBase, period: { ...params.period, from: previous.from, to: previous.to } }));
  }
  clearMemo();
  await doVongSuKien("getProjectedDeliveryMetrics · PRODUCT", () => getProjectedDeliveryMetrics(params.period, basis, "PRODUCT", giaTriDon));
  clearMemo();
  await doVongSuKien("getReturnIntelligence · nhận sẵn báo cáo kỳ này (đúng đường trang)", () =>
    getReturnIntelligence({ period: params.period, previous, basis, codes, marketerIds, trendGrain, reasonReport: baoCao, value: giaTriDon }),
  );

  console.log("── 3. QUA HTTP TỚI MÁY CHỦ THẬT (đầu phản hồi · thân) ──");
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) {
    console.log("  CHƯA ĐO ĐƯỢC: thiếu AUTH_SECRET nên không ký được phiên");
    return;
  }
  const [admin] = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
  if (!admin) {
    console.log("  CHƯA ĐO ĐƯỢC: không có tài khoản quản trị để ký phiên");
    return;
  }
  const key = new TextEncoder().encode(secret);
  const mint = () => new SignJWT({ email: admin.email, name: admin.name, role: "ADMIN" }).setProtectedHeader({ alg: "HS256" }).setSubject(admin.id).setIssuedAt().setExpirationTime("10m").sign(key);
  const mo = async (duongDan: string, nhan: string) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}${duongDan}`, { headers: { cookie: `erp_session=${await mint()}` }, redirect: "manual", signal: AbortSignal.timeout(90_000) });
      const dau = Date.now() - t0;
      const than = await r.arrayBuffer();
      console.log(`  HTTP ${r.status} · đầu phản hồi ${String(dau).padStart(5)} ms · thân ${String(Date.now() - t0).padStart(6)} ms · ${Math.round(than.byteLength / 1024)} kB${r.headers.get("location") ? ` · chuyển tới ${r.headers.get("location")}` : ""} · ${nhan}`);
    } catch (e) {
      console.log(`  LỖI sau ${Date.now() - t0} ms · ${nhan}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await mo("/operations", "đối chứng /operations");
  await mo("/reports/returns", "/reports/returns · lượt 1");
  await mo("/reports/returns", "/reports/returns · lượt 2 (đệm máy chủ ấm)");
  await mo(`/reports/returns?period=${params.period.key}&basis=${basis}`, "/reports/returns · ghi rõ tham số mặc định");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
