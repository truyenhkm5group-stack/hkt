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
];

const DAILY = [
  { job: "pancake-reconcile", hour: 2, minute: 15 }, // 02:15 giờ Việt Nam
  { job: "vtp-tracking", hour: 3, minute: 0, query: "all=1&limit=2000" },
  { job: "pancake-warehouses", hour: 3, minute: 30 },
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
      trigger(item.job);
      setInterval(() => trigger(item.job), item.every * 60_000);
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
