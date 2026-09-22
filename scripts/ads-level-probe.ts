/**
 * ═══════ CHI TIÊU QUẢNG CÁO Ở CẤP MẨU CÓ CỘNG ĐÚNG BẰNG CẤP CHIẾN DỊCH KHÔNG — CHỈ ĐỌC ═══════
 *
 * ─── VÌ SAO PHẢI DÒ TRƯỚC KHI ĐỔI ───
 *
 * `ad_spends` là NGUỒN THẨM QUYỀN của tiền quảng cáo trong mọi báo cáo lợi nhuận, lương và
 * marketer (AGENTS.md mục 15). Hôm nay nó ở hạt CHIẾN DỊCH × NGÀY. Muốn báo cáo chuẩn tới từng
 * nhóm / từng mẩu thì phải hạ hạt xuống MẨU × NGÀY — và đó là thao tác nguy hiểm nhất trong cả
 * việc này: thêm dòng cấp mẩu mà quên bỏ dòng cấp chiến dịch là **nhân đôi toàn bộ chi phí quảng
 * cáo**, tức làm sai mọi con số lợi nhuận và lương cùng lúc.
 *
 * Về lý thuyết Facebook bảo đảm Σ(mẩu) = chiến dịch. Về thực tế thì chưa ai đo trên tài khoản của
 * shop này, và có những loại chiến dịch (Advantage+ / chi tiêu ở cấp chiến dịch) trả về lệch.
 * **Một lời bảo đảm chưa đo không phải một lời bảo đảm.** Script này đo, và không ghi gì.
 *
 * ─── NÓ TRẢ LỜI BỐN CÂU ───
 *
 *  1. Σ chi cấp MẨU có bằng Σ chi cấp CHIẾN DỊCH không — theo TỪNG (tài khoản × ngày), không chỉ tổng.
 *     Tổng khớp mà từng ngày lệch là dấu hiệu bù trừ, và nó nguy hiểm hơn lệch tổng.
 *  2. Đổi hạt thì sổ mẩu / sổ nhóm đầy thêm bao nhiêu (đo 22/09: `fb_ads` 185 dòng, `fb_adsets` 10
 *     dòng, trong khi 30 ngày có 1.096 chiến dịch tiêu tiền).
 *  3. Bao nhiêu mẩu đã có trong `fb_ads` — phần còn lại là phần ERP chưa từng nhìn thấy.
 *  4. Số lời gọi API và thời gian: cấp mẩu trả về nhiều dòng hơn hẳn, phải biết cái giá trước khi
 *     đưa nó vào job chạy mỗi giờ.
 *
 * ─── CHẠY ───
 *   npx tsx scripts/ads-level-probe.ts            # 7 ngày gần nhất
 *   npx tsx scripts/ads-level-probe.ts --days=30
 *
 * KHÔNG ghi một dòng nào vào CSDL. KHÔNG in token (kho mã là PUBLIC — AGENTS.md mục 5).
 */
import "dotenv/config";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";

const vnd = (n: number) => Math.round(n).toLocaleString("vi-VN");

