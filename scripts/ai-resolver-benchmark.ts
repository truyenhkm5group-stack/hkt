/**
 * ĐO PHÉP NHẬN DIỆN SẢN PHẨM trên dữ liệu THẬT đã nạp — không gọi mô hình, không tạo việc mới.
 *
 *   npx tsx scripts/ai-resolver-benchmark.ts --page=<PAGE_ID> [--backfill]
 *
 * VÌ SAO CẦN RIÊNG MỘT BÀI ĐO. 189 tin đang nằm trong CSDL bản chạy thử được nạp TRƯỚC khi có các
 * cột tín hiệu quảng cáo, nên `ad_id` của chúng rỗng; mà nạp lại thì cơ chế chống trùng bỏ qua
 * đúng những tin ấy. Không backfill thì phép đo sẽ nói "không có mã quảng cáo nào" — một kết luận
 * SAI về dữ liệu, không phải về phép khớp.
 *
 * `--backfill` đọc LẠI từ Pancake (CHỈ GET) và điền tín hiệu vào các dòng đang rỗng. Chỉ ghi vào
 * CSDL bản chạy thử; không đụng production, không gửi gì cho khách, không tạo đơn.
 */
import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { resolveProduct } from "@/lib/ai-workforce/agents/sales/resolve-product";
import { learnAdMapping } from "@/lib/ai-workforce/agents/sales/ad-map";
import { PRODUCT_RESOLUTION_LABEL, type ProductResolutionSource } from "@/lib/constants/product-resolution";

