/**
 * Kiểm tra kết nối Pancake POS & Viettel Post bằng API key trong .env (không ghi vào DB).
 *   npm run check:integrations
 */
import "dotenv/config";
import { env } from "@/lib/env";
import { asRecord, str } from "@/lib/integrations/http";
import { PancakeClient } from "@/lib/integrations/pancake/client";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import { ViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { FacebookAdsClient } from "@/lib/integrations/facebook/client";
import { PancakePagesClient } from "@/lib/integrations/pancake/pages";

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => console.log(`  ✗ ${msg}`);
const info = (msg: string) => console.log(`    ${msg}`);

async function checkPancake() {
  console.log("\n▶ Pancake POS");
  if (!env.pancake.apiKey || !env.pancake.shopId) {
    bad("Chưa có PANCAKE_API_KEY / PANCAKE_SHOP_ID trong .env");
    return null;
  }
  const client = new PancakeClient();
  let vtpNumber: string | null = null;
  try {
    const shops = await client.getShops();
    const shop = shops.find((s) => str(s.id) === env.pancake.shopId);
    if (shop) ok(`API key hợp lệ · shop "${str(shop.name)}" (${env.pancake.shopId})`);
    else {
      bad(`API key hợp lệ nhưng không thấy shop ${env.pancake.shopId}. Các shop có quyền: ${shops.map((s) => `${str(s.name)} (${str(s.id)})`).join(", ") || "không có"}`);
    }
  } catch (error) {
    bad(`Không gọi được /shops: ${error instanceof Error ? error.message : String(error)}`);
    info("Kiểm tra lại API key (Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → API Key) và kết nối mạng.");
    return null;
  }
  try {
    const page = await client.listOrders({ pageSize: 5, pageNumber: 1 });
    ok(`Đọc được đơn hàng · tổng ${page.totalEntries} đơn, ${page.totalPages} trang`);
    for (const raw of page.data) {
      const mapped = mapOrder(raw);
      if (!mapped) continue;
      info(`#${mapped.systemId ?? mapped.id} · ${mapped.statusName} · ${mapped.billFullName} · ${mapped.totalPriceAfterDiscount.toLocaleString("vi-VN")}₫ · ${mapped.shipment ? `${mapped.shipment.carrier} ${mapped.shipment.vtpOrderNumber ?? mapped.shipment.trackingCode ?? ""}` : "chưa gửi ĐVVC"}`);
      if (!vtpNumber && mapped.shipment?.vtpOrderNumber) vtpNumber = mapped.shipment.vtpOrderNumber;
    }
  } catch (error) {
    bad(`Không đọc được đơn hàng: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const products = await client.listProducts(1, 2);
    ok(`Đọc được sản phẩm · ${products.totalEntries} sản phẩm`);
  } catch (error) {
    bad(`Không đọc được sản phẩm: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const warehouses = await client.listWarehouses();
    ok(`Kho: ${warehouses.map((w) => str(w.name)).join(", ") || "không có"}`);
  } catch (error) {
    bad(`Không đọc được kho: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const customers = await client.listCustomers({ pageSize: 1 });
    ok(`Khách hàng: ${customers.totalEntries}`);
  } catch (error) {
    bad(`Không đọc được khách hàng: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!vtpNumber) {
    try {
      const page = await client.listOrders({ pageSize: 50, pageNumber: 1, filterStatus: [2, 3] });
      for (const raw of page.data) {
        const partner = asRecord(asRecord(raw).partner);
        const n = str(partner.order_number_vtp);
        if (n) {
          vtpNumber = n;
          break;
        }
      }
    } catch {
      // bỏ qua
    }
  }
  return vtpNumber;
}

async function checkViettelPost(sampleOrderNumber: string | null) {
  console.log("\n▶ Viettel Post");
  const client = new ViettelPostClient();
  if (!client.configured) {
    bad("Chưa có VIETTELPOST_API_KEY (hoặc VIETTELPOST_USERNAME/PASSWORD) trong .env");
    return;
  }
  try {
    const result = await client.testConnection();
    ok(`Lấy được token đối tác${result.tokenExpiresAt ? ` · hết hạn ${result.tokenExpiresAt.toLocaleString("vi-VN")}` : ""}`);
    if (result.account.name || result.account.phone) info(`Tài khoản: ${result.account.name} ${result.account.phone}`);
    if (result.inventories.length) info(`Kho gửi hàng: ${result.inventories.map((i) => `${i.name} (${i.id})`).join(", ")}`);
  } catch (error) {
    bad(`Không lấy được token: ${error instanceof Error ? error.message : String(error)}`);
    info("Token bí mật lấy tại https://viettelpost.vn/cau-hinh-tai-khoan → Thêm mới token → Sao chép token (xác thực OTP).");
    info("Nếu vẫn lỗi, điền VIETTELPOST_USERNAME / VIETTELPOST_PASSWORD (tài khoản đối tác) để dùng cách Login → ownerconnect.");
    return;
  }
  if (sampleOrderNumber) {
    try {
      const detail = await client.getOrderDetail(sampleOrderNumber);
      if (detail) ok(`Tra cứu vận đơn ${sampleOrderNumber}: ${detail.status ?? "?"} ${detail.statusName} · ${detail.statusDate?.toLocaleString("vi-VN") ?? ""}`);
      else bad(`Vận đơn ${sampleOrderNumber} không có trong tài khoản Viettel Post này (đơn có thể thuộc tài khoản khác).`);
    } catch (error) {
      bad(`Tra cứu vận đơn lỗi: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else info("Không có mã vận đơn Viettel Post nào trong đơn Pancake gần đây để tra cứu thử.");
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86_400_000);
    const list = await client.listOrders({ from, to, page: 1 });
    ok(`Danh sách vận đơn 7 ngày: ${list.total} vận đơn`);
  } catch (error) {
    bad(`Không đọc được danh sách vận đơn (order-filter): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkPancakePages() {
  console.log("\n▶ Pancake Pages (chat)");
  if (!env.pancake.pagesAccessToken) {
    bad("Chưa có PANCAKE_ACCESS_TOKEN trong .env");
    return;
  }
  try {
    const client = new PancakePagesClient();
    const pages = await client.listPages();
    ok(`Token hợp lệ · ${pages.length} page: ${pages.map((p) => `${p.name} (${p.id})`).join(", ") || "không có"}`);
    const first = pages[0];
    if (first) {
      const convs = await client.listConversations(first.id, new Date(Date.now() - 48 * 3_600_000), new Date(), 5);
      ok(`Page "${first.name}": ${convs.length} hội thoại 48h gần nhất (thử 5)`);
      for (const c of convs.slice(0, 2)) {
        const msgs = await client.listMessages(first.id, c.id, 10);
        info(`- ${c.customerName || c.id} · thẻ [${c.tags.join(", ")}] · ${msgs.length} tin nhắn · khách gửi: ${msgs.filter((m) => !m.fromPage).length}`);
      }
    }
  } catch (error) {
    bad(`Pancake Pages lỗi: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkFacebook() {
  console.log("\n▶ Facebook Ads");
  if (!env.facebook.accessToken) {
    bad("Chưa có FACEBOOK_ACCESS_TOKEN trong .env (Business Settings → System Users → Generate token, quyền ads_read + business_management)");
    return;
  }
  try {
    const client = new FacebookAdsClient();
    const result = await client.testConnection();
    ok(`Token hợp lệ · ${result.userName || result.userId}${result.businessName ? ` · BM "${result.businessName}"` : ""} (${env.facebook.businessId})`);
    if (result.accounts.length) ok(`Tài khoản quảng cáo: ${result.accounts.map((a) => `${a.name} (${a.accountId}, ${a.currency}${a.relation === "client" ? ", client" : ""})`).join(", ")}`);
    else bad("BM không có tài khoản quảng cáo nào mà token nhìn thấy — gán System User vào các tài khoản quảng cáo (Business Settings → Ad Accounts → Add People/Partners).");
    const first = result.accounts[0];
    if (first) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
      const since = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - 6 * 86_400_000));
      const rows = await client.campaignInsights(first.accountId, since, today);
      ok(`Insights 7 ngày của "${first.name}": ${rows.length} dòng ngày×chiến dịch · chi ${rows.reduce((s, r) => s + r.spend, 0).toLocaleString("vi-VN")} ${first.currency}`);
    }
  } catch (error) {
    bad(`Facebook lỗi: ${error instanceof Error ? error.message : String(error)}`);
    info("Token hết hạn (mã 190) → tạo token System User mới, không đặt thời hạn. Thiếu quyền → thêm ads_read, business_management.");
  }
}

async function main() {
  console.log("Kiểm tra kết nối API — Shop Control ERP");
  const vtpNumber = await checkPancake();
  await checkViettelPost(vtpNumber);
  await checkFacebook();
  await checkPancakePages();
  console.log("\nHoàn tất. Nếu tất cả ✓ thì chạy: npm run sync -- pancake-all --backfill");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
