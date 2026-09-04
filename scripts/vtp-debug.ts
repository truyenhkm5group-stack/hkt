/**
 * In phản hồi thô của API Viettel Post để chẩn đoán tích hợp (che token).
 *   npm run vtp:debug -- <mã vận đơn>
 */
import "dotenv/config";
import { ViettelPostClient } from "@/lib/integrations/viettelpost/client";

function show(label: string, value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`\n### ${label}\n${text.length > 6000 ? `${text.slice(0, 6000)} …(${text.length} ký tự)` : text}`);
}

async function main() {
  const orderNumber = process.argv[2] ?? "";
  const client = new ViettelPostClient();
  const token = await client.getToken(true);
  console.log(`Token: ${token.slice(0, 12)}… (${token.length} ký tự)`);
  const tries: [string, () => Promise<unknown>][] = [
    ["user/info", () => client.debugCall("user/info", { token })],
    ["order/getOrderDetailV3 GET ?OrderNumber", () => client.debugCall("order/getOrderDetailV3", { token, query: { OrderNumber: orderNumber } })],
    ["order/getOrderDetailV3 POST {ORDER_NUMBER}", () => client.debugCall("order/getOrderDetailV3", { token, method: "POST", body: { ORDER_NUMBER: orderNumber } })],
    ["order/getOrderDetail POST", () => client.debugCall("order/getOrderDetail", { token, method: "POST", body: { ORDER_NUMBER: orderNumber } })],
    ["order/getOrderDetailV2 GET", () => client.debugCall("order/getOrderDetailV2", { token, query: { OrderNumber: orderNumber } })],
    ["order/order-filter POST page=1 (7 ngày)", () => {
      const fmt = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86_400_000);
      return client.debugCall("order/order-filter", { token, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmt(from), to_date: fmt(to), list_inventory: [], list_status: [] } });
    }],
    ["order/listOrder GET (7 ngày)", () => client.debugCall("order/listOrder", { token, query: { page: 1, size: 5 } })],
    ["order/list-data-push-his", () => client.debugCall("order/list-data-push-his", { token, query: { orderNumber } })],
  ];
  for (const [label, fn] of tries) {
    try {
      show(label, await fn());
    } catch (error) {
      show(label, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
