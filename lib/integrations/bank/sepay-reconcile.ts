/**
 * ═══════ ĐỐI CHIẾU SEPAY: VÁ NHỮNG GÓI TIN WEBHOOK KHÔNG BAO GIỜ TỚI ═══════
 *
 * Quét lại một khoảng ngày qua API SePay rồi cho MỌI giao dịch đi qua ĐÚNG cửa ghi của webhook.
 * Giao dịch đã có ⇒ nhận là trùng, không đụng gì. Giao dịch chưa có ⇒ đó chính là gói tin đã mất,
 * và nó được vá vào sổ với `source = 'API'` để về sau còn truy được nó vào bằng đường nào.
 *
 * ─── VÌ SAO KHÔNG PHẢI HỆ THỐNG THỨ HAI ───
 *
 * Không có bảng riêng, không có khoá riêng, không có logic hợp nhất riêng. Cùng
 * `ingestSepayTransaction`, cùng `bank_ref`, cùng `bank_txn_provider_uq`. Chạy lại bao nhiêu lần
 * cũng vô hại — đó là điều kiện để một đường đối chiếu dám chạy tự động.
 *
 * ─── CHẠY THỬ PHẢI DỰ BÁO ĐÚNG CÁI SẼ XẢY RA ───
 *
 * Một lượt chạy thử nói "12 giao dịch mới" rồi lượt ghi thật chỉ tạo 3 dòng là lượt chạy thử VÔ
 * DỤNG — người ta đọc nó để quyết định có cho ghi hay không. Nên phần xem trước dùng ĐÚNG hai khoá
 * mà đường ghi dùng, theo ĐÚNG thứ tự:
 *
 *   1. mã SePay  (`provider` + `provider_txn_id`) — gói tin webhook đã ghi dòng này;
 *   2. mã bút toán ngân hàng (`bank_ref`)         — sao kê tải tay đã nhập, chưa webhook nào chạm.
 *
 * Bỏ bước 2 là LỖI THẬT có trong bản đầu: một giao dịch nhập từ file mà webhook làm mất sẽ bị đếm
 * là "mới", trong khi lượt ghi thật sẽ HỘI TỤ vào dòng cũ chứ không tạo dòng nào. Nay lượt ghi thật
 * còn tự đối chiếu lại con số của mình với con số xem trước và kêu lên nếu hai bên lệch.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { applyBankRules } from "@/lib/integrations/bank/apply-rules";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import { bankMatchKey, sepayBankRef, type SepayTransaction } from "@/lib/integrations/bank/sepay";
import { fetchSepayTransactionPage, mapSepayApiRow, webhookFailedAtProvider } from "@/lib/integrations/bank/sepay-api";

/** Trần an toàn: một lượt đối chiếu không được biến thành lượt kéo vô hạn. */
const MAX_PAGES = 50;
const PER_PAGE = 200;

const b = schema.bankTransactions;
const acc = schema.bankAccounts;

export type SepayReconcileResult = {
  configured: boolean;
  apply: boolean;
  from: string;
  to: string;
  /** Số giao dịch API trả về. */
  scanned: number;
  /** Đã có trong sổ, TÁCH THEO ĐƯỜNG ĐÃ TẠO DÒNG — để thấy đường nào đang làm việc của nó. */
  inLedgerFromWebhook: number;
  inLedgerFromImport: number;
  inLedgerFromApi: number;
  inLedgerFromManual: number;
  alreadyInLedger: number;
  /** THIẾU trong sổ: gói tin webhook không bao giờ tới. Con số quan trọng nhất của cả lượt chạy. */
  missing: number;
  /** Đã vá vào sổ (chỉ khi `apply`). */
  patched: number;
  /** Giao dịch mới sẽ/đã làm TIỀN VÀO của sổ tăng bấy nhiêu. */
  projectedIn: number;
  /** Giao dịch mới sẽ/đã làm TIỀN RA của sổ tăng bấy nhiêu. */
  projectedOut: number;
  /** Giao dịch mới trùng khoá lưới an toàn với một dòng KHÁC mã — nêu ra để người xem, KHÔNG tự gộp. */
  duplicateSuspects: number;
  /** Giao dịch thuộc tài khoản chưa ai xác nhận (hoặc tài khoản lần đầu xuất hiện). */
  accountUnconfirmed: number;
  /** Chính SePay nói gói tin gửi hỏng (`webhook_success = 0`). */
  providerSaysWebhookFailed: number;
  /** Dòng API đọc không ra — nêu tên, không bỏ qua im lặng. */
  unreadable: string[];
  /** Mâu thuẫn DỮ LIỆU giữa sổ và API (số tiền / mốc), hoặc giữa xem trước và ghi thật. */
  conflicts: string[];
  /**
   * Số dòng mà webhook và API mang hai mã nhà cung cấp khác nhau cho CÙNG một giao dịch.
   *
   * BÌNH THƯỜNG với SePay: webhook gửi số nguyên, API v2 trả UUID. Đếm để thấy quy mô, KHÔNG
   * xếp vào mâu thuẫn — nếu không, lượt chạy mỗi giờ sẽ đẻ ra một danh sách mâu thuẫn dài vô tận
   * và mâu thuẫn THẬT sẽ chìm trong đó.
   */
  providerIdMismatch: number;
  /** Hình dạng phong bì thật của API, để lần sau siết bộ đọc cho đúng. */
  shape: string;
};

