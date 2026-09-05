/**
 * Dò xem API Pancake có trả lịch sử mua hàng theo SĐT trên toàn hệ thống (số GTC / hoàn như Pancake hiển thị cạnh SĐT) không.
 * In mã HTTP + các khoá / đoạn đầu phản hồi, KHÔNG in api_key / token.
 *   npx tsx scripts/phone-probe.ts 0788281828
 */
import "dotenv/config";
import { env } from "@/lib/env";

const phone = (process.argv[2] ?? "").replace(/\D/g, "");
const key = env.pancake.apiKey;
const shop = env.pancake.shopId;
const base = env.pancake.baseUrl.replace(/\/$/, "");
const token = env.pancake.pagesAccessToken;

const mask = (t: string) => t.replace(new RegExp(key, "g"), "***").replace(token ? new RegExp(token, "g") : /$^/, "***");

async function probe(name: string, url: string) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const text = mask(await res.text());
    let keys = "";
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const first = Array.isArray(j.data) ? (j.data[0] as Record<string, unknown> | undefined) : Array.isArray(j.customers) ? (j.customers[0] as Record<string, unknown> | undefined) : null;
      keys = `keys=${Object.keys(j).join(",")}${first ? ` · item=${Object.keys(first).join(",")}` : ""}`;
    } catch {
      keys = "";
    }
    console.log(`- ${name}: HTTP ${res.status} · ${keys || text.slice(0, 200).replace(/\s+/g, " ")}`);
    const hit = /(succeed|success|returned|return_count|bomb|warning|black|reputation|history|total_order|delivered)/i.exec(text);
    if (hit && res.ok) console.log(`    → có từ khoá "${hit[1]}": ${text.slice(Math.max(0, (hit.index ?? 0) - 120), (hit.index ?? 0) + 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`- ${name}: lỗi ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  if (!phone) throw new Error("Nhập SĐT: npx tsx scripts/phone-probe.ts 09xxxxxxxx");
  if (!key) throw new Error("Chưa có PANCAKE_API_KEY");
  const q = `api_key=${key}`;
  const c = [
    ["customers?search", `${base}/shops/${shop}/customers?${q}&page_size=2&search=${phone}`],
    ["customers?phone_number", `${base}/shops/${shop}/customers?${q}&page_size=2&phone_number=${phone}`],
    ["customers/check_phone", `${base}/shops/${shop}/customers/check_phone?${q}&phone_number=${phone}`],
    ["customers/phone_info", `${base}/shops/${shop}/customers/phone_info?${q}&phone_number=${phone}`],
    ["customers/phone/<sđt>", `${base}/shops/${shop}/customers/phone/${phone}?${q}`],
    ["customers/<sđt>", `${base}/shops/${shop}/customers/${phone}?${q}`],
    ["customers/<sđt>/statistics", `${base}/shops/${shop}/customers/${phone}/statistics?${q}`],
    ["customers/<sđt>/orders", `${base}/shops/${shop}/customers/${phone}/orders?${q}`],
    ["orders?search (shop)", `${base}/shops/${shop}/orders?${q}&page_size=1&search=${phone}`],
    ["orders/check_phone", `${base}/shops/${shop}/orders/check_phone?${q}&phone_number=${phone}`],
    ["phone_numbers/<sđt>", `${base}/shops/${shop}/phone_numbers/${phone}?${q}`],
    ["check_phone (root)", `${base}/check_phone?${q}&phone_number=${phone}&shop_id=${shop}`],
    ["customers/stats", `${base}/shops/${shop}/customers/stats?${q}&phone_number=${phone}`],
    ["customer_histories", `${base}/shops/${shop}/customer_histories?${q}&phone_number=${phone}`],
    ["blacklist", `${base}/shops/${shop}/blacklist?${q}&phone_number=${phone}`],
  ] as const;
  for (const [name, url] of c) await probe(name, url);
  if (token) {
    console.log("Pages API (chat):");
    await probe("pages", `https://pages.fm/api/public_api/v1/pages?access_token=${token}`);
    await probe("conversations?search phone (page đầu)", `https://pages.fm/api/public_api/v1/pages?access_token=${token}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
