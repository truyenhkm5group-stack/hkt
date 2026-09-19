import { and, count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { env } from "@/lib/env";

/**
 * TÌNH TRẠNG VẬN HÀNH CỦA MỘT FANPAGE — trả lời đúng một câu: **đường dữ liệu có đang sống không**.
 *
 * Tách hẳn khỏi `lib/queries/fanpage-sales.ts`, vốn trả lời một câu khác hẳn: *page này đang bán mẫu
 * nào, khai đủ dữ kiện chưa*. Gộp hai câu vào một hàm thì người trực mở màn hình ra không biết con
 * số nào nói về cái gì — và "chưa khai giá" với "hai ngày không nhận được tin nào" là hai việc của
 * hai người khác nhau.
 *
 * ═══ HAI ĐỒNG HỒ, KHÔNG GỘP ═══
 *
 * `lastRunAt` = vòng đọc gần nhất, KỂ CẢ vòng hỏng. `lastOkAt` = vòng CHẠY ĐƯỢC gần nhất. Gộp lại
 * thì một bộ nạp hỏng liên tục vẫn trông như đang sống, vì nó vẫn "chạy" đều đặn.
 *
 * ═══ KHÔNG BAO GIỜ IN KHOÁ ═══
 *
 * Kho mã này PUBLIC. Tình trạng chứng thư chỉ có hai giá trị — có khai hay chưa — và độ dài để
 * phân biệt "khai rỗng" với "chưa khai". Không có đường nào từ đây ra giá trị thật của token.
 */

/** Chứng thư đọc Pancake của một page: CHỈ nói có hay không, không bao giờ nói là gì. */
export type CredentialStatus = {
  /** Token của CHÍNH page (phạm vi hẹp — phương án đúng cho một bản chạy thử cắm vào dữ liệu thật). */
  hasPageToken: boolean;
  /** Token người dùng (mở mọi page của tài khoản). */
  hasUserToken: boolean;
  /** `PANCAKE_PAGE_ID` đang khai có trùng page đang xem không — token page chỉ mở đúng page của nó. */
  pageTokenMatchesThisPage: boolean;
  ok: boolean;
  /** Câu tiếng Việt nói thẳng thiếu gì và phải làm gì. */
  note: string;
};

export type FanpageOps = {
  pancakePageId: string;
  facebookPageId: string;
  name: string;
  aiMode: string;
  hasProfile: boolean;
  credential: CredentialStatus;
  /** Mốc đọc — `null` = CHƯA LẦN NÀO, không phải "vừa xong". */
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastCustomerMessageAt: Date | null;
  lastError: string;
  consecutiveErrors: number;
  /** Cộng dồn từ sổ mốc đọc (bộ nạp tự đếm). */
  cursorMessagesIngested: number;
  /** ĐẾM THẬT trong CSDL — đặt cạnh con số cộng dồn ở trên có chủ ý: hai con số lệch nhau nghĩa là
   *  có đường ghi thứ hai (webhook) hoặc sổ mốc đã bị dựng lại. */
  conversations: number;
  messages: number;
  customerMessages: number;
  employeeMessages: number;
  /** Lượt chạy nhân sự AI trên page này. */
  aiRuns7d: number;
  aiErrors7d: number;
  lastAiRunAt: Date | null;
  /** Danh mục làm nền cho page: mã WIN đang khai và số mẫu mã của nó trong ERP. */
  catalogProductCode: string;
  catalogVariants: number;
  catalogPriceDeclared: boolean;
  /**
   * CHỖ HỔNG DỮ LIỆU ĐANG TỐN BAO NHIÊU — 14 ngày gần nhất, đếm theo LÝ DO CHUYỂN NGƯỜI.
   *
   * Màn hình khai bảng số đo vốn đã nói "CHƯA CÓ — máy chuyển người ở mọi câu hỏi size". Đúng,
   * nhưng nó không nói điều đó tốn gì, nên nó đọc như một mục cấu hình còn trống chứ không như
   * một việc phải làm. Một con số đứng cạnh biến cùng câu chữ ấy thành một ưu tiên.
   */
  handoffs14d: { reason: string; count: number }[];
  handoffTotal14d: number;
  runsTotal14d: number;
  /** Lượt chạy KHÔNG nối được về một mã hàng / mẫu mã / giá — ba chỗ hổng nền tảng của §grounding. */
  runsWithoutProduct14d: number;
  runsWithoutVariant14d: number;
  runsWithoutPrice14d: number;
};

function credentialStatus(pancakePageId: string): CredentialStatus {
  const hasPageToken = env.pancake.pageAccessToken.length > 0;
  const hasUserToken = env.pancake.pagesAccessToken.length > 0;
  const pageTokenMatchesThisPage = hasPageToken && env.pancake.pageId === pancakePageId;
  const ok = pageTokenMatchesThisPage || hasUserToken;
  const note = pageTokenMatchesThisPage
    ? "Token của chính page này — phạm vi hẹp, đúng cho bản chạy thử"
    : hasUserToken
      ? "Đang dùng token NGƯỜI DÙNG (mở mọi page của tài khoản). Khai PANCAKE_PAGE_ACCESS_TOKEN cho riêng page này thì phạm vi hẹp hơn."
      : hasPageToken
        ? `Có token page nhưng nó thuộc page ${env.pancake.pageId || "(chưa khai mã)"}, KHÔNG phải page này — token của một page chỉ mở đúng page ấy`
        : "CHƯA khai chứng thư nào — không đọc được hội thoại của page này";
  return { hasPageToken, hasUserToken, pageTokenMatchesThisPage, ok, note };
}

export async function fanpageOps(pancakePageId: string): Promise<FanpageOps> {
  const db = await getDb();
  const c = schema.salesConversations;
  const m = schema.salesMessages;
  const r = schema.aiRuns;
  const bayNgay = new Date(Date.now() - 7 * 86_400_000);

  const [profile, cursor, convRow, msgRow, runRow] = await Promise.all([
    db.query.fanpageSalesProfiles.findFirst({ where: eq(schema.fanpageSalesProfiles.pancakePageId, pancakePageId) }),
    db.query.salesIngestCursors.findFirst({ where: eq(schema.salesIngestCursors.pageId, pancakePageId) }),
    db.select({ n: count() }).from(c).where(eq(c.pageId, pancakePageId)),
    db
      .select({
        total: count(),
        // Tin của KHÁCH và tin của SHOP đếm riêng: một page chỉ toàn tin shop nghĩa là bộ nạp đọc
        // được nhưng khách chưa nhắn, khác hẳn một page không đọc được gì.
        customer: sql<number>`count(*) filter (where not ${m.fromPage})`,
        employee: sql<number>`count(*) filter (where ${m.fromPage})`,
      })
      .from(m)
      .innerJoin(c, eq(c.id, m.conversationId))
      .where(eq(c.pageId, pancakePageId)),
    db
      .select({
        runs: sql<number>`count(*) filter (where ${r.startedAt} >= ${bayNgay})`,
        errors: sql<number>`count(*) filter (where ${r.startedAt} >= ${bayNgay} and ${r.error} is not null)`,
        last: sql<Date | null>`max(${r.startedAt})`,
      })
      .from(r)
      .innerJoin(c, eq(c.id, r.subjectId))
      .where(and(eq(c.pageId, pancakePageId), eq(r.subjectType, "CONVERSATION"))),
  ]);

  let catalogProductCode = "";
  let catalogVariants = 0;
  if (profile?.activeProductId) {
    const [sp] = await db
      .select({ ma: schema.products.customId, n: sql<number>`(select count(*) from ${schema.productVariants} v where v.product_id = ${schema.products.id})` })
      .from(schema.products)
      .where(eq(schema.products.id, profile.activeProductId))
      .limit(1);
    catalogProductCode = sp?.ma ?? "";
    catalogVariants = Number(sp?.n ?? 0);
  }

  /*
    ĐẾM THEO LÝ DO CHUYỂN NGƯỜI, 14 ngày.

    Đếm theo `sales_suggestions.action` chứ KHÔNG theo `ai_runs.status`: `status` dựng từ bản quyết
    định ĐƯỢC PHÉP, mà ở nấc bóng hội thoại có người vào thì bản ấy luôn là `NO_ACTION` ⇒ `SUCCEEDED`.
    Đếm bằng nó là đếm hụt đúng những lượt đáng xem nhất. `action` là bản ĐỂ CHẤM, cùng bản mà mọi
    báo cáo chất lượng khác đang đọc — hai chỗ phải nói cùng một con số.

    Lý do cũng lấy từ bản để chấm (`decision->'evaluation'`), lùi về bản được phép cho những lượt
    chạy TRƯỚC bản vá lưu bản để chấm. Lượt không ghi được mã lý do nào hiện thành MỘT DÒNG RIÊNG,
    không lặng lẽ rơi khỏi bảng — luật 13 đòi mọi lần chuyển người mang mã lý do, nên số lượt thiếu
    mã chính là số lần luật ấy đang bị vi phạm.
  */
  const muoiBonNgay = new Date(Date.now() - 14 * 86_400_000);
  const handoffRows = rowsOf<{ reason: string; n: number }>(
    await db.execute(sql`
      select coalesce(
               nullif(r.decision->'evaluation'->>'handoffReason', ''),
               nullif(r.decision->>'handoffReason', ''),
               '(chưa ghi mã lý do)'
             ) as reason,
             count(*)::int as n
        from sales_suggestions s
        join sales_conversations c on c.id = s.conversation_id
        left join ai_runs r on r.id = s.run_id
       where c.page_id = ${pancakePageId}
         and s.created_at >= ${muoiBonNgay}
         and s.action = 'HANDOFF_HUMAN'
       group by 1 order by 2 desc
    `),
  ).map((x) => ({ reason: String(x.reason), count: Number(x.n) }));

  const [nen] = rowsOf<{ tong: number; khong_sp: number; khong_mm: number; khong_gia: number }>(
    await db.execute(sql`
      select count(*)::int                                                              as tong,
             count(*) filter (where coalesce(r.state_after->>'productId', '') = '')::int as khong_sp,
             count(*) filter (where coalesce(r.state_after->>'variantId', '') = '')::int as khong_mm,
             count(*) filter (where r.state_after->>'quotedTotal' is null)::int          as khong_gia
        from sales_suggestions s
        join sales_conversations c on c.id = s.conversation_id
        join ai_runs r on r.id = s.run_id
       where c.page_id = ${pancakePageId} and s.created_at >= ${muoiBonNgay}
    `),
  );

  return {
    pancakePageId,
    facebookPageId: profile?.facebookPageId ?? "",
    name: profile?.name ?? "",
    aiMode: profile?.aiMode ?? "SHADOW",
    hasProfile: Boolean(profile),
    credential: credentialStatus(pancakePageId),
    lastRunAt: cursor?.lastRunAt ?? null,
    lastOkAt: cursor?.lastOkAt ?? null,
    lastCustomerMessageAt: cursor?.lastMessageAt ?? null,
    lastError: cursor?.lastError ?? "",
    consecutiveErrors: cursor?.consecutiveErrors ?? 0,
    cursorMessagesIngested: cursor?.messagesIngested ?? 0,
    conversations: Number(convRow[0]?.n ?? 0),
    messages: Number(msgRow[0]?.total ?? 0),
    customerMessages: Number(msgRow[0]?.customer ?? 0),
    employeeMessages: Number(msgRow[0]?.employee ?? 0),
    aiRuns7d: Number(runRow[0]?.runs ?? 0),
    aiErrors7d: Number(runRow[0]?.errors ?? 0),
    lastAiRunAt: runRow[0]?.last ? new Date(runRow[0].last as unknown as string) : null,
    catalogProductCode,
    catalogVariants,
    // `unitPrice` là `null` khi CHƯA KHAI — khác hẳn 0. Máy không báo giá khi chưa khai.
    catalogPriceDeclared: profile?.unitPrice !== null && profile?.unitPrice !== undefined,
    handoffs14d: handoffRows,
    handoffTotal14d: handoffRows.reduce((a, x) => a + x.count, 0),
    runsTotal14d: Number(nen?.tong ?? 0),
    runsWithoutProduct14d: Number(nen?.khong_sp ?? 0),
    runsWithoutVariant14d: Number(nen?.khong_mm ?? 0),
    runsWithoutPrice14d: Number(nen?.khong_gia ?? 0),
  };
}
