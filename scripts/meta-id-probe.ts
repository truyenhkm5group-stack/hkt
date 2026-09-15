/**
 * DÒ XEM 10 MÃ META TRONG TRACKING LANDING THẬT SỰ LÀ CÁI GÌ — CHỈ ĐỌC, KHÔNG GHI GÌ.
 *
 * ─── VÌ SAO CẦN ───
 *
 * 31 đơn landing đang treo ở `NO_MATCH`, và 29 trong số đó mang một dãy số 18 chữ số ở ô lẽ ra
 * phải là TÊN chiến dịch. Meta dùng cùng một dải `120...` cho ad · adset · campaign, nên nhìn dãy
 * số KHÔNG đoán được nó là gì. Đo trên production: cả 10 mã đều KHÔNG có mặt trong `ad_spends`
 * (campaign_id) lẫn `fb_ads` (id · adset_id · campaign_id) lẫn `orders.ad_id`.
 *
 * Trước khi viết bất kỳ luật quy kết nào, phải biết chắc mỗi mã là loại nút nào và thuộc tài khoản
 * quảng cáo nào. Graph API là nơi duy nhất trả lời được — `metadata=1` cho biết KIỂU của nút mà
 * không cần đoán trước trường nào tồn tại.
 *
 * ─── CHẠY ───
 *   npx tsx scripts/meta-id-probe.ts                 # đọc mã từ chính các đơn landing còn treo
 *   npx tsx scripts/meta-id-probe.ts 1202481... ...  # hoặc dò đúng những mã truyền vào
 *
 * KHÔNG in token ra màn hình (kho mã là PUBLIC — AGENTS.md mục 5).
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";

const GRAPH = "https://graph.facebook.com/v21.0";

type Probe = {
  id: string;
  orders: number;
  /** Kiểu nút Graph tự khai: `adgroup` (mẩu quảng cáo) · `campaign` (nhóm) · `adcampaign` (chiến dịch)… */
  kind: string;
  name: string;
  accountId: string;
  campaignId: string;
  adsetId: string;
  status: string;
  effectiveStatus: string;
  error: string;
};

async function graph(id: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${id}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", env.facebook.accessToken);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as Record<string, unknown>;
    throw new Error(`HTTP ${res.status} · ${String(err.message ?? "")} (code ${String(err.code ?? "?")})`);
  }
  return body;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

async function probeOne(id: string, orders: number): Promise<Probe> {
  const base: Probe = { id, orders, kind: "", name: "", accountId: "", campaignId: "", adsetId: "", status: "", effectiveStatus: "", error: "" };
  try {
    /*
      `metadata=1` trả về `metadata.type` — KIỂU nút do chính Graph khai. Đây là cách duy nhất hỏi
      "cái này là gì" mà không phải đoán trước một danh sách trường; xin nhầm trường cho một kiểu
      nút khác thì Graph trả lỗi #100 và ta không học được gì.
    */
    const meta = await graph(id, { fields: "id,name" });
    base.name = str(meta.name);
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    return base;
  }
  /*
    XIN TRƯỜNG THEO KIỂU DẦN TỪ HẸP TỚI RỘNG.

    `metadata=1` ở phiên bản API này KHÔNG trả `metadata.type` (đo thật: rỗng cho cả 10 mã), nên
    không thể dựa vào nó để chọn bộ trường. Cách còn lại là THỬ: xin bộ trường của mẩu quảng cáo
    trước (có cả `adset_id` lẫn `campaign_id`), hỏng thì bộ của nhóm quảng cáo (chỉ `campaign_id`),
    hỏng nữa thì bộ tối thiểu. Trường nào Graph nhận chính là lời khai về kiểu nút — và đó là suy
    luận từ CÂU TRẢ LỜI CỦA NGUỒN, không phải đoán theo cái tên.

    Quan trọng nhất là `campaign_id`: nó mới là khoá nối sang `ad_spends` để ra marketer.
  */
  const attempts: { kind: string; fields: string }[] = [
    { kind: "AD", fields: "account_id,campaign_id,adset_id,status,effective_status" },
    { kind: "ADSET", fields: "account_id,campaign_id,status,effective_status" },
    { kind: "CAMPAIGN", fields: "account_id,objective,status,effective_status" },
    { kind: "?", fields: "account_id,status,effective_status" },
  ];
  for (const a of attempts) {
    try {
      const node = await graph(id, { fields: a.fields });
      base.kind = base.kind || a.kind;
      base.accountId = str(node.account_id).replace(/^act_/, "");
      base.campaignId = str(node.campaign_id);
      base.adsetId = str(node.adset_id);
      base.status = str(node.status);
      base.effectiveStatus = str(node.effective_status);
      base.error = "";
      return base;
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
    }
  }
  return base;
}

async function main() {
  if (!env.facebook.accessToken) throw new Error("Chưa cấu hình FACEBOOK_ACCESS_TOKEN");
  const argIds = process.argv.slice(2).filter((x) => /^\d{5,}$/.test(x));
  let targets: { id: string; orders: number }[];
  if (argIds.length) {
    targets = argIds.map((id) => ({ id, orders: 0 }));
  } else {
    const db = await getDb();
    const rows = await db
      .select({ id: sql<string>`la.utm->>'campaignName'`, orders: sql<number>`count(*)::int` })
      .from(sql`${schema.landingAttributions} la`)
      .where(sql`la.marketer_id is null and la.utm->>'campaignName' ~ '^[0-9]{10,25}$'`)
      .groupBy(sql`1`);
    targets = rows.map((r) => ({ id: r.id, orders: Number(r.orders) })).sort((a, b) => b.orders - a.orders);
  }
  console.log(`Dò ${targets.length} mã Meta (chỉ đọc)\n`);
  const out: Probe[] = [];
  for (const t of targets) out.push(await probeOne(t.id, t.orders));

  const w = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  console.log(`${w("mã", 20)} ${w("đơn", 4)} ${w("kiểu", 12)} ${w("TKQC", 17)} ${w("chiến dịch", 20)} ${w("trạng thái", 12)} tên / lỗi`);
  for (const p of out) {
    console.log(`${w(p.id, 20)} ${w(String(p.orders), 4)} ${w(p.kind || "?", 12)} ${w(p.accountId || "-", 17)} ${w(p.campaignId || "-", 20)} ${w(p.effectiveStatus || p.status || "-", 12)} ${p.error ? `LỖI: ${p.error}` : p.name}`);
  }

  const theoKieu = new Map<string, number>();
  for (const p of out) {
    const k = p.error ? `lỗi: ${p.error.slice(0, 60)}` : p.kind || "?";
    theoKieu.set(k, (theoKieu.get(k) ?? 0) + 1);
  }
  console.log("\nTổng hợp theo kiểu nút:");
  for (const [k, n] of [...theoKieu.entries()].sort((a, b) => b[1] - a[1])) console.log(`  · ${k}: ${n} mã`);
  const donCuuDuoc = out.filter((p) => !p.error && p.accountId).reduce((t, p) => t + p.orders, 0);
  console.log(`\nMã tra được TKQC: ${out.filter((p) => !p.error && p.accountId).length}/${out.length} · ứng với ${donCuuDuoc} đơn landing đang treo.`);
}

main().then(() => process.exit(0));
