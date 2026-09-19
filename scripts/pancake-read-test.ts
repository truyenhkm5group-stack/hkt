/**
 * KIỂM TRA QUYỀN ĐỌC PANCAKE — CHỈ GỌI GET, KHÔNG MỘT LỜI GỌI GHI NÀO.
 *
 *   npx tsx scripts/pancake-read-test.ts --page=<PAGE_ID> [--hours=24] [--fb=<FACEBOOK_PAGE_ID>]
 *
 * Trả lời bằng dữ liệu thật chứ không bằng cấu hình:
 *   1. Token có dùng được không?
 *   2. Page có truy cập được không, TÊN là gì, và mã Facebook của nó là gì?
 *   3. Đọc được hội thoại không? PHÂN TRANG có đúng không?
 *   4. Đọc được tin nhắn không? Có mã trùng không? Thứ tự thời gian có thật không?
 *
 * ═══ VÌ SAO KHÔNG ĐOÁN TRƯỜNG NÀO LÀ MÃ FACEBOOK ═══
 *
 * Mã Pancake và mã Facebook của cùng một page là HAI SỐ KHÁC NHAU, và tài liệu không nói chắc
 * Pancake trả mã Facebook ở khoá nào. Nên tệp này IN RA mọi khoá trông như một mã định danh cùng
 * giá trị của chúng, rồi mới so với `--fb` nếu được truyền. Đoán một tên khoá rồi báo "không khớp"
 * là dựng ra một sự cố không có thật; in cả bộ ra thì người đọc thấy ngay sự thật.
 *
 * VÌ SAO TỰ GỌI `fetch` THAY VÌ DÙNG `PancakePagesClient`: client gọi `pageToken()`, và hàm ấy
 * POST tới `generate_page_access_token` khi chưa có page token. Đó là một lời gọi GHI (nó sinh ra
 * một chứng thư mới). Bài kiểm "chỉ đọc" mà tự sinh token thì không còn là bài kiểm chỉ đọc.
 *
 * Token KHÔNG BAO GIỜ được in. Nội dung tin nhắn của khách bị CHE — kho mã này PUBLIC và ảnh chụp
 * màn hình hay được dán sang chỗ khác.
 */
import "dotenv/config";
import { env } from "@/lib/env";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

/** Che nội dung: giữ độ dài và ba ký tự đầu, đủ để nhận ra kiểu dữ liệu mà không lộ câu chữ. */
function mask(value: unknown): string {
  if (typeof value !== "string") return String(value);
  return value.length <= 3 ? value : `${value.slice(0, 3)}…(${value.length} ký tự)`;
}

const BASE = env.pancake.pagesBaseUrl;

const nghi = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
  429 KHÔNG PHẢI MỘT CÂU TRẢ LỜI — VÀ ĐỌC NÓ NHƯ MỘT CÂU TRẢ LỜI LÀ CÁCH BÀI KIỂM TỰ NÓI DỐI.

  Lượt chạy 10:44 ngày 19/09/2026 bắn mười lời gọi liền nhau. Sáu lời gọi cuối nhận 429, và bản
  đầu của tệp này in chúng ra thành "tham số không được chấp nhận" — một kết luận về THAM SỐ rút
  ra từ một phản hồi về TẦN SUẤT. Sáu dòng sai ấy trông y như sáu phép đo thật.

  Nay: giãn nhịp giữa các lời gọi, thử lại có lùi dần khi gặp 429, và nếu vẫn 429 thì trả về đúng
  chữ "CHƯA ĐO ĐƯỢC" chứ không bao giờ trả về một phán quyết. AGENTS.md §5 đã ghi luật tôn trọng
  429 cho đường chạy thật; một bài kiểm phá luật ấy thì nó đo chính cái nó vừa gây ra.
