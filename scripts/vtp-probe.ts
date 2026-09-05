/**
 * Dò API cổng khách hàng Viettel Post (api.viettelpost.vn, đăng nhập qua id.viettelpost.vn / token đối tác) để liệt kê vận đơn
 * tạo qua Pancake. In status + đoạn đầu phản hồi, che token / mật khẩu.
 *   npx tsx scripts/vtp-probe.ts [mã vận đơn]
 */
import "dotenv/config";
import { env } from "@/lib/env";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";

const orderNumber = process.argv[2] || "PKE1512546011";
const fmtVN = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
const to = new Date();
const from = new Date(Date.now() - 30 * 86_400_000);
const secrets: string[] = [];
const mask = (t: string) => secrets.reduce((o, s) => (s ? o.split(s).join("***") : o), t);
const show = (label: string, v: unknown) => console.log(`- ${label}: ${mask(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 380).replace(/\s+/g, " ")}`);

async function call(url: string, init: RequestInit & { token?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/plain, */*", "user-agent": "Mozilla/5.0", origin: "https://viettelpost.vn", referer: "https://viettelpost.vn/" };
  if (init.token) headers.Token = init.token;
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  const client = getViettelPostClient();
  const partnerToken = await client.getToken();
  secrets.push(partnerToken, env.viettelPost.apiKey ?? "", env.viettelPost.password ?? "");
  const user = env.viettelPost.username ?? "";
  const pass = env.viettelPost.password ?? "";
  // 1) OIDC password grant trên id.viettelpost.vn (client vtp.web)
  const tokens: { label: string; token?: string; bearer?: string }[] = [{ label: "partner Token header", token: partnerToken }, { label: "partner Bearer", bearer: partnerToken }];
  if (user && pass) {
    for (const scope of ["openid profile offline_access", "openid"]) {
      try {
        const body = new URLSearchParams({ grant_type: "password", username: user, password: pass, client_id: "vtp.web", client_secret: "vtp-web", scope });
        const res = await fetch("https://id.viettelpost.vn/connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(25_000) });
        const text = await res.text();
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
        const at = typeof j.access_token === "string" ? j.access_token : "";
        const idt = typeof j.id_token === "string" ? j.id_token : "";
        if (at) secrets.push(at);
        if (idt) secrets.push(idt);
        show(`id.viettelpost.vn connect/token (${scope}) HTTP ${res.status}`, at ? `OK access_token ${at.length} ký tự, id_token ${idt.length}, keys=${Object.keys(j).join(",")}` : text.slice(0, 200));
        if (at) { tokens.push({ label: "OIDC Bearer", bearer: at }); tokens.push({ label: "OIDC Token header", token: at }); break; }
      } catch (e) {
        show("connect/token lỗi", e instanceof Error ? e.message : String(e));
      }
    }
  } else show("OIDC", "thiếu VIETTELPOST_USERNAME / PASSWORD");
  // 2) Thử các endpoint web
  const bodies: Record<string, unknown>[] = [
    { status: -1, pageIndex: 1, pageSize: 20, fromDate: fmtVN(from), toDate: fmtVN(to) },
    { STATUS: -1, PAGE_INDEX: 1, PAGE_SIZE: 20, FROM_DATE: fmtVN(from), TO_DATE: fmtVN(to) },
    { page: 1, limit: 20, from_date: fmtVN(from), to_date: fmtVN(to) },
    { status: "-1", page: 1, size: 20, fromDate: from.toISOString(), toDate: to.toISOString() },
  ];
  const endpoints = ["https://api.viettelpost.vn/api/supperapp/total-order-by-status", "https://api.viettelpost.vn/api/supperapp/get-list-order-by-status-v2", "https://api.viettelpost.vn/api/supperapp/orderByStatusWeb", "https://api.viettelpost.vn/api/supperapp/orderByStatusSummary", "https://api.viettelpost.vn/api/orderOperate/search-list-order"];
  for (const t of tokens) {
    console.log(`## ${t.label}`);
    for (const ep of endpoints) {
      for (const [i, body] of bodies.entries()) {
        try {
          const r = await call(ep, { method: "POST", body: JSON.stringify(body), token: t.token, bearer: t.bearer });
          show(`${ep.split("/api/")[1]} body#${i + 1} HTTP ${r.status}`, r.text.slice(0, 260));
          if (r.status === 200 && r.text.length > 50 && !/error":true/.test(r.text)) break;
        } catch (e) {
          show(ep, e instanceof Error ? e.message : String(e));
        }
      }
    }
    for (const [label, url, init] of [
      ["2.0/order/status/{no} GET", `https://api.viettelpost.vn/api/2.0/order/status/${orderNumber}`, { method: "GET" }],
      ["2.0/order/get_detail POST", "https://api.viettelpost.vn/api/2.0/order/get_detail", { method: "POST", body: JSON.stringify({ ORDER_NUMBER: orderNumber, orderNumber }) }],
      ["orders/orderStatus POST", "https://api.viettelpost.vn/api/orders/orderStatus", { method: "POST", body: JSON.stringify({ orderNumber, ORDER_NUMBER: orderNumber }) }],
      ["supperapp/selectOrderInfo POST", "https://api.viettelpost.vn/api/supperapp/selectOrderInfo", { method: "POST", body: JSON.stringify({ orderNumber, ORDER_NUMBER: orderNumber }) }],
      ["user/getSettingTabOrderWeb GET", "https://api.viettelpost.vn/api/user/getSettingTabOrderWeb", { method: "GET" }],
    ] as const) {
      try {
        const r = await call(url, { ...init, token: t.token, bearer: t.bearer });
        show(`${label} HTTP ${r.status}`, r.text.slice(0, 260));
      } catch (e) {
        show(label, e instanceof Error ? e.message : String(e));
      }
    }
  }
}

main().catch((e) => {
  console.error(mask(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
