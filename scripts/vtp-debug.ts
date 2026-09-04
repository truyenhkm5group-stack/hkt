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

  // Thử lọc theo từng kho gửi (mỗi mã khách hàng có thể là một kho riêng)
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 86_400_000);
  try {
    const inv = await client.debugCall("user/listInventory", { token });
    const list = Array.isArray(inv.data) ? inv.data : [];
    show("user/listInventory (rút gọn)", list.map((r) => ({ groupaddressId: (r as Record<string, unknown>).groupaddressId, cusId: (r as Record<string, unknown>).cusId, name: (r as Record<string, unknown>).name, phone: (r as Record<string, unknown>).phone })));
    const ids = list.map((r) => Number((r as Record<string, unknown>).groupaddressId)).filter((n) => Number.isFinite(n));
    const res = await client.debugCall("order/order-filter", { token, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmt(from), to_date: fmt(to), list_inventory: ids, list_status: [] } });
    show(`order/order-filter với ${ids.length} kho (14 ngày)`, res);
  } catch (error) {
    show("order-filter theo kho", { error: error instanceof Error ? error.message : String(error) });
  }

  // Thử cách đăng nhập bằng tài khoản đối tác (Login → ownerconnect) rồi tra cứu lại
  const { env } = await import("@/lib/env");
  if (env.viettelPost.username && env.viettelPost.password) {
    const credentials = { USERNAME: env.viettelPost.username, PASSWORD: env.viettelPost.password };
    try {
      const login = await client.debugCall("user/Login", { method: "POST", body: credentials });
      const t2 = String((login.data as Record<string, unknown>)?.token ?? "");
      show("user/Login", { status: login.status, error: login.error, message: login.message, tokenLength: t2.length, data: t2 ? { ...(login.data as Record<string, unknown>), token: "***" } : login.data });
      if (t2) {
        show("[Login] getOrderDetailV3", await client.debugCall("order/getOrderDetailV3", { token: t2, query: { OrderNumber: orderNumber } }));
        show("[Login] order-filter 14 ngày", await client.debugCall("order/order-filter", { token: t2, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmt(from), to_date: fmt(to), list_inventory: [], list_status: [] } }));
        const owner = await client.debugCall("user/ownerconnect", { method: "POST", body: credentials, token: t2 });
        const t3 = String((owner.data as Record<string, unknown>)?.token ?? "");
        show("user/ownerconnect", { status: owner.status, error: owner.error, message: owner.message, tokenLength: t3.length, data: t3 ? { ...(owner.data as Record<string, unknown>), token: "***" } : owner.data });
        if (t3) {
          show("[ownerconnect] getOrderDetailV3", await client.debugCall("order/getOrderDetailV3", { token: t3, query: { OrderNumber: orderNumber } }));
          show("[ownerconnect] order-filter 14 ngày", await client.debugCall("order/order-filter", { token: t3, method: "POST", query: { page: 1 }, body: { filter: "", from_date: fmt(from), to_date: fmt(to), list_inventory: [], list_status: [] } }));
          show("[ownerconnect] user/listInventory (rút gọn)", (Array.isArray((await client.debugCall("user/listInventory", { token: t3 })).data) ? ((await client.debugCall("user/listInventory", { token: t3 })).data as Record<string, unknown>[]) : []).map((r) => ({ groupaddressId: r.groupaddressId, cusId: r.cusId, name: r.name })));
        }
      }
    } catch (error) {
      show("Login/ownerconnect", { error: error instanceof Error ? error.message : String(error) });
    }
  } else {
    show("Login/ownerconnect", "bỏ qua: chưa cấu hình VIETTELPOST_USERNAME/PASSWORD");
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
