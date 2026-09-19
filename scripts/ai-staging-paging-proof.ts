/**
 * BẰNG CHỨNG SỐNG CHO PHÂN TRANG — CHẠY CHÍNH HÀM MÀ LƯỢT NẠP CHẠY. CHỈ GỌI GET.
 *
 *   npx tsx scripts/ai-staging-paging-proof.ts --page=<ID> [--hours=24]
 *
 * ═══ KHÁC `pancake-pagination-probe.ts` Ở ĐIỂM QUYẾT ĐỊNH ═══
 *
 * Tệp dò kia tự gọi `fetch` để TÌM RA tham số đúng — và nó đã tìm ra (`current_count`: trang 2 trả
 * 40 mã, trùng 0, tổng duy nhất 100). Nhưng nó chứng minh **API làm được**, không chứng minh
 * **lượt nạp của ERP đang làm**. Hai câu ấy chỉ trùng nhau khi bản vá đã lên máy chủ và đang chạy;
 * đúng khoảng cách ấy là chỗ một bản vá "đã sửa rồi" nằm im trong kho mã suốt nhiều tuần.
 *
 * Nên tệp này KHÔNG tự gọi API. Nó gọi `PancakePagesClient.listConversations` — ĐÚNG hàm mà
 * `lib/ai-workforce/agents/sales/ingest.ts` gọi — rồi đo từ bên ngoài bằng cách bọc `fetch`.
 * Đo một hàm khác với hàm đang phục vụ khách là đo một hệ thống không ai chạy.
 *
 * ═══ BỌC `fetch` LÀ ĐỌC, KHÔNG PHẢI SỬA ═══
 *
 * Lớp bọc chỉ ĐẾM và GHI LẠI mã hội thoại của từng phản hồi rồi chuyển nguyên văn cho hàm thật.
 * Nó không đổi tham số, không chặn lời gọi, không sửa dữ liệu trả về. Nếu nó sửa bất cứ thứ gì
 * thì con số in ra sẽ là của một đường chạy khác — tức là vô giá trị.
 */
import "dotenv/config";
import { PancakePagesClient } from "@/lib/integrations/pancake/pages";
import { env } from "@/lib/env";

