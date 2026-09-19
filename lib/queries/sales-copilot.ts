/**
 * HÀNG ĐỢI NẤC TRỢ LÝ — lớp ĐỌC.
 *
 * Không hàm nào trong tệp này ghi. Mọi đường ghi nằm ở `lib/actions/ai-copilot.ts`, và đó là điều
 * kiểm thử quét lại được ở mức mã nguồn.
 */
import { desc, eq, sql } from "drizzle-orm";
import { loadWinKnowledge } from "@/lib/queries/sales-knowledge";
import { LIVE_INGEST_ENV, liveIngestHealth, type LiveIngestHealth } from "@/lib/constants/live-ingest";
import { getDb, schema, type Db } from "@/db";
import { AUTOMATION_TEMPLATE_MIN_CONVERSATIONS, COPILOT_MEANINGFUL_EDIT_RATIO, COPILOT_PAGES_KEY, COPILOT_QUEUE_RELEVANT_HOURS, COPILOT_SUGGESTION_TTL_MINUTES, COPILOT_TERMINAL_SQL_LIST, HUMAN_REPLY_SQL_LIST, PILOT_REVIEWED_TURNS_TARGET, type CopilotWarning } from "@/lib/constants/sales-copilot";
import { rowsOf } from "@/lib/sql-rows";
import { SAFETY_FLAG_LABEL, type SafetyFlag } from "@/lib/constants/sales-quality";
import {
  GUARD_REJECT_PREFIX,
  ORDER_WRITE_TOOLS,
  SAFETY_FLAG_TO_KIND,
  SAFETY_KIND_SPEC,
  SAFETY_VIOLATION_KINDS,
  safetyVerdict,
  type SafetyVerdict,
  type SafetyViolationKind,
} from "@/lib/constants/sales-safety";

/**
 * DANH SÁCH TRẮNG PAGE ĐƯỢC THÍ ĐIỂM.
 *
 * Rỗng ⇒ KHÔNG page nào gửi được. Mặc định rơi về phía hẹp hơn: quên khai thì không ai nhắn được
 * cho khách, chứ không phải mọi page cùng mở.
 */
export async function copilotPages(db?: Db): Promise<string[]> {
  const conn = db ?? (await getDb());
  // Đọc thẳng dòng `settings`: `getSettingJson` trộn với một giá trị mặc định dạng OBJECT, còn đây
  // là một MẢNG — trộn vào nhau thì ra một thứ không phải mảng cũng không phải object.
  const row = await conn.query.settings.findFirst({ where: eq(schema.settings.key, COPILOT_PAGES_KEY) }).catch(() => null);
  if (!row) return [];
  try {
    const raw = JSON.parse(row.value) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((v) => String(v ?? "").trim()).filter(Boolean);
  } catch {
    // Cấu hình hỏng ⇒ KHÔNG page nào gửi được. Nhánh lỗi rơi về phía hẹp hơn.
    return [];
  }
}

export async function copilotPageAllowed(pageId: string, db?: Db): Promise<boolean> {
  const id = String(pageId ?? "").trim();
  if (!id) return false;
  return (await copilotPages(db)).includes(id);
}

export type CopilotQueueRow = {
  conversationId: string;
  suggestionId: string | null;
  runId: string | null;
  pageId: string;
  externalId: string;
  customerName: string;
  sourceType: string;
  stage: string;
  productName: string;
  humanTakeoverAt: Date | null;
  takeoverByUserId: string | null;
  /**
   * MÁY đã xin người vào (`conversation.handoff`) nhưng CHƯA AI nhận.
   *
   * Khác hẳn `takeoverByUserId` có giá trị — cái đó là "đã có chủ". Cái này là "cần chủ", nên thẻ
   * phải nói ra bằng chữ và phải nằm đầu hàng đợi.
   */
  machineHandoff: boolean;
  /** Vì sao máy xin người vào. Rỗng = không có lý do được ghi. */
  handoffRequestReason: string;
  customerMessage: string;
  customerMessageAt: Date | null;
  suggestedReply: string;
  action: string;
  confidence: number | null;
  handoffReason: string;
  decisionReason: string;
  missing: string[];
  intents: string[];
  entities: Record<string, unknown>;
  /** Cờ dữ kiện của bước QUYẾT ĐỊNH (đã có SĐT chưa, đã có địa chỉ chưa…). */
  decisionFacts: Record<string, unknown>;
  suggestedAt: Date | null;
  /** Câu này còn gửi được không, và nếu không thì vì sao. */
  stale: string | null;
  /** Khách đã nhắn và CHƯA ai đáp — điều kiện để một hội thoại có mặt trong hàng đợi. */
  waitingForReply: boolean;
  /** Khách đã chờ bao nhiêu phút. Xếp hàng theo con số này: ai chờ lâu nhất lên trước. */
  waitedMinutes: number | null;
  /** ẢNH CHỤP dữ kiện máy chủ đã dùng lúc soạn câu — không tính lại lúc đọc. */
  facts: Record<string, unknown>;
  /** Đang thiếu gì. Hiện TRÊN thẻ, trước khi nhân viên bấm. */
  warnings: CopilotWarning[];
  /** Ai đã xử lý câu này rồi (rỗng = chưa ai). */
  handledAction: string;
  handledBy: string;
};

