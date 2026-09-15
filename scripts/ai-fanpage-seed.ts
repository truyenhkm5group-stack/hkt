/**
 * KHAI HỒ SƠ BÁN HÀNG CHO MỘT FANPAGE từ dòng lệnh, và xem lại kết quả phân loại.
 *
 *   npx tsx scripts/ai-fanpage-seed.ts --page=<PAGE_ID> [--name=...] [--product=Q004] \
 *       [--price=499000] [--ship=25000] [--mode=SHADOW] [--apply]
 *
 * Mặc định CHẠY THỬ. `--product` nhận MÃ HÀNG (không phải id nội bộ) để gõ cho nhanh.
 *
 * KHÔNG có mặc định cho `--product`: mẫu thắng là quyết định kinh doanh của chủ shop. Không khai
 * thì hồ sơ vẫn được tạo với mẫu thắng RỖNG, và mọi hội thoại rơi về `UNKNOWN` ⇒ chuyển người —
 * đúng hơn là đoán bừa một mẫu rồi tư vấn sai cả trăm cuộc.
 */
import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { classifyConversationSource } from "@/lib/ai-workforce/agents/sales/classify-source";
import { CLASSIFICATION_SOURCE_LABEL, SOURCE_TYPE_LABEL, type ClassificationSource, type SourceType } from "@/lib/constants/fanpage-sales";

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const apDung = process.argv.includes("--apply");
  const pageId = arg("page") ?? "";
  if (!pageId) { console.error("Thiếu --page=<PANCAKE_PAGE_ID>"); process.exit(1); }

  await ensureMigrated();
  const db = await getDb();

  const maHang = arg("product") ?? "";
  let productId: string | null = null;
  if (maHang) {
    const [sp] = await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.customId, maHang)).limit(1);
    if (!sp) { console.error(`Không tìm thấy mã hàng "${maHang}" trong danh mục`); process.exit(1); }
    productId = sp.id;
    console.log(`Mẫu thắng: ${maHang} · ${sp.name}`);
  } else {
    console.log("Mẫu thắng: (CHƯA KHAI) — hội thoại sẽ rơi về UNKNOWN và chuyển người");
  }

  const gia = arg("price") ? Number(arg("price")) : null;
  const ship = arg("ship") ? Number(arg("ship")) : null;
  const nac = arg("mode") ?? "SHADOW";

  const dangCo = await db.query.fanpageSalesProfiles.findFirst({ where: eq(schema.fanpageSalesProfiles.pancakePageId, pageId) });
  const doiBanChat = dangCo && (dangCo.activeProductId !== productId || dangCo.unitPrice !== gia || dangCo.shippingFee !== ship);

  console.log(`\nHồ sơ hiện tại: ${dangCo ? `bản ${dangCo.version}, mẫu ${dangCo.activeProductId ?? "(chưa khai)"}` : "(chưa có)"}`);
  console.log(`Sẽ ghi       : mẫu ${productId ?? "(chưa khai)"} · giá ${gia ?? "(chưa khai)"} · ship ${ship ?? "(chưa khai)"} · nấc ${nac}`);
  if (doiBanChat) console.log(`Bản hồ sơ    : ${dangCo!.version} → ${dangCo!.version + 1} (đổi mẫu/giá ⇒ bản mới; hội thoại CŨ giữ nguyên bản cũ)`);

  if (apDung) {
    const giaTri = {
      pancakePageId: pageId, name: arg("name") ?? dangCo?.name ?? "", aiMode: nac, active: true,
      activeProductId: productId, unitPrice: gia, shippingFee: ship,
    };
    if (dangCo) {
      await db.update(schema.fanpageSalesProfiles)
        .set({ ...giaTri, version: doiBanChat ? dangCo.version + 1 : dangCo.version, effectiveFrom: doiBanChat ? new Date() : dangCo.effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.fanpageSalesProfiles.id, dangCo.id));
    } else {
      await db.insert(schema.fanpageSalesProfiles).values({ ...giaTri, version: 1, effectiveFrom: new Date() });
    }
    console.log("Đã ghi hồ sơ.");
  } else {
    console.log("\n--dry-run (mặc định): KHÔNG ghi gì. Thêm --apply để lưu.");
  }

  // ── Xem phân loại sẽ ra sao trên chính các hội thoại đang có ──
  const ds = await db
    .select({ id: schema.salesConversations.id })
    .from(schema.salesConversations)
    .where(and(eq(schema.salesConversations.pageId, pageId), sql`exists (select 1 from sales_messages m where m.conversation_id = ${schema.salesConversations.id} and m.from_page = false and btrim(m.text) <> '')`))
    .limit(200);

  const demLoai = new Map<SourceType, number>();
  const demNguon = new Map<ClassificationSource, number>();
  for (const c of ds) {
    const kq = await classifyConversationSource({ conversationId: c.id, pancakePageId: pageId }, db);
    demLoai.set(kq.sourceType, (demLoai.get(kq.sourceType) ?? 0) + 1);
    demNguon.set(kq.classificationSource, (demNguon.get(kq.classificationSource) ?? 0) + 1);
  }

  console.log(`\n───────── PHÂN LOẠI ${ds.length} HỘI THOẠI CÓ TIN KHÁCH ─────────`);
  for (const [k, n] of [...demLoai.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${SOURCE_TYPE_LABEL[k].padEnd(20)} ${n}`);
  console.log("  ── căn cứ ──");
  for (const [k, n] of [...demNguon.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${CLASSIFICATION_SOURCE_LABEL[k].padEnd(26)} ${n}`);
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });
