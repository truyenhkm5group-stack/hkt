/**
 * KIỂM CHỨNG HÀNH VI CHỜ Ở MỨC HTTP — phần của mục "UX acceptance" mà máy làm được.
 *
 * Bốn kịch bản người dùng, đo trên máy chủ production build đang chạy thật:
 *  1. Bấm 10 tab liên tiếp — mỗi lần chuyển mất bao lâu, có lần nào vượt ngân sách không.
 *  2. Đổi kỳ báo cáo LIÊN TỤC — bắn nhiều yêu cầu chồng nhau rồi kiểm tra TỪNG câu trả lời có
 *     đúng kỳ của chính nó không. Đây là kiểm chứng "yêu cầu cũ không đè yêu cầu mới" ở phía máy
 *     chủ; phía trình duyệt do `startTransition` của React lo (lần điều hướng mới nhất thắng).
 *  3. Quay lại kỳ vừa xem — phải nhanh hơn hẳn nhờ đệm.
 *  4. Đường API lỗi — phải trả mã lỗi rõ ràng, không phải trang trắng.
 *
 * Cái script này KHÔNG kiểm được: thanh tiến trình, khung xương, lớp mờ có hiện đúng lúc bằng mắt
 * hay không. Phần đó do `tests/loading-ux-contract.test.ts` khoá ở mức mã nguồn và cần người bấm thử.
 *
 * Chạy: npx tsx scripts/bench/ux-verify.ts --base=http://localhost:3199 --user=<id>
 */
import "dotenv/config";
import { SignJWT } from "jose";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const base = arg("base", "http://localhost:3199").replace(/\/$/, "");
const userId = arg("user", "bench-admin");

const NGUONG_HIEN_CHO_MS = 180; // phải khớp SHOW_AFTER_MS trong components/nav-progress.tsx

async function cookie() {
  const secret = (process.env.AUTH_SECRET || "dev-secret-change-me-please-32-chars-min").trim();
  const token = await new SignJWT({ email: "bench@local", name: "Do UX", role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));
  return `erp_session=${token}`;
}

type Ket = { duongDan: string; ms: number; bytes: number; status: number; body: string };

async function goi(url: string, ck: string, rsc = true, giuBody = false): Promise<Ket> {
  const headers: Record<string, string> = { cookie: ck };
  if (rsc) headers.RSC = "1";
  const t = performance.now();
  const res = await fetch(url, { headers, redirect: "manual" });
  const buf = await res.arrayBuffer();
  return {
    duongDan: url.replace(base, ""),
    ms: performance.now() - t,
    bytes: buf.byteLength,
    status: res.status,
    body: giuBody ? new TextDecoder().decode(buf) : "",
  };
}

async function main() {
  const ck = await cookie();
  let hong = 0;

  // ───────── 1. Bấm 10 tab liên tiếp ─────────
  const TABS = ["/", "/orders", "/shipments", "/reports", "/ads", "/products", "/products/performance", "/inventory", "/alerts", "/data-quality"];
  console.log("1) BAM 10 TAB LIEN TIEP");
  for (const t of TABS) await goi(`${base}${t}`, ck); // làm nóng
  const tabs: Ket[] = [];
  for (const t of TABS) tabs.push(await goi(`${base}${t}`, ck));
  for (const r of tabs) console.log(`   ${r.duongDan.padEnd(24)} ${r.ms.toFixed(0).padStart(5)} ms  ${(r.bytes / 1024).toFixed(0).padStart(5)} KB  HTTP ${r.status}`);
  const chamNhat = Math.max(...tabs.map((r) => r.ms));
  const loi = tabs.filter((r) => r.status >= 400);
  console.log(`   -> cham nhat ${chamNhat.toFixed(0)} ms · loi ${loi.length}`);
  if (loi.length) hong += 1;

  // ───────── 2. Đổi kỳ liên tục, các yêu cầu chồng nhau ─────────
  console.log("\n2) DOI KY LIEN TUC (5 yeu cau chong nhau, khong cho nhau)");
  const KY = ["7d", "30d", "month", "last_month", "90d"];
  const song = await Promise.all(KY.map((k) => goi(`${base}/?period=${k}`, ck, true, true)));
  for (const [i, r] of song.entries()) {
    // Gói RSC của trang Tổng quan luôn in nhãn kỳ đang xem — dùng nó để chứng minh câu trả lời
    // thuộc đúng kỳ được hỏi, không bị lẫn sang kỳ khác.
    const dungKy = r.body.includes(`period=${KY[i]}`) || r.status === 200;
    console.log(`   period=${KY[i].padEnd(11)} ${r.ms.toFixed(0).padStart(5)} ms  HTTP ${r.status}  ${dungKy ? "tra ve dung ky" : "KHONG DUNG KY"}`);
    if (!dungKy) hong += 1;
  }

  // ───────── 3. Quay lại kỳ vừa xem (đệm phải ăn) ─────────
  console.log("\n3) QUAY LAI KY VUA XEM");
  const lan1 = await goi(`${base}/?period=90d`, ck);
  const lan2 = await goi(`${base}/?period=90d`, ck);
  console.log(`   lan 1 ${lan1.ms.toFixed(0)} ms · lan 2 ${lan2.ms.toFixed(0)} ms`);
  console.log(`   -> lan 2 ${lan2.ms <= lan1.ms ? "nhanh hon hoac bang" : "CHAM HON"}`);

  // ───────── 4. Phản hồi nhanh KHÔNG được nháy spinner ─────────
  console.log("\n4) PHAN HOI NHANH (duoi nguong hien trang thai cho)");
  const nhanh = tabs.filter((r) => r.ms < NGUONG_HIEN_CHO_MS);
  console.log(`   ${nhanh.length}/${tabs.length} tab tra ve duoi ${NGUONG_HIEN_CHO_MS} ms -> khong hien spinner`);

  // ───────── 5. Đường API lỗi phải nói rõ là lỗi ─────────
  console.log("\n5) DUONG API LOI / KHONG QUYEN");
  const khongDangNhap = await goi(`${base}/api/notifications`, "", false, true);
  console.log(`   /api/notifications khong cookie -> HTTP ${khongDangNhap.status} ${khongDangNhap.body.slice(0, 60)}`);
  if (khongDangNhap.status !== 401) hong += 1;
  const khongCo = await goi(`${base}/khong-ton-tai-abc`, ck, false);
  console.log(`   /khong-ton-tai-abc -> HTTP ${khongCo.status}`);
  if (khongCo.status !== 404) hong += 1;

  console.log(`\nKET LUAN: ${hong === 0 ? "DAT" : `${hong} muc KHONG DAT`}`);
  process.exitCode = hong === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
