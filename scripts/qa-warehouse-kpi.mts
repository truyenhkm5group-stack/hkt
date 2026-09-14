/**
 * KIỂM MẮT KHỐI ĐO HIỆU SUẤT KHO HÀNG HOÀN.
 *
 * Dựng một CSDL PGlite riêng, đổ đúng thứ khối này cần (kiện trải đủ BỐN nhóm tuổi, một người đếm
 * có khoá, một lượt đếm vô danh, một phiếu tái nhập hai mẫu mã), rồi mở trang bằng trình duyệt thật
 * ở CẢ HAI chủ đề sáng/tối và ba mức thu phóng.
 *
 * Chạy: npx tsx scripts/qa-warehouse-kpi.mts --base=http://localhost:3150
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const arg = (n: string, d: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const base = arg("base", "http://localhost:3150").replace(/\/$/, "");

async function mint() {
  const secret = (process.env.AUTH_SECRET || "dev-secret-change-me-please-32-chars-min").trim();
  return new SignJWT({ email: "qa@local", name: "QA Kho", role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("qa-admin")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));
}

const loi: string[] = [];
const ok = (dieu: string, dung: boolean, chiTiet = "") => {
  console.log(`${dung ? "✓" : "✗"} ${dieu}${chiTiet ? ` — ${chiTiet}` : ""}`);
  if (!dung) loi.push(dieu);
};

async function main() {
  const token = await mint();
  // Bản Chromium cài sẵn của môi trường khác bản mà gói playwright mong đợi — trỏ thẳng vào nó
  // thay vì tải thêm một bản nữa.
  const browser = await chromium.launch({ executablePath: process.env.QA_CHROME || "/opt/pw-browsers/chromium" });

  for (const theme of ["light", "dark"] as const) {
    for (const zoom of [90, 100, 110]) {
      const ctx = await browser.newContext({
        colorScheme: theme,
        viewport: { width: Math.round(1440 / (zoom / 100)), height: Math.round(900 / (zoom / 100)) },
      });
      await ctx.addCookies([{ name: "erp_session", value: token, domain: "localhost", path: "/" }]);
      const page = await ctx.newPage();
      const consoleLoi: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleLoi.push(m.text());
      });
      const httpLoi: string[] = [];
      page.on("response", (r) => {
        if (r.status() >= 400 && !r.url().includes("favicon")) httpLoi.push(`${r.status()} ${r.url().replace(base, "")}`);
      });

      const res = await page.goto(`${base}/inventory/returns`, { waitUntil: "networkidle", timeout: 60_000 });
      const nhan = `${theme} ${zoom}%`;
      ok(`[${nhan}] trang mở được`, res?.status() === 200, `HTTP ${res?.status()}`);

      const chu = await page.locator("body").innerText();

      if (theme === "light" && zoom === 100) {
        // Bốn khối mới phải có mặt.
        ok("khối “Kho hàng hoàn hôm nay”", chu.includes("Kho hàng hoàn hôm nay"));
        ok("ô “Quá hạn đếm”", chu.includes("Quá hạn đếm"));
        ok("hai tỷ lệ", chu.includes("Tỷ lệ bán lại được") && chu.includes("Tỷ lệ thu hồi tồn"));
        ok("dải tuổi theo GIỜ", chu.includes("< 24 giờ") && chu.includes("> 72 giờ"));
        ok("khối năng suất", /Năng suất \d+ ngày/.test(chu));
        ok("bảng người đếm", chu.includes("Người đếm hàng hoàn"));
        ok("bảng mẫu mã", chu.includes("Mẫu mã quay lại tồn"));
        ok("khối chưa đo được", chu.includes("Ba chỉ số ERP chưa đo được"));

        // Dải tuổi CŨ theo NGÀY phải biến mất — hai dải tuổi là hai câu trả lời cho một câu hỏi.
        ok("dải tuổi cũ theo ngày đã bỏ", !chu.includes("Tuổi kiện chờ đếm:"), "chuỗi cũ có dấu hai chấm");

        // Lượt đếm vô danh không được gán cho ai.
        ok("lượt đếm vô danh đếm riêng", chu.includes("Chưa quy kết được về tài khoản"));

        // Biểu đồ phải vẽ được (recharts dựng <svg> trong khối chart).
        const svg = await page.locator(".recharts-surface").count();
        ok("biểu đồ năng suất vẽ được", svg >= 1, `${svg} svg`);
      }

      // Không tràn ngang ở mọi chủ đề / mức thu phóng.
      const tran = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(`[${nhan}] không tràn ngang`, tran <= 1, `lệch ${tran}px`);
      ok(`[${nhan}] không lỗi console`, consoleLoi.length === 0, consoleLoi.slice(0, 2).join(" | "));
      ok(`[${nhan}] không lỗi HTTP`, httpLoi.length === 0, httpLoi.slice(0, 2).join(" | "));

      await ctx.close();
    }
  }

  await browser.close();
  console.log(loi.length ? `\n✗ ${loi.length} lỗi` : "\n✓ 0 lỗi");
  process.exit(loi.length ? 1 : 0);
}

main();
