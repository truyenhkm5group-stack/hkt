import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { renderTemplate, shortName } from "@/lib/constants/outreach";
import { loadOutreachConfig, nurtureVars } from "@/lib/outreach/build";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { classifyOutreachError } from "@/lib/constants/outreach-errors";

/**
 * Gửi tin cho các mục đã chọn (chỉ PENDING đã đến hạn, có hội thoại Pancake). Tôn trọng giới hạn ngày và giãn cách 1,5 giây.
 * Băn khoăn nhiều bước: gửi xong bước k → chuẩn bị bước k+1, hẹn sau nurtureStepGapDays ngày; hết bước → SENT.
 */
export async function sendOutreachTargets(ids: string[], actor: string, options: { dryRun?: boolean } = {}) {
  const db = await getDb();
  const cfg = await loadOutreachConfig();
  const client = getPancakePagesClient();
  const t = schema.outreachTargets;
  const [sentToday] = await db.select({ count: sql<number>`count(*)` }).from(t).where(gte(t.sentAt, new Date(Date.now() - 86_400_000)));
  let remaining = Math.max(0, cfg.dailyLimit - Number(sentToday?.count ?? 0));
  /*
    ═══ GIỮ CHỖ NGUYÊN TỬ — BẤM HAI LẦN KHÔNG GỬI HAI TIN ═══

    Bản cũ ĐỌC các dòng `PENDING` rồi gửi. Hai lượt chạy song song (người dùng bấm hai lần, hoặc
    bấm rồi job nền chạy) cùng đọc thấy đúng những dòng đó và cùng gửi — khách nhận hai tin giống
    hệt nhau, và không có gì trong dữ liệu nói rằng đã có hai lượt.

    Nay dùng một lệnh `UPDATE … WHERE status = 'PENDING' RETURNING`: Postgres chỉ cho MỘT lượt
    thắng trên mỗi dòng, và lượt đó nhận về đúng danh sách nó vừa giành được. Lượt thua nhận danh
    sách rỗng và không gửi gì. Không cần khoá, không cần hàng đợi.

    ĐIỀU KIỆN "ĐẾN HẠN" NẰM NGAY TRONG LỆNH GIÀNH CHỖ, không phải trong vòng lặp phía sau.
    `isDue()` đòi `status === 'PENDING'`; giành chỗ xong thì dòng đã là `SENDING`, nên gọi `isDue`
    sau đó sẽ trả về `false` cho MỌI dòng và đường gửi đứng im hoàn toàn. Bài kiểm bắt được đúng
    điều này — nó là một sự cố im lặng, không lỗi, không dòng đỏ, chỉ là không tin nào đi.
  */
  const denHan = sql`(${t.nextAt} is null or ${t.nextAt} <= now())`;
  const claimed = await db
    .update(t)
    .set({ status: "SENDING", updatedAt: new Date() })
    .where(and(inArray(t.id, ids), eq(t.status, "PENDING"), denHan))
    .returning();
  const targets = claimed;

  // Dòng được yêu cầu nhưng CHƯA tới hạn: không giành, không đụng, chỉ đếm để báo lại.
  const [chuaToiHan] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(and(inArray(t.id, ids), eq(t.status, "PENDING"), sql`not ${denHan}`));

  /** Trả một dòng đã giành về `PENDING` khi chưa thực sự gửi đi — không để nó kẹt ở `SENDING`. */
  const traLai = async (id: string, patch: Record<string, unknown> = {}) => {
    await db.update(t).set({ status: "PENDING", updatedAt: new Date(), ...patch }).where(eq(t.id, id));
  };

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const notDue = Number(chuaToiHan?.n ?? 0);
  for (const row of targets) {
    if (!row.pageId || !row.conversationId) {
      await db.update(t).set({ status: "SKIPPED", error: "Không có hội thoại Pancake — nhắn qua Zalo/SMS", errorKind: "NO_CONVERSATION", updatedAt: new Date() }).where(eq(t.id, row.id));
      skipped += 1;
      continue;
    }
    if (remaining <= 0) {
      // Hết hạn mức ngày KHÔNG phải lỗi của dòng này — trả về `PENDING` để mai gửi tiếp.
      await traLai(row.id);
      skipped += 1;
      continue;
    }
    const r = options.dryRun ? { ok: true as const } : await client.sendMessage(row.pageId, row.conversationId, row.pancakeCustomerId, row.message);
    const now = new Date();
    let mediaNote = "";
    if (r.ok && !options.dryRun && Array.isArray(row.mediaUrls) && row.mediaUrls.length) {
      const failures: string[] = [];
      for (const url of row.mediaUrls.slice(0, cfg.maxMediaPerMessage)) {
        await new Promise((res) => setTimeout(res, 800));
        const a = await client.sendAttachment(row.pageId, row.conversationId, row.pancakeCustomerId, url);
        if (!a.ok) failures.push(a.error ?? "lỗi");
      }
      if (failures.length) mediaNote = `Ảnh/video: ${failures.length}/${row.mediaUrls.length} gửi lỗi (${failures[0].slice(0, 120)})`;
    }
    if (r.ok) {
      const steps = row.segment === "NURTURE" ? cfg.nurtureSteps : [row.message];
      const nextStep = row.step + 1;
      if (nextStep < steps.length) {
        const nextMessage = renderTemplate(steps[nextStep], nurtureVars(cfg, shortName(row.customerName), row.suggestions));
        await db.update(t).set({ status: "PENDING", step: nextStep, message: nextMessage, sentCount: row.sentCount + 1, sentAt: now, sentBy: actor, nextAt: new Date(now.getTime() + cfg.nurtureStepGapDays * 86_400_000), error: mediaNote, errorKind: mediaNote ? "CONTENT_REJECTED" : null, providerMessageId: "id" in r ? (r.id ?? null) : null, acceptedAt: now, attemptCount: row.attemptCount + 1, updatedAt: now }).where(eq(t.id, row.id));
      } else {
        /*
          `SENT` CHỈ KHI NHÀ CUNG CẤP XÁC NHẬN. `acceptedAt` là mốc họ nhận, khác `sentAt` là lúc
          ta bấm — và `providerMessageId` là thứ duy nhất chứng minh tin đã sang tới họ, thay vì ta
          tự tin rằng nó đã đi.
        */
        await db.update(t).set({ status: "SENT", step: nextStep, sentCount: row.sentCount + 1, sentAt: now, sentBy: actor, nextAt: null, error: mediaNote, errorKind: mediaNote ? "CONTENT_REJECTED" : null, providerMessageId: "id" in r ? (r.id ?? null) : null, acceptedAt: now, attemptCount: row.attemptCount + 1, updatedAt: now }).where(eq(t.id, row.id));
      }
      sent += 1;
      remaining -= 1;
    } else {
      // Phân loại NGAY lúc ghi, để bảng lỗi nói được VIỆC PHẢI LÀM thay vì chỉ in nguyên văn của Meta.
      const nguyenVan = ("error" in r && r.error ? r.error : "Gửi thất bại").slice(0, 300);
      const loai = classifyOutreachError(nguyenVan);
      await db.update(t).set({ status: "FAILED", error: nguyenVan, errorKind: loai.kind, attemptCount: row.attemptCount + 1, updatedAt: now }).where(eq(t.id, row.id));
      failed += 1;
    }
    if (!options.dryRun) await new Promise((res) => setTimeout(res, 1500));
  }
  return { sent, failed, skipped, notDue, remainingToday: remaining };
}
