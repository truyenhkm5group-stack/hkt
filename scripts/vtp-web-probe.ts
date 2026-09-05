/**
 * Tìm endpoint API mà cổng khách hàng viettelpost.vn (trang Quản lý vận đơn) dùng: tải HTML + các bundle JS, lọc ra
 * các URL / đường dẫn API xuất hiện trong mã. Không cần đăng nhập, không in secret.
 *   npx tsx scripts/vtp-web-probe.ts [từ khoá,cách,nhau,bởi,phẩy]
 */
const PAGES = ["https://viettelpost.vn/quan-ly-van-don", "https://viettelpost.vn/"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

async function get(url: string) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text(), url: res.url };
}

async function main() {
  const scripts = new Set<string>();
  for (const p of PAGES) {
    try {
      const { status, text, url } = await get(p);
      console.log(`# ${p} → HTTP ${status} (${url}) · ${text.length} ký tự`);
      const base = new URL(url);
      for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) scripts.add(new URL(m[1], base).toString());
      for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]*viettelpost[a-z0-9./-]*/gi)) console.log("  host trong HTML:", m[0]);
    } catch (e) {
      console.log(`# ${p} lỗi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`# ${scripts.size} bundle`);
  const hits = new Map<string, number>();
  const hosts = new Map<string, number>();
  const texts = new Map<string, string>();
  for (const s of [...scripts].slice(0, 40)) {
    try {
      const { status, text } = await get(s);
      console.log(`  - ${s.slice(-70)} → ${status} · ${Math.round(text.length / 1024)} KB`);
      texts.set(s, text);
      for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\.viettelpost\.vn[^"'`\s)]*/gi)) hosts.set(m[0].slice(0, 120), (hosts.get(m[0].slice(0, 120)) ?? 0) + 1);
      for (const m of text.matchAll(/["'`](\/?(?:api|v1|v2|v3)\/[a-zA-Z0-9_\-./{}$]{3,80})["'`]/g)) hits.set(m[1], (hits.get(m[1]) ?? 0) + 1);
      for (const m of text.matchAll(/["'`]([a-zA-Z0-9_\-./]*(?:order|van-don|vandon|shipment|tracking|bill)[a-zA-Z0-9_\-./{}$]{0,60})["'`]/gi)) if (m[1].includes("/")) hits.set(m[1], (hits.get(m[1]) ?? 0) + 1);
    } catch (e) {
      console.log(`  - ${s.slice(-70)} lỗi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Tải thêm các chunk lazy (được tham chiếu trong bundle) để tìm mã của trang Quản lý vận đơn
  const chunkUrls = new Set<string>();
  for (const s of [...scripts]) {
    const base = s.slice(0, s.lastIndexOf("/") + 1);
    for (const m of texts.get(s)?.matchAll(/["'`]([A-Za-z0-9_\-]+(?:\.[0-9a-f]{6,})?\.js)["'`]/g) ?? []) chunkUrls.add(base + m[1]);
  }
  for (const c of [...chunkUrls].filter((c) => !scripts.has(c)).slice(0, 80)) {
    try {
      const { status, text } = await get(c);
      if (status !== 200 || text.length < 1000) continue;
      texts.set(c, text);
      for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\.viettelpost\.vn[^"'`\s)]*/gi)) hosts.set(m[0].slice(0, 120), (hosts.get(m[0].slice(0, 120)) ?? 0) + 1);
      for (const m of text.matchAll(/["'`](\/?(?:api|v1|v2|v3)\/[a-zA-Z0-9_\-./{}$]{3,80})["'`]/g)) hits.set(m[1], (hits.get(m[1]) ?? 0) + 1);
    } catch {
      /* bỏ qua */
    }
  }
  console.log(`# đã tải thêm ${texts.size - scripts.size} chunk lazy`);
  // Ngữ cảnh mã quanh các từ khoá (tham số request, cách lấy Token)
  const keywords = (process.argv[2] ? process.argv[2].split(",") : ["get-list-order-by-status-v2", "total-order-by-status", "exportExcelWebNew", "connect/token", "loginSSO", "LoginSSO", "id_token", "oms-sso", "headers.Token", "Token:", "\"Token\"", "localStorage.getItem", "search-list-order"]).map((k) => k.trim()).filter(Boolean);
  console.log("# Ngữ cảnh mã quanh từ khoá:");
  for (const kw of keywords) {
    let shown = 0;
    for (const [u, text] of texts) {
      let idx = text.indexOf(kw);
      while (idx >= 0 && shown < 4) {
        const snippet = text.slice(Math.max(0, idx - 350), idx + 650).replace(/\s+/g, " ");
        console.log(`\n## [${kw}] ${u.slice(-50)} @${idx}\n${snippet}`);
        shown++;
        idx = text.indexOf(kw, idx + kw.length + 2000);
      }
      if (shown >= 4) break;
    }
    if (!shown) console.log(`\n## [${kw}] không thấy`);
  }
  console.log("# Host API xuất hiện trong bundle:");
  for (const [h, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${n}× ${h}`);
  console.log("# Đường dẫn liên quan đơn / api:");
  for (const [h, n] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120)) console.log(`  ${n}× ${h}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
