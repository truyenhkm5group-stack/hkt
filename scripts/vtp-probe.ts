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
  const webToken = process.env.VIETTELPOST_WEB_TOKEN ?? "";
  if (webToken) secrets.push(webToken);
  const tokens: { label: string; token?: string; bearer?: string }[] = [];
  if (webToken) tokens.push({ label: "VIETTELPOST_WEB_TOKEN Token header", token: webToken });
  // 0) OIDC discovery
  try {
    const r = await call("https://id.viettelpost.vn/.well-known/openid-configuration", { method: "GET" });
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* ignore */ }
    show(`openid-configuration HTTP ${r.status}`, { token_endpoint: j.token_endpoint, grant_types_supported: j.grant_types_supported, scopes_supported: j.scopes_supported });
  } catch (e) {
    show("openid-configuration lỗi", e instanceof Error ? e.message : String(e));
  }
  // 1) OIDC password grant trên id.viettelpost.vn (client vtp.web) – thử nhiều dạng username
  const userVariants = Array.from(new Set([user, user.replace(/^0/, "84"), user.replace(/^0/, "+84")].filter(Boolean)));
  if (user && pass) {
    outer: for (const u of userVariants) {
      for (const [scope, secret] of [["openid profile offline_access", "vtp-web"], ["openid", "vtp-web"], ["openid", ""]] as const) {
        try {
          const params: Record<string, string> = { grant_type: "password", username: u, password: pass, client_id: "vtp.web", scope };
          if (secret) params.client_secret = secret;
          const body = new URLSearchParams(params);
          const res = await fetch("https://id.viettelpost.vn/connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(25_000) });
          const text = await res.text();
          let j: Record<string, unknown> = {};
          try { j = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
          const at = typeof j.access_token === "string" ? j.access_token : "";
          const idt = typeof j.id_token === "string" ? j.id_token : "";
          if (at) secrets.push(at);
          if (idt) secrets.push(idt);
          show(`connect/token user=${u.slice(0, 3)}…${u.slice(-2)} scope=${scope} secret=${secret ? "yes" : "no"} HTTP ${res.status}`, at ? `OK access_token ${at.length} ký tự, id_token ${idt.length}, keys=${Object.keys(j).join(",")}` : text.slice(0, 200));
          if (at) { tokens.push({ label: "OIDC Bearer", bearer: at }); tokens.push({ label: "OIDC Token header", token: at }); break outer; }
        } catch (e) {
          show("connect/token lỗi", e instanceof Error ? e.message : String(e));
        }
      }
    }
    // 1b) Đăng nhập kiểu cũ trên api.viettelpost.vn (giống partner user/Login)
    for (const url of ["https://api.viettelpost.vn/api/v2/user/Login", "https://api.viettelpost.vn/api/user/Login", "https://api.viettelpost.vn/api/user/login", "https://api.viettelpost.vn/api/v2/user/ownerconnect", "https://api.viettelpost.vn/api/user/loginWeb", "https://api.viettelpost.vn/api/v2/user/LoginWeb"]) {
      try {
        const r = await call(url, { method: "POST", body: JSON.stringify({ USERNAME: user, PASSWORD: pass, username: user, password: pass }) });
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* ignore */ }
        const data = (j.data ?? {}) as Record<string, unknown>;
        const tok = [data.token, data.Token, data.access_token, j.token, j.access_token].find((x): x is string => typeof x === "string" && x.length > 20) ?? "";
        if (tok) secrets.push(tok);
        show(`${url.split("/api/")[1]} HTTP ${r.status}`, tok ? `OK token ${tok.length} ký tự, keys=${Object.keys(data).join(",")}` : r.text.slice(0, 220));
        if (tok) { tokens.push({ label: `web login ${url.split("/api/")[1]} Token header`, token: tok }); break; }
      } catch (e) {
        show(url, e instanceof Error ? e.message : String(e));
      }
    }
  } else show("OIDC", "thiếu VIETTELPOST_USERNAME / PASSWORD");
  if (!tokens.length) tokens.push({ label: "partner Token header", token: partnerToken });
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
      ["user/get GET", "https://api.viettelpost.vn/api/user/get", { method: "GET" }],
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