function emptyResult(apply: boolean, from: Date, to: Date): SepayReconcileResult {
  return {
    configured: false,
    apply,
    from: from.toISOString(),
    to: to.toISOString(),
    scanned: 0,
    inLedgerFromWebhook: 0,
    inLedgerFromImport: 0,
    inLedgerFromApi: 0,
    inLedgerFromManual: 0,
    alreadyInLedger: 0,
    missing: 0,
    patched: 0,
    projectedIn: 0,
    projectedOut: 0,
    duplicateSuspects: 0,
    accountUnconfirmed: 0,
    providerSaysWebhookFailed: 0,
    unreadable: [],
    conflicts: [],
    providerIdMismatch: 0,
    shape: "",
  };
}

export type SepayPreview = {
  /** `null` = chưa có trong sổ. Khác null = đường vào ĐÃ TẠO dòng đó. */
  existingSource: string | null;
  duplicateSuspect: boolean;
  accountUnconfirmed: boolean;
};

/**
 * Xem trước MỘT giao dịch: sổ đã có chưa, và nếu chưa thì việc ghi nó sẽ chạm vào những gì.
 *
 * Bốn câu hỏi độc lập, bốn lượt hỏi có chỉ mục. Cố ý KHÔNG gộp thành một câu lệnh phức tạp: một
 * lượt đối chiếu chỉ vài trăm dòng, và một câu SQL dễ đọc sai đắt hơn nhiều so với vài mili giây.
 */
