/**
 * PANCAKE CÓ PHÂN TRANG ĐƯỢC KHÔNG — VÀ BẰNG THAM SỐ NÀO. CHỈ GỌI GET.
 *
 *   npx tsx scripts/pancake-pagination-probe.ts --page=<ID> [--hours=24]
 *
 * ═══ VÌ SAO CẦN MỘT TỆP RIÊNG, TÁCH KHỎI `pancake-read-test.ts` ═══
 *
 * Bài kiểm đọc trả lời "có đọc được không". Tệp này trả lời một câu hẹp hơn và khó hơn: **lấy
 * được hội thoại thứ 61 bằng cách nào**. Đã đo ngày 19/09/2026: `page_number` và `page_size` bị
 * BỎ QUA — xin 20 nhận 60, trang 1 và trang 2 trùng đủ 60/60 mã. Lượt nạp thật vì thế gọi hai
 * mươi lần cho một trang dữ liệu (đã vá: nay dừng ở lần thứ hai và nói ra rằng mẻ chưa đủ).
 *
 * Nhưng "đã thôi gọi lại" KHÔNG phải "đã lấy đủ". Nếu một cửa sổ có hơn 60 hội thoại thì phần
 * vượt trần hiện không có đường nào lấy được, và mọi con số dựng trên mẻ nạp đều đứng trên một
 * mẫu bị cắt mà không ai biết. Đó là thứ tệp này đi đo.
 *
 * ═══ 429 LÀ KẺ THÙ CỦA CHÍNH PHÉP ĐO NÀY ═══
 *
 * Lượt dò đầu tiên bắn mười lời gọi liền nhau; sáu lời gọi cuối nhận 429 và bản đầu của bài kiểm
 * in chúng ra thành "tham số không được chấp nhận" — một kết luận về THAM SỐ rút ra từ một phản
 * hồi về TẦN SUẤT. Nên ở đây mỗi lời gọi cách nhau `NHIP_MS`, có lùi dần khi gặp 429, và một
 * lượt hỏi không đo được thì in ra ĐÚNG CHỮ "CHƯA ĐO ĐƯỢC" chứ không bao giờ thành một phán quyết.
 *
 * ═══ BẰNG CHỨNG PHẢI LÀ TẬP MÃ, KHÔNG PHẢI SỐ ĐẾM ═══
 *
 * Hai trang cùng trả 60 dòng có thể là 60 hội thoại khác nhau, hoặc đúng 60 hội thoại cũ. Số đếm
 * không phân biệt được hai chuyện ấy. Nên mọi phán quyết ở đây dựa trên GIAO của hai tập mã, và
 * bản in luôn kèm: mã trang 1 · mã trang 2 · số trùng · số duy nhất · tổng lấy được.
 */
import "dotenv/config";
import { env } from "@/lib/env";