const arg = (name: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

type LuotGoi = { thuTu: number; currentCount: string; soDong: number; ma: string[] };

async function main() {
  const pageId = arg("page") || env.pancake.pageId;
  const hours = Number(arg("hours")) || 24;
  if (!pageId) {
    console.error("✗ DỪNG: chưa khai mã page.");
    process.exit(1);
  }

  const luot: LuotGoi[] = [];
  const fetchGoc = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetchGoc(input as Parameters<typeof fetchGoc>[0], init);
    const url = new URL(String(typeof input === "object" && "url" in input ? input.url : input));
    if (!url.pathname.includes("/conversations") || url.pathname.includes("/messages")) return res;
    // ĐỌC BẢN SAO. `res.json()` tiêu hết luồng, nên phải `clone()` — không thì hàm thật nhận một
    // phản hồi đã cạn và phép đo tự làm hỏng thứ nó đang đo.
    let ma: string[] = [];
    let soDong = 0;
    try {
      const body = (await res.clone().json()) as Record<string, unknown>;
      const ds = body.conversations ?? (body.data as Record<string, unknown>)?.conversations ?? body.data;
      const list = Array.isArray(ds) ? (ds as Record<string, unknown>[]) : [];
      soDong = list.length;
      ma = list.map((c) => String(c.id ?? c.conversation_id ?? "")).filter(Boolean);
    } catch {
      /* phản hồi không phải JSON — vẫn đếm là một lượt gọi, đó mới là điều đang đo */
    }
    luot.push({ thuTu: luot.length + 1, currentCount: url.searchParams.get("current_count") ?? "(không gửi)", soDong, ma });
    return res;
  }) as unknown as typeof fetch;

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3_600_000);
  const client = new PancakePagesClient();
  let ketQua: Awaited<ReturnType<PancakePagesClient["listConversations"]>> = [];
  try {
    // `limit` rộng tay: đang đo xem LẤY ĐƯỢC BAO NHIÊU, nên một cái trần chật sẽ cắt mất câu trả lời.
    ketQua = await client.listConversations(pageId, since, until, 500);
  } finally {
    globalThis.fetch = fetchGoc;
  }

  console.log("───────── TỪNG LƯỢT GỌI DANH SÁCH HỘI THOẠI ─────────");
  for (const l of luot) {
    const truoc = new Set(luot.filter((x) => x.thuTu < l.thuTu).flatMap((x) => x.ma));
    const trung = l.ma.filter((m) => truoc.has(m)).length;
    console.log(
      `  lượt ${l.thuTu} · current_count=${String(l.currentCount).padStart(4)} · nhận ${String(l.soDong).padStart(3)} dòng · trùng với các lượt trước: ${trung}`,
    );
    if (l.ma.length) console.log(`     mã đầu ${l.ma[0]} … mã cuối ${l.ma[l.ma.length - 1]}`);
  }

  const tatCaMa = luot.flatMap((l) => l.ma);
  const duyNhat = new Set(tatCaMa);
  const trang1 = new Set(luot[0]?.ma ?? []);
  const trang2 = luot[1]?.ma ?? [];
  const chongLan12 = trang2.filter((m) => trang1.has(m)).length;
  const maKetQua = ketQua.map((c) => c.id);
  const trungTrongKetQua = maKetQua.length - new Set(maKetQua).size;

  console.log("\n───────── TỔNG HỢP ─────────");
  console.log(`  cửa sổ đo              : ${hours} giờ`);
  console.log(`  TỔNG LƯỢT GỌI API      : ${luot.length}`);
  console.log(`  tổng dòng nhận về      : ${tatCaMa.length}`);
  console.log(`  MÃ DUY NHẤT            : ${duyNhat.size}`);
  console.log(`  chồng lấn trang 1 ↔ 2  : ${chongLan12}`);
  console.log(`  hàm trả về             : ${ketQua.length} hội thoại · ${new Set(maKetQua).size} mã duy nhất`);
  console.log(`  MÃ TRÙNG trong kết quả : ${trungTrongKetQua}`);
  console.log(`  cờ lặp trang một       : ${client.paginationStalled ? "CÓ" : "KHÔNG"}`);

  /*
    NGHIỆM THU — bốn điều, và mỗi điều phải tự đứng được.

    Điều đầu có một lối thoát TRUNG THỰC: nếu cửa sổ thật sự có ít hơn 60 hội thoại thì không phép
    đo nào chứng minh được gì, và bài này phải nói "CHƯA KẾT LUẬN ĐƯỢC" chứ không được nói ĐẠT.
    Một cửa sổ vắng khách trả về ĐẠT là đúng kiểu ô xanh vô nghĩa mà cả bộ luật này chống lại.
  */
  const quaTran = duyNhat.size > 60;
  const nhieuLuot = luot.length >= 2;
  const khongLap = !client.paginationStalled;
  const khongTrung = trungTrongKetQua === 0;

  console.log("\n───────── NGHIỆM THU ─────────");
  console.log(`  ${quaTran ? "✓" : "○"} lấy được QUÁ 60 mã duy nhất (${duyNhat.size})`);
  console.log(`  ${nhieuLuot && chongLan12 === 0 ? "✓" : "○"} trang 2 KHÁC trang 1 (chồng lấn ${chongLan12})`);
  console.log(`  ${khongLap ? "✓" : "✗"} KHÔNG lặp lại trang một`);
  console.log(`  ${khongTrung ? "✓" : "✗"} KHÔNG có mã trùng trong kết quả`);

  if (!khongLap || !khongTrung) {
    console.error("\n✗ KHÔNG ĐẠT — đường nạp vẫn lặp trang hoặc trả mã trùng.");
    process.exit(1);
  }
  if (!quaTran) {
    console.log(`\n○ CHƯA KẾT LUẬN ĐƯỢC: cửa sổ này chỉ có ${duyNhat.size} hội thoại, dưới trần 60 của một lượt gọi.`);
    console.log("  Phân trang KHÔNG bị chạm tới, nên không có gì để chứng minh. Chạy lại với `--hours` lớn hơn,");
    console.log("  hoặc vào giờ đông khách. ĐÂY KHÔNG PHẢI MỘT LƯỢT ĐẠT.");
    process.exit(2);
  }
  console.log("\n✓ ĐẠT — đường nạp THẬT lấy được quá 60 hội thoại trong một cửa sổ, không lặp, không trùng.");
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
