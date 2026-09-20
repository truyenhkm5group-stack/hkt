import { eq, sql } from "drizzle-orm";
import { moTaLoiCsdl } from "@/lib/db/error-message";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { buildProductCodeIndex, type ProductCodeEntry } from "@/lib/integrations/facebook/match";
import { loadAdsMapping, reapplyAdsMapping, resolveCampaign } from "@/lib/integrations/facebook/mapping";
import { vnStartOfDay } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

const PLATFORM = "Facebook";

function dayKey(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function addDays(key: string, days: number) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isRateLimit(error: unknown) {
  const message = moTaLoiCsdl(error);
  return /request limit reached|\(mã (4|17|32|613)\)|too many calls|rate limit/i.test(message);
}

async function withRateLimitRetry<T>(fn: () => Promise<T>, log: (m: string) => void, label: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimit(error) || attempt >= 6) throw error;
      const wait = Math.min(300_000, 60_000 * attempt);
      log(`${label}: Facebook giới hạn tần suất, chờ ${Math.round(wait / 1000)}s rồi thử lại (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Facebook từ chối khoảng thời gian quá dài với time_increment=1 ("reduce the amount of data").
 * Thử cửa sổ 92 ngày; lỗi thì chia 31 ngày; vẫn lỗi thì 7 ngày. Gặp giới hạn tần suất (mã 4/17/32/613) thì chờ và thử lại.
 */
async function fetchInsightsChunked(client: ReturnType<typeof getFacebookAdsClient>, accountId: string, since: string, until: string, log: (m: string) => void) {
  const out: Awaited<ReturnType<typeof client.campaignInsights>> = [];
  const fetchWindow = async (s: string, e: string, sizes: number[]): Promise<void> => {
    try {
      out.push(...(await withRateLimitRetry(() => client.campaignInsights(accountId, s, e), log, `act_${accountId} ${s}→${e}`)));
    } catch (error) {
      if (!sizes.length || isRateLimit(error)) throw error;
      const [size, ...rest] = sizes;
      log(`act_${accountId} ${s}→${e}: ${moTaLoiCsdl(error)} — chia cửa sổ ${size} ngày`);
      let cur = s;
      while (cur <= e) {
        const stop = addDays(cur, size - 1) < e ? addDays(cur, size - 1) : e;
        await fetchWindow(cur, stop, rest);
        cur = addDays(stop, 1);
      }
    }
  };
  let start = since;
  while (start <= until) {
    const end = addDays(start, 91) < until ? addDays(start, 91) : until;
    await fetchWindow(start, end, [31, 7]);
    start = addDays(end, 1);
  }
  return out;
}

export async function loadProductCodeIndex(): Promise<ProductCodeEntry[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId, skus: sql<string[]>`coalesce(array_agg(distinct ${schema.productVariants.sku}) filter (where ${schema.productVariants.sku} <> ''), '{}')` })
    .from(schema.products)
    .leftJoin(schema.productVariants, eq(schema.productVariants.productId, schema.products.id))
    .where(eq(schema.products.isRemoved, false))
    .groupBy(schema.products.id);
  return buildProductCodeIndex(rows.map((r) => ({ ...r, skus: Array.isArray(r.skus) ? r.skus : [] })));
}

/**
 * Đồng bộ chi tiêu quảng cáo Facebook: mọi tài khoản trong Business Manager, theo ngày × chiến dịch.
 * Ghi đè các dòng đã có cùng khoá (Facebook có thể điều chỉnh số liệu vài ngày sau).
 */
export async function syncFacebookAds(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}) {
  return runSyncJob({ source: "FACEBOOK", job: "ads_insights", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getFacebookAdsClient();
    const days = Math.min(Math.max(options.days ?? 3, 1), 1100);
    const until = dayKey(new Date());
    const since = dayKey(new Date(Date.now() - (days - 1) * 86_400_000));
    const [index, mapping] = await Promise.all([loadProductCodeIndex(), loadAdsMapping()]);
    /*
      VÒNG LẶP NẠP SỐ LIỆU CŨNG GHI THẲNG VÀO CỘT CÓ KHOÁ NGOẠI.

      `reapplyAdsMapping()` đã được vá, nhưng `values.productId` dưới đây đến từ cùng một nguồn
      (`resolveCampaign` → bảng ghép trong `settings`) và đi vào cùng một cột
      `ad_spends.product_id → products.id`. Vá một đường mà để hở đường kia thì lỗi quay lại
      nguyên vẹn, chỉ khác chỗ ném: một mã hàng chết làm hỏng lượt upsert và KẾT THÚC SỚM vòng
      lặp của cả tài khoản đó — những dòng insight còn lại của tài khoản không bao giờ được ghi.
    */
    const maHangCoThat = new Set((await db.select({ id: schema.products.id }).from(schema.products)).map((p) => p.id));
    const ghepTreo = new Map<string, string>();
    const accounts = await client.listAdAccounts();
    ctx.summary.detail = `${accounts.length} tài khoản · ${since} → ${until}`;
    await ctx.progress();
    let rows = 0;
    let matched = 0;
    const errors: string[] = [];
    for (const account of accounts) {
      try {
        const insights = await fetchInsightsChunked(client, account.accountId, since, until, ctx.log);
        const rate = account.currency && account.currency !== "VND" ? (account.currency === "USD" ? env.facebook.usdToVnd : 1) : 1;
        for (const row of insights) {
          if (!row.date) continue;
          const resolved = resolveCampaign(row.campaignId, row.campaignName, mapping, index, account.accountId);
          if (resolved.productId) matched += 1;
          const spend = Math.round(row.spend * rate);
          const values = {
            platform: PLATFORM,
            campaign: row.campaignName || row.campaignId,
            spend,
            leads: row.messages || row.leads,
            orders: row.purchases,
            revenue: Math.round(row.purchaseValue * rate),
            spendDate: vnStartOfDay(row.date),
            note: `Tài khoản ${account.name}${account.currency !== "VND" ? ` · ${account.currency} ×${rate}` : ""}`,
            createdBy: "facebook-sync",
            externalKey: `fb:${account.accountId}:${row.campaignId}:${row.date}`,
            accountId: account.accountId,
            accountName: account.name,
            campaignId: row.campaignId,
            productId: resolved.productId,
            impressions: row.impressions,
            clicks: row.clicks,
            messages: row.messages,
            currency: account.currency,
            excluded: resolved.excluded,
            marketerId: resolved.marketerId,
          };
          /*
            MÃ HÀNG CHẾT ⇒ KHÔNG GHI NÓ, VÀ CŨNG KHÔNG XOÁ CÁI ĐANG CÓ.

            Dòng MỚI vào đời với `product_id = NULL` (chưa quy kết — đúng sự thật, vì bảng ghép
            đang trỏ vào hư không). Dòng ĐÃ CÓ thì giữ nguyên `product_id` cũ bằng cách trỏ lại
            chính cột đó trong nhánh `DO UPDATE`: ghi `NULL` đè lên nó là lặng lẽ gỡ chi phí
            quảng cáo khỏi một mã hàng và làm báo cáo lợi nhuận đổi số mà không ai được báo
            (AGENTS.md mục 8.8).
          */
          const maTreo = values.productId && !maHangCoThat.has(values.productId) ? values.productId : null;
          if (maTreo) ghepTreo.set(row.campaignId || values.campaign, maTreo);
          const giaTri = maTreo ? { ...values, productId: null } : values;
          const setKhiTrung = maTreo
            ? { ...giaTri, productId: sql`${schema.adSpends.productId}`, updatedAt: new Date() }
            : { ...giaTri, updatedAt: new Date() };
          const [r] = await db
            .insert(schema.adSpends)
            .values(giaTri)
            .onConflictDoUpdate({ target: schema.adSpends.externalKey, set: setKhiTrung })
            .returning({ createdAt: schema.adSpends.createdAt, updatedAt: schema.adSpends.updatedAt });
          if (r && r.updatedAt.getTime() - r.createdAt.getTime() < 2000) ctx.summary.imported += 1;
          else ctx.summary.updated += 1;
          rows += 1;
        }
        ctx.log(`${account.name} (${account.accountId}): ${insights.length} dòng`);
      } catch (error) {
        ctx.summary.failed += 1;
        const message = moTaLoiCsdl(error);
        errors.push(`${account.name}: ${message.slice(0, 160)}`);
        ctx.log(`${account.name} (${account.accountId}): ${message}`);
      }
      await ctx.progress();
    }
    /*
      GHÉP TREO GẶP Ở VÒNG LẶP NẠP SỐ LIỆU PHẢI ĐƯỢC BÁO RIÊNG, TRƯỚC BƯỚC DỌN DẸP.

      Nếu gộp nó vào khối `try` bên dưới thì một cú ném của `reapplyAdsMapping()` sẽ cuốn theo cả
      danh sách này — và chỗ hỏng nằm ở vòng lặp nạp, nơi đã ghi dữ liệu xong, lại là chỗ biến
      mất khỏi báo cáo.
    */
    const treoNap = [...ghepTreo].map(([campaignId, productId]) => ({ campaignId, campaign: campaignId, productId }));
    if (treoNap.length) {
      const ten = treoNap.slice(0, 5).map((d) => `${d.campaign} → ${d.productId}`);
      ctx.summary.warning = `${treoNap.length} chiến dịch ghép vào mã hàng KHÔNG CÒN TỒN TẠI — dòng mới để trống mã hàng, dòng cũ GIỮ NGUYÊN: ${ten.join(" · ")}${treoNap.length > 5 ? " …" : ""}. Sửa ở trang Chi phí › Ghép chiến dịch.`;
      for (const d of treoNap) ctx.log(`ghép treo (lúc nạp): ${d.campaignId} → mã hàng ${d.productId} không có trong sổ`);
    }

    /*
      ÁP LẠI BẢNG GHÉP LÀ BƯỚC DỌN DẸP, KHÔNG PHẢI VIỆC CHÍNH — NÊN NÓ KHÔNG ĐƯỢC GIẾT LƯỢT CHẠY.

      Số liệu quảng cáo đã ghi xong ở vòng lặp trên. Bước này chỉ áp lại mã hàng / marketer cho
      những dòng CŨ. Trước đây nó nằm ngoài mọi `try/catch`, nên một dòng ghép trỏ vào mã hàng
      không còn tồn tại (khoá ngoại `ad_spends.product_id → products.id`) làm cả lượt chạy ghi
      FAILED — mỗi lượt, mãi mãi, vì nguyên nhân là tất định. Và màn hình chỉ nói "FAILED": không
      ai phân biệt được ĐỒNG BỘ HỎNG với MỘT BƯỚC DỌN DẸP HỎNG, mà hai thứ đó sửa ở hai chỗ khác.

      Nay nó ra `warning` ⇒ lượt chạy ghi PARTIAL kèm lý do đọc được. PARTIAL nói đúng sự thật:
      việc chính xong, một phần phụ chưa xong.
    */
    try {
      const reapplied = await reapplyAdsMapping();
      if (reapplied.changed) ctx.log(`Áp lại ghép mã hàng: ${reapplied.changed} dòng thay đổi`);
      /*
        BẢNG GHÉP TRỎ VÀO MÃ HÀNG ĐÃ BIẾN MẤT PHẢI NÊU TÊN.

        Dữ liệu cũ được GIỮ NGUYÊN (không ghi `null` — xem `reapplyAdsMapping`), nên không con số
        nào đổi. Nhưng im lặng thì bảng ghép hỏng đó sống mãi: đúng cái đã làm job chết nhiều giờ.
      */
      if (reapplied.danglingProducts.length) {
        const ten = reapplied.danglingProducts.slice(0, 5).map((d) => `${d.campaign || d.campaignId} → ${d.productId}`);
        // GỘP VÀO, không ghi đè: cảnh báo của vòng lặp nạp ở trên nói về một chỗ hỏng khác.
        const cauNay = `${reapplied.danglingProducts.length} chiến dịch ghép vào mã hàng KHÔNG CÒN TỒN TẠI — đã giữ nguyên dữ liệu cũ, chưa áp ghép: ${ten.join(" · ")}${reapplied.danglingProducts.length > 5 ? " …" : ""}. Sửa ở trang Chi phí › Ghép chiến dịch.`;
        ctx.summary.warning = [ctx.summary.warning, cauNay].filter(Boolean).join(" · ");
        for (const d of reapplied.danglingProducts) ctx.log(`ghép treo: ${d.campaignId} → mã hàng ${d.productId} không có trong sổ`);
      }
      if (reapplied.errors.length) {
        const cau = reapplied.errors.slice(0, 3).map((e) => `${e.campaignId}: ${e.message.slice(0, 120)}`);
        ctx.summary.warning = [ctx.summary.warning, `${reapplied.errors.length} chiến dịch không áp được ghép: ${cau.join(" | ")}`].filter(Boolean).join(" · ");
      }
    } catch (error) {
      const message = moTaLoiCsdl(error);
      ctx.summary.warning = [ctx.summary.warning, `Không áp lại được bảng ghép mã hàng: ${message.slice(0, 200)}. Số liệu quảng cáo của lượt này VẪN ĐÃ GHI XONG.`].filter(Boolean).join(" · ");
      ctx.log(`áp lại ghép mã hàng hỏng: ${message}`);
    }
    ctx.summary.detail = `${accounts.length} tài khoản · ${rows} dòng ngày×chiến dịch (${since} → ${until}) · ghép được mã hàng ${matched}/${rows}${errors.length ? ` · lỗi: ${errors.join(" | ")}` : ""}`;
    publish({ type: "ads" });
    return { accounts: accounts.length, rows, matched };
  });
}
