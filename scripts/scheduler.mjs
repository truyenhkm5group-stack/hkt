/**
 * Bộ lập lịch đồng bộ (chạy như một tiến trình riêng, ví dụ service "scheduler" trong docker-compose).
 * Gọi các API /api/sync/<job> của ERP theo chu kỳ. Không cần build TypeScript.
 */
const BASE = (process.env.ERP_INTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET || "";

const minutes = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const JOBS = [
  { job: "pancake-orders", every: minutes("SYNC_ORDERS_EVERY_MINUTES", 3), offset: 0.2 },
  { job: "vtp-tracking", every: minutes("SYNC_VTP_EVERY_MINUTES", 10), offset: 1 },
  { job: "pancake-products", every: minutes("SYNC_PRODUCTS_EVERY_MINUTES", 30), offset: 2 },
  { job: "pancake-returns", every: minutes("SYNC_RETURNS_EVERY_MINUTES", 30), offset: 4 },
  { job: "pancake-customers", every: minutes("SYNC_CUSTOMERS_EVERY_MINUTES", 60), offset: 6 },
  { job: "pancake-inventory", every: minutes("SYNC_INVENTORY_EVERY_MINUTES", 60), offset: 8 },
  { job: "facebook-ads", every: minutes("SYNC_ADS_EVERY_MINUTES", 60), offset: 10 },
  { job: "alerts", every: minutes("ALERTS_EVERY_MINUTES", 10), offset: 3 },
  { job: "cs-chat", every: minutes("SYNC_CHAT_EVERY_MINUTES", 15), offset: 5 },
  { job: "ads-billing", every: minutes("SYNC_ADS_BILLING_EVERY_MINUTES", 30), offset: 12 },
  { job: "landing-sheet", query: "new=1", every: minutes("SYNC_LANDING_FAST_EVERY_MINUTES", 1), offset: 7 }, // near-realtime: nạp nhanh dòng mới
  { job: "landing-sheet", every: minutes("SYNC_LANDING_EVERY_MINUTES", 10), offset: 8.5 }, // đầy đủ: ghép lại theo SĐT, cập nhật dòng đã sửa
  // LỚP TĂNG TỐC PHẢI CÓ NGƯỜI LÀM MỚI, nếu không nó tự mục.
  //
  // `canonical_order_outcome` chỉ được coi là dùng được khi nó MỚI HƠN đơn và vận đơn của nó; đơn cũ
  // hơn thì báo cáo tự tính lại (chậm chứ không sai). Mà `pancake-orders` chạy 3 phút một lần và
  // chạm vào `orders.updated_at`, nên số dòng cũ chỉ có tăng.
  //
  // Đo trên production 09/09/2026: sau 73 phút không ai dựng lại, 80/2.433 dòng đã cũ. Cứ thế thì
  // vài tuần nữa gần như mọi đơn rơi về đường chậm và trang chủ quay lại mức 60 giây của trước P0.3.
  { job: "outcome-materialize", every: minutes("OUTCOME_MATERIALIZE_EVERY_MINUTES", 5), offset: 1.5 },
  // GIỮ ẤM TRANG CHỦ. Đo được: nguội 76-88 giây, ấm ~100ms. Chạy mỗi 4 phút — ngắn hơn TTL 300
  // giây của bảng điều khiển, nên đệm không bao giờ kịp nguội và người mở trang không phải trả giá.
  { job: "dashboard-warm", every: minutes("DASHBOARD_WARM_EVERY_MINUTES", 4), offset: 0.5 },
];

const DAILY = [
  { job: "pancake-reconcile", hour: 2, minute: 15 }, // 02:15 giờ Việt Nam
  { job: "vtp-tracking", hour: 3, minute: 0, query: "all=1&limit=2000" },
  { job: "pancake-warehouses", hour: 3, minute: 30 },
  { job: "facebook-ads", hour: 4, minute: 0, query: "days=30" },
  { job: "outreach-build", hour: 8, minute: 30 }, // lập danh sách chăm sóc khách & bán chéo mỗi sáng // đối chiếu lại 30 ngày (Facebook có thể điều chỉnh số liệu muộn)
  // QUÉT đối soát mỗi sáng, CHỈ ĐỌC — cố ý KHÔNG truyền fix=1.
  //
  // Trước đây lệch dữ liệu chỉ lộ ra khi có người bấm tay, nên 70 vận đơn lệch ảnh chụp nằm im
  // nhiều ngày. Quét tự động thì chúng hiện ra ở Chất lượng dữ liệu ngay hôm sau.
  //
  // Vì sao KHÔNG tự sửa: sửa dữ liệu production không có người xem là đúng loại việc phải hỏi chủ
  // shop (AGENTS.md mục 7). Máy phát hiện, người quyết định.
  { job: "data-check", hour: 6, minute: 30 },
];

const log = (...args) => console.log(new Date().toISOString(), "[scheduler]", ...args);

async function trigger(job, query = "") {
  const url = `${BASE}/api/sync/${job}?wait=0${query ? `&${query}` : ""}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "x-cron-secret": SECRET } });
    const body = await res.json().catch(() => ({}));
    log(job, res.status, body.message || (body.started ? "started" : JSON.stringify(body).slice(0, 120)));
  } catch (error) {
    log(job, "lỗi:", error.message);
  }
}

async function waitForApp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // chưa sẵn sàng
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

function vnNow() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: get("hour"), minute: get("minute") };
}

async function main() {
  log("Đang chờ ERP sẵn sàng tại", BASE);
  const ready = await waitForApp();
  if (!ready) log("ERP chưa phản hồi, vẫn tiếp tục thử theo lịch.");

  for (const item of JOBS) {
    setTimeout(() => {
      trigger(item.job, item.query);
      setInterval(() => trigger(item.job, item.query), item.every * 60_000);
    }, item.offset * 60_000);
  }
  log("Lịch chạy:", JOBS.map((j) => `${j.job}/${j.every}p`).join(", "));

  const firedToday = new Set();
  setInterval(() => {
    const { hour, minute } = vnNow();
    for (const d of DAILY) {
      const key = `${d.job}-${new Date().toDateString()}`;
      if (hour === d.hour && minute === d.minute && !firedToday.has(key)) {
        firedToday.add(key);
        trigger(d.job, d.query);
      }
    }
  }, 30_000);
}

main();
