/**
 * HÀNG ĐỢI NẤC TRỢ LÝ — lớp ĐỌC.
 *
 * Không hàm nào trong tệp này ghi. Mọi đường ghi nằm ở `lib/actions/ai-copilot.ts`, và đó là điều
 * kiểm thử quét lại được ở mức mã nguồn.
 */
import { desc, eq, sql } from "drizzle-orm";
import { loadWinKnowledge } from "@/lib/queries/sales-knowledge";
import { getDb, schema, type Db } from "@/db";
import { COPILOT_MEANINGFUL_EDIT_RATIO, COPILOT_PAGES_KEY, COPILOT_QUEUE_RELEVANT_HOURS, COPILOT_SUGGESTION_TTL_MINUTES, type CopilotWarning } from "@/lib/constants/sales-copilot";
import { rowsOf } from "@/lib/sql-rows";

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
      with moi_nhat as (
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
      -- Nhân viên đã trả lời SAU tin khách cuối chưa. Chưa thì đây là việc đang chờ người.
      left join lateral (
        select max(sent_at) as luc from sales_messages
        where conversation_id = c.id and from_page = true and sender_type in ('PAGE_HUMAN', 'PAGE_BOT')
      ) nv on true
      left join ai_runs r on r.id = m.run_id
      left join lateral (
        select action, actor_name from sales_copilot_actions
        where suggestion_id = m.id and action in ('SEND','EDIT_SEND','REJECT') and send_status <> 'FAILED'
        order by created_at desc limit 1
      ) a on true

      where (c.human_takeover_at is null or c.takeover_by_user_id = ${options.heldByUserId ?? null})
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