function parseArr(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v ?? "")).filter(Boolean);
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseObj(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Hàng đợi: MỖI HỘI THOẠI MỘT DÒNG, mang câu gợi ý mới nhất.
 *
 * Một hội thoại nhiều lượt gợi ý thì chỉ lượt cuối còn nghĩa — các lượt trước đã bị chính hội thoại
 * bỏ lại phía sau. Hiện cả chuỗi thì hàng đợi dài gấp mấy lần mà không thêm một việc nào.
 */
export async function copilotQueue(
  options: { pageIds?: string[]; limit?: number; includeHandled?: boolean; heldByUserId?: string | null; db?: Db } = {},
): Promise<CopilotQueueRow[]> {
  const db = options.db ?? (await getDb());
  /*
    `pageIds` TRUYỀN VÀO LÀ MỘT LỜI KHẲNG ĐỊNH, KỂ CẢ KHI NÓ RỖNG.

    Viết `options.pageIds?.length ? … : …` thì một mảng RỖNG rơi về danh sách cấu hình — tức là
    "tôi không cho page nào" lại đọc ra "lấy hết những page đang mở". Nhánh mặc định của một hàm
    đọc phải rơi về phía HẸP HƠN, nên chỉ `undefined` mới là "chưa nói gì".
  */
  const pages = options.pageIds ?? (await copilotPages(db));
  if (!pages.length) return [];
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);

  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with cau_mau as (
        /*
          CÂU MẪU CỦA PAGE — cùng một chuỗi ký tự xuất hiện ở NHIỀU HỘI THOẠI KHÁC NHAU.

          Đếm theo số HỘI THOẠI chứ không theo số TIN: một nhân viên có thể gửi lại cùng một câu
          vài lần cho CÙNG một khách (khách không thấy tin, gửi ảnh kèm chú thích), nhưng cùng một
          câu ở ba hội thoại khác nhau thì nó là câu chạy sẵn.
        */
        select lower(btrim(m.text)) as van_ban
        from sales_messages m
        join sales_conversations sc on sc.id = m.conversation_id
        where m.from_page = true
          and m.sender_type in (${sql.raw(HUMAN_REPLY_SQL_LIST)})
          and btrim(m.text) <> ''
          and sc.page_id in (${sql.join(pages.map((p) => sql`${p}`), sql`, `)})
        group by 1
        having count(distinct m.conversation_id) >= ${AUTOMATION_TEMPLATE_MIN_CONVERSATIONS}
      ),
      moi_nhat as (
        select distinct on (s.conversation_id)
               s.id, s.conversation_id, s.run_id, s.suggested_reply, s.action, s.confidence, s.created_at, s.facts_json
        from sales_suggestions s
        where s.conversation_id in (select id from sales_conversations where page_id in (${sql.join(pages.map((p) => sql`${p}`), sql`, `)}))
          -- KHÔNG có câu thì không có việc: một thẻ với ô soạn rỗng chỉ làm dài hàng đợi.
          and btrim(s.suggested_reply) <> ''
          -- Dòng evaluation_only sinh ra CHỈ để chấm điểm khi người đã cầm hội thoại. Đưa nó vào
          -- hàng đợi là mời nhân viên gửi một câu mà chính hệ thống đã quyết định không gửi.
          and s.evaluation_only = false
        order by s.conversation_id, s.created_at desc
      )
      select c.id                                            as conversation_id,
             m.id                                            as suggestion_id,
             m.run_id                                        as run_id,
             c.page_id, c.external_id, c.customer_name, c.source_type, c.stage,
             c.human_takeover_at, c.takeover_by_user_id,
             coalesce(c.takeover_reason, '')                  as takeover_reason,
             coalesce(p.name, '')                            as product_name,
             coalesce(m.suggested_reply, '')                 as suggested_reply,
             m.facts_json                                    as facts_json,
             coalesce(m.action, '')                          as action,
             m.confidence, m.created_at                      as suggested_at,
             coalesce(t.text, '')                            as customer_message,
             t.sent_at                                       as customer_message_at,
             coalesce(r.decision->>'handoffReason', '')      as handoff_reason,
             coalesce(r.decision->>'reason', '')             as decision_reason,
             coalesce(r.decision->'missing', '[]'::jsonb)    as missing,
             coalesce(r.understanding->'intents', '[]'::jsonb) as intents,
             coalesce(r.understanding->'entities', '{}'::jsonb) as entities,
             coalesce(r.decision->'facts', '{}'::jsonb)      as facts,
             coalesce(a.action, '')                          as handled_action,
             coalesce(a.actor_name, '')                      as handled_by,
             (nv.luc is null or nv.luc < t.sent_at)          as dang_cho_tra_loi,
             (select count(*)::int from sales_messages nm
                where nm.conversation_id = c.id and nm.from_page = false and nm.sent_at > m.created_at) as tin_moi
      from sales_conversations c
      join moi_nhat m on m.conversation_id = c.id
      left join products p on p.id = c.active_product_id
      /*
        TIN KHÁCH CUỐI PHẢI LÀ TIN CỦA KHÁCH THẬT.

        Cờ from_page = false chưa đủ: thông báo nền tảng ("… đã trả lời một quảng cáo") và tin bot
        cũng có thể rơi vào chiều ấy. Xếp một hội thoại lên đầu hàng đợi vì một thông báo hệ thống
        là mời nhân viên trả lời một cái máy.
      */
      left join lateral (
        select text, sent_at from sales_messages
        where conversation_id = c.id and from_page = false and sender_type = 'CUSTOMER' and btrim(text) <> ''
        order by sent_at desc nulls last limit 1
      ) t on true
      /*
        NHÂN VIÊN đã trả lời SAU tin khách cuối chưa. Chưa thì đây là việc đang chờ người.

        HAI ĐIỀU KIỆN, và cả hai đều đến từ số đo ngày 16/09/2026:

        ① CHỈ PAGE_HUMAN — xem HUMAN_REPLY_SENDER_TYPES. Bản trước nhận cả PAGE_BOT, nên một câu
           tự động làm khách biến mất khỏi hàng đợi.
        ② KHÔNG PHẢI CÂU MẪU. Trên page thí điểm, đúng một tài khoản gửi cả 339 tin mang nhãn
           PAGE_HUMAN, 71 tin trong số đó gửi TRƯỚC khi khách nhắn câu đầu tiên, và hai câu dài
           xuất hiện đúng một lần ở mỗi 35 hội thoại khác nhau. Đó là một kịch bản chạy sẵn, không
           phải người gõ. Nhãn PAGE_HUMAN đặt lúc NẠP không thể thấy điều này — nó chỉ nhìn được
           một tin — nên phép nhận dạng nằm ở đây, nơi có cả tập dữ liệu để so.
      */
      left join lateral (
        select max(m.sent_at) as luc
        from sales_messages m
        where m.conversation_id = c.id
          and m.from_page = true
          and m.sender_type in (${sql.raw(HUMAN_REPLY_SQL_LIST)})
          and btrim(m.text) <> ''
          and lower(btrim(m.text)) not in (select van_ban from cau_mau)
      ) nv on true
      left join ai_runs r on r.id = m.run_id
      left join lateral (
        select action, actor_name from sales_copilot_actions
        where suggestion_id = m.id and action in ('SEND','EDIT_SEND','REJECT') and send_status <> 'FAILED'
        order by created_at desc limit 1
      ) a on true

      /*
        CHỈ NGƯỜI THẬT MỚI LÀM MỘT HỘI THOẠI RỜI HÀNG ĐỢI CHUNG.

        Cột human_takeover_at có HAI nơi ghi, và chúng nói hai điều NGƯỢC nhau:

          · nhân viên bấm "Tự nhận việc"  ⇒ có takeover_by_user_id ⇒ ĐÃ CÓ CHỦ, người khác khỏi đọc;
          · công cụ conversation.handoff do CHÍNH MÁY gọi khi nó không trả lời được ⇒ KHÔNG có
            khoá người ⇒ CHƯA AI CẦM, và đây đúng là việc cần người nhất.

        Bản trước loại cả hai như nhau. Đo 18/09/2026: 24 hội thoại bị đánh dấu, NGƯỜI tự nhận 0,
        máy xin người vào 24 — nghĩa là mọi cuộc mà máy kêu cứu đều biến mất khỏi màn hình người.
        Và vì khoá người là NULL, mệnh đề "trừ việc của chính mình" không bao giờ khớp, nên chúng
        vô hình với TẤT CẢ.

        Nên điều kiện loại trừ đọc takeover_by_user_id, KHÔNG đọc human_takeover_at.
      */
      where (c.takeover_by_user_id is null or c.takeover_by_user_id = ${options.heldByUserId ?? null})
        -- KHÔNG có tin khách thật thì không có việc: một hội thoại chỉ gồm thông báo quảng cáo
        -- không phải một người đang chờ được trả lời.
        and t.sent_at is not null
        /*
          NHÂN VIÊN ĐÃ ĐÁP SAU LƯỢT ẤY RỒI THÌ KHÔNG CÒN LÀ VIỆC.

          Trước đây những dòng này vẫn hiện, chỉ xếp xuống cuối. Nhưng "xuống cuối" vẫn là một thẻ
          nhân viên phải đọc và bỏ qua — và với một tồn đọng vài chục hội thoại thì phần lớn công
          sức đọc hàng đợi rơi vào những việc đã xong.
        */
        and (nv.luc is null or nv.luc < t.sent_at)
        /*
          VÀ QUÁ CŨ THÌ CŨNG RỜI ĐI.

          Hàng đợi xếp người chờ LÂU NHẤT lên trước, nên không có mốc cắt thì một tồn đọng vài ngày
          sẽ đẩy các cuộc nguội ngắt lên đầu và chôn người vừa nhắn xuống dưới. Mốc này cũng trùng
          cửa sổ 24 giờ của Facebook: quá đó phần lớn là không nhắn lại được nữa.
        */
        and t.sent_at >= now() - (${COPILOT_QUEUE_RELEVANT_HOURS} || ' hours')::interval
      /*
        THỨ TỰ HÀNG ĐỢI — ĐỂ NGƯỜI TRỰC MỞ RA LÀ THẤY VIỆC ĐÁNG LÀM NHẤT Ở TRÊN CÙNG.

        Bậc 1 và quan trọng nhất: KHÁCH ĐANG CHỜ. Một người vừa nhắn và chưa ai đáp là việc gấp
        hơn mọi thứ khác, bất kể họ hỏi gì.

        Bậc 2, trong nhóm đang chờ, xếp theo Ý ĐỊNH — đọc từ ai_runs.understanding, không đoán
        lại từ câu chữ: muốn mua / xác nhận (1) · hỏi giá, màu, size, còn hàng (2) · băn khoăn (3)
        · còn lại (4).

        Bậc 3: mới nhất trước. Trả lời một người vừa nhắn năm phút trước có ích hơn một người nhắn
        từ hôm qua — người hôm qua nhiều khả năng đã bỏ đi hoặc đã được nhân viên trả lời.
      */
      /*
        AI CHỜ LÂU NHẤT THÌ ĐƯỢC TRẢ LỜI TRƯỚC — trong số những cuộc CÒN ĐÁNG TRẢ LỜI.

        Đây là xếp hàng theo thứ tự đến, như mọi quầy phục vụ. Một người đợi bốn mươi phút gấp hơn
        một người vừa nhắn hai phút, bất kể họ hỏi gì; mốc cắt 24 giờ ở trên mới là thứ giữ cho
        "lâu nhất" không có nghĩa là "nguội nhất".

        Ý ĐỊNH chỉ phá hoà: hai người chờ xấp xỉ bằng nhau thì phục vụ người sắp mua trước. Xếp ý
        định lên trên thời gian chờ sẽ để một người hỏi bâng quơ ngồi đợi mãi vì luôn có người khác
        "đáng giá hơn" chen lên.
      */
      order by
        /*
          BẬC 0 — MÁY ĐÃ KÊU CỨU THÌ LÊN ĐẦU.

          Đứng TRÊN cả thời gian chờ, và đó là khác biệt có chủ ý so với mọi bậc còn lại: những
          cuộc này máy đã đọc và tự nhận là mình không xử lý được. Chúng không "đến lượt" — chúng
          đã được sàng lọc một lần rồi.
        */
        case when c.human_takeover_at is not null and c.takeover_by_user_id is null then 0 else 1 end,
        t.sent_at asc nulls last,
        case
          when r.understanding->'intents' @> '["PURCHASE_INTENT"]'::jsonb or r.understanding->'intents' @> '["CONFIRM"]'::jsonb then 1
          when r.understanding->'intents' @> '["PRICE_QUESTION"]'::jsonb then 2
          when r.understanding->'intents' @> '["STOCK_QUESTION"]'::jsonb or r.understanding->'intents' @> '["PRODUCT_QUESTION"]'::jsonb then 3
          when r.understanding->'intents' @> '["SIZE_QUESTION"]'::jsonb then 4
          when r.understanding->'intents' @> '["OBJECTION"]'::jsonb then 5
          else 6
        end
      limit ${limit}
    `),
  );

  /*
    CHÍNH SÁCH ĐỔI TRẢ ĐỌC MỘT LẦN CHO CẢ LƯỢT, KHÔNG CHỤP THEO TỪNG CÂU.

    Nó là cấu hình mức SHOP, đổi vài tháng một lần — nên "đọc lúc này" vẫn đúng, khác hẳn giá hay
    tồn (thay đổi theo từng lượt, nên phải là ảnh chụp). Một lượt đọc cho cả hàng đợi thay vì một
    lượt cho mỗi thẻ.
  */
  const thieuChinhSach = new Map<string, boolean>();
  for (const pageId of pages) {
    const bo = await loadWinKnowledge(pageId, db).catch(() => null);
    thieuChinhSach.set(pageId, !bo || !bo.knowledge.exchangeAnswerable);
  }

  const now = Date.now();
  return rows
    .filter((r) => options.includeHandled || !String(r.handled_action ?? ""))
    .map((r) => {
      const suggestedAt = r.suggested_at ? new Date(String(r.suggested_at)) : null;
      const phut = suggestedAt ? (now - suggestedAt.getTime()) / 60_000 : Number.POSITIVE_INFINITY;
      const tinMoi = Number(r.tin_moi ?? 0);
      const stale =
        tinMoi > 0
          ? `Khách đã nhắn thêm ${tinMoi} tin sau khi câu này được soạn`
          : phut > COPILOT_SUGGESTION_TTL_MINUTES
            ? `Câu gợi ý đã soạn ${Math.round(phut)} phút trước`
            : null;
      return {
        conversationId: String(r.conversation_id),
        suggestionId: r.suggestion_id ? String(r.suggestion_id) : null,
        runId: r.run_id ? String(r.run_id) : null,
        pageId: String(r.page_id ?? ""),
        externalId: String(r.external_id ?? ""),
        customerName: String(r.customer_name ?? ""),
        sourceType: String(r.source_type ?? ""),
        stage: String(r.stage ?? ""),
        productName: String(r.product_name ?? ""),
        humanTakeoverAt: r.human_takeover_at ? new Date(String(r.human_takeover_at)) : null,
        takeoverByUserId: r.takeover_by_user_id ? String(r.takeover_by_user_id) : null,
        machineHandoff: Boolean(r.human_takeover_at) && !r.takeover_by_user_id,
        handoffRequestReason: String(r.takeover_reason ?? ""),
        customerMessage: String(r.customer_message ?? ""),
        customerMessageAt: r.customer_message_at ? new Date(String(r.customer_message_at)) : null,
        suggestedReply: String(r.suggested_reply ?? ""),
        action: String(r.action ?? ""),
        confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
        handoffReason: String(r.handoff_reason ?? ""),
        decisionReason: String(r.decision_reason ?? ""),
        missing: parseArr(r.missing),
        intents: parseArr(r.intents),
        entities: parseObj(r.entities),
        decisionFacts: parseObj(r.facts),
        suggestedAt,
        stale,
        waitingForReply: r.dang_cho_tra_loi === true || String(r.dang_cho_tra_loi) === "true",
        waitedMinutes: r.customer_message_at ? Math.max(0, Math.round((now - new Date(String(r.customer_message_at)).getTime()) / 60_000)) : null,
        facts: parseObj(r.facts_json),
        warnings: [...parseArr(parseObj(r.facts_json).warnings), ...(thieuChinhSach.get(String(r.page_id ?? "")) ? ["POLICY_MISSING"] : [])].filter(
          (w, i, all) => all.indexOf(w) === i,
        ) as CopilotWarning[],
        handledAction: String(r.handled_action ?? ""),
        handledBy: String(r.handled_by ?? ""),
      };
    });
}

export type CopilotKpi = {
  suggestions: number;
  byAction: Record<string, number>;
  sentUnchanged: number;
  editedSent: number;
  rejected: number;
  takeover: number;
  /** Tỷ lệ câu máy soạn được dùng (gửi nguyên văn hoặc sửa rồi gửi). `null` = chưa có lượt nào. */
  acceptanceRate: number | null;
  /** Trong số câu đã gửi, bao nhiêu phần trăm phải SỬA ĐÁNG KỂ. `null` = chưa gửi lượt nào. */
  meaningfulEditRate: number | null;
  /** Giây trung vị từ lúc máy soạn xong tới lúc người bấm. `null` = chưa đo được. */
  medianReviewSeconds: number | null;
  rejectReasons: { reason: string; n: number }[];
  /** Số tin THẬT SỰ đã rời khỏi ERP — đọc từ sổ, không suy từ cờ nào. */
  actuallySent: number;
  failedSends: number;
  /**
   * LẦN GỬI ĐẦU TIÊN DO NGƯỜI BẤM — đã có chưa, và đã tự kiểm chứng chưa.
   *
   * `pending: true` nghĩa là chưa ai bấm gửi lần nào, nên phép thử đầu-cuối trên khách thật CHƯA
   * CHẠY. Đó là một trạng thái hợp lệ để bắt đầu thí điểm, nhưng phải in ra chứ không được để
   * người đọc tưởng mọi thứ đã được chứng minh.
   */
  firstHumanSend: {
    pending: boolean;
    at: Date | null;
    by: string;
    /** `true` = đọc lại Pancake thấy ĐÚNG MỘT bản. `null` = chưa kiểm được. */
    verified: boolean | null;
    note: string;
  };
  /** Số lần gửi mà đọc lại thấy NHIỀU HƠN MỘT bản — phải luôn bằng 0. */
  duplicateSends: number;
  /** Số lần người bấm gửi TRONG LÚC hệ thống đang báo thiếu dữ liệu. */
  sentWithWarnings: number;
};

/** Chỉ số nấc trợ lý. Mẫu số rỗng ⇒ `null`, KHÔNG phải 0% (luật 42). */
export async function copilotKpi(days = 7, db?: Db): Promise<CopilotKpi> {
  const conn = db ?? (await getDb());
  const tu = new Date(Date.now() - days * 86_400_000);
  const rows = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`
      select action,
             count(*)::int                                                as n,
             count(*) filter (where send_status = 'SENT')::int            as da_gui,
             count(*) filter (where send_status = 'FAILED')::int          as hong,
             count(*) filter (where edited = true)::int                   as da_sua
      from sales_copilot_actions where created_at >= ${tu} group by 1
    `),
  );
  const byAction: Record<string, number> = {};
  let actuallySent = 0;
  let failedSends = 0;
  for (const r of rows) {
    byAction[String(r.action)] = Number(r.n ?? 0);
    actuallySent += Number(r.da_gui ?? 0);
    failedSends += Number(r.hong ?? 0);
  }
  const sentUnchanged = byAction.SEND ?? 0;
  const editedSent = byAction.EDIT_SEND ?? 0;
  const rejected = byAction.REJECT ?? 0;
  const takeover = byAction.TAKEOVER ?? 0;
  const quyetDinh = sentUnchanged + editedSent + rejected;

  const [trungVi] = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`
      select percentile_cont(0.5) within group (order by review_seconds)::int as tv
      from sales_copilot_actions
      where created_at >= ${tu} and review_seconds is not null and action in ('SEND','EDIT_SEND','REJECT')
    `),
  );
  const lyDo = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`
      select reject_reason as reason, count(*)::int as n from sales_copilot_actions
      where created_at >= ${tu} and action = 'REJECT' and reject_reason is not null
      group by 1 order by 2 desc
    `),
  );
  const [goiY] = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`select count(*)::int as n from sales_suggestions where created_at >= ${tu} and btrim(suggested_reply) <> ''`),
  );
  /*
    SỬA NHẸ KHÁC SỬA ĐÁNG KỂ.

    Đếm "có sửa hay không" thì một dấu chấm thành dấu phẩy cũng vào cùng rổ với một câu viết lại từ
    đầu — và tỷ lệ ấy nói sai về chất lượng câu máy soạn theo hướng bi quan. Ngưỡng lấy từ hằng số
    đang chạy (`COPILOT_MEANINGFUL_EDIT_RATIO`), không gõ lại ở đây.
  */
  const [dangKe] = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`
      select count(*)::int as n from sales_copilot_actions
      where created_at >= ${tu} and action = 'EDIT_SEND' and send_status = 'SENT'
        and edit_distance is not null
        and edit_distance::float / greatest(length(suggested_text), 1) >= ${COPILOT_MEANINGFUL_EDIT_RATIO}
    `),
  );
  const daGui = sentUnchanged + editedSent;

  const [dau] = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`
      select created_at, actor_name, verified, verify_note
      from sales_copilot_actions
      where action in ('SEND','EDIT_SEND') and send_status = 'SENT'
      order by created_at asc limit 1
    `),
  );
  const [batThuong] = rowsOf<Record<string, unknown>>(
    await conn.execute(sql`
      select
        count(*) filter (where verified = false)::int                          as trung_ban,
        count(*) filter (where jsonb_array_length(warnings) > 0)::int          as gui_khi_thieu
      from sales_copilot_actions
      where action in ('SEND','EDIT_SEND') and send_status = 'SENT'
    `),
  );

  return {
    suggestions: Number(goiY?.n ?? 0),
    firstHumanSend: {
      pending: !dau,
      at: dau?.created_at ? new Date(String(dau.created_at)) : null,
      by: String(dau?.actor_name ?? ""),
      verified: dau ? (dau.verified === null || dau.verified === undefined ? null : Boolean(dau.verified)) : null,
      note: String(dau?.verify_note ?? ""),
    },
    duplicateSends: Number(batThuong?.trung_ban ?? 0),
    sentWithWarnings: Number(batThuong?.gui_khi_thieu ?? 0),
    byAction,
    sentUnchanged,
    editedSent,
    rejected,
    takeover,
    acceptanceRate: quyetDinh ? Math.round((daGui / quyetDinh) * 1000) / 10 : null,
    meaningfulEditRate: daGui ? Math.round((Number(dangKe?.n ?? 0) / daGui) * 1000) / 10 : null,
    medianReviewSeconds: trungVi?.tv === null || trungVi?.tv === undefined ? null : Number(trungVi.tv),
    rejectReasons: lyDo.map((r) => ({ reason: String(r.reason), n: Number(r.n ?? 0) })),
    actuallySent,
    failedSends,
  };
}

/** Lịch sử thao tác của một hội thoại — để người sau đọc lại được vì sao. */
export async function copilotHistory(conversationId: string, db?: Db) {
  const conn = db ?? (await getDb());
  return conn.query.salesCopilotActions.findMany({
    where: eq(schema.salesCopilotActions.conversationId, conversationId),
    orderBy: [desc(schema.salesCopilotActions.createdAt)],
    limit: 20,
  });
}


export type IngestStatus = {
  pageId: string;
  health: LiveIngestHealth;
  lastOkAt: Date | null;
  lastRunAt: Date | null;
  lastCustomerMessageAt: Date | null;
  lastError: string;
  consecutiveErrors: number;
  messagesIngested: number;
};

/**
 * SỨC KHOẺ BỘ NẠP — để nhân viên không phải đọc log mới biết hệ thống có đang sống không.
 *
 * `lastOkAt` (vòng CHẠY ĐƯỢC gần nhất) mới là con số trả lời câu ấy, không phải `lastRunAt` (vòng
 * gần nhất, kể cả hỏng): một bộ nạp hỏng liên tục vẫn "chạy" đều đặn.
 */
export async function ingestStatus(dbIn?: Db): Promise<IngestStatus[]> {
  const db = dbIn ?? (await getDb());
  const pages = await copilotPages(db);
  if (!pages.length) return [];
  const bat = String(process.env[LIVE_INGEST_ENV] ?? "").toLowerCase() === "true";
  const ra: IngestStatus[] = [];
  for (const pageId of pages) {
    const moc = await db.query.salesIngestCursors.findFirst({ where: eq(schema.salesIngestCursors.pageId, pageId) });
    ra.push({
      pageId,
      health: liveIngestHealth({ enabled: bat, lastOkAt: moc?.lastOkAt ?? null, consecutiveErrors: moc?.consecutiveErrors ?? 0 }),
      lastOkAt: moc?.lastOkAt ?? null,
      lastRunAt: moc?.lastRunAt ?? null,
      lastCustomerMessageAt: moc?.lastMessageAt ?? null,
      lastError: moc?.lastError ?? "",
      consecutiveErrors: moc?.consecutiveErrors ?? 0,
      messagesIngested: moc?.messagesIngested ?? 0,
    });
  }
  return ra;
}

export type FirstHumanSend = {
  /** ĐÃ có ít nhất một tin do NGƯỜI bấm gửi đi thành công. */
  verified: boolean;
  at: Date | null;
  /** Ảnh chụp tên người bấm, do máy chủ đọc từ phiên — không nhận từ client. */
  actorName: string;
  /** Tổng số tin đã rời khỏi ERP do người bấm. */
  sentCount: number;
};

/**
 * LẦN GỬI ĐẦU TIÊN DO NGƯỜI BẤM — đọc từ SỔ THAO TÁC, không từ một cờ.
 *
 * `FIRST_HUMAN_SEND_PENDING` không phải một biến ai đó đặt tay: nó là câu hỏi "sổ thao tác đã có
 * dòng gửi THÀNH CÔNG nào chưa". Một cờ đặt tay thì sai được; một phép đếm trên chính bảng ghi
 * vết thì không.
 */
export async function firstHumanSend(dbIn?: Db): Promise<FirstHumanSend> {
  const db = dbIn ?? (await getDb());
  const rows = await db
    .select({ n: sql<number>`count(*)::int`, luc: sql<string | null>`min(${schema.salesCopilotActions.createdAt})` })
    .from(schema.salesCopilotActions)
    .where(sql`${schema.salesCopilotActions.action} in ('SEND','EDIT_SEND') and ${schema.salesCopilotActions.sendStatus} = 'SENT'`);
  const n = Number(rows[0]?.n ?? 0);
  if (!n) return { verified: false, at: null, actorName: "", sentCount: 0 };
  const dau = await db.query.salesCopilotActions.findFirst({
    where: sql`${schema.salesCopilotActions.action} in ('SEND','EDIT_SEND') and ${schema.salesCopilotActions.sendStatus} = 'SENT'`,
    orderBy: [schema.salesCopilotActions.createdAt],
    columns: { createdAt: true, actorName: true },
  });
  return { verified: true, at: dau?.createdAt ?? null, actorName: dau?.actorName ?? "", sentCount: n };
}


/**
 * ═══════════════════ BẢNG ĐIỂM THÍ ĐIỂM — ỨNG DỤNG TỰ ĐỌC ĐƯỢC ═══════════════════
 *
 * Mọi con số dưới đây trước đây chỉ có khi một người (hoặc một phiên trợ lý) mở ops chạy SQL tay.
 * Một chỉ số chỉ đọc được bằng cách gõ lệnh là một chỉ số KHÔNG AI ĐỌC: chủ shop không mở ops, và
 * nhân viên trực chat lại càng không. Cho nên nó phải nằm trên chính màn hình họ đang dùng.
 *
 * BA ĐỘ MỊN KHÁC NHAU, KHÔNG ĐƯỢC TRỘN (luật 8.2):
 *
 *   · LƯỢT KHÁCH (một câu máy soạn được một người kết thúc) — tử số của tỷ lệ dùng được / phải
 *     sửa / từ chối. Mẫu số là SỐ LƯỢT ĐÃ SOÁT.
 *   · HỘI THOẠI — tỷ lệ người phải nhận hẳn việc. Một hội thoại có ba lượt soát vẫn là MỘT lần
 *     nhận việc, nên chia cho số lượt sẽ ra một con số không có nghĩa.
 *   · LƯỢT CHẠY MÔ HÌNH — đường mô hình, token, độ trễ. Một lượt soát có thể không gọi mô hình
 *     nào (nấc luật), nên cũng không chia chung mẫu số được.
 *
 * KHÔNG CÓ CỬA SỔ THỜI GIAN cho phép đếm tiến độ. Chỉ số 7 ngày là để đọc CHẤT LƯỢNG hiện tại;
 * còn "đã đủ 20 lượt chưa" là một phép đếm CỘNG DỒN. Đặt cửa sổ vào đó thì lượt thứ nhất rơi ra
 * khỏi kỳ vào ngày thứ tám và thanh tiến độ ĐI LÙI — page ít khách sẽ không bao giờ tới đích dù
 * đã soát đủ số lượt.
 */
export type PilotStatus = {
  target: { min: number; max: number };
  /** MỘT CÂU MÁY SOẠN ĐƯỢC MỘT NGƯỜI KẾT THÚC. Không tính tin hệ thống / bot / nhân viên. */
  reviewedTurns: number;
  /** Phân loại theo việc CUỐI CÙNG của mỗi lượt, nên bốn số này cộng lại đúng bằng `reviewedTurns`. */
  decisions: { sendUnchanged: number; editAndSend: number; reject: number };
  /** Độ mịn HỘI THOẠI — đứng riêng vì không cùng mẫu số với ba số trên. */
  conversations: { touched: number; takenOver: number; handoffRate: number | null };
  /** Mẫu số rỗng ⇒ `null` (CHƯA BIẾT), không phải 0% (luật 42). */
  rates: { acceptance: number | null; unchanged: number | null; edit: number | null; reject: number | null };
  reviewSeconds: { avg: number | null; median: number | null };
  /** Đường mô hình của chính các câu trong thí điểm: RULE (không gọi mô hình) · ECONOMY · STRONG. */
  route: {
    tier: string;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    medianLatencyMs: number | null;
    /** VND. `null` = chưa khai đơn giá ⇒ CHƯA BIẾT, KHÔNG phải 0đ. */
    costVnd: number | null;
    unpricedRuns: number;
  }[];
};

export async function pilotStatus(dbIn?: Db): Promise<PilotStatus> {
  const db = dbIn ?? (await getDb());

  /*
    MỘT LƯỢT SOÁT = MỘT CÂU GỢI Ý, KHÔNG PHẢI MỘT DÒNG SỔ.

    Gửi hỏng vì mạng rồi bấm lại là HAI dòng sổ cho CÙNG một lượt khách. Đếm dòng thì tiến độ
    thí điểm tăng vì đường truyền chập chờn. Vì thế gom về từng câu gợi ý và lấy việc CUỐI CÙNG
    của câu ấy — một câu từng gửi hỏng rồi gửi được là một lượt "đã gửi", không phải hai.
  */
  const [d] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with viec_cuoi as (
        select suggestion_id,
               -- Khoá dòng phá hoà: hai dòng ghi trong cùng một mili giây vẫn phải ra CÙNG một kết quả,
               -- nếu không thì cùng một dữ liệu đọc hai lần cho hai con số.
               (array_agg(action order by created_at desc, id desc))[1] as viec
        from sales_copilot_actions
        where suggestion_id is not null and action in (${sql.raw(COPILOT_TERMINAL_SQL_LIST)})
        group by 1
      )
      select count(*)::int                                  as da_soat,
             count(*) filter (where viec = 'SEND')::int      as gui_nguyen_van,
             count(*) filter (where viec = 'EDIT_SEND')::int as sua_roi_gui,
             count(*) filter (where viec = 'REJECT')::int    as tu_choi
      from viec_cuoi
    `),
  );
  const daSoat = Number(d?.da_soat ?? 0);
  const guiNguyenVan = Number(d?.gui_nguyen_van ?? 0);
  const suaRoiGui = Number(d?.sua_roi_gui ?? 0);
  const tuChoi = Number(d?.tu_choi ?? 0);

  const [h] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select count(distinct conversation_id)::int                                    as cham_toi,
             count(distinct conversation_id) filter (where action = 'TAKEOVER')::int as nguoi_nhan
      from sales_copilot_actions
      where action in (${sql.raw(COPILOT_TERMINAL_SQL_LIST)}) or action = 'TAKEOVER'
    `),
  );
  const chamToi = Number(h?.cham_toi ?? 0);
  const nguoiNhan = Number(h?.nguoi_nhan ?? 0);

  const [t] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select avg(review_seconds)::int                                          as tb,
             percentile_cont(0.5) within group (order by review_seconds)::int  as tv
      from sales_copilot_actions
      where review_seconds is not null and action in (${sql.raw(COPILOT_TERMINAL_SQL_LIST)})
    `),
  );

  /*
    ĐƯỜNG MÔ HÌNH ĐỌC TỪ CHÍNH CÁC CÂU TRONG THÍ ĐIỂM, không từ toàn bộ bảng lượt chạy.

    Bảng lượt chạy còn giữ cả giai đoạn chạy thử và các lượt đo thử nghiệm trên hội thoại dựng
    sẵn. Trộn chúng vào đây thì tỷ lệ "bao nhiêu phần trăm phải dùng mô hình mạnh" nói về một tập
    dữ liệu không ai đang thí điểm. Lọc theo page thí điểm là phép lọc hẹp và đúng nghĩa.
  */
  const pages = await copilotPages(db);
  const route: PilotStatus["route"] = [];
  if (pages.length) {
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select r.tier                                                            as bac,
               count(*)::int                                                     as luot,
               coalesce(sum(r.input_tokens), 0)::int                             as token_vao,
               coalesce(sum(r.output_tokens), 0)::int                            as token_ra,
               percentile_cont(0.5) within group (order by r.latency_ms)::int    as do_tre,
               sum(r.cost_vnd)::int                                              as chi_phi,
               count(*) filter (where r.cost_vnd is null)::int                   as chua_khai_gia
        from sales_suggestions s
        join ai_runs r on r.id = s.run_id
        join sales_conversations c on c.id = s.conversation_id
        where c.page_id in (${sql.join(pages.map((p) => sql`${p}`), sql`, `)})
        group by 1
        order by 2 desc
      `),
    );
    for (const r of rows) {
      route.push({
        tier: String(r.bac ?? ""),
        runs: Number(r.luot ?? 0),
        inputTokens: Number(r.token_vao ?? 0),
        outputTokens: Number(r.token_ra ?? 0),
        medianLatencyMs: r.do_tre === null || r.do_tre === undefined ? null : Number(r.do_tre),
        // Một lượt chưa khai giá là CHƯA BIẾT chi phí. Cộng phần đã khai rồi in ra như tổng của
        // cả nhóm là khẳng định những lượt kia tốn 0đ — đúng thứ luật 42 cấm.
        costVnd: Number(r.chua_khai_gia ?? 0) > 0 || r.chi_phi === null || r.chi_phi === undefined ? null : Number(r.chi_phi),
        unpricedRuns: Number(r.chua_khai_gia ?? 0),
      });
    }
  }

  const tyLe = (tu: number) => (daSoat ? Math.round((tu / daSoat) * 1000) / 10 : null);
  return {
    target: { min: PILOT_REVIEWED_TURNS_TARGET.min, max: PILOT_REVIEWED_TURNS_TARGET.max },
    reviewedTurns: daSoat,
    decisions: { sendUnchanged: guiNguyenVan, editAndSend: suaRoiGui, reject: tuChoi },
    conversations: {
      touched: chamToi,
      takenOver: nguoiNhan,
      handoffRate: chamToi ? Math.round((nguoiNhan / chamToi) * 1000) / 10 : null,
    },
    rates: {
      acceptance: tyLe(guiNguyenVan + suaRoiGui),
      unchanged: tyLe(guiNguyenVan),
      edit: tyLe(suaRoiGui),
      reject: tyLe(tuChoi),
    },
    reviewSeconds: {
      avg: t?.tb === null || t?.tb === undefined ? null : Number(t.tb),
      median: t?.tv === null || t?.tv === undefined ? null : Number(t.tv),
    },
    route,
  };
}


/**
 * ═══════════════════ BẢNG AN TOÀN — GOM, KHÔNG PHÁT HIỆN THÊM ═══════════════════
 *
 * Mọi con số dưới đây đọc từ tín hiệu ĐÃ CÓ: sổ thao tác, sổ lỗi của chốt an toàn, sổ gọi công cụ,
 * và nhãn người chấm. Hàm này KHÔNG soi câu chữ, KHÔNG thêm một luật an toàn nào — nó chỉ trả lời
 * câu "hôm nay có gì lọt ra không" ở một chỗ, thay vì bắt người đọc ghép bốn góc màn hình.
 *
 * HAI CỘT TÁCH RỜI, và đó là toàn bộ ý nghĩa của thẻ:
 *   · `blocked` — chốt nổ TRƯỚC khi câu ra khỏi máy, hoặc người soát bắt được trước khi bấm gửi.
 *   · `escaped` — đã tới khách hoặc đã ghi dữ liệu. CHỈ cột này mới là vi phạm.
 * Gộp hai cột là biến một hệ thống đang làm đúng việc thành báo động đỏ.
 */
export type SafetyRow = {
  kind: SafetyViolationKind;
  /** `null` = CHƯA ĐO ĐƯỢC (không có tín hiệu nào), KHÁC HẲN 0 = đã đo và sạch. */
  blocked: number | null;
  escaped: number | null;
  /** Vài ca để mở ra kiểm tay. Rỗng khi không có ca nào. */
  samples: { conversationId: string; runId: string; note: string }[];
};

export type SafetyBoard = {
  verdict: SafetyVerdict;
  /** Tổng số vi phạm ĐÃ LỌT — con số lớn trên đầu thẻ. */
  escaped: number;
  /** Tổng số lần chốt an toàn nổ đúng. Tin tốt, đứng riêng. */
  blocked: number;
  /** Bao nhiêu loại chưa có gì đo được. > 0 ⇒ không được kết luận PASS tuyệt đối. */
  unmeasured: number;
  rows: SafetyRow[];
};

export async function safetyBoard(dbIn?: Db): Promise<SafetyBoard> {
  const db = dbIn ?? (await getDb());
  const chan: Partial<Record<SafetyViolationKind, number>> = {};
  const lot: Partial<Record<SafetyViolationKind, number>> = {};
  const viDu: Partial<Record<SafetyViolationKind, SafetyRow["samples"]>> = {};
  const them = (k: SafetyViolationKind, con: { conversationId: string; runId: string; note: string }) => {
    const ds = (viDu[k] ??= []);
    if (ds.length < 3) ds.push(con);
  };

  /*
    1. GỬI MÀ KHÔNG CÓ NGƯỜI BẤM, và 2. GỬI TRÙNG.

    Cả hai đọc từ sổ thao tác. Ô khoá tài khoản rỗng trên một dòng ĐÃ GỬI nghĩa là tin đi mà không
    ai chịu trách nhiệm — đúng thứ cả kiến trúc này dựng ra để không bao giờ xảy ra (luật 34).
  */
  const soThaoTac = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select conversation_id, coalesce(run_id, '') as run_id, actor_user_id, verified, verify_note
      from sales_copilot_actions
      where action in ('SEND','EDIT_SEND') and send_status = 'SENT'
    `),
  );
  chan.AUTO_SEND_WITHOUT_HUMAN_CLICK = 0;
  lot.AUTO_SEND_WITHOUT_HUMAN_CLICK = 0;
  /*
    ĐƯỜNG THOÁT THẬT SỰ CỦA "MÁY TỰ GỬI" KHÔNG PHẢI Ô KHOÁ RỖNG.

    `sales_copilot_actions.actor_user_id` là NOT NULL kèm khoá ngoại, nên một dòng thao tác thiếu
    khoá tài khoản KHÔNG GHI ĐƯỢC — cửa ấy đóng ở mức CSDL, không cần đếm. Cửa còn lại là một câu
    được đánh dấu ĐÃ GỬI mà KHÔNG có dòng sổ nào cả: đúng hình dạng của một tiến trình nền gọi
    thẳng cổng gửi, vòng qua Server Action. Đó mới là thứ phải đếm.
  */
  const [khongSo] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select count(*)::int as n, min(s.conversation_id) as hoi_thoai, min(coalesce(s.run_id, '')) as run_mau
      from sales_suggestions s
      where s.sent = true
        and not exists (
          select 1 from sales_copilot_actions a
          where a.suggestion_id = s.id and a.action in ('SEND','EDIT_SEND') and a.send_status = 'SENT'
        )
    `),
  );
  if (Number(khongSo?.n ?? 0) > 0) {
    lot.AUTO_SEND_WITHOUT_HUMAN_CLICK = Number(khongSo.n);
    them("AUTO_SEND_WITHOUT_HUMAN_CLICK", {
      conversationId: String(khongSo.hoi_thoai ?? ""),
      runId: String(khongSo.run_mau ?? ""),
      note: `${khongSo.n} câu bị đánh dấu ĐÃ GỬI mà không có dòng thao tác nào của người`,
    });
  }
  chan.DUPLICATE_SEND = 0;
  lot.DUPLICATE_SEND = 0;
  for (const r of soThaoTac) {
    const conv = String(r.conversation_id ?? "");
    const run = String(r.run_id ?? "");
    if (!r.actor_user_id) {
      lot.AUTO_SEND_WITHOUT_HUMAN_CLICK = (lot.AUTO_SEND_WITHOUT_HUMAN_CLICK ?? 0) + 1;
      them("AUTO_SEND_WITHOUT_HUMAN_CLICK", { conversationId: conv, runId: run, note: "tin đã gửi nhưng không có khoá tài khoản người bấm" });
    }
    if (r.verified === false) {
      lot.DUPLICATE_SEND = (lot.DUPLICATE_SEND ?? 0) + 1;
      them("DUPLICATE_SEND", { conversationId: conv, runId: run, note: String(r.verify_note ?? "đọc lại thấy nhiều hơn một bản") });
    }
  }

  /*
    3. MÁY TỰ TẠO ĐƠN — và 4 (một phần): cổng công cụ đã chặn bao nhiêu lần.

    `outcome = 'OK'` trên một công cụ ghi đơn nghĩa là đơn ĐÃ được tạo. `DENIED` là cổng nổ đúng.
  */
  const goiCongCu = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select tool, outcome, count(*)::int as n, min(run_id) as run_mau
      from ai_tool_calls group by 1, 2
    `),
  );
  chan.AI_CREATED_ORDER = 0;
  lot.AI_CREATED_ORDER = 0;
  for (const r of goiCongCu) {
    if (!(ORDER_WRITE_TOOLS as readonly string[]).includes(String(r.tool ?? ""))) continue;
    const n = Number(r.n ?? 0);
    if (String(r.outcome) === "OK") {
      lot.AI_CREATED_ORDER = (lot.AI_CREATED_ORDER ?? 0) + n;
      them("AI_CREATED_ORDER", { conversationId: "", runId: String(r.run_mau ?? ""), note: `công cụ ${r.tool} chạy THÀNH CÔNG ${n} lần` });
    } else {
      chan.AI_CREATED_ORDER = (chan.AI_CREATED_ORDER ?? 0) + n;
    }
  }

  /*
    5. SÁU CHỐT AN TOÀN — đọc từ sổ lỗi, gom theo nhãn.

    Đây là cột ĐÃ CHẶN: câu mang lời bịa bị vứt ngay lúc sinh, khách không bao giờ thấy nó.
  */
  const soLoi = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select message, count(*)::int as n, min(coalesce(run_id, '')) as run_mau, min(subject_id) as hoi_thoai_mau
      from ai_errors
      where scope = 'MODEL' and message like ${`${GUARD_REJECT_PREFIX}%`}
      group by 1 order by 2 desc limit 200
    `),
  );
  for (const k of ["INVENTED_PRICE", "INVENTED_PROMOTION", "INVENTED_SIZE", "INVENTED_INVENTORY", "INVENTED_POLICY"] as const) chan[k] = 0;
  for (const r of soLoi) {
    const con = String(r.message ?? "").slice(GUARD_REJECT_PREFIX.length).trim();
    for (const [co, kind] of Object.entries(SAFETY_FLAG_TO_KIND) as [SafetyFlag, SafetyViolationKind][]) {
      if (!con.startsWith(SAFETY_FLAG_LABEL[co])) continue;
      const n = Number(r.n ?? 0);
      chan[kind] = (chan[kind] ?? 0) + n;
      them(kind, { conversationId: String(r.hoi_thoai_mau ?? ""), runId: String(r.run_mau ?? ""), note: `${con} (${n} lần)` });
      break;
    }
  }

  /*
    6. NHÃN NGƯỜI CHẤM — sai sản phẩm · xác nhận đơn sai · nói điều không có thật.

    Người chấm bắt được TRƯỚC khi bấm gửi là CHẶN. Bắt được trên một câu ĐÃ GỬI là LỌT — khách đã
    đọc nó rồi. Hai chuyện khác hẳn nhau nên không được cộng chung.
  */
  const nhan = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select l.conversation_id,
             l.product_ok, l.confirmation_ok, l.hallucination, l.hallucination_note,
             exists (
               select 1 from sales_copilot_actions a
               where a.suggestion_id = l.suggestion_id and a.action in ('SEND','EDIT_SEND') and a.send_status = 'SENT'
             ) as da_gui
      from sales_review_labels l
      where l.product_ok = false or l.confirmation_ok = false or l.hallucination = true
    `),
  );
  for (const k of ["WRONG_PRODUCT", "FALSE_ORDER_CONFIRMATION"] as const) {
    chan[k] = 0;
    lot[k] = 0;
  }
  lot.INVENTED_POLICY = 0;
  for (const r of nhan) {
    const conv = String(r.conversation_id ?? "");
    const daGui = r.da_gui === true;
    const ghi = (k: SafetyViolationKind, ghiChu: string) => {
      if (daGui) lot[k] = (lot[k] ?? 0) + 1;
      else chan[k] = (chan[k] ?? 0) + 1;
      them(k, { conversationId: conv, runId: "", note: `${ghiChu}${daGui ? " — ĐÃ GỬI cho khách" : " — người soát bắt được trước khi gửi"}` });
    };
    if (r.product_ok === false) ghi("WRONG_PRODUCT", "người chấm: nhận sai sản phẩm");
    if (r.confirmation_ok === false) ghi("FALSE_ORDER_CONFIRMATION", "người chấm: xác nhận đơn sai");
    if (r.hallucination === true) ghi("INVENTED_POLICY", `người chấm: ${String(r.hallucination_note ?? "nói điều không có thật")}`);
  }

  const rows: SafetyRow[] = SAFETY_VIOLATION_KINDS.map((kind) => {
    const spec = SAFETY_KIND_SPEC[kind];
    return {
      kind,
      // CHƯA ĐO ĐƯỢC ⇒ `null`, không phải 0. Đây là toàn bộ lý do thẻ này đáng tin (luật 42 · 45).
      blocked: spec.measured ? (chan[kind] ?? 0) : null,
      escaped: spec.measured ? (lot[kind] ?? 0) : null,
      samples: viDu[kind] ?? [],
    };
  });
  const tongLot = rows.reduce((t, r) => t + (r.escaped ?? 0), 0);
  const tongChan = rows.reduce((t, r) => t + (r.blocked ?? 0), 0);
  const chuaDo = rows.filter((r) => r.escaped === null).length;
  return { verdict: safetyVerdict(tongLot, chuaDo), escaped: tongLot, blocked: tongChan, unmeasured: chuaDo, rows };
}
