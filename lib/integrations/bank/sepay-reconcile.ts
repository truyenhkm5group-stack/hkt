/**
 * ═══════ ĐỐI CHIẾU SEPAY: VÁ NHỮNG GÓI TIN WEBHOOK KHÔNG BAO GIỜ TỚI ═══════
 *
 * Quét lại một khoảng ngày qua API SePay rồi cho MỌI giao dịch đi qua đúng cửa ghi của webhook.
 * Giao dịch đã có ⇒ nhận là trùng, không đụng gì. Giao dịch chưa có ⇒ đó chính là gói tin đã mất,
 * và nó được vá vào sổ với `source = 'API'` để về sau còn truy được nó vào bằng đường nào.
 *
 * ─── VÌ SAO KHÔNG PHẢI HỆ THỐNG THỨ HAI ───
 *
 * Không có bảng riêng, không có khoá riêng, không có logic hợp nhất riêng. Cùng
 * `ingestSepayTransaction`, cùng `bank_ref`, cùng `bank_txn_provider_uq`. Chạy lại bao nhiêu lần
 * cũng vô hại — đó là điều kiện để một đường đối chiếu dám chạy tự động.
 *
 * ─── MẶC ĐỊNH CHẠY THỬ ───
 *
 * `apply` mặc định `false`. Mã này chưa từng chạy với API thật (chủ shop chưa tạo token), nên lần
 * đầu phải NHÌN xem nó định ghi gì rồi mới cho ghi. Cùng quy ước với `vtp-rebuild-state`,
 * `cod-rebuild`, `cod-status-repair` của kho này.
 */
import type { Db } from "@/db";
import { getDb } from "@/db";
import { env } from "@/lib/env";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { applyBankRules } from "@/lib/integrations/bank/apply-rules";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import { fetchSepayTransactionPage, mapSepayApiRow, webhookFailedAtProvider } from "@/lib/integrations/bank/sepay-api";

/** Trần an toàn: một lượt đối chiếu không được biến thành lượt kéo vô hạn. */
const MAX_PAGES = 50;
const PER_PAGE = 200;

export type SepayReconcileResult = {
  configured: boolean;
  apply: boolean;
  from: string;
  to: string;
  /** Số giao dịch API trả về. */
  scanned: number;
  /** Đã có trong sổ — đường webhook đã làm đúng việc của nó. */
  alreadyInLedger: number;
  /** THIẾU trong sổ: gói tin webhook không bao giờ tới. Đây là con số quan trọng nhất của cả lượt chạy. */
  missing: number;
  /** Đã vá vào sổ (chỉ khi `apply`). */
  patched: number;
  /** Chính SePay nói gói tin gửi hỏng (`webhook_success = 0`). */
  providerSaysWebhookFailed: number;
  /** Dòng API đọc không ra — nêu tên, không bỏ qua im lặng. */
  unreadable: string[];
  /** Mâu thuẫn giữa sổ và API trên cùng một giao dịch. */
  conflicts: string[];
  /** Hình dạng phong bì thật của API, để lần sau siết bộ đọc cho đúng. */
  shape: string;
};

export async function reconcileSepay(options: {
  days?: number;
  apply?: boolean;
  trigger?: SyncTrigger;
  actor?: string;
  db?: Db;
}): Promise<SepayReconcileResult> {
  const days = Math.max(1, Math.min(options.days ?? 7, 180));
  const apply = options.apply ?? false;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const empty: SepayReconcileResult = {
    configured: false,
    apply,
    from: from.toISOString(),
    to: to.toISOString(),
    scanned: 0,
    alreadyInLedger: 0,
    missing: 0,
    patched: 0,
    providerSaysWebhookFailed: 0,
    unreadable: [],
    conflicts: [],
    shape: "",
  };

  // Chưa có token thì KHÔNG ghi một lần chạy nào: một job im lặng không làm gì mỗi giờ sẽ chôn
  // `sync_runs` dưới hàng trăm dòng vô nghĩa và làm hỏng chính chỗ để nhìn ra sự cố thật.
  if (!env.sepay.apiToken) return empty;

  const db = options.db ?? (await getDb());

  const { result } = await runSyncJob(
    { source: "SEPAY", job: "sepay_reconcile", trigger: options.trigger ?? "MANUAL", actor: options.actor ?? "system" },
    async (ctx) => {
      const out: SepayReconcileResult = { ...empty, configured: true };
      const newIds: string[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        const pageData = await fetchSepayTransactionPage({ from, to, page, perPage: PER_PAGE });
        if (page === 1) out.shape = pageData.shape;
        if (!pageData.rows.length) break;

        for (const row of pageData.rows) {
          out.scanned += 1;
          if (webhookFailedAtProvider(row)) out.providerSaysWebhookFailed += 1;

          const mapped = mapSepayApiRow(row);
          if (!mapped.ok) {
            out.unreadable.push(mapped.error);
            ctx.summary.failed += 1;
            continue;
          }

          if (!apply) {
            // CHẠY THỬ: chỉ hỏi sổ, không ghi. Dùng đúng khoá mà đường ghi sẽ dùng.
            const có = await daCoTrongSo(db, mapped.txn.providerTxnId);
            if (có) out.alreadyInLedger += 1;
            else out.missing += 1;
            continue;
          }

          const outcome = await ingestSepayTransaction(db, mapped.txn, { source: "API" });
          if (outcome.created) {
            out.missing += 1;
            out.patched += 1;
            newIds.push(outcome.transactionId);
            ctx.summary.imported += 1;
          } else {
            out.alreadyInLedger += 1;
            ctx.summary.skipped += 1;
          }
          if (outcome.conflict) out.conflicts.push(`${mapped.txn.referenceCode || mapped.txn.providerTxnId}: ${outcome.conflict}`);
        }

        const hetTrang = pageData.hasMore === false || (pageData.hasMore === null && pageData.rows.length < PER_PAGE);
        if (hetTrang) break;
      }

      // Gán nhãn theo quy tắc CHỈ cho dòng vừa vá — quét cả bảng cho một lượt đối chiếu là phí.
      if (newIds.length) await applyBankRules(db, { ids: newIds });

      ctx.summary.detail = [
        `${days} ngày · quét ${out.scanned}`,
        `đã có ${out.alreadyInLedger}`,
        `thiếu ${out.missing}`,
        apply ? `đã vá ${out.patched}` : "CHẠY THỬ (chưa ghi)",
        out.providerSaysWebhookFailed ? `SePay báo gửi hỏng ${out.providerSaysWebhookFailed}` : "",
        out.unreadable.length ? `đọc không ra ${out.unreadable.length}` : "",
        out.conflicts.length ? `mâu thuẫn ${out.conflicts.length}` : "",
        out.shape,
      ]
        .filter(Boolean)
        .join(" · ");

      return out;
    },
  );

  return result ?? { ...empty, configured: true };
}

/** Sổ đã có giao dịch mang mã SePay này chưa — hỏi đúng cột mà ràng buộc chống trùng dùng. */
async function daCoTrongSo(db: Db, providerTxnId: string): Promise<boolean> {
  const { schema } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const b = schema.bankTransactions;
  const rows = await db
    .select({ id: b.id })
    .from(b)
    .where(and(eq(b.provider, "SEPAY"), eq(b.providerTxnId, providerTxnId)))
    .limit(1);
  return rows.length > 0;
}