export async function previewSepayTransaction(db: Db, txn: SepayTransaction): Promise<SepayPreview> {
  const bankRef = sepayBankRef(txn);

  // 1 ─ Mã SePay: webhook (hoặc lượt đối chiếu trước) đã ghi dòng này.
  const theoMaSePay = await db
    .select({ source: b.source })
    .from(b)
    .where(and(eq(b.provider, "SEPAY"), eq(b.providerTxnId, txn.providerTxnId)))
    .limit(1);

  // 2 ─ Mã bút toán ngân hàng: sao kê tải tay đã nhập, chưa webhook nào chạm tới.
  const theoMaNganHang = theoMaSePay.length ? [] : await db.select({ source: b.source }).from(b).where(eq(b.bankRef, bankRef)).limit(1);

  const existingSource = theoMaSePay[0]?.source ?? theoMaNganHang[0]?.source ?? null;

  // 3 ─ Lưới an toàn: CHỈ hỏi cho giao dịch sẽ tạo dòng mới. Dòng đã có thì nó nằm sẵn trong sổ,
  //     hỏi thêm chỉ đếm trùng chính nó.
  let duplicateSuspect = false;
  if (!existingSource) {
    const key = bankMatchKey({ amount: txn.amount, txnAt: txn.txnAt });
    const nghi = await db
      .select({ id: b.id })
      .from(b)
      .where(and(eq(b.matchKey, key), ne(b.bankRef, bankRef)))
      .limit(1);
    duplicateSuspect = nghi.length > 0;
  }

  // 4 ─ Tài khoản: chưa có nghĩa là sẽ được tự khai ở trạng thái chờ xác nhận.
  const taiKhoan = await db
    .select({ status: acc.status })
    .from(acc)
    .where(
      and(
        eq(acc.provider, "SEPAY"),
        eq(acc.gateway, txn.gateway),
        eq(acc.accountNumber, txn.accountNumber),
        eq(acc.subAccount, txn.subAccount),
      ),
    )
    .limit(1);
  const accountUnconfirmed = !taiKhoan.length || taiKhoan[0].status === "UNCONFIRMED";

  return { existingSource, duplicateSuspect, accountUnconfirmed };
}

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

  // Chưa có token thì KHÔNG ghi một lần chạy nào: một job im lặng không làm gì mỗi giờ sẽ chôn
  // `sync_runs` dưới hàng trăm dòng vô nghĩa và làm hỏng chính chỗ để nhìn ra sự cố thật.
  if (!env.sepay.apiToken) return emptyResult(apply, from, to);

  const db = options.db ?? (await getDb());

  const { result } = await runSyncJob(
    { source: "SEPAY", job: "sepay_reconcile", trigger: options.trigger ?? "MANUAL", actor: options.actor ?? "system" },
    async (ctx) => {
      const out = { ...emptyResult(apply, from, to), configured: true };
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
          const txn = mapped.txn;

          // Xem trước LUÔN chạy, cả ở lượt ghi thật: đó là cách con số của hai lượt giống nhau, và
          // là cách người đọc tin được lượt chạy thử.
          const truoc = await previewSepayTransaction(db, txn);
          if (truoc.accountUnconfirmed) out.accountUnconfirmed += 1;

          if (truoc.existingSource) {
            out.alreadyInLedger += 1;
            if (truoc.existingSource === "WEBHOOK") out.inLedgerFromWebhook += 1;
            else if (truoc.existingSource === "IMPORT") out.inLedgerFromImport += 1;
            else if (truoc.existingSource === "API") out.inLedgerFromApi += 1;
            else out.inLedgerFromManual += 1;
          } else {
            out.missing += 1;
            if (truoc.duplicateSuspect) out.duplicateSuspects += 1;
            if (txn.amount > 0) out.projectedIn += txn.amount;
            else out.projectedOut += -txn.amount;
          }

          if (!apply) {
            ctx.summary.skipped += 1;
            continue;
          }

          const outcome = await ingestSepayTransaction(db, txn, { source: "API" });
          if (outcome.created) {
            out.patched += 1;
            newIds.push(outcome.transactionId);
            ctx.summary.imported += 1;
          } else {
            ctx.summary.skipped += 1;
          }
          if (outcome.providerIdMismatch) out.providerIdMismatch += 1;
          if (outcome.conflict) out.conflicts.push(`${txn.referenceCode || txn.providerTxnId}: ${outcome.conflict}`);
        }

        const hetTrang = pageData.hasMore === false || (pageData.hasMore === null && pageData.rows.length < PER_PAGE);
        if (hetTrang) break;
      }

      // Gán nhãn theo quy tắc CHỈ cho dòng vừa vá — quét cả bảng cho một lượt đối chiếu là phí.
      if (newIds.length) await applyBankRules(db, { ids: newIds });

      // XEM TRƯỚC PHẢI KHỚP VIỆC ĐÃ LÀM. Lệch nghĩa là đường xem trước và đường ghi đang nhận diện
      // giao dịch theo hai cách khác nhau — và khi đó không ai còn tin được lượt chạy thử nữa.
      if (apply && out.patched !== out.missing) {
        out.conflicts.push(
          `xem trước nói ${out.missing} giao dịch mới nhưng ghi thật tạo ${out.patched} dòng — hai đường đang nhận diện khác nhau`,
        );
      }

      ctx.summary.detail = [
        `${days} ngày · quét ${out.scanned}`,
        `đã có ${out.alreadyInLedger} (webhook ${out.inLedgerFromWebhook} · file ${out.inLedgerFromImport} · api ${out.inLedgerFromApi})`,
        `thiếu ${out.missing}`,
        apply ? `đã vá ${out.patched}` : "CHẠY THỬ (chưa ghi)",
        out.duplicateSuspects ? `nghi trùng ${out.duplicateSuspects}` : "",
        out.providerIdMismatch ? `khác mã nhà cung cấp ${out.providerIdMismatch} (bình thường với SePay)` : "",
        out.accountUnconfirmed ? `tài khoản chưa xác nhận ${out.accountUnconfirmed}` : "",
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

  return result ?? { ...emptyResult(apply, from, to), configured: true };
}

/** Tổng sổ hiện tại — in trước/sau một lượt ghi thật thì thấy ngay có nhân đôi hay không. */
export async function bankLedgerTotals(db: Db) {
  const [r] = await db
    .select({
      rows: sql<number>`count(*)`,
      inflow: sql<number>`coalesce(sum(case when ${b.amount} > 0 then ${b.amount} else 0 end), 0)`,
      outflow: sql<number>`coalesce(sum(case when ${b.amount} < 0 then -${b.amount} else 0 end), 0)`,
    })
    .from(b);
  return { rows: Number(r.rows), inflow: Number(r.inflow), outflow: Number(r.outflow) };
}