function dayKey(d: Date) {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** `null` = CHƯA BIẾT (mẫu số 0), không phải 0% — mục 42. */
function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

type Lech = { accountId: string; accountName: string; date: string; campaign: number; ad: number; delta: number };

async function main() {
  const days = Math.min(Math.max(Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7)) || 7, 1), 90);
  if (!env.facebook.accessToken) {
    console.log("Chưa cấu hình FACEBOOK_ACCESS_TOKEN — không dò được. Đây là thiếu cấu hình, KHÔNG phải kết luận 'hai cấp khớp nhau'.");
    return;
  }
  const until = dayKey(new Date());
  const since = dayKey(new Date(Date.now() - (days - 1) * 86_400_000));
  console.log(`Dò chi tiêu hai cấp · ${since} → ${until} (${days} ngày) · CHỈ ĐỌC\n`);

  const client = getFacebookAdsClient();
  const accounts = await client.listAdAccounts();
  console.log(`${accounts.length} tài khoản quảng cáo\n`);

  const lech: Lech[] = [];
  const moiMau = new Map<string, { adsetId: string; campaignId: string; name: string; spend: number }>();
  const moiNhom = new Set<string>();
  const moiChienDich = new Set<string>();
  let tongCampaign = 0;
  let tongAd = 0;
  let dongCampaign = 0;
  let dongAd = 0;
  const loi: string[] = [];

  for (const acc of accounts) {
    const batDau = Date.now();
    try {
      const [camp, ad] = await Promise.all([client.campaignInsights(acc.accountId, since, until), client.adInsights(acc.accountId, since, until)]);
      dongCampaign += camp.length;
      dongAd += ad.length;

      /*
        SO THEO TỪNG NGÀY, KHÔNG CHỈ SO TỔNG.

        Tổng khớp trong khi từng ngày lệch là dấu hiệu BÙ TRỪ — và một bộ đổi hạt dựa trên tổng
        khớp sẽ đúng ở con số cuối cùng trong khi mọi dòng theo ngày đều sai. Đó đúng là kiểu sai
        mà bảng quyết định (chạy trên cửa sổ 14 ngày) sẽ nuốt trọn mà không ai thấy.
      */
      const theoNgayCampaign = new Map<string, number>();
      for (const r of camp) theoNgayCampaign.set(r.date, (theoNgayCampaign.get(r.date) ?? 0) + r.spend);
      const theoNgayAd = new Map<string, number>();
      for (const r of ad) theoNgayAd.set(r.date, (theoNgayAd.get(r.date) ?? 0) + r.spend);

      for (const date of new Set([...theoNgayCampaign.keys(), ...theoNgayAd.keys()])) {
        const c = theoNgayCampaign.get(date) ?? 0;
        const a = theoNgayAd.get(date) ?? 0;
        tongCampaign += c;
        tongAd += a;
        // Ngưỡng 1 đơn vị tiền tệ: Facebook làm tròn từng dòng, nên lệch dưới mức ấy là làm tròn,
        // không phải mất tiền. Lệch lớn hơn thì phải hiện ra.
        if (Math.abs(c - a) >= 1) lech.push({ accountId: acc.accountId, accountName: acc.name, date, campaign: c, ad: a, delta: a - c });
      }

      for (const r of ad) {
        if (!r.adId) continue;
        const cu = moiMau.get(r.adId);
        moiMau.set(r.adId, { adsetId: r.adsetId, campaignId: r.campaignId, name: r.adName, spend: (cu?.spend ?? 0) + r.spend });
        if (r.adsetId) moiNhom.add(r.adsetId);
        if (r.campaignId) moiChienDich.add(r.campaignId);
      }
      console.log(`  ${acc.name} (${acc.accountId}): ${camp.length} dòng chiến dịch · ${ad.length} dòng mẩu · ${Math.round((Date.now() - batDau) / 1000)}s`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      loi.push(`${acc.name}: ${m.slice(0, 140)}`);
      console.log(`  ${acc.name} (${acc.accountId}): LỖI — ${m.slice(0, 140)}`);
    }
  }

  // ── Sổ mẩu / sổ nhóm hiện có biết bao nhiêu trong số này ──
  const db = await getDb();
  const adIds = [...moiMau.keys()];
  const daBiet = new Set<string>();
  for (let i = 0; i < adIds.length; i += 500) {
    const lo = adIds.slice(i, i + 500);
    if (!lo.length) continue;
    const rows = await db.select({ id: schema.fbAds.id }).from(schema.fbAds).where(inArray(schema.fbAds.id, lo));
    for (const r of rows) daBiet.add(r.id);
  }
  const nhomIds = [...moiNhom];
  const nhomDaBiet = new Set<string>();
  for (let i = 0; i < nhomIds.length; i += 500) {
    const lo = nhomIds.slice(i, i + 500);
    if (!lo.length) continue;
    const rows = await db.select({ id: schema.fbAdsets.id }).from(schema.fbAdsets).where(inArray(schema.fbAdsets.id, lo));
    for (const r of rows) nhomDaBiet.add(r.id);
  }

  console.log("\n══════════ 1. HAI CẤP CÓ CỘNG BẰNG NHAU KHÔNG ══════════");
  console.log(`  Σ chi cấp CHIẾN DỊCH : ${vnd(tongCampaign)} (${dongCampaign} dòng)`);
  console.log(`  Σ chi cấp MẨU        : ${vnd(tongAd)} (${dongAd} dòng)`);
  const deltaTong = tongAd - tongCampaign;
  console.log(`  Lệch tổng            : ${deltaTong >= 0 ? "+" : ""}${vnd(deltaTong)}  (${pct(Math.abs(deltaTong), tongCampaign) ?? "—"}% của cấp chiến dịch)`);
  console.log(`  Số (tài khoản × ngày) lệch: ${lech.length}`);
  if (lech.length) {
    console.log("  10 ngày lệch nhiều nhất:");
    for (const l of [...lech].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10)) {
      console.log(`    · ${l.date} ${l.accountName}: chiến dịch ${vnd(l.campaign)} vs mẩu ${vnd(l.ad)} ⇒ ${l.delta >= 0 ? "+" : ""}${vnd(l.delta)}`);
    }
  }

  console.log("\n══════════ 2. ĐỔI HẠT THÌ SỔ ĐẦY THÊM BAO NHIÊU ══════════");
  const soMauCu = (await db.select({ id: schema.fbAds.id }).from(schema.fbAds)).length;
  const soNhomCu = (await db.select({ id: schema.fbAdsets.id }).from(schema.fbAdsets)).length;
  console.log(`  Mẩu quảng cáo thấy trong kỳ : ${moiMau.size}  (sổ đang có ${soMauCu}, đã biết ${daBiet.size}, MỚI ${moiMau.size - daBiet.size})`);
  console.log(`  Nhóm quảng cáo thấy trong kỳ: ${moiNhom.size}  (sổ đang có ${soNhomCu}, đã biết ${nhomDaBiet.size}, MỚI ${moiNhom.size - nhomDaBiet.size})`);
  console.log(`  Chiến dịch thấy trong kỳ    : ${moiChienDich.size}`);

  console.log("\n══════════ 3. KẾT LUẬN ══════════");
  if (loi.length) {
    console.log(`  ⚠ ${loi.length} tài khoản lỗi — kết luận dưới đây CHỈ nói về phần đọc được, không nói về toàn bộ:`);
    for (const l of loi) console.log(`    · ${l}`);
  }
  /*
    BA KẾT LUẬN, KHÔNG PHẢI HAI.

    "Khớp" và "lệch" là hai; cái thứ ba là "chưa đủ căn cứ" — không đọc được tài khoản nào, hoặc
    không có chi tiêu nào trong kỳ. Gộp nó vào "khớp" là lấy sự thiếu hiểu biết của mình làm bằng
    chứng rằng không có gì đáng lo (AGENTS.md mục 48).
  */
  if (tongCampaign === 0 && tongAd === 0) {
    console.log("  CHƯA ĐỦ CĂN CỨ: không có chi tiêu nào trong kỳ đọc được. KHÔNG kết luận hai cấp khớp nhau.");
  } else if (lech.length === 0) {
    console.log("  ✅ KHỚP TỪNG NGÀY: hạ hạt xuống cấp mẩu KHÔNG làm đổi một đồng nào của báo cáo lợi nhuận.");
    console.log("     Đường đi an toàn: thay dòng cấp chiến dịch bằng dòng cấp mẩu theo TỪNG (tài khoản × ngày), trong một giao dịch.");
  } else {
    console.log(`  ⛔ LỆCH ở ${lech.length} (tài khoản × ngày). KHÔNG được đổi hạt cho tới khi hiểu vì sao.`);
    console.log("     Nguyên nhân hay gặp: chiến dịch Advantage+ / chi tiêu đặt ở cấp chiến dịch nên không có mẩu nào gánh.");
    console.log("     Cách xử lý ĐÚNG: giữ dòng cấp chiến dịch làm thẩm quyền, và ghi phần chênh thành một dòng 'chi không gắn được mẩu' — KHÔNG chia đều xuống các mẩu.");
  }
}

main().then(() => process.exit(0));
