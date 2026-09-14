/**
 * ═══════════ ĐỘ PHỦ LÝ DO HOÀN: MÀN HÌNH NÓI GÌ, VÀ CÓ ĐÚNG KHÔNG ═══════════
 *
 * Chạy TRONG container app trên production. Hai đường, phải nói cùng một con số:
 *
 *   1. MÁY TÍNH BÁO CÁO — gọi thẳng `getReturnReasonReport()`, đúng hàm mà trang gọi;
 *   2. MÀN HÌNH — tải thật `/reports/returns` bằng phiên hợp lệ rồi tìm chính những con số ấy
 *      trong HTML. Đây là tầng duy nhất thấy được một khối biến mất sau lớp bắt lỗi: trang vẫn
 *      trả HTTP 200 mà khối độ phủ không hiện — chuyện đã xảy ra thật ngày 14/09.
 *
 * CHỈ ĐỌC. Không ghi một dòng nào.
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { RETURN_REASON_LABEL, type ReturnReason } from "@/lib/constants/return-reason";
import { resolvePeriod } from "@/lib/search-params";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";
const PERIOD = process.env.COVERAGE_PERIOD ?? "all";
const so = (n: number) => n.toLocaleString("vi-VN");
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

async function main() {
  const period = resolvePeriod({ period: PERIOD }, "all");
  const bc = await getReturnReasonReport({ period, basis: "SHIPPED" });
  const c = bc.reasonCoverage;

  console.log(`── ĐỘ PHỦ LÝ DO HOÀN · kỳ "${PERIOD}" · mốc SHIPPED ──\n`);
  console.log(`Đơn đã bàn giao ĐVVC : ${so(bc.eligibleSent)}`);
  console.log(`Đơn đã có kết quả cuối: ${so(bc.finished)}  (giao ${so(bc.delivered)} · hoàn ${so(bc.returned)} · đang chạy ${so(bc.active)})`);
  console.log("");
  console.log("trạng thái độ phủ            |   đơn |    %  | việc phải làm");
  console.log("----------------------------+-------+-------+---------------------------------------");
  const hang = (ten: string, n: number, viec: string) =>
    console.log(`${ten.padEnd(27)} | ${so(n).padStart(5)} | ${pct(bc.returned ? (n / bc.returned) * 100 : null).padStart(5)} | ${viec}`);
  hang("Đã xác định lý do", c.known, "không phải việc");
  hang("Có chứng từ, chưa xếp được", c.rawOnly, "mở chữ ra đọc rồi chọn lý do");
  hang("Chưa có chứng từ nào", c.noEvidence, "phải ĐI HỎI — không có gì để đọc");
  console.log(`${"TỔNG ĐƠN HOÀN".padEnd(27)} | ${so(bc.returned).padStart(5)} |`);

  /* Bất biến: ba phần phải cộng lại đúng bằng tổng đơn hoàn. */
  if (c.known + c.rawOnly + c.noEvidence !== bc.returned) {
    console.error(`\n✗ LỆCH: ${c.known} + ${c.rawOnly} + ${c.noEvidence} ≠ ${bc.returned}`);
    process.exit(1);
  }

  /* ─── Lý do thật, theo số ĐƠN ─── */
  console.log("\ntop lý do (trên đơn ĐÃ BIẾT lý do)");
  console.log("--------------------------------------------------");
  const chiTiet = bc.groups.flatMap((g) => g.details).filter((d) => d.count > 0).sort((a, b) => b.count - a.count);
  for (const d of chiTiet.slice(0, 10)) {
    console.log(`${RETURN_REASON_LABEL[d.reason as ReturnReason].padEnd(34)} | ${so(d.count).padStart(5)} đơn`);
  }

  /* ─── Lý do lớn nhất của từng mã hàng ─── */
  console.log("\nlý do lớn nhất theo mã hàng (mã có ≥ 5 đơn hoàn)");
  console.log("--------------------------------------------------");
  const theoMa = bc.products.filter((p) => p.returned >= 5).sort((a, b) => b.returned - a.returned).slice(0, 12);
  for (const p of theoMa) {
    // `topReason` do chính máy tính báo cáo dựng — KHÔNG tự xếp lại ở đây, vì hai cách xếp là hai
    // con số và màn hình chỉ hiện một trong hai.
    const top = p.topReason;
    console.log(
      `${p.code.padEnd(8)} | hoàn ${so(p.returned).padStart(4)} / ${so(p.finished).padStart(4)} | ${top ? `${top.label} (${so(top.count)} · ${top.share.toFixed(0)}%)` : "chưa xác định được lý do nào"}`,
    );
  }

  /* ─── MÀN HÌNH THẬT ─── */
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) {
    console.log("\n(bỏ qua phần màn hình: thiếu AUTH_SECRET)");
    return;
  }
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
  if (!user) {
    console.log("\n(bỏ qua phần màn hình: chưa có tài khoản quản trị)");
    return;
  }
  const token = await new SignJWT({ email: user.email, name: user.name, role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));
  const res = await fetch(`${BASE}/reports/returns?period=${encodeURIComponent(PERIOD)}&basis=SHIPPED`, {
    headers: { cookie: `erp_session=${token}` },
    redirect: "manual",
  });
  if (res.status !== 200) {
    console.error(`\n✗ Màn hình trả HTTP ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();

  /*
    Tìm CHÍNH những con số máy tính vừa ra, trong HTML đã render. Không bóc số rồi so — chỉ cần
    biết chúng CÓ MẶT: một khối bị nuốt sau lớp bắt lỗi thì không con số nào của nó xuất hiện.
  */
  const thieu: string[] = [];
  for (const [ten, n] of [["đã xác định", c.known], ["có chứng từ chưa xếp", c.rawOnly], ["chưa có chứng từ", c.noEvidence]] as const) {
    if (!html.includes(so(n))) thieu.push(`${ten} (${so(n)})`);
  }
  const coKhoi = html.includes("Đã xác định lý do") && html.includes("Chưa có chứng từ nào");
  console.log("\n── MÀN HÌNH THẬT ──");
  console.log(`HTTP 200 · ${so(html.length)} ký tự · khối độ phủ ba ô: ${coKhoi ? "CÓ" : "KHÔNG THẤY"}`);
  if (!coKhoi) {
    console.error("✗ Khối độ phủ KHÔNG hiện trên màn hình — trang vẫn 200 nhưng người đọc không thấy con số nào.");
    process.exit(1);
  }
  console.log(thieu.length ? `⚠ không tìm thấy trên trang: ${thieu.join(", ")}` : "✓ cả ba con số của máy tính đều có mặt trong HTML đã render");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