*/
async function get(
  path: string,
  params: Record<string, string | number>,
  lanThu = 3,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let cuoi = { status: 0, body: {} as Record<string, unknown> };
  for (let i = 0; i < lanThu; i++) {
    if (i > 0) await nghi(1500 * 2 ** (i - 1));
    // `url` không bao giờ được in ra: nó chứa token ở query string.
    const res = await fetch(url, { method: "GET", headers: { accept: "*/*" } });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    cuoi = { status: res.status, body };
    if (res.status !== 429) return cuoi;
  }
  return cuoi;
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

/*
  SỔ PHÁT HIỆN — mã thoát quyết ở CUỐI, không ở chỗ phát hiện đầu tiên.

  Lượt chạy 19/09/2026 thoát ngay tại khối phân trang, nên năm khối sau nó (tin nhắn, mã trùng,
  thứ tự thời gian, đính kèm, danh tính người gửi) KHÔNG chạy. Một bài kiểm dừng ở phát hiện đầu
  tiên buộc người đọc phải sửa xong cái thứ nhất mới biết còn cái thứ hai hay không — và với một
  bài kiểm gọi API thật, mỗi lượt như thế tốn một vòng triển khai. Chạy hết, rồi mới kết luận.

  Vẫn còn lối THOÁT SỚM, nhưng chỉ cho những thứ làm mọi khối sau mất nghĩa: không có chứng thư,
  không có mã page, không liệt kê được page, không đọc nổi một hội thoại nào.
*/
const PHAT_HIEN: string[] = [];
function ghiLoi(cau: string) {
  PHAT_HIEN.push(cau);
  console.error(`  ✗ ${cau}`);
}

async function main() {
  const pageId = arg("page") || env.pancake.pageId;
  const hours = Number(arg("hours")) || 24;
  /** Mã Facebook KỲ VỌNG. Không truyền thì chỉ in ra mã đọc được, không kết luận khớp/lệch. */
  const fbMong = arg("fb");

  // Ưu tiên token của CHÍNH page (phạm vi hẹp hơn); không có thì dùng token người dùng.
  const pageToken = env.pancake.pageAccessToken;
  const userToken = env.pancake.pagesAccessToken;
  const key = pageToken ? "page_access_token" : "access_token";
  const token = pageToken || userToken;

  console.log("───────── CHỨNG THƯ ĐANG DÙNG ─────────");
  console.log(`  Loại               : ${pageToken ? "token của MỘT page (phạm vi hẹp)" : "token người dùng (mở mọi page)"}`);
  console.log(`  Độ dài             : ${token ? token.length : 0} ký tự`);
  console.log(`  Page cần đọc       : ${pageId || "(chưa khai)"}`);
  if (!token) {
    console.error("\n✗ DỪNG: chưa có PANCAKE_PAGE_ACCESS_TOKEN lẫn PANCAKE_ACCESS_TOKEN.");
    process.exit(1);
  }
  if (!pageId) {
    console.error("\n✗ DỪNG: chưa khai PANCAKE_PAGE_ID.");
    process.exit(1);
  }

  // ── 1. PAGE CÓ TRUY CẬP ĐƯỢC KHÔNG, TÊN GÌ ──
  // Chỉ hỏi được khi cầm token người dùng; token của một page không liệt kê page nào.
  console.log("\n───────── 1. PAGE ─────────");
  let pageName = "";
  if (userToken) {
    const { status, body } = await get("pages", { access_token: userToken });
    if (status >= 400) {
      console.error(`  ✗ GET /pages trả HTTP ${status} — token người dùng không dùng được.`);
      process.exit(1);
    }
    const categorized = (body.categorized ?? {}) as Record<string, unknown>;
    const pages = [...arr(categorized.activated), ...arr(body.pages), ...arr(body.data)];
    const found = pages.find((p) => String(p.id) === pageId);
    console.log(`  Tài khoản thấy     : ${pages.length} page`);
    if (!found) {
      console.error(`  ✗ Page ${pageId} KHÔNG nằm trong danh sách page của tài khoản này.`);
      console.error("    Kiểm lại mã page, hoặc token thuộc một tài khoản khác.");
      process.exit(1);
    }
    pageName = String(found.name ?? "");
    console.log(`  ✓ Tìm thấy page    : ${pageId}`);
    console.log(`    Tên              : ${pageName || "(Pancake không trả tên)"}`);
    console.log(`    Nền tảng         : ${String(found.platform ?? "(không khai)")}`);

    /*
      MÃ FACEBOOK: IN RA MỌI KHOÁ TRÔNG NHƯ MỘT MÃ, KHÔNG ĐOÁN MỘT TÊN KHOÁ.

      Mã Pancake và mã Facebook của cùng một page là hai số khác nhau, và tài liệu không nói chắc
      Pancake trả mã Facebook ở khoá nào. Đoán một tên khoá rồi báo "không khớp" là dựng ra một sự
      cố không có thật. In cả bộ khoá ra thì sự thật tự lộ, và lần sau không ai phải đoán nữa.
    */
    console.log("    ── mọi khoá trông như một mã định danh ──");
    const maKhoa = Object.entries(found)
      .filter(([k, v]) => /(^|_)(id|uid|fb|facebook|page)/i.test(k) && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => [k, String(v)] as const);
    if (maKhoa.length === 0) console.log("      (không khoá nào)");
    for (const [k, v] of maKhoa) console.log(`      ${k.padEnd(22)} = ${v}`);

    if (fbMong) {
      const khop = maKhoa.filter(([, v]) => v === fbMong);
      if (khop.length) {
        console.log(`    ✓ Mã Facebook ${fbMong} KHỚP ở khoá: ${khop.map(([k]) => k).join(", ")}`);
      } else {
        // KHÔNG thoát khác 0: đây là một phát hiện phải đọc, không phải một lỗi kết nối. Quyền đọc
        // vẫn đạt; thứ cần xem lại là bản đồ mã page mà tài liệu cũ đang ghi.
        console.log(`    ⚠ Mã Facebook ${fbMong} KHÔNG khớp khoá nào ở trên.`);
        console.log("      Quyền đọc VẪN đạt — nhưng bản đồ mã page trong tài liệu cần kiểm lại.");
      }
    } else {
      console.log("    (chưa truyền --fb=<mã> nên không kết luận khớp/lệch)");
    }
  } else {
    console.log("  (chỉ có token của một page — không liệt kê được page, sẽ kiểm bằng đường đọc hội thoại)");
  }

  // ── 2. ĐỌC HỘI THOẠI ──
  console.log("\n───────── 2. HỘI THOẠI ─────────");
  const until = Math.floor(Date.now() / 1000);
  const since = until - hours * 3600;
  const conv = await get(`pages/${pageId}/conversations`, {
    [key]: token,
    since,
    until,
    page_number: 1,
    page_size: 20,
    order_by: "updated_at",
  });
  if (conv.status >= 400) {
    console.error(`  ✗ HTTP ${conv.status} — không đọc được hội thoại của page này.`);
    const why = conv.body.message ?? conv.body.error ?? conv.body.reason;
    if (why) console.error(`    Pancake nói: ${String(why)}`);
    process.exit(1);
  }
  const conversations = arr(conv.body.conversations ?? (conv.body.data as Record<string, unknown>)?.conversations ?? conv.body.data);
  console.log(`  ✓ Đọc được         : ${conversations.length} hội thoại trong ${hours} giờ qua`);
  for (const c of conversations.slice(0, 5)) {
    const customer = arr(c.customers)[0] ?? {};
    console.log(`    ${String(c.id)} · khách ${mask(String(customer.name ?? ""))} · cập nhật ${String(c.updated_at ?? "?")}`);
  }
  if (!conversations.length) {
    console.log("\n  ⚠ Không có hội thoại nào trong cửa sổ này. Quyền đọc VẪN đạt (API trả 200),");
    console.log("    nhưng lượt nạp sẽ không có gì để nạp — nới cửa sổ thời gian hoặc chọn page khác.");
    process.exit(0);
  }

  /*
    ── 2b. PHÂN TRANG CÓ THẬT SỰ SANG TRANG KHÔNG ──

    Một API trả HTTP 200 cho mọi `page_number` mà luôn đưa lại TRANG MỘT là dạng hỏng tệ nhất có
    thể có ở đây: lượt nạp chạy hai mươi vòng, mỗi vòng thấy "có dữ liệu", và không bao giờ đi quá
    năm mươi hội thoại đầu. Không lỗi, không cảnh báo, chỉ là phần còn lại của page không bao giờ
    tới. Nên phải so MÃ HỘI THOẠI của hai trang, không so số lượng.
  */
  console.log("\n───────── 2b. PHÂN TRANG ─────────");
  const trang2 = await get(`pages/${pageId}/conversations`, {
    [key]: token, since, until, page_number: 2, page_size: 20, order_by: "updated_at",
  });
  if (trang2.status >= 400) {
    console.log(`  ⚠ trang 2 trả HTTP ${trang2.status} — không kiểm được phân trang.`);
  } else {
    const ds2 = arr(trang2.body.conversations ?? (trang2.body.data as Record<string, unknown>)?.conversations ?? trang2.body.data);
    const id1 = new Set(conversations.map((c) => String(c.id)));
    const trung = ds2.filter((c) => id1.has(String(c.id))).length;
    console.log(`  trang 1: ${conversations.length} · trang 2: ${ds2.length} · TRÙNG mã: ${trung}`);
    if (ds2.length === 0) {
      console.log("  ✓ trang 2 rỗng — page này ít hội thoại hơn một trang, phân trang không kết luận được.");
    } else if (trung === ds2.length) {
      ghiLoi("TRANG 2 LẶP LẠI TRANG 1 — phân trang KHÔNG chạy. Lượt nạp sẽ không bao giờ đi quá trang đầu.");
    } else if (trung > 0) {
      // Chồng lấn một phần là BÌNH THƯỜNG khi sắp theo `updated_at`: hội thoại có tin mới nhảy
      // trang giữa hai lời gọi. Đường nạp chống trùng bằng mã tin nên nó không đẻ ra bản sao.
      console.log(`  ✓ phân trang chạy (chồng lấn ${trung} — hợp lệ khi sắp theo updated_at)`);
    } else {
      console.log("  ✓ phân trang chạy, hai trang không trùng mã nào.");
    }
  }

  /*
    ── 2c. `page_size` CÓ ĐƯỢC TÔN TRỌNG KHÔNG, VÀ 60 LÀ TRẦN HAY LÀ TOÀN BỘ? ──

    Hai câu hỏi này quyết định phân trang hỏng có TỐN DỮ LIỆU hay không, và không câu nào suy ra
    được từ câu kia:

      · Xin 20 mà nhận 60 ⇒ tham số bị BỎ QUA. Lượt nạp xin 50 cũng sẽ nhận 60, tức điều kiện dừng
        `list.length < 50` không bao giờ đúng ⇒ nó chạy đủ hai mươi vòng, mỗi vòng nhận lại y
        nguyên trang một. Hai mươi lời gọi cho một trang dữ liệu, và hạn mức Pancake phải gánh.
      · Nới cửa sổ thời gian mà số hội thoại KHÔNG đổi ⇒ 60 là TRẦN CỨNG, và phần vượt trần không
        có đường nào lấy được bằng bộ tham số hiện tại ⇒ MẤT DỮ LIỆU THẬT.
      · Nới cửa sổ mà số hội thoại TĂNG ⇒ máy chủ trả trọn cửa sổ trong một lần, phân trang chỉ là
        thừa chứ không làm mất gì. Cùng một triệu chứng, hai hậu quả khác hẳn nhau.

    Không có phép đo này thì "phân trang hỏng" là một câu báo động chưa biết nặng nhẹ ra sao.
  */
  console.log("\n───────── 2c. TRẦN DỮ LIỆU ─────────");
  console.log(`  xin page_size=20   : nhận ${conversations.length}${conversations.length !== 20 ? "  ⚠ Pancake BỎ QUA page_size" : ""}`);
  const cuaSo = [1, hours, 24 * 30];
  const demTheoCuaSo: { gio: number; n: number }[] = [];
  for (const gio of cuaSo) {
    await nghi(1200);
    const r = await get(`pages/${pageId}/conversations`, {
      [key]: token, since: until - gio * 3600, until, page_number: 1, page_size: 20, order_by: "updated_at",
    });
    const n = r.status >= 400 ? -1 : arr(r.body.conversations ?? (r.body.data as Record<string, unknown>)?.conversations ?? r.body.data).length;
    demTheoCuaSo.push({ gio, n });
    const vi = r.status === 429 ? "CHƯA ĐO ĐƯỢC (429 — bị giới hạn tần suất)" : n < 0 ? `CHƯA ĐO ĐƯỢC (HTTP ${r.status})` : `${n} hội thoại`;
    console.log(`  cửa sổ ${String(gio).padStart(4)} giờ  : ${vi}`);
  }
  /*
    KẾT LUẬN "TRẦN CỨNG" ĐÒI MỌI CỬA SỔ ĐỀU ĐO ĐƯỢC.

    Cửa sổ RỘNG NHẤT chính là cửa sổ duy nhất có thể bác bỏ giả thuyết trần — nó là phép đo mang
    thông tin nhất, nên cũng là phép đo mà việc mất nó gây hại nhất. Hai cửa sổ hẹp cùng ra 60
    KHÔNG chứng minh được gì: 60 hội thoại có tin mới trong một giờ là chuyện có thật với một page
    đang chạy quảng cáo. Thiếu một phép đo thì câu trả lời đúng là CHƯA BIẾT, không phải con số
    còn lại (AGENTS.md mục 8.5).
  */
  const doDuoc = demTheoCuaSo.filter((x) => x.n >= 0);
  const thieu = demTheoCuaSo.length - doDuoc.length;
  const max = Math.max(...doDuoc.map((x) => x.n), 0);
  const min = Math.min(...doDuoc.map((x) => x.n), Number.POSITIVE_INFINITY);
  if (max > min) {
    console.log(`  ✓ cửa sổ có tác dụng (${min} → ${max}) — máy chủ trả theo khoảng thời gian, không kẹt ở một trần cố định.`);
  } else if (thieu > 0) {
    console.log(`  ⚠ CHƯA KẾT LUẬN ĐƯỢC: ${thieu}/${demTheoCuaSo.length} cửa sổ không đo được (429). Cửa sổ rộng nhất là cửa sổ`);
    console.log("    duy nhất bác bỏ được giả thuyết trần, nên mất nó là mất cả phép đo. Chạy lại khi hết giới hạn.");
  } else if (doDuoc.length >= 2 && max === min && max > 0) {
    ghiLoi(`MỌI CỬA SỔ (kể cả ${Math.max(...cuaSo)} giờ) ĐỀU TRẢ ĐÚNG ${max} — ${max} là TRẦN CỨNG. Phần vượt trần KHÔNG có đường lấy.`);
  }

  /*
    ── 2d. CÓ THAM SỐ NÀO THẬT SỰ SANG TRANG KHÔNG? ──

    `page_number` bị bỏ qua không có nghĩa là API không phân trang được — có thể nó đặt tên khoá
    khác. Dò từng tên, CHỈ GỌI GET, và so MÃ HỘI THOẠI ĐẦU TIÊN: khoá nào làm đổi mã đầu tiên thì
    khoá ấy đang thật sự dịch cửa sổ. Không dò thì bản vá sẽ là đoán, và đoán sai một tên tham số
    thì lượt nạp vẫn đọc lại trang một — y như hôm nay, chỉ khác là lần này có người tin nó đã sửa.
  */
  console.log("\n───────── 2d. DÒ TÊN THAM SỐ PHÂN TRANG ─────────");
  const maDau = String(conversations[0]?.id ?? "");
  const maCuoi = String(conversations[conversations.length - 1]?.id ?? "");
  const ungVien: Record<string, string | number>[] = [
    { page: 2 },
    { offset: conversations.length },
    { skip: conversations.length },
    { current_count: conversations.length },
    { last_conversation_id: maCuoi },
    { after: maCuoi },
  ];
  let daTimRa = "";
  let chuaDo = 0;
  for (const tham of ungVien) {
    const ten = Object.keys(tham)[0];
    await nghi(1200);
    const r = await get(`pages/${pageId}/conversations`, {
      [key]: token, since, until, page_size: 20, order_by: "updated_at", ...tham,
    });
    if (r.status === 429) {
      // KHÔNG nói gì về tham số: 429 là câu trả lời về TẦN SUẤT, không phải về tên khoá.
      console.log(`  ${ten.padEnd(22)} → CHƯA ĐO ĐƯỢC (429 — bị giới hạn tần suất, không nói gì về tham số này)`);
      chuaDo += 1;
      continue;
    }
    if (r.status >= 400) {
      console.log(`  ${ten.padEnd(22)} → HTTP ${r.status} — máy chủ TỪ CHỐI tham số này`);
      continue;
    }
    const ds = arr(r.body.conversations ?? (r.body.data as Record<string, unknown>)?.conversations ?? r.body.data);
    const doiTrang = ds.length > 0 && String(ds[0].id ?? "") !== maDau;
    console.log(`  ${ten.padEnd(22)} → ${ds.length} hội thoại · mã đầu ${doiTrang ? "ĐỔI ✓" : "y nguyên"}`);
    if (doiTrang && !daTimRa) daTimRa = ten;
  }
  if (daTimRa) {
    console.log(`  ⇒ \`${daTimRa}\` LÀ tham số phân trang thật. Sửa \`PancakePagesClient.listConversations\` sang khoá này.`);
  } else if (chuaDo === ungVien.length) {
    console.log(`  ⇒ CHƯA ĐO ĐƯỢC TÊN NÀO (cả ${chuaDo}/${ungVien.length} lượt đều 429). Khối này KHÔNG nói gì về phân trang.`);
  } else {
    console.log(`  ⇒ KHÔNG tên nào trong ${ungVien.length - chuaDo} tên ĐO ĐƯỢC dịch được cửa sổ${chuaDo ? ` (còn ${chuaDo} tên chưa đo được vì 429)` : ""}.`);
    console.log("    Mới chỉ kết luận NHỮNG TÊN ẤY không phải — KHÔNG kết luận API không phân trang được.");
  }

  // ── 3. ĐỌC TIN NHẮN ──
  console.log("\n───────── 3. TIN NHẮN ─────────");
  const first = conversations[0];
  const customerId = String(arr(first.customers)[0]?.id ?? (first.customer as Record<string, unknown>)?.id ?? "");
  // Tham số khớp ĐÚNG `PancakePagesClient.listMessages` (`current_count`, không phải `page_number`).
  // Bài kiểm gọi khác connector thì nó kiểm một đường mà lượt nạp đi một đường khác.
  const msg = await get(`pages/${pageId}/conversations/${String(first.id)}/messages`, {
    [key]: token,
    customer_id: customerId,
    current_count: 0,
    page_size: 10,
  });
  if (msg.status >= 400) {
    ghiLoi(`HTTP ${msg.status} — đọc được hội thoại nhưng KHÔNG đọc được tin nhắn.`);
    const why = msg.body.message ?? msg.body.error ?? msg.body.reason;
    if (why) console.error(`    Pancake nói: ${String(why)}`);
  }
  const messages = arr(msg.body.messages ?? (msg.body.data as Record<string, unknown>)?.messages ?? msg.body.data);
  console.log(`  ✓ Đọc được         : ${messages.length} tin trong hội thoại ${String(first.id)}`);
  for (const m of messages.slice(0, 5)) {
    const from = (m.from ?? {}) as Record<string, unknown>;
    const fromPage = String(from.id ?? "") === pageId;
    console.log(`    ${fromPage ? "SHOP " : "KHÁCH"} · ${String(m.inserted_at ?? "?")} · ${mask(String(m.message ?? ""))}`);
  }

  /* ── 3b. MÃ TRÙNG · THỨ TỰ THỜI GIAN · ĐÍNH KÈM · DANH TÍNH ── */
  console.log("\n───────── 3b. TÍNH TOÀN VẸN CỦA TIN NHẮN ─────────");
  const ids = messages.map((m) => String(m.id ?? m.message_id ?? ""));
  const rong = ids.filter((x) => !x).length;
  const trungMa = ids.length - new Set(ids.filter(Boolean)).size;
  console.log(`  tin đọc được       : ${messages.length}`);
  console.log(`  KHÔNG có mã        : ${rong}${rong ? "  ⚠ chống trùng dựa vào mã — tin không mã phải rơi về vân tay nội dung" : ""}`);
  console.log(`  mã TRÙNG nhau      : ${trungMa}${trungMa ? "  ⚠ cùng một tin xuất hiện hai lần trong MỘT lời gọi" : ""}`);

  // Mốc thời gian: API trả theo thứ tự nào là việc của nó, nhưng mọi tin PHẢI có mốc đọc được —
  // thiếu mốc thì không dựng lại được hội thoại theo trình tự, và cả phép chia lượt sụp đổ.
  const moc = messages.map((m) => Date.parse(String(m.inserted_at ?? m.created_time ?? m.created_at ?? "")));
  const khongMoc = moc.filter((t) => Number.isNaN(t)).length;
  const hopLe = moc.filter((t) => !Number.isNaN(t));
  const giam = hopLe.every((t, i) => i === 0 || hopLe[i - 1] >= t);
  const tang = hopLe.every((t, i) => i === 0 || hopLe[i - 1] <= t);
  console.log(`  thiếu mốc thời gian: ${khongMoc}${khongMoc ? "  ⚠" : ""}`);
  console.log(`  thứ tự API trả     : ${giam ? "mới → cũ" : tang ? "cũ → mới" : "KHÔNG theo thứ tự nào"}`);

  const coDinhKem = messages.filter((m) => arr(m.attachments).length > 0).length;
  const loaiDinhKem = new Set(messages.flatMap((m) => arr(m.attachments).map((a) => String(a.type ?? ""))).filter(Boolean));
  console.log(`  tin có đính kèm    : ${coDinhKem}${coDinhKem ? ` · loại: ${[...loaiDinhKem].join(", ") || "(không khai type)"}` : ""}`);
  const coMaQC = messages.filter((m) => arr(m.attachments).some((a) => a.ad_id)).length;
  console.log(`  tin kèm mã quảng cáo: ${coMaQC}  (tín hiệu sản phẩm DUY NHẤT có thật trong Pages API)`);

  // DANH TÍNH: ai gửi. Tin của shop mà chỉ có MỘT mã người gửi nghĩa là không phân biệt được
  // người với máy bằng danh tính — phải dựa vào phép nhận dạng câu mẫu ở lớp đọc.
  const nguoiGui = new Map<string, number>();
  for (const m of messages) {
    const from = (m.from ?? {}) as Record<string, unknown>;
    const k = `${String(from.id ?? "")}|${mask(String(from.name ?? ""))}`;
    nguoiGui.set(k, (nguoiGui.get(k) ?? 0) + 1);
  }
  console.log(`  số người gửi khác nhau: ${nguoiGui.size}`);
  for (const [k, n] of [...nguoiGui.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    const [id, ten] = k.split("|");
    const laPage = id === pageId;
    console.log(`    ${laPage ? "SHOP " : "KHÁCH"} · ${id || "(không mã)"} · ${ten || "(không tên)"} · ${n} tin`);
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  console.log(`  Page ${pageId}${pageName ? ` (${pageName})` : ""}: quyền ĐỌC đạt — hội thoại và tin nhắn đều lấy được.`);
  console.log("  Không một lời gọi GHI nào được thực hiện trong bài kiểm này.");
  if (PHAT_HIEN.length) {
    // QUYỀN ĐỌC ĐẠT và ĐƯỜNG NẠP ĐÚNG là hai câu khác nhau. Gộp chúng thành một chữ "hỏng" thì
    // người đọc đi kiểm lại token — đúng cái duy nhất đang tốt.
    console.log(`\n  NHƯNG còn ${PHAT_HIEN.length} phát hiện về ĐƯỜNG NẠP, không phải về quyền đọc:`);
    for (const c of PHAT_HIEN) console.log(`    · ${c}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