const arg = (name: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

/** Nhịp tối thiểu giữa hai lời gọi. Rộng tay có chủ ý: phép đo này chạy vài phút một lần, không phải vài giây. */
const NHIP_MS = 2_500;
const nghi = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = env.pancake.pagesBaseUrl;
type KetQua = { status: number; ids: string[]; soDong: number; loi: string };

let soLoiGoi = 0;

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

/** Một lời gọi GET, có giãn nhịp và lùi dần khi 429. KHÔNG bao giờ in URL (nó mang token). */
async function hoi(pageId: string, params: Record<string, string | number>): Promise<KetQua> {
  for (let lan = 0; lan < 3; lan++) {
    await nghi(lan === 0 ? NHIP_MS : NHIP_MS * 2 ** lan);
    soLoiGoi += 1;
    const url = new URL(`${BASE}/pages/${pageId}/conversations`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let status = 0;
    let body: Record<string, unknown> = {};
    try {
      const res = await fetch(url, { method: "GET", headers: { accept: "*/*" } });
      status = res.status;
      body = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      return { status: 0, ids: [], soDong: 0, loi: e instanceof Error ? e.message : String(e) };
    }
    if (status === 429) continue;
    if (status >= 400) return { status, ids: [], soDong: 0, loi: `HTTP ${status}` };
    const list = arr(body.conversations ?? (body.data as Record<string, unknown>)?.conversations ?? body.data);
    return { status, ids: list.map((c) => String(c.id ?? c.conversation_id ?? "")).filter(Boolean), soDong: list.length, loi: "" };
  }
  return { status: 429, ids: [], soDong: 0, loi: "CHƯA ĐO ĐƯỢC (429 sau 3 lần thử — bị giới hạn tần suất)" };
}

/** In bằng chứng của một phép so hai trang. Đây là khuôn DUY NHẤT được dùng để kết luận. */
function soHaiTrang(ten: string, t1: KetQua, t2: KetQua): "SANG_TRANG" | "LAP_LAI" | "RONG" | "CHUA_DO_DUOC" {
  if (t1.loi || t2.loi) {
    console.log(`  ${ten.padEnd(30)} → CHƯA ĐO ĐƯỢC · ${t1.loi || t2.loi}`);
    return "CHUA_DO_DUOC";
  }
  const tap1 = new Set(t1.ids);
  const trung = t2.ids.filter((id) => tap1.has(id)).length;
  const duyNhat = new Set([...t1.ids, ...t2.ids]).size;
  console.log(
    `  ${ten.padEnd(30)} → trang1 ${String(t1.soDong).padStart(3)} · trang2 ${String(t2.soDong).padStart(3)} · TRÙNG ${String(trung).padStart(3)} · DUY NHẤT ${String(duyNhat).padStart(3)}`,
  );
  if (t2.soDong === 0) return "RONG";
  if (trung === t2.soDong) return "LAP_LAI";
  return "SANG_TRANG";
}

async function main() {
  const pageId = arg("page") || env.pancake.pageId;
  const hours = Number(arg("hours")) || 24;
  const pageToken = env.pancake.pageAccessToken;
  const userToken = env.pancake.pagesAccessToken;
  const key = pageToken ? "page_access_token" : "access_token";
  const token = pageToken || userToken;
  if (!token || !pageId) {
    console.error("✗ DỪNG: thiếu chứng thư hoặc mã page.");
    process.exit(1);
  }

  const until = Math.floor(Date.now() / 1000);
  const since = until - hours * 3600;
  const nen = { [key]: token, since, until, order_by: "updated_at" } as Record<string, string | number>;

  console.log("───────── 0. TRANG NỀN (mọi phép so đều dựa vào trang này) ─────────");
  const goc = await hoi(pageId, { ...nen, page_size: 50 });
  if (goc.loi) {
    console.error(`  ✗ ${goc.loi} — không có trang nền thì không phép so nào có nghĩa.`);
    process.exit(1);
  }
  console.log(`  ${goc.soDong} hội thoại · ${new Set(goc.ids).size} mã duy nhất · cửa sổ ${hours} giờ`);
  console.log(`  mã ĐẦU : ${goc.ids[0] ?? "(rỗng)"}`);
  console.log(`  mã CUỐI: ${goc.ids[goc.ids.length - 1] ?? "(rỗng)"}`);
  if (goc.soDong === 0) {
    console.log("  cửa sổ rỗng — nới `--hours` rồi chạy lại.");
    process.exit(0);
  }
  const maCuoi = goc.ids[goc.ids.length - 1]!;

  /*
    ── 1. SÁU CÁCH XIN "TRANG SAU" ──

    Mỗi ứng viên là một CÁCH HIỂU khác nhau về phân trang, không phải sáu cách viết của một cách:
      · đánh số trang   — máy chủ tự nhớ kích thước trang;
      · bỏ qua N dòng   — nơi gọi tự đếm;
      · con trỏ         — máy chủ trả mốc để xin tiếp;
      · mã dòng cuối    — nơi gọi nói "cho tôi thứ sau cái này".
    Một API chỉ hỗ trợ ĐÚNG MỘT trong bốn kiểu, nên dò cả bốn mới biết nó thuộc kiểu nào.
  */
  console.log("\n───────── 1. XIN TRANG SAU BẰNG SÁU THAM SỐ ─────────");
  const ungVien: { ten: string; tham: Record<string, string | number> }[] = [
    { ten: "page_number=2", tham: { page_number: 2, page_size: 50 } },
    { ten: "page=2", tham: { page: 2, page_size: 50 } },
    { ten: "offset=<số dòng>", tham: { offset: goc.soDong, page_size: 50 } },
    { ten: "skip=<số dòng>", tham: { skip: goc.soDong, page_size: 50 } },
    { ten: "current_count=<số dòng>", tham: { current_count: goc.soDong, page_size: 50 } },
    { ten: "last_conversation_id", tham: { last_conversation_id: maCuoi, page_size: 50 } },
  ];
  const thang: string[] = [];
  for (const uv of ungVien) {
    const kq = await hoi(pageId, { ...nen, ...uv.tham });
    if (soHaiTrang(uv.ten, goc, kq) === "SANG_TRANG") thang.push(uv.ten);
  }

  /*
    ── 2. THU HẸP CỬA SỔ THỜI GIAN — ĐƯỜNG LÙI KHÔNG CẦN PHÂN TRANG ──

    Kể cả khi API không phân trang được, vẫn lấy đủ dữ liệu được: chia cửa sổ thành nhiều lát
    MỎNG HƠN TRẦN rồi ghép lại. Phép đo này kiểm hai tính chất mà đường lùi ấy dựa vào:
      (a) `since`/`until` THẬT SỰ lọc — hai lát rời nhau phải cho hai tập mã rời nhau;
      (b) hợp của các lát phải PHỦ được tập của cửa sổ lớn, nếu không thì cắt nhỏ cũng mất dữ liệu.
    Không có (a) thì cắt nhỏ vô nghĩa; không có (b) thì cắt nhỏ vẫn sót.
  */
  console.log("\n───────── 2. CẮT CỬA SỔ THỜI GIAN CÓ THẬT SỰ LỌC KHÔNG ─────────");
  const giua = Math.floor((since + until) / 2);
  const nuaDau = await hoi(pageId, { [key]: token, since, until: giua, page_size: 50, order_by: "updated_at" });
  const nuaSau = await hoi(pageId, { [key]: token, since: giua, until, page_size: 50, order_by: "updated_at" });
  if (nuaDau.loi || nuaSau.loi) {
    console.log(`  CHƯA ĐO ĐƯỢC · ${nuaDau.loi || nuaSau.loi}`);
  } else {
    const tapDau = new Set(nuaDau.ids);
    const chongLan = nuaSau.ids.filter((id) => tapDau.has(id)).length;
    const hop = new Set([...nuaDau.ids, ...nuaSau.ids]);
    const tapGoc = new Set(goc.ids);
    const gocKhongCoTrongHop = [...tapGoc].filter((id) => !hop.has(id)).length;
    console.log(`  nửa ĐẦU ${nuaDau.soDong} · nửa SAU ${nuaSau.soDong} · chồng lấn ${chongLan} · hợp ${hop.size}`);
    console.log(`  cửa sổ lớn ${tapGoc.size} mã · trong đó KHÔNG nằm trong hợp hai nửa: ${gocKhongCoTrongHop}`);
    if (chongLan === 0 && hop.size > tapGoc.size) {
      console.log("  ✓ cắt cửa sổ LÀ một đường lấy thêm dữ liệu: hai lát rời nhau và cộng lại NHIỀU HƠN cửa sổ lớn");
      console.log("    ⇒ cửa sổ lớn ĐANG BỊ CẮT BỚT, và cắt nhỏ lấy lại được phần bị cắt.");
    } else if (chongLan === 0 && hop.size === tapGoc.size) {
      console.log("  ✓ hai lát rời nhau và cộng lại ĐÚNG BẰNG cửa sổ lớn ⇒ cửa sổ lớn chưa chạm trần.");
    } else if (chongLan > 0) {
      console.log("  ⚠ hai lát CHỒNG LẤN — `since`/`until` không cắt sạch theo mốc, đường lùi phải chống trùng bằng mã.");
    }
    if (gocKhongCoTrongHop > 0) {
      console.log(`  ⚠ ${gocKhongCoTrongHop} mã có trong cửa sổ lớn nhưng KHÔNG có trong hai nửa — cắt nhỏ SÓT dữ liệu.`);
    }
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  console.log(`  đã gọi ${soLoiGoi} lượt GET, không một lời gọi GHI nào.`);
  if (thang.length) {
    console.log(`  ✓ THAM SỐ PHÂN TRANG THẬT: ${thang.join(", ")}`);
    console.log("    Sửa `PancakePagesClient.listConversations` sang khoá này, rồi bỏ điều kiện dừng tạm thời.");
  } else {
    console.log("  ✗ KHÔNG tham số nào trong sáu tham số ĐO ĐƯỢC dịch được cửa sổ.");
    console.log("    Đây KHÔNG phải kết luận 'API không phân trang được' — chỉ là sáu tên này không phải.");
    console.log("    Đường lùi: đồng bộ tăng dần theo CỬA SỔ THỜI GIAN (xem khối 2), chống trùng bằng mã hội thoại.");
  }
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
