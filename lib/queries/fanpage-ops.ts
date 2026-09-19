import { and, count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
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
  };
}
