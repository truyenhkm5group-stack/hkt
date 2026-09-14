/**
 * KIỂM KÊ TÍN HIỆU PANCAKE — CHỈ ĐỌC, CHỈ GỌI GET.
 *
 * Vì sao cần: `PancakePagesClient` chỉ giữ lại bảy trường của mỗi tin nhắn (id · chữ · người gửi ·
 * mốc thời gian · cờ có đính kèm) và `toNormalizedMessage` ghi `raw: {}`. Mọi thứ khác Pancake trả
 * về đều bị vứt NGAY tại tầng ánh xạ, nên không thể kiểm kê từ CSDL bản chạy thử — dữ liệu chưa
 * bao giờ được lưu. Phải hỏi thẳng API.
 *
 * Bài này KHÔNG đoán trường nào tồn tại. Nó đọc phản hồi thật rồi liệt kê ĐƯỜNG DẪN KHOÁ có mặt,
 * kiểu dữ liệu, và tỷ lệ có giá trị. Sau đó mới quyết định Product Resolver dựa được vào đâu.
 *
 * QUYỀN RIÊNG TƯ: log của GitHub Actions là CÔNG KHAI. Bài này in TÊN KHOÁ, không in giá trị —
 * trừ một danh sách cho phép hẹp gồm các khoá thuộc về SHOP (post/ad/product/sku/…), và kể cả
 * chúng cũng bị cắt còn 24 ký tự. Không khoá nào chứa tên / SĐT / địa chỉ / nội dung tin được in.
 */
import "dotenv/config";
import { fetchJson, asArray, asRecord, str } from "@/lib/integrations/http";

const BASE = process.env.PANCAKE_PAGES_BASE_URL || "https://pages.fm/api/v1";
const TOKEN = process.env.PANCAKE_ACCESS_TOKEN || "";
const PAGE = process.env.PANCAKE_PAGE_ID || "";

/** Khoá được phép in mẫu: dữ liệu của SHOP, không phải của khách. */
const CHO_PHEP = /(^|[._[])(post|ad|adset|campaign|product|sku|code|type|source|ref|referral|platform|tag|category|variant|order|cart|is_[a-z_]+|has_[a-z_]+)(_id|_ids)?($|[._[])/i;
const CAM = /(phone|name|address|email|avatar|message|text|snippet|note|content|title|description|url|link|token|secret|customer|thumb|image|picture|body)/i;

type Stat = { kieu: Set<string>; gap: number; coGiaTri: number; mau: Set<string> };
const stats = new Map<string, Stat>();

function ghi(duong: string, gia: unknown) {
  let s = stats.get(duong);
  if (!s) { s = { kieu: new Set(), gap: 0, coGiaTri: 0, mau: new Set() }; stats.set(duong, s); }
  s.gap += 1;
  const rong = gia === null || gia === undefined || gia === "" || (Array.isArray(gia) && !gia.length);
  if (!rong) s.coGiaTri += 1;
  s.kieu.add(Array.isArray(gia) ? "mảng" : gia === null ? "null" : typeof gia);
  if (!rong && s.mau.size < 2 && CHO_PHEP.test(duong) && !CAM.test(duong)) {
    const t = typeof gia === "object" ? JSON.stringify(gia) : String(gia);
    s.mau.add(t.slice(0, 24));
  }
}

function di(gia: unknown, duong: string, sau = 0) {
  if (sau > 5) return;
  ghi(duong, gia);
  if (Array.isArray(gia)) {
    for (const x of gia.slice(0, 3)) di(x, `${duong}[]`, sau + 1);
    return;
  }
  if (gia && typeof gia === "object") {
    for (const [k, v] of Object.entries(gia as Record<string, unknown>)) di(v, duong ? `${duong}.${k}` : k, sau + 1);
  }
}

async function get(path: string, query: Record<string, string | number>) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const { body } = await fetchJson(url, { method: "GET", headers: { accept: "*/*" }, serviceName: "Pancake Pages", timeoutMs: 30_000, retries: 1 });
  return asRecord(body);
}

function inBang(tieuDe: string, loc: (d: string) => boolean, tongMau: number) {
  console.log(`\n───────── ${tieuDe} ─────────`);
  const hang = [...stats.entries()].filter(([d]) => loc(d) && d.split(".").length <= 4).sort();
  for (const [duong, s] of hang) {
    if (!duong) continue;
    const ty = s.gap ? Math.round((s.coGiaTri / s.gap) * 100) : 0;
    const mau = s.mau.size ? `  vd: ${[...s.mau].join(" · ")}` : "";
    console.log(`  ${duong.padEnd(46)} ${[...s.kieu].join("/").padEnd(10)} có giá trị ${String(s.coGiaTri).padStart(3)}/${String(s.gap).padEnd(3)} (${ty}%)${mau}`);
  }
  void tongMau;
}

async function main() {
  if (!TOKEN || !PAGE) { console.error("Thiếu PANCAKE_ACCESS_TOKEN hoặc PANCAKE_PAGE_ID"); process.exit(1); }
  const gio = Number(process.argv.find((a) => a.startsWith("--hours="))?.split("=")[1] ?? 24);
  const soHoiThoai = Number(process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 20);
  const until = Math.floor(Date.now() / 1000);
  const since = until - gio * 3600;

  console.log(`Kiểm kê tín hiệu page ${PAGE} · ${gio} giờ · tối đa ${soHoiThoai} hội thoại · CHỈ GET`);

  const rec = await get(`pages/${PAGE}/conversations`, { access_token: TOKEN, since, until, page_number: 1, page_size: 50, order_by: "updated_at" });
  const list = asArray(rec.conversations ?? asRecord(rec.data).conversations ?? rec.data).map(asRecord);
  console.log(`Đọc được ${list.length} hội thoại.`);
  const mau = list.slice(0, soHoiThoai);
  for (const c of mau) di(c, "");
  inBang(`HỘI THOẠI — ${mau.length} mẫu`, () => true, mau.length);

  stats.clear();
  let soTin = 0;
  let coDinhKem = 0;
  for (const c of mau.slice(0, 10)) {
    const id = str(c.id, c.conversation_id);
    const kh = str(asRecord(asArray(c.customers)[0] ?? c.customer ?? c.from).id);
    if (!id) continue;
    try {
      const r = await get(`pages/${PAGE}/conversations/${id}/messages`, { access_token: TOKEN, customer_id: kh, current_count: 0, page_size: 30 });
      const tin = asArray(r.messages ?? asRecord(r.data).messages).map(asRecord);
      soTin += tin.length;
      for (const m of tin) {
        di(m, "");
        if (asArray(m.attachments).length) coDinhKem += 1;
      }
    } catch (e) {
      console.log(`  ⚠ hội thoại ${id.slice(0, 8)}…: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  inBang(`TIN NHẮN — ${soTin} mẫu (${coDinhKem} tin có đính kèm)`, () => true, soTin);
  console.log("\nXong. Không gọi một lệnh ghi nào.");
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });
