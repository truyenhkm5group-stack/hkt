/**
 * Dò các API liệt kê vận đơn của Viettel Post (đối tác v2 và cổng khách hàng viettelpost.vn) bằng token hiện có,
 * để tìm endpoint trả về các vận đơn tạo qua Pancake. In mã HTTP / status + đoạn đầu phản hồi, KHÔNG in token / mật khẩu.
 *   npx tsx scripts/vtp-probe.ts [mã vận đơn]
 */
import "dotenv/config";
import { env } from "@/lib/env";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";

const orderNumber = process.argv[2] || "PKE1508909088";
const fmtVN = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
const fmtISO = (d: Date) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(Date.now() - 30 * 86_400_000);

function mask(t: string, secrets: string[]) {
  let out = t;
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out;
}

async function main() {
  const client = getViettelPostClient();
  const token = await client.getToken();
  const secrets = [token, env.viettelPost.apiKey ?? "", env.viettelPost.password ?? ""].filter(Boolean) as string[];
  const show = (label: string, v: unknown) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    console.log(`- ${label}: ${mask(text, secrets).slice(0, 420).replace(/\s+/g, " ")}`);
  };
  const tries: [string, () => Promise<unknown>][] = [
    ["order-filter body VN 30 ngày + list_status all", () => client.debugCall("order/order-filter", { token, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmtVN(from), to_date: fmtVN(to), list_inventory: [], list_status: [] } })],
    ["order-filter body ISO", () => client.debugCall("order/order-filter", { token, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmtISO(from), to_date: fmtISO(to), list_inventory: [], list_status: [] } })],
    ["order-filter UPPER keys", () => client.debugCall("order/order-filter", { token, method: "POST", body: { FILTER: "", FROM_DATE: fmtVN(from), TO_DATE: fmtVN(to), LIST_INVENTORY: [], LIST_STATUS: [], PAGE: 1, PAGE_SIZE: 20 } })],
    ["order-filter filter=mã vận đơn", () => client.debugCall("order/order-filter", { token, method: "POST", query: { page: 1 }, body: { filter: orderNumber, from_date: fmtVN(new Date(Date.now() - 90 * 86_400_000)), to_date: fmtVN(to), list_inventory: [], list_status: [] } })],
    ["order/listOrder POST {page,size}", () => client.debugCall("order/listOrder", { token, method: "POST", body: { page: 1, size: 20 } })],
    ["order/listOrder POST {PAGE_INDEX,PAGE_SIZE,FROM_DATE,TO_DATE}", () => client.debugCall("order/listOrder", { token, method: "POST", body: { PAGE_INDEX: 1, PAGE_SIZE: 20, FROM_DATE: fmtVN(from), TO_DATE: fmtVN(to) } })],
    ["order/getListOrder POST", () => client.debugCall("order/getListOrder", { token, method: "POST", body: { PAGE_INDEX: 1, PAGE_SIZE: 20, FROM_DATE: fmtVN(from), TO_DATE: fmtVN(to) } })],
    ["order/getListOrder GET", () => client.debugCall("order/getListOrder", { token, query: { page: 1, size: 20, fromDate: fmtVN(from), toDate: fmtVN(to) } })],
    ["order/list POST", () => client.debugCall("order/list", { token, method: "POST", body: { page: 1, size: 20, fromDate: fmtVN(from), toDate: fmtVN(to) } })],
    ["order/order-list POST", () => client.debugCall("order/order-list", { token, method: "POST", body: { page: 1, size: 20 } })],
    ["order/getOrderList POST", () => client.debugCall("order/getOrderList", { token, method: "POST", body: { PAGE: 1, PAGE_SIZE: 20, FROM_DATE: fmtVN(from), TO_DATE: fmtVN(to) } })],
    ["order/search POST", () => client.debugCall("order/search", { token, method: "POST", body: { keyword: orderNumber } })],
    ["order/getOrderByToken GET", () => client.debugCall("order/getOrderByToken", { token, query: { orderNumber } })],
    ["order/order-report POST", () => client.debugCall("order/order-report", { token, method: "POST", body: { from_date: fmtVN(from), to_date: fmtVN(to) } })],
    ["order/statistical POST", () => client.debugCall("order/statistical", { token, method: "POST", body: { from_date: fmtVN(from), to_date: fmtVN(to) } })],
    ["order/order-filter-v2 POST", () => client.debugCall("order/order-filter-v2", { token, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmtVN(from), to_date: fmtVN(to), list_inventory: [], list_status: [] } })],
    ["user/info", () => client.debugCall("user/info", { token })],
    ["user/getInfoUser", () => client.debugCall("user/getInfoUser", { token })],
    ["user/listInventory count", async () => ({ count: ((await client.debugCall("user/listInventory", { token })).data as unknown[])?.length })],
  ];
  for (const [label, fn] of tries) {
    try {
      show(label, await fn());
    } catch (e) {
      show(label, `lỗi ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }
  // Cổng khách hàng viettelpost.vn (web) — thử vài host / đường dẫn với cùng token
  const webTries: [string, string, RequestInit][] = [
    ["web api order-filter", "https://viettelpost.vn/api/v2/order/order-filter?page=1", { method: "POST", body: JSON.stringify({ filter: "", from_date: fmtVN(from), to_date: fmtVN(to), list_inventory: [], list_status: [] }) }],
    ["api.viettelpost.vn v2 order-filter", "https://api.viettelpost.vn/v2/order/order-filter?page=1", { method: "POST", body: JSON.stringify({ filter: "", from_date: fmtVN(from), to_date: fmtVN(to), list_inventory: [], list_status: [] }) }],
    ["partner v2 getOrderDetailV3 (đối chiếu)", `https://partner.viettelpost.vn/v2/order/getOrderDetailV3?OrderNumber=${orderNumber}`, { method: "GET" }],
    ["partner v2 categories/listProvince (sanity)", "https://partner.viettelpost.vn/v2/categories/listProvince", { method: "GET" }],
  ];
  for (const [label, url, init] of webTries) {
    try {
      const res = await fetch(url, { ...init, headers: { "content-type": "application/json", accept: "application/json", Token: token }, signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      show(`${label} HTTP ${res.status}`, text.slice(0, 300));
    } catch (e) {
      show(label, `lỗi ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
