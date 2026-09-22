import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { moTaLoiCsdl } from "@/lib/db/error-message";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { getFacebookAdsClient, type FbAdInsight, type FbCampaignInsight } from "@/lib/integrations/facebook/client";
import { decideGrain, type AdSpendGrain } from "@/lib/constants/ads-grain";
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
async function fetchChunked<T>(
  fetchOne: (s: string, e: string) => Promise<T[]>,
  accountId: string,
  since: string,
  until: string,
  log: (m: string) => void,
  nhan: string,
): Promise<T[]> {
  const out: T[] = [];
  const fetchWindow = async (s: string, e: string, sizes: number[]): Promise<void> => {
    try {
      out.push(...(await withRateLimitRetry(() => fetchOne(s, e), log, `act_${accountId} ${nhan} ${s}→${e}`)));
    } catch (error) {
      if (!sizes.length || isRateLimit(error)) throw error;
      const [size, ...rest] = sizes;
      log(`act_${accountId} ${nhan} ${s}→${e}: ${moTaLoiCsdl(error)} — chia cửa sổ ${size} ngày`);
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

/**
 * ───────────── HAI CẤP, MỘT BỘ CHIA CỬA SỔ ─────────────
 *
 * Cấp mẩu trả về nhiều dòng hơn hẳn cấp chiến dịch, nên nó đụng trần "reduce the amount of data"
 * sớm hơn — dùng chung bộ chia cửa sổ là để không phải chỉnh tay hai bộ số khi Facebook đổi trần.
 */
const fetchCampaignInsights = (client: ReturnType<typeof getFacebookAdsClient>, accountId: string, since: string, until: string, log: (m: string) => void) =>
  fetchChunked<FbCampaignInsight>((s, e) => client.campaignInsights(accountId, s, e), accountId, since, until, log, "chiến dịch");

const fetchAdInsights = (client: ReturnType<typeof getFacebookAdsClient>, accountId: string, since: string, until: string, log: (m: string) => void) =>
  fetchChunked<FbAdInsight>((s, e) => client.adInsights(accountId, s, e), accountId, since, until, log, "mẩu");

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
/**
 * ───────────── MỘT DÒNG `ad_spends`, DỰNG TỪ MỘT DÒNG INSIGHTS ─────────────
 *
 * Dùng chung cho cả hai hạt để hai cấp không trôi xa nhau: mọi cột ngoài bốn cột định danh đều đi
 * qua CÙNG một phép tính. Hai bản riêng là hai con số "tin nhắn" sống song song, đúng lớp lỗi mà
 * `metricsOf()` trong client vừa được gộp lại để tránh.
 *
 * ─── KHOÁ TỰ NHIÊN MANG THEO HẠT ───
 *
 * `fb:<tk>:<chiến dịch>:<ngày>` cho hạt chiến dịch, `fb:<tk>:<chiến dịch>:<nhóm>:<mẩu>:<ngày>` cho
 * hạt mẩu. Hai không gian khoá KHÔNG giao nhau, nên chuyển hạt không bao giờ ghi đè nhầm — dòng
 * hạt cũ bị dọn bằng bước ② ở vòng lặp, một cách tường minh, chứ không bằng một va chạm khoá may rủi.
 *
 * ─── QUY KẾT MÃ HÀNG / MARKETER VẪN ĐI THEO CHIẾN DỊCH ───
 *
 * `resolveCampaign` khai theo chiến dịch, và một mẩu thì thuộc đúng một chiến dịch — nên mọi mẩu
 * của cùng chiến dịch thừa hưởng cùng mã hàng và cùng marketer. Đây KHÔNG phải phân bổ: nó là
 * quan hệ cha–con có thật, không phải một phép chia tiền.
 */
function dungDong(
  row: FbCampaignInsight | FbAdInsight,
  account: { accountId: string; name: string; currency: string },
  rate: number,
  date: string,
  grain: AdSpendGrain,
  mapping: Awaited<ReturnType<typeof loadAdsMapping>>,
  index: ProductCodeEntry[],
) {
  const resolved = resolveCampaign(row.campaignId, row.campaignName, mapping, index, account.accountId);
  const mau = "adId" in row ? row : null;
  const externalKey =
    grain === "AD" && mau
      ? `fb:${account.accountId}:${row.campaignId}:${mau.adsetId}:${mau.adId}:${date}`
      : `fb:${account.accountId}:${row.campaignId}:${date}`;
  return {
    platform: PLATFORM,
    campaign: row.campaignName || row.campaignId,
    spend: Math.round(row.spend * rate),
    leads: row.messages || row.leads,
    orders: row.purchases,
    revenue: Math.round(row.purchaseValue * rate),
    spendDate: vnStartOfDay(date),
    note: `Tài khoản ${account.name}${account.currency !== "VND" ? ` · ${account.currency} ×${rate}` : ""}`,
    createdBy: "facebook-sync",
    externalKey,
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
    grain,
    adsetId: mau?.adsetId || null,
    adsetName: mau?.adsetName ?? "",
    adId: mau?.adId || null,
    adName: mau?.adName ?? "",
  };
}

/**
 * ───────────── ĐIỀN SỔ MẨU VÀ SỔ NHÓM TỪ CHÍNH DÒNG CHI TIÊU ─────────────
 *
 * Đây là nửa thứ hai của giá trị mà cấp mẩu mang lại, và nó đắt hơn phần tiền.
 *
 * `syncFacebookAdIndex` đi từ ĐƠN ra: nó chỉ tra những `ad_id` đã xuất hiện trong đơn, nên nó không
 * bao giờ biết một mẩu chưa đẻ ra đơn nào — và cũng không bao giờ biết bài viết của mẩu ấy để nối
 * ngược lại. Đo production 22/09/2026: `fb_ads` **185 dòng** trong khi 30 ngày có **1.096 chiến
 * dịch** tiêu tiền. Một vòng luẩn quẩn: không có đơn ⇒ không index mẩu ⇒ không có bài viết ⇒ không
 * nối được đơn.
 *
 * Đường này đi từ TIỀN ra, nên nó lật ngược chiều ấy.
 *
 * ─── KHÔNG ĐỤNG `post_id` ───
 *
 * Cột đó do `syncFacebookAdIndex` điền (nó hỏi `effective_object_story_id`, thứ insights không
 * trả). Ghi đè bằng `NULL` ở đây là xoá đúng mắt xích nối đơn về chiến dịch — nên nhánh `DO UPDATE`
 * cố ý KHÔNG liệt kê `postId` và `storyId`.
 */
async function capNhatSoMauVaNhom(adRows: FbAdInsight[], accountId: string) {
  if (!adRows.length) return;
  const db = await getDb();

  const nhom = new Map<string, { id: string; name: string; campaignId: string | null; accountId: string }>();
  const mau = new Map<string, { id: string; name: string; adsetId: string | null; campaignId: string | null; campaignName: string; accountId: string }>();
  for (const r of adRows) {
    if (r.adsetId) nhom.set(r.adsetId, { id: r.adsetId, name: r.adsetName, campaignId: r.campaignId || null, accountId });
    if (r.adId) mau.set(r.adId, { id: r.adId, name: r.adName, adsetId: r.adsetId || null, campaignId: r.campaignId || null, campaignName: r.campaignName, accountId });
  }

  const now = new Date();
  for (const lo of chiaLo([...nhom.values()], 200)) {
    await db
      .insert(schema.fbAdsets)
      .values(lo.map((n) => ({ ...n, status: "", missing: false, fetchedAt: now })))
      .onConflictDoUpdate({
        target: schema.fbAdsets.id,
        // `status` KHÔNG có trong insights — giữ nguyên giá trị cũ thay vì ghi chuỗi rỗng đè lên.
        set: { name: sql`excluded.name`, campaignId: sql`excluded.campaign_id`, accountId: sql`excluded.account_id`, fetchedAt: now, updatedAt: now },
      });
  }
  for (const lo of chiaLo([...mau.values()], 200)) {
    await db
      .insert(schema.fbAds)
      .values(lo.map((m) => ({ ...m, status: "", missing: false, fetchedAt: now })))
      .onConflictDoUpdate({
        target: schema.fbAds.id,
        // KHÔNG liệt kê `postId` / `storyId`: chúng là việc của syncFacebookAdIndex.
        set: {
          name: sql`excluded.name`,
          adsetId: sql`excluded.adset_id`,
          campaignId: sql`excluded.campaign_id`,
          campaignName: sql`excluded.campaign_name`,
          accountId: sql`excluded.account_id`,
          fetchedAt: now,
          updatedAt: now,
        },
      });
  }
}

function chiaLo<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
    /*
      ═══════════ MỘT (TÀI KHOẢN × NGÀY) CHỈ ĐƯỢC MANG MỘT HẠT ═══════════

      Đây là chỗ nguy hiểm nhất của cả bộ đồng bộ. `ad_spends` là nguồn thẩm quyền của tiền quảng
      cáo ở mọi báo cáo lợi nhuận và lương (AGENTS.md mục 15) — để dòng cấp MẨU nằm cạnh dòng cấp
      CHIẾN DỊCH của cùng một ngày là nhân đôi toàn bộ chi phí quảng cáo của ngày ấy.

      Ba lớp giữ, theo thứ tự:

       ① CỔNG ĐỐI CHIẾU TẠI CHỖ. Mỗi ngày, Σ cấp mẩu phải khớp tổng cấp chiến dịch của CHÍNH ngày
         ấy. Lệch quá dung sai ⇒ `decideGrain` trả về hạt `CAMPAIGN` cho ngày đó. Thà một ngày ở
         hạt thô còn hơn một ngày sai tiền.
       ② DỌN ĐÚNG THỨ KHÔNG CÒN ĐƯỢC BÁO. Sau khi ghi, xoá những dòng TỰ ĐỘNG của ngày ấy mà lượt
         này KHÔNG ghi ra — nó vừa chuyển hạt sạch sẽ, vừa dọn dòng của mẩu đã bị xoá trên Facebook.
         Dòng GÕ TAY (`external_key IS NULL`) không bao giờ bị đụng tới.
       ③ CHỈ XỬ LÝ NGÀY CÓ MẶT Ở CẤP CHIẾN DỊCH. Cấp chiến dịch là nguồn đối chiếu; một ngày chỉ
         thấy ở cấp mẩu nghĩa là phép đối chiếu KHÔNG THỰC HIỆN ĐƯỢC, và khi ấy không được xoá gì.
    */
    for (const account of accounts) {
      try {
        const rate = account.currency && account.currency !== "VND" ? (account.currency === "USD" ? env.facebook.usdToVnd : 1) : 1;
        const campaignRows = await fetchCampaignInsights(client, account.accountId, since, until, ctx.log);
        /*
          CẤP MẨU HỎNG KHÔNG ĐƯỢC KÉO THEO CẢ LƯỢT ĐỒNG BỘ.

          Quyền token thiếu, Facebook trả lỗi, hay đơn giản là quá nhiều dòng — tất cả đều chỉ có
          nghĩa là "hôm nay chưa có chi tiết cấp mẩu", không có nghĩa là "chi tiêu quảng cáo hôm
          nay không tồn tại". Rơi về mảng rỗng ⇒ mọi ngày giữ hạt chiến dịch, đúng như trước bản này.
        */
        const adRows = await fetchAdInsights(client, account.accountId, since, until, ctx.log).catch((error) => {
          ctx.log(`${account.name}: không đọc được cấp mẩu (${moTaLoiCsdl(error).slice(0, 120)}) — giữ hạt chiến dịch`);
          return [] as FbAdInsight[];
        });

        const theoNgay = new Map<string, { camp: FbCampaignInsight[]; ad: FbAdInsight[] }>();
        for (const r of campaignRows) {
          if (!r.date) continue;
          const g = theoNgay.get(r.date) ?? { camp: [], ad: [] };
          g.camp.push(r);
          theoNgay.set(r.date, g);
        }
        for (const r of adRows) {
          if (!r.date) continue;
          // ③ Ngày không có ở cấp chiến dịch thì KHÔNG dựng nhóm mới — không đối chiếu được.
          const g = theoNgay.get(r.date);
          if (g) g.ad.push(r);
        }

        let soNgayMau = 0;
        for (const [date, g] of theoNgay) {
          const campTotal = g.camp.reduce((t, r) => t + Math.round(r.spend * rate), 0);
          const adTotal = g.ad.reduce((t, r) => t + Math.round(r.spend * rate), 0);
          const quyet = decideGrain(campTotal, adTotal, g.ad.length);
          if (quyet.verdict === "MISMATCH") ctx.log(`${account.name} ${date}: ${quyet.reason}`);

          const ghiCapMau = quyet.grain === "AD";
          if (ghiCapMau) soNgayMau += 1;

          const dong = ghiCapMau
            ? g.ad.map((r) => dungDong(r, account, rate, date, "AD", mapping, index))
            : g.camp.map((r) => dungDong(r, account, rate, date, "CAMPAIGN", mapping, index));

          const khoaDaGhi: string[] = [];
          for (const values of dong) {
            if (values.productId) matched += 1;
            /*
              MÃ HÀNG CHẾT ⇒ KHÔNG GHI NÓ, VÀ CŨNG KHÔNG XOÁ CÁI ĐANG CÓ.

              Dòng MỚI vào đời với `product_id = NULL` (chưa quy kết — đúng sự thật, vì bảng ghép
              đang trỏ vào hư không). Dòng ĐÃ CÓ thì giữ nguyên `product_id` cũ bằng cách trỏ lại
              chính cột đó trong nhánh `DO UPDATE`: ghi `NULL` đè lên nó là lặng lẽ gỡ chi phí
              quảng cáo khỏi một mã hàng và làm báo cáo lợi nhuận đổi số mà không ai được báo
              (AGENTS.md mục 8.8).
            */
            const maTreo = values.productId && !maHangCoThat.has(values.productId) ? values.productId : null;
            if (maTreo) ghepTreo.set(values.campaignId || values.campaign, maTreo);
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
            khoaDaGhi.push(values.externalKey);
            rows += 1;
          }

          // ② Dọn dòng TỰ ĐỘNG của ngày này mà lượt vừa rồi không ghi ra.
          const cungNgay = and(
            eq(schema.adSpends.platform, PLATFORM),
            eq(schema.adSpends.accountId, account.accountId),
            eq(schema.adSpends.spendDate, vnStartOfDay(date)),
            isNotNull(schema.adSpends.externalKey),
          );
          await db.delete(schema.adSpends).where(khoaDaGhi.length ? and(cungNgay, notInArray(schema.adSpends.externalKey, khoaDaGhi)) : cungNgay);
        }

        await capNhatSoMauVaNhom(adRows, account.accountId);
        ctx.log(`${account.name} (${account.accountId}): ${theoNgay.size} ngày · ${soNgayMau} ngày ở hạt MẨU · ${rows} dòng`);
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