async function main() {
  const pageId = process.argv.find((a) => a.startsWith("--page="))?.split("=")[1] ?? "";
  const backfill = process.argv.includes("--backfill");
  await ensureMigrated();
  const db = await getDb();

  // ───── 1. BACKFILL TÍN HIỆU QUẢNG CÁO (chỉ GET từ Pancake) ─────
  if (backfill) {
    const client = getPancakePagesClient();
    const hoiThoai = await db.query.salesConversations.findMany({
      where: pageId ? eq(schema.salesConversations.pageId, pageId) : undefined,
      columns: { id: true, externalId: true, pageId: true, pancakeCustomerId: true },
      limit: 200,
    });
    console.log(`\n───────── BACKFILL TÍN HIỆU: ${hoiThoai.length} hội thoại ─────────`);
    let daDien = 0;
    let loi = 0;
    for (const ht of hoiThoai) {
      try {
        const tin = await client.listMessages(ht.pageId, ht.externalId, ht.pancakeCustomerId, 30);
        for (const m of tin) {
          if (!m.adId && !m.adDescription && !m.postUrl) continue;
          const r = await db
            .update(schema.salesMessages)
            .set({ adId: m.adId, adDescription: m.adDescription, postUrl: m.postUrl, attachmentTypes: m.attachmentTypes })
            .where(and(eq(schema.salesMessages.conversationId, ht.id), eq(schema.salesMessages.externalId, m.id), eq(schema.salesMessages.adId, "")))
            .returning({ id: schema.salesMessages.id });
          daDien += r.length;
        }
      } catch (e) {
        loi += 1;
        console.log(`  ⚠ ${ht.externalId.slice(0, 10)}…: ${(e as Error).message.slice(0, 70)}`);
      }
    }
    console.log(`  Đã điền tín hiệu cho ${daDien} tin nhắn${loi ? ` · ${loi} hội thoại đọc lỗi` : ""}`);
  }

  // ───── 2. TÍN HIỆU ĐANG CÓ ─────
  const [tin] = await db
    .select({
      tong: sql<number>`count(*)::int`,
      coAd: sql<number>`count(*) filter (where ${schema.salesMessages.adId} <> '')::int`,
      coCau: sql<number>`count(*) filter (where ${schema.salesMessages.adDescription} <> '')::int`,
      coBai: sql<number>`count(*) filter (where ${schema.salesMessages.postUrl} <> '')::int`,
    })
    .from(schema.salesMessages);
  console.log(`\n───────── TÍN HIỆU TRONG CSDL ─────────`);
  console.log(`  tin nhắn ${tin.tong} · có mã quảng cáo ${tin.coAd} · có câu quảng cáo ${tin.coCau} · có đường dẫn bài ${tin.coBai}`);

  // ───── 3. GIẢI TỪNG HỘI THOẠI ─────
  const hoiThoai = await db.query.salesConversations.findMany({
    where: pageId ? eq(schema.salesConversations.pageId, pageId) : undefined,
    columns: { id: true, pageId: true, externalId: true },
    limit: 200,
  });
  const dem = new Map<ProductResolutionSource, { luot: number; raSP: number }>();
  let tong = 0;
  let raSP = 0;
  let hoc = 0;

  for (const ht of hoiThoai) {
    // Tin KHÁCH gần nhất — đúng thứ dây chuyền thật sẽ giải.
    const tinKhach = await db.query.salesMessages.findMany({
      where: and(eq(schema.salesMessages.conversationId, ht.id), eq(schema.salesMessages.fromPage, false)),
      orderBy: (m, { desc }) => [desc(m.sentAt)],
      columns: { id: true, text: true, adId: true, adDescription: true, postUrl: true },
      limit: 1,
    });
    const m = tinKhach[0];
    if (!m) continue;
    // Mã quảng cáo có thể nằm ở tin ĐẦU của hội thoại (lúc khách bấm vào), không phải tin cuối.
    const [coAd] = await db
      .select({ adId: schema.salesMessages.adId, adDescription: schema.salesMessages.adDescription, postUrl: schema.salesMessages.postUrl })
      .from(schema.salesMessages)
      .where(and(eq(schema.salesMessages.conversationId, ht.id), sql`${schema.salesMessages.adId} <> ''`))
      .limit(1);

    const kq = await resolveProduct(
      {
        conversationId: ht.id,
        pageId: ht.pageId,
        text: m.text,
        adId: m.adId || coAd?.adId || "",
        adDescription: m.adDescription || coAd?.adDescription || "",
        postUrl: m.postUrl || coAd?.postUrl || "",
      },
      db,
    );
    tong += 1;
    if (kq.productId) raSP += 1;
    const o = dem.get(kq.source) ?? { luot: 0, raSP: 0 };
    o.luot += 1;
    if (kq.productId) o.raSP += 1;
    dem.set(kq.source, o);

    await db.insert(schema.salesProductResolutions).values({
      conversationId: ht.id,
      messageId: m.id,
      productId: kq.productId,
      variantId: kq.variantId,
      productCode: kq.productCode,
      source: kq.source,
      confidence: kq.confidence,
      evidence: kq.evidence,
      candidateCount: kq.candidateCount,
    });
    const h = await learnAdMapping({ pageId: ht.pageId, adId: coAd?.adId ?? "", postUrl: coAd?.postUrl ?? "", adDescription: coAd?.adDescription ?? "", resolution: kq }, db);
    if (h.learned) hoc += 1;
  }

  console.log(`\n───────── KẾT QUẢ NHẬN DIỆN (${tong} hội thoại) ─────────`);
  for (const [nguon, o] of [...dem.entries()].sort((a, b) => b[1].luot - a[1].luot)) {
    console.log(`  ${PRODUCT_RESOLUTION_LABEL[nguon].padEnd(32)} ${String(o.luot).padStart(3)} lượt · ra sản phẩm ${o.raSP}`);
  }
  console.log(`  ─────`);
  console.log(`  TỶ LỆ NHẬN DIỆN: ${raSP}/${tong} (${tong ? Math.round((raSP / tong) * 100) : 0}%) · bản đồ quảng cáo học thêm ${hoc} khoá`);

  // ───── 4. KHOÁ QUẢNG CÁO CHƯA AI TRỎ ─────
  const chua = await db
    .select({ adKey: schema.salesMessages.adId, soHT: sql<number>`count(distinct ${schema.salesMessages.conversationId})::int`, cau: sql<string>`max(${schema.salesMessages.adDescription})` })
    .from(schema.salesMessages)
    .where(and(sql`${schema.salesMessages.adId} <> ''`, sql`not exists (select 1 from sales_ad_product_map m where m.ad_key = ${schema.salesMessages.adId})`))
    .groupBy(schema.salesMessages.adId)
    .orderBy(sql`count(distinct ${schema.salesMessages.conversationId}) desc`)
    .limit(20);
  console.log(`\n───────── QUẢNG CÁO CHƯA TRỎ SẢN PHẨM (${chua.length}) ─────────`);
  console.log(`(mở /ai/ad-map để trỏ một lần; sau đó mọi hội thoại từ quảng cáo ấy nhận ra đúng mẫu)`);
  for (const c of chua) console.log(`  ${c.adKey}  ${c.soHT} hội thoại  · ${(c.cau ?? "").replace(/\s+/g, " ").slice(0, 60)}`);

  console.log("\nXong. Không gọi mô hình, không gửi tin, không tạo đơn.");
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });
