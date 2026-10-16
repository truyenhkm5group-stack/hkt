/**
 * ═══════════ AI CÓ PHẢI TRẢ LỜI LƯỢT KHÁCH NÀY KHÔNG — PHẦN THUẦN (P0 response-ownership, chủ shop 11/10/2026) ═══════════
 *
 * Hai ca thật cùng một gốc — ERP PHÂN LOẠI SAI NGƯỜI GỬI của tin phía page:
 *
 *  · «Uyen Tran» (c4de110b…, 11/10 09:14): tin chào quảng cáo của page («CHẢ CÁ THU NGUYÊN CHẤT…», «1kg 279k · 2kg 539k») tới CÙNG
 *    PHÚT với câu hỏi thật của khách («cá đánh bắt vùng biển nào? tươi hay chiên? cho mình xin giá») ⇒ câu hỏi bị chốt «Page / nhân
 *    viên đã trả lời», bot chỉ trả lời câu mẫu «Báo giá chả cá thu?» tới sau. Luật cũ (fanpage.ts `pageRepliedSince` ·
 *    `pancakeCreatedAfterVerdict` · `pageAnsweredVerdict`): MỌI tin phía page có chữ tạo SAU tin khách SỚM NHẤT của lượt là «đã trả
 *    lời» — tin chào / tự động của page bị coi như câu trả lời của người.
 *  · «Lê Bạch Nguyên» (11/10 09:25): khách «Lấy 1kg»; một tin page mang CHỮ HỆ THỐNG của Facebook («Bạn đang phản hồi bình luận của
 *    người dùng về bài viết…» — tiếng vọng của tin riêng trả lời bình luận, Pancake chuyển tiếp như tin page) ⇒ luật «tin page tới
 *    lúc bot đang trò chuyện ⇒ là người» (`pageSideIsStaffCond`) bật nhường 30 phút ⇒ «Lấy 1kg» lần hai bị chặn, không ai xử lý.
 *
 * Luật thay thế (tệp này — HÀM THUẦN, không đọc / ghi CSDL, không đọc đồng hồ):
 *
 *  1. NGUỒN GỐC mỗi tin ra là một trong sáu giá trị ĐÓNG (`OUTBOUND_ORIGINS`): AI_AGENT · VERIFIED_HUMAN · PANCAKE_AUTOMATION ·
 *     META_SYSTEM · OTHER_APP · UNKNOWN — suy ra từ dữ kiện ĐÃ CÓ (`classifyOutbound`), không đoán theo «bot vừa nói».
 *  2. Một LƯỢT KHÁCH = các tin khách liên tiếp (tin tự động / hệ thống chen giữa KHÔNG cắt lượt). Lượt chỉ «đã trả lời» khi có tin
 *     ra HỢP LỆ có thứ tự SAU tin khách CUỐI của lượt (`buildCustomerTurns`). Tin tự động / chào quảng cáo / hệ thống KHÔNG BAO GIỜ
 *     trả lời một câu hỏi thật — KỂ CẢ lượt chỉ gồm câu mẫu của quảng cáo («Báo giá chả cá thu?»). Ngoại lệ cũ cho lượt toàn câu
 *     mẫu («Dư Thị Liên», 05/10 — tránh báo giá đôi) đã BỎ theo quyết định chủ shop 16/10/2026 (issue #856, ca «Cao Hải Ninh»): lời
 *     chào / creative tự động không phải câu giải đáp, câu báo giá của máy chủ là nguồn giá có thẩm quyền, và bỏ lỡ một khách hỏi
 *     giá từ quảng cáo đắt hơn một câu chào trùng ý. Đường AI và hộp thư (`latestTurnState`) giờ nói CÙNG một điều.
 *  3. Thứ tự so theo MỐC NGUỒN (`source_at` của Pancake / Meta) + thứ tự nguồn, KHÔNG theo phút; thiếu mốc nguồn ⇒ chỉ tin ra tới
 *     sau ≥ `ORDER_AMBIGUITY_MS` mới chắc là «sau». Câu của BOT chỉ trả lời tin khách bot đã THẤY (tin còn PENDING thì chưa).
 *  4. NHƯỜNG NGƯỜI chỉ bật khi tin ra là VERIFIED_HUMAN (`originPausesAi`). UNKNOWN: không nhường mù, nhưng vẫn tính là đã trả lời
 *     lượt ngay trước nó (không trả lời đôi) và để lại lý do `UNKNOWN_SENDER` cho người kiểm — lượt khách KẾ TIẾP AI trả lời.
 *  5. Máy trạng thái chủ trả lời (`responseOwnerState`): AI_ACTIVE · HUMAN_ACTIVE · TEMPORARY_AI_PAUSE · HANDOFF_PENDING · RESOLVED.
 *  6. Hết nhường ⇒ đánh giá lại TỒN (`resumeDecision`): lượt khách MỚI NHẤT còn chưa ai trả lời, còn tươi ⇒ AI trả lời MỘT lần cho
 *     cả lượt — không gửi bù từng tin.
 *  7. Đếm cho bảng điều khiển (`ownershipMetrics`) + HÀNG ĐỢI CỨU ĐƠN (`rescueCandidates`): ý định mua → AI bị chặn → không ai trả
 *     lời hợp lệ.
 */

// ─────────────────────────── Hằng ───────────────────────────

/** Ghi chú dòng tin ra của ERP (bản sao chữ của `fanpage.ts` — bài kiểm so bằng nhau; tệp thuần không nhập tệp máy chủ). */
export const BOT_SENT_NOTE = "BOT_SENT";
export const PAGE_REPLY_NOTE = "PAGE_REPLY";
export const STAFF_OUT_ID_PREFIX = "staff-out:";

/** Nguồn gốc của MỘT tin ra (phía page). Danh sách ĐÓNG — `sales_chat_inbound.sender_kind` có CHECK đúng danh sách này. */
export const OUTBOUND_ORIGINS = ["AI_AGENT", "VERIFIED_HUMAN", "PANCAKE_AUTOMATION", "META_SYSTEM", "OTHER_APP", "UNKNOWN"] as const;
export type OutboundOrigin = (typeof OUTBOUND_ORIGINS)[number];
export type SenderKind = "CUSTOMER" | OutboundOrigin;

export const ORIGIN_LABEL: Record<OutboundOrigin, string> = {
  AI_AGENT: "Bot ERP",
  VERIFIED_HUMAN: "Nhân viên (đã xác minh)",
  PANCAKE_AUTOMATION: "Tự động của page",
  META_SYSTEM: "Dòng hệ thống Facebook / Pancake",
  OTHER_APP: "Ứng dụng khác nối page",
  UNKNOWN: "Phía page — chưa rõ ai gửi",
};

/** Nhãn tác giả của dòng phía page trong hộp thư (ngoài ERP). HÀM THUẦN. */
export function pageAuthorLabel(origin: OutboundOrigin | null): string {
  if (!origin || origin === "UNKNOWN") return "Phía page (ngoài ERP)";
  return `${ORIGIN_LABEL[origin]} (ngoài ERP)`;
}

/** Hai mốc tới cách nhau ít hơn chừng này mà thiếu mốc nguồn ⇒ KHÔNG biết tin nào tạo trước. */
export const ORDER_AMBIGUITY_MS = 60_000;
/** Tin phía page chưa rõ nguồn nằm trong chừng này quanh tin MỞ phiên của khách ⇒ tin chào / tự động của page. */
export const GREETING_WINDOW_MS = 60_000;
/** Im lặng lâu hơn chừng này ⇒ tin khách kế tiếp mở PHIÊN mới (quảng cáo kéo khách cũ quay lại cũng có tin chào). */
export const SESSION_GAP_MS = 24 * 3_600_000;
/**
 * Khoá so câu mẫu: gộp khoảng trắng, bỏ đầu / cuối (Pancake trả cùng một tin mẫu với xuống dòng / khoảng trắng khác nhau giữa các hội
 * thoại). Bản SQL tương đương ở `response-ownership-ledger.ts` (`btrim(regexp_replace(…, '[[:space:]]+', ' ', 'g'))`). HÀM THUẦN.
 */
export function templateKeyOf(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
/** Câu khách trùng nguyên văn ở ít nhất chừng này hội thoại KHÁC (7 ngày) ⇒ câu mẫu của quảng cáo, không phải câu tự gõ. */
export const CUSTOMER_TEMPLATE_MIN_THREADS = 2;
/** Hết nhường: lượt khách cũ hơn chừng này thì KHÔNG trả lời bù (nhắn vào hội thoại đã nguội là làm phiền) — vào hàng đợi người. */
export const RESUME_MAX_TURN_AGE_MS = 2 * 3_600_000;
/** Trung vị thời gian tới câu trả lời hợp lệ chỉ in khi mẫu ≥ chừng này (luật 63 — mẫu nhỏ trả `null`). */
export const TIMING_MIN_SAMPLE = 10;
/** Lượt khách bị chặn mà chưa ai trả lời quá chừng này ⇒ đếm vào «mất vì bị chặn». */
export const LOST_AFTER_MS = 2 * 3_600_000;

/**
 * CHỮ HỆ THỐNG của Facebook / Pancake đi kèm tin phía page — không ai gõ, không trả lời khách. «Bạn đang phản hồi bình luận…» là dòng
 * Facebook chèn vào TIN RIÊNG trả lời bình luận (ca «Lê Bạch Nguyên», «Thuy Nguyen» 0d12c66f…); các mẫu còn lại là ghi chú tự động của
 * Pancake (`PANCAKE_AUTO_NOTE_RE` ở fanpage.ts — đường nhận đã bỏ chúng, ở đây để dòng cũ / tin đọc từ Pancake cũng phân loại đúng).
 */
export const META_SYSTEM_TEXT_RE =
  /bạn đang phản hồi bình luận|you(?:'|’)?re replying to (?:a )?comment|replied to (?:a|your) comment|đã trả lời (?:về )?một (?:quảng cáo|bài viết)|nhãn tự động|đánh dấu trạng thái đơn|đặt giai đoạn của khách hàng/i;

/**
 * Bản SQL (Postgres `~*`) của `META_SYSTEM_TEXT_RE` — điều kiện «Tin khách chưa đọc» chạy ở máy chủ CSDL. Bài kiểm đối chiếu hai bản trên
 * cùng các câu mẫu.
 */
export const META_SYSTEM_TEXT_SQL_RE =
  "(bạn đang phản hồi bình luận|you('|’)?re replying to (a )?comment|replied to (a|your) comment|đã trả lời (về )?một (quảng cáo|bài viết)|nhãn tự động|đánh dấu trạng thái đơn|đặt giai đoạn của khách hàng)";

/** Ứng dụng của Meta mà nhân viên dùng để nhắn tay từ Hộp thư Page / Meta Business Suite (tiếng vọng mang `app_id` này). */
export const META_HUMAN_INBOX_APP_IDS: readonly string[] = ["263902037430900"];

// ─────────────────────────── 1. Nguồn gốc người gửi ───────────────────────────

/** Dữ kiện về MỘT tin phía page — mọi trường đều là thứ đường nhận / Pancake / Meta đã đưa, không trường nào là suy đoán. */
export type OutboundFacts = {
  text: string;
  /** Đúng mã tin bot ERP đã ghi lúc gửi, hoặc trùng / chứa nguyên văn một đoạn bot vừa gửi (tiếng vọng). */
  botEcho: boolean;
  /** Dòng nhân viên gửi từ hộp thư ERP (`staff-out:`), hoặc tiếng vọng của nó. */
  erpStaff: boolean;
  /** Pancake gắn người gửi là tài khoản nhân viên (`from.uid` / `from.admin_id`) và KHÔNG gắn cờ tự động. */
  pancakeStaffAccount: boolean;
  /** Pancake / Meta gắn cờ tự động (`is_automated` / `ai_generated`). */
  automatedFlag: boolean;
  /** Tiếng vọng Meta: `app_id` của ứng dụng gửi (Messenger trực tiếp). `null` = không có / không phải đường Meta. */
  metaAppId: string | null;
  /** Danh sách `app_id` của CHÍNH nền tảng (bot). */
  ownAppIds?: readonly string[];
  /** Nguyên văn (≥ 40 ký tự) page đã gửi ở một hội thoại KHÁC trong 7 ngày — tin mẫu tự động. */
  templateText: boolean;
};

/**
 * Nguồn gốc MỘT tin phía page. Thứ tự = độ chắc của chứng cứ: tiếng vọng của chính ERP → chữ hệ thống → cờ tự động / tin mẫu → tài
 * khoản nhân viên (Pancake) / ứng dụng hộp thư của Meta → ứng dụng khác → KHÔNG RÕ. «Bot vừa nói trong 3 giờ» KHÔNG phải chứng cứ
 * (đó là gốc của ca «Lê Bạch Nguyên»). HÀM THUẦN.
 */
export function classifyOutbound(f: OutboundFacts): OutboundOrigin {
  if (f.botEcho) return "AI_AGENT";
  if (f.erpStaff) return "VERIFIED_HUMAN";
  if (META_SYSTEM_TEXT_RE.test(f.text)) return "META_SYSTEM";
  if (f.metaAppId && (f.ownAppIds ?? []).includes(f.metaAppId)) return "AI_AGENT";
  if (f.automatedFlag) return "PANCAKE_AUTOMATION";
  // Tài khoản nhân viên Pancake gõ một câu đã dùng ở hội thoại khác (câu trả lời lưu sẵn) vẫn là NGƯỜI — tin mẫu chỉ là chứng cứ khi
  // không có danh tính người gửi.
  if (f.pancakeStaffAccount) return "VERIFIED_HUMAN";
  // Câu mẫu xét TRƯỚC mã app hộp thư người của Meta: chưa có số đo chứng minh trả lời tự động / trả lời nhanh cài trong Business Suite
  // KHÔNG mang mã app đó — đảo thứ tự thì lời chào quảng cáo thành «người», đóng lượt và AI nhường 30 phút (đúng ca #856, chiều ngược).
  if (f.templateText) return "PANCAKE_AUTOMATION";
  if (f.metaAppId) return META_HUMAN_INBOX_APP_IDS.includes(f.metaAppId) ? "VERIFIED_HUMAN" : "OTHER_APP";
  return "UNKNOWN";
}

/** Chỉ người ĐÃ XÁC MINH mới làm AI nhường (luật 4). UNKNOWN / tự động / hệ thống / ứng dụng khác ⇒ không. HÀM THUẦN. */
export function originPausesAi(origin: OutboundOrigin): boolean {
  return origin === "VERIFIED_HUMAN";
}

/** Đọc ngược cột `sender_kind` (chuỗi lạ / NULL ⇒ `null` — dòng cũ trước 0244). HÀM THUẦN. */
export function parseOrigin(v: unknown): OutboundOrigin | null {
  return typeof v === "string" && (OUTBOUND_ORIGINS as readonly string[]).includes(v) ? (v as OutboundOrigin) : null;
}

/**
 * Người gửi của MỘT dòng sổ tin thô (`sales_chat_inbound`): `BOT_SENT` ⇒ AI_AGENT; `PAGE_REPLY` của hộp thư ERP ⇒ VERIFIED_HUMAN;
 * `PAGE_REPLY` khác ⇒ cột `sender_kind` (dòng cũ chưa có ⇒ UNKNOWN, kèm chữ hệ thống ⇒ META_SYSTEM); còn lại ⇒ khách. HÀM THUẦN.
 */
export function senderOfRow(r: { note: string | null; messageId: string; senderKind?: string | null; text?: string }): SenderKind {
  if (r.note === BOT_SENT_NOTE) return "AI_AGENT";
  if (r.note === PAGE_REPLY_NOTE) {
    if (r.messageId.startsWith(STAFF_OUT_ID_PREFIX)) return "VERIFIED_HUMAN";
    const stored = parseOrigin(r.senderKind);
    if (stored) return stored;
    return r.text && META_SYSTEM_TEXT_RE.test(r.text) ? "META_SYSTEM" : "UNKNOWN";
  }
  return "CUSTOMER";
}

// ─────────────────────────── 2. Lượt khách ───────────────────────────

export type LedgerMessage = {
  id: string;
  sender: SenderKind;
  text?: string;
  /** Mốc ERP NHẬN dòng này (ms) — `created_at`. Với tin ERP tự gửi (bot / nhân viên ERP) đây cũng là mốc gửi. */
  arrivedAt: number;
  /** Mốc TẠO tin ở nguồn (Pancake `inserted_at` / Meta `timestamp`), ms. `null` = chưa biết. */
  sourceAt: number | null;
  /** Thứ tự trong danh sách của nguồn (cùng mốc nguồn thì phân xử bằng số này). */
  sourceSeq?: number | null;
  /** Tin khách: câu mẫu quảng cáo (`CUSTOMER_TEMPLATE_MIN_THREADS`). */
  template?: boolean;
  /**
   * Tin khách KHÔNG có chữ mà AI đọc được (nhãn dán · ghi âm · video — ghi chú MEDIA_ONLY). Vẫn là một LƯỢT KHÁCH với hàng đợi người
   * (mở / kéo dài lượt — «không bỏ sót khách»), nhưng lượt chỉ gồm tin như vậy KHÔNG để AI trả lời (`CustomerTurn.aiAnswerable`).
   */
  mediaOnly?: boolean;
  /** Trạng thái / ghi chú của dòng tin khách (PENDING · DONE · SKIPPED · DEAD). */
  status?: string | null;
  note?: string | null;
};

export type CustomerTurn = {
  /** Mã lượt TẤT ĐỊNH: theo mã tin khách ĐẦU của lượt. */
  id: string;
  messageIds: string[];
  firstAt: number;
  lastAt: number;
  lastMessageId: string;
  /** Mọi tin của lượt đều là câu mẫu quảng cáo. CHỈ ĐỂ ĐỌC / HIỂN THỊ: từ #856 không quyết định nào (trả lời hay không, ai đóng lượt) dựa vào cờ này. */
  allTemplate: boolean;
  /** Lượt có ít nhất một tin AI đọc được (không chỉ nhãn dán / ghi âm). `false` ⇒ việc của người, AI không trả lời / không gửi bù. */
  aiAnswerable: boolean;
  answered: boolean;
  answeredBy: { id: string; origin: OutboundOrigin; at: number } | null;
};

export function turnIdOf(firstMessageId: string): string {
  return `turn:${firstMessageId}`;
}

const keyOf = (m: LedgerMessage) => m.sourceAt ?? m.arrivedAt;

function orderLedger(ms: readonly LedgerMessage[]): LedgerMessage[] {
  return [...ms].sort((a, b) => keyOf(a) - keyOf(b) || a.arrivedAt - b.arrivedAt || (a.sourceSeq ?? 0) - (b.sourceSeq ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Tin ra `o` CHẮC CHẮN tạo SAU tin khách `c`? Bot / nhân viên ERP: mốc gửi của chính ERP so với mốc ERP nhận tin khách, và bot chỉ
 * trả lời tin nó đã THẤY (tin còn PENDING ⇒ chưa). Tin ngoài ERP: hai mốc nguồn (bằng nhau ⇒ thứ tự nguồn; không có ⇒ KHÔNG chắc);
 * thiếu mốc nguồn ⇒ tới sau ≥ `ORDER_AMBIGUITY_MS`. Không chắc ⇒ `false` — khách nhận một câu trùng còn hơn không ai trả lời. HÀM THUẦN.
 */
export function definitelyAfter(o: LedgerMessage, c: LedgerMessage): boolean {
  if (o.sender === "AI_AGENT") return c.status !== "PENDING" && o.arrivedAt > c.arrivedAt;
  // Nhân viên gửi từ hộp thư ERP (đồng hồ của ERP, không có mốc nguồn): họ chỉ thấy tin khách ERP ĐÃ nhận.
  if (o.sender === "VERIFIED_HUMAN" && o.sourceAt === null) return o.arrivedAt > c.arrivedAt;
  if (o.sourceAt !== null && c.sourceAt !== null) {
    if (o.sourceAt !== c.sourceAt) return o.sourceAt > c.sourceAt;
    return o.sourceSeq != null && c.sourceSeq != null && o.sourceSeq > c.sourceSeq;
  }
  return o.arrivedAt - c.arrivedAt >= ORDER_AMBIGUITY_MS;
}

/**
 * Tin phía page CHƯA RÕ nguồn nằm quanh tin MỞ PHIÊN của khách (hội thoại mới, hoặc sau ≥ 24 giờ im) ⇒ tin chào / tự động của page
 * (lời chào quảng cáo tới trước hay sau tin khách đều vậy — «Nguyễn Oanh», «Moscow Hoàng Hải», «Tuyet Nguyen», «Uyen Tran»). HÀM THUẦN.
 */
export function effectiveOrigins(ms: readonly LedgerMessage[]): Map<string, SenderKind> {
  const ordered = orderLedger(ms);
  const out = new Map<string, SenderKind>(ordered.map((m) => [m.id, m.sender]));
  const starts: number[] = [];
  let lastActivity: number | null = null;
  for (const m of ordered) {
    if (m.sender === "CUSTOMER") {
      if (lastActivity === null || keyOf(m) - lastActivity >= SESSION_GAP_MS) starts.push(keyOf(m));
      lastActivity = keyOf(m);
    } else if (m.sender === "AI_AGENT" || m.sender === "VERIFIED_HUMAN") lastActivity = keyOf(m);
  }
  for (const m of ordered) {
    if (m.sender !== "UNKNOWN") continue;
    if (starts.some((s) => Math.abs(keyOf(m) - s) <= GREETING_WINDOW_MS)) out.set(m.id, "PANCAKE_AUTOMATION");
  }
  return out;
}

/**
 * Tin ra có TRẢ LỜI một lượt khách không. Hợp lệ: bot ERP · người đã xác minh · ứng dụng khác · không rõ (không trả lời đôi — luật 4).
 * Tự động của page và chữ hệ thống KHÔNG BAO GIỜ — kể cả với lượt toàn câu mẫu quảng cáo (luật 2, issue #856). HÀM THUẦN.
 */
export function answers(origin: SenderKind): boolean {
  return origin !== "CUSTOMER" && origin !== "META_SYSTEM" && origin !== "PANCAKE_AUTOMATION";
}

/**
 * LƯỢT KHÁCH của MỘT hội thoại, theo thứ tự nguồn. Tin khách liên tiếp gom thành một lượt; tin ra KHÔNG trả lời được (tự động, hệ
 * thống, mơ hồ thứ tự) không cắt lượt. Tin ra hợp lệ trả lời phần ĐẦU của lượt mà nó chắc chắn tới sau ⇒ phần đó thành một lượt đã trả
 * lời, phần còn lại vẫn mở (khách gõ thêm trong lúc bot soạn KHÔNG bị nuốt). Chỉ lượt CUỐI có thể còn mở. HÀM THUẦN.
 */
export function buildCustomerTurns(ms: readonly LedgerMessage[], opts: { handledThrough?: number | null } = {}): CustomerTurn[] {
  const origins = effectiveOrigins(ms);
  const ordered = orderLedger(ms);
  const turns: CustomerTurn[] = [];
  let open: LedgerMessage[] = [];
  const close = (msgs: LedgerMessage[], by: CustomerTurn["answeredBy"]) => {
    turns.push({
      id: turnIdOf(msgs[0].id),
      messageIds: msgs.map((m) => m.id),
      firstAt: keyOf(msgs[0]),
      lastAt: keyOf(msgs[msgs.length - 1]),
      lastMessageId: msgs[msgs.length - 1].id,
      allTemplate: msgs.every((m) => m.template === true),
      aiAnswerable: msgs.some((m) => !m.mediaOnly),
      answered: by !== null,
      answeredBy: by,
    });
  };
  for (const m of ordered) {
    const origin = origins.get(m.id) ?? m.sender;
    if (origin === "CUSTOMER") {
      open.push(m);
      continue;
    }
    if (!open.length) continue;
    if (!answers(origin)) continue;
    let covered = 0;
    while (covered < open.length && definitelyAfter(m, open[covered])) covered++;
    if (!covered) continue;
    close(open.slice(0, covered), { id: m.id, origin: origin as OutboundOrigin, at: keyOf(m) });
    open = open.slice(covered);
  }
  if (open.length) {
    // NGƯỜI XỬ LÝ RÕ (đánh dấu đã xử lý trong ERP) tới mốc `handledThrough` ⇒ phần lượt nhận trước mốc đó coi như đã trả lời.
    const h = opts.handledThrough ?? null;
    const handled = h === null ? 0 : open.filter((m) => m.arrivedAt <= h).length;
    if (handled === open.length) close(open, { id: "handled", origin: "VERIFIED_HUMAN", at: h! });
    else {
      if (handled) close(open.slice(0, handled), { id: "handled", origin: "VERIFIED_HUMAN", at: h! });
      close(open.slice(handled), null);
    }
  }
  return turns;
}

/**
 * ═══ «TIN KHÁCH CHƯA ĐỌC» CỦA HỘP THƯ = LƯỢT KHÁCH MỚI NHẤT CHƯA ĐƯỢC XỬ LÝ (chủ shop 11/10/2026 — OWNER CORRECTION) ═══
 *
 * MỘT định nghĩa, hai dạng: hàm thuần này (TS) và `latestCustomerTurnUnhandledSql` (response-ownership-ledger.ts — điều kiện SQL cho
 * listInbox / bộ đếm). `tests/response-ownership.test.ts` chạy CẢ HAI trên cùng một bộ dữ liệu PGlite và so từng hội thoại.
 *
 * Lượt khách mới nhất ĐÃ XỬ LÝ khi tin khách CUỐI (theo thứ tự nguồn) có, đứng SAU nó, một trong:
 *  (1) câu bot đã gửi (dòng `BOT_SENT` — dòng ghi sẵn bị XOÁ khi gửi hỏng) mà bot đã THẤY tin khách đó (không còn PENDING);
 *  (2) câu nhân viên hợp lệ: hộp thư ERP (`staff-out:` — tin nhân viên chưa `SENT` không tính) hoặc người đã xác minh phía page;
 *  (3) câu phía page hợp lệ: ứng dụng khác / chưa rõ người gửi (không phải tin chào đầu phiên), chắc chắn tạo sau (`definitelyAfter`);
 *  (4) một NGƯỜI mở / đọc tường minh lượt đó — con trỏ đọc của BẤT KỲ người dùng (`sales_chat_reads.read_through_at`), hoặc mốc mở
 *      cấp cửa hàng cũ `staff_seen_at` (trước con trỏ V3 10/10 — bằng chứng người mở), ≥ tin khách cuối.
 * Tin khách MEDIA_ONLY (nhãn dán / ghi âm) LÀ một lượt khách ở đây (người phải thấy) — chỉ đường AI mới không trả lời lượt toàn media.
 * Tin tự động của page (kể cả trả lời câu mẫu quảng cáo) và chữ hệ thống KHÔNG BAO GIỜ là xử lý — CÙNG luật với đường quyết định của
 * AI từ 16/10/2026 (issue #856), nên hộp thư và AI không còn chỗ «hộp thư báo chờ mà AI đã đóng lượt».
 * Không có tin khách nào ⇒ không có gì chưa xử lý. Dùng chung `effectiveOrigins` · `answers` · `definitelyAfter` với đường quyết định.
 */
export type LatestTurnState = {
  hasCustomer: boolean;
  /** `true` = không nằm trong «Tin khách chưa đọc». */
  handled: boolean;
  /** Ai xử lý: nguồn gốc câu trả lời, hoặc `HUMAN_READ` (người mở / đọc). `null` = chưa xử lý / không có lượt. */
  by: OutboundOrigin | "HUMAN_READ" | null;
  turnId: string | null;
  lastCustomerId: string | null;
  /** Mốc tin khách cuối (thứ tự nguồn), ms. */
  lastCustomerAt: number | null;
};

export function latestTurnHandled(ledger: readonly LedgerMessage[], opts: { readThroughAt?: number | null } = {}): LatestTurnState {
  const origins = effectiveOrigins(ledger);
  const ordered = orderLedger(ledger);
  let lastIdx = -1;
  ordered.forEach((m, i) => {
    if (m.sender === "CUSTOMER") lastIdx = i;
  });
  if (lastIdx < 0) return { hasCustomer: false, handled: true, by: null, turnId: null, lastCustomerId: null, lastCustomerAt: null };
  const c = ordered[lastIdx];
  const base = { hasCustomer: true, turnId: buildCustomerTurns(ledger).at(-1)?.id ?? turnIdOf(c.id), lastCustomerId: c.id, lastCustomerAt: keyOf(c) };
  for (const o of ordered.slice(lastIdx + 1)) {
    const origin = origins.get(o.id) ?? o.sender;
    if (origin === "CUSTOMER" || !answers(origin)) continue;
    if (definitelyAfter(o, c)) return { ...base, handled: true, by: origin };
  }
  const h = opts.readThroughAt ?? null;
  if (h !== null && c.arrivedAt <= h) return { ...base, handled: true, by: "HUMAN_READ" };
  return { ...base, handled: false, by: null };
}

/**
 * CHAT WEB (không có sổ tin thô — lịch sử hội thoại chính là thứ khách thấy): lượt khách = dòng `user` CÓ khối chữ (dòng kết quả công
 * cụ cũng mang vai `user` — không phải khách); xử lý = dòng `assistant` có khối chữ đứng SAU nó theo `seq` (bot / «[Shop đã nhắn]» của
 * nhân viên — chat web không có đường gửi hỏng: câu đã ghi là câu khách thấy khi mở lại khung chat), hoặc người mở / đọc tường minh.
 * Cùng hợp đồng `LatestTurnState` với kênh nhắn tin; bản SQL cùng tệp ledger. HÀM THUẦN.
 */
export type WebMessage = { seq: number; role: "user" | "assistant"; hasText: boolean; at: number; staff?: boolean };

export function latestWebTurnHandled(msgs: readonly WebMessage[], opts: { readThroughAt?: number | null } = {}): LatestTurnState {
  const users = msgs.filter((m) => m.role === "user" && m.hasText);
  if (!users.length) return { hasCustomer: false, handled: true, by: null, turnId: null, lastCustomerId: null, lastCustomerAt: null };
  const last = users.reduce((a, b) => (b.seq > a.seq ? b : a));
  const firstOfTurn = [...users].filter((u) => u.seq <= last.seq && !msgs.some((m) => m.role === "assistant" && m.hasText && m.seq > u.seq && m.seq < last.seq)).reduce((a, b) => (b.seq < a.seq ? b : a), last);
  const base = { hasCustomer: true, turnId: turnIdOf(`web:${firstOfTurn.seq}`), lastCustomerId: `web:${last.seq}`, lastCustomerAt: last.at };
  const reply = msgs.filter((m) => m.role === "assistant" && m.hasText && m.seq > last.seq).sort((a, b) => a.seq - b.seq)[0];
  if (reply) return { ...base, handled: true, by: reply.staff ? "VERIFIED_HUMAN" : "AI_AGENT" };
  const h = opts.readThroughAt ?? null;
  if (h !== null && last.at <= h) return { ...base, handled: true, by: "HUMAN_READ" };
  return { ...base, handled: false, by: null };
}

/** API theo yêu cầu: một lượt + các tin TỚI SAU nó ⇒ đã trả lời chưa, bởi ai. HÀM THUẦN. */
export function turnAnswered(turn: readonly LedgerMessage[], later: readonly LedgerMessage[]): { answered: boolean; by: CustomerTurn["answeredBy"] } {
  if (!turn.length) return { answered: true, by: null };
  const all = buildCustomerTurns([...turn, ...later]);
  const last = all.find((t) => t.messageIds.includes(turn[turn.length - 1].id));
  return { answered: Boolean(last?.answered), by: last?.answeredBy ?? null };
}

/** MỘT tin theo danh sách của NGUỒN (Pancake): mốc tạo + thứ tự + nguồn gốc nếu là tin ra (`null` = tin khách). */
export type SourceMessage = { id: string; at: number | null; seq: number; outbound: OutboundOrigin | null; text: string };

/**
 * Ghép lời khai của NGUỒN vào sổ: dòng đã có nhận mốc tạo + thứ tự của nguồn; tin RA mà webhook chưa kịp tới (Pancake giữ tin ngay
 * khi nhận — «Dư Thị Liên» 05/10) được thêm vào sổ với nguồn gốc đã phân loại. Tin KHÁCH chưa có trong sổ KHÔNG thêm (đường nhận /
 * quét lại ghi nó, và nó sẽ có lượt riêng). HÀM THUẦN.
 */
export function mergeSourceView(ledger: readonly LedgerMessage[], source: readonly SourceMessage[]): LedgerMessage[] {
  const byId = new Map(source.map((s) => [s.id, s]));
  const known = new Set(ledger.map((m) => m.id));
  const out = ledger.map((m) => {
    const s = byId.get(m.id);
    return s && s.at !== null ? { ...m, sourceAt: s.at, sourceSeq: s.seq } : m;
  });
  for (const s of source) {
    if (known.has(s.id) || s.outbound === null || s.at === null) continue;
    out.push({ id: s.id, sender: s.outbound, text: s.text, arrivedAt: s.at, sourceAt: s.at, sourceSeq: s.seq });
  }
  return out;
}

/** Lượt mở (chưa ai trả lời) — `null` khi mọi lượt đã có câu trả lời. HÀM THUẦN. */
export function openTurnOf(turns: readonly CustomerTurn[]): CustomerTurn | null {
  const last = turns[turns.length - 1];
  return last && !last.answered ? last : null;
}

/**
 * Chia các tin khách CHỜ BOT (PENDING) thành: đã có câu trả lời hợp lệ sau nó (chốt «page đã trả lời», kèm nguồn gốc người trả lời) ·
 * thuộc lượt MỞ (bot trả lời MỘT lần cho cả lượt). HÀM THUẦN.
 */
export function partitionPending(pendingIds: readonly string[], turns: readonly CustomerTurn[]): { answered: string[]; open: string[]; answeredBy: OutboundOrigin | null; openTurn: CustomerTurn | null } {
  const set = new Set(pendingIds);
  const answered: string[] = [];
  const open: string[] = [];
  let answeredBy: OutboundOrigin | null = null;
  for (const t of turns) {
    for (const id of t.messageIds) {
      if (!set.has(id)) continue;
      if (t.answered) {
        answered.push(id);
        answeredBy = t.answeredBy?.origin ?? answeredBy;
      } else open.push(id);
    }
  }
  // Tin chờ không có trong sổ (đọc thiếu) ⇒ coi là chưa ai trả lời — không bao giờ nuốt.
  for (const id of pendingIds) if (!answered.includes(id) && !open.includes(id)) open.push(id);
  return { answered, open, answeredBy, openTurn: openTurnOf(turns) };
}

// ─────────────────────────── 3. Máy trạng thái chủ trả lời ───────────────────────────

/** Tên trạng thái DÙNG CHUNG với worker `handoff-ownership` — nhập từ đây, không gõ lại chữ. */
export const RESPONSE_OWNER_STATES = ["AI_ACTIVE", "HUMAN_ACTIVE", "TEMPORARY_AI_PAUSE", "HANDOFF_PENDING", "RESOLVED"] as const;
export type ResponseOwnerState = (typeof RESPONSE_OWNER_STATES)[number];

export const RESPONSE_OWNER_LABEL: Record<ResponseOwnerState, string> = {
  AI_ACTIVE: "AI đang trả lời",
  HUMAN_ACTIVE: "Người đang trả lời",
  TEMPORARY_AI_PAUSE: "AI tạm nhường",
  HANDOFF_PENDING: "Chờ người nhận",
  RESOLVED: "Đã xong",
};

/** Dữ kiện nhường đã lưu (`aiHoldOf` — ai-hold-shared.ts) + mốc tiếp quản / ai cầm. */
export type OwnerInput = {
  hold: { state: "AI_ACTIVE" | "HUMAN_COOLDOWN" | "HUMAN_TAKEOVER"; cause: "STAFF_REPLY" | "AI_DOWN" | "TAKEOVER" | "NEEDS_HUMAN" | null; until: Date | null };
  conversationStatus: string;
  handoffReason: string | null;
  openTurn: CustomerTurn | null;
  /** Ai đang cầm (người phụ trách) — `null` = không ai. */
  assigneeUserId?: string | null;
};

export type OwnerView = {
  state: ResponseOwnerState;
  reason: string;
  /** Mốc AI được trả lời lại (chỉ TEMPORARY_AI_PAUSE). */
  resumeAt: string | null;
  /** Lượt khách mở mà AI KHÔNG trả lời được ⇒ hàng đợi cần người. */
  needsQueue: boolean;
};

/** Trạng thái chủ trả lời của MỘT hội thoại. HÀM THUẦN. */
export function responseOwnerState(i: OwnerInput): OwnerView {
  const open = i.openTurn !== null;
  if (i.hold.state === "HUMAN_TAKEOVER") {
    if (i.hold.cause === "TAKEOVER") return { state: "HUMAN_ACTIVE", reason: "Người tiếp quản trong ERP", resumeAt: null, needsQueue: open };
    return { state: "HANDOFF_PENDING", reason: i.handoffReason ?? "AI đã chuyển người", resumeAt: null, needsQueue: open };
  }
  if (i.hold.state === "HUMAN_COOLDOWN") {
    return { state: "TEMPORARY_AI_PAUSE", reason: i.hold.cause === "AI_DOWN" ? "AI tạm hỏng — tự thử lại" : "Nhân viên vừa trả lời tay", resumeAt: i.hold.until ? i.hold.until.toISOString() : null, needsQueue: open };
  }
  if (i.conversationStatus === "CLOSED" && !open) return { state: "RESOLVED", reason: "Đã chốt", resumeAt: null, needsQueue: false };
  return { state: "AI_ACTIVE", reason: "AI trả lời lượt khách kế tiếp", resumeAt: null, needsQueue: false };
}

/** «HH:mm» giờ Việt Nam. HÀM THUẦN. */
export function vnClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/**
 * Câu phụ dưới dấu vết của MỘT tin khách: lượt của nó có ai trả lời chưa, và nếu chưa thì ai đang cầm / AI tiếp lúc nào. Ghi chú cũ
 * «Page / nhân viên đã trả lời» mà sổ cho thấy KHÔNG có câu trả lời hợp lệ ⇒ nói thẳng là ghi nhầm. `null` = không cần câu phụ. HÀM THUẦN.
 */
export function turnTraceNote(i: { answered: boolean; isOpenTurn: boolean; code: string | null; owner: OwnerView; answeredBy: OutboundOrigin | null }): string | null {
  if (i.answered) {
    if (i.code === "AI_SKIPPED_PAGE_ANSWERED" && i.answeredBy) return `Đã có câu trả lời sau tin này — ${ORIGIN_LABEL[i.answeredBy]}`;
    return null;
  }
  if (!i.code) return null;
  const prefix = i.code === "AI_SKIPPED_PAGE_ANSWERED" ? "Ghi nhầm «đã trả lời»: chưa có câu trả lời hợp lệ nào sau tin này" : "Chưa ai trả lời lượt này";
  if (!i.isOpenTurn) return prefix;
  if (i.owner.state === "TEMPORARY_AI_PAUSE") return `${prefix} · ${i.owner.reason} · AI tiếp lúc ${vnClock(i.owner.resumeAt)}`;
  if (i.owner.state === "HUMAN_ACTIVE") return `${prefix} · người đang tiếp quản — trả lời từ hộp thư`;
  if (i.owner.state === "HANDOFF_PENDING") return `${prefix} · chờ người nhận`;
  return `${prefix} · AI sẽ đánh giá lại ở lượt quét kế tiếp`;
}

// ─────────────────────────── 4. Hết nhường ⇒ đánh giá lại tồn ───────────────────────────

export type ResumeVerdict = { resume: true; turnId: string; messageIds: string[] } | { resume: false; reason: "NOT_AI" | "NO_OPEN_TURN" | "MEDIA_ONLY" | "IN_FLIGHT" | "NOT_PAUSED" | "STALE" };

/**
 * Hội thoại vừa về tay AI (hết nhường / trả lại): lượt khách MỚI NHẤT chưa ai trả lời, mọi tin của nó bị chốt bởi một lý do nhường /
 * «đã trả lời» nhầm (`pauseNotes`), còn tươi ⇒ mở lại CẢ lượt cho MỘT câu trả lời. Tin đang chờ (PENDING) ⇒ đường webhook đang lo. HÀM THUẦN.
 */
export function resumeDecision(i: { owner: ResponseOwnerState; turns: readonly CustomerTurn[]; ledger: readonly LedgerMessage[]; nowMs: number; pauseNotes: (note: string | null) => boolean; maxAgeMs?: number }): ResumeVerdict {
  if (i.owner !== "AI_ACTIVE") return { resume: false, reason: "NOT_AI" };
  const t = openTurnOf(i.turns);
  if (!t) return { resume: false, reason: "NO_OPEN_TURN" };
  // Nhãn dán / ghi âm trong lượt: không phải việc của AI, không cần mở lại — chỉ xét các tin AI đọc được.
  const rows = t.messageIds.map((id) => i.ledger.find((m) => m.id === id)).filter((r) => !r?.mediaOnly);
  if (!t.aiAnswerable || !rows.length) return { resume: false, reason: "MEDIA_ONLY" };
  if (rows.some((r) => r?.status === "PENDING")) return { resume: false, reason: "IN_FLIGHT" };
  if (!rows.every((r) => r && r.status === "SKIPPED" && i.pauseNotes(r.note ?? null))) return { resume: false, reason: "NOT_PAUSED" };
  if (i.nowMs - t.lastAt > (i.maxAgeMs ?? RESUME_MAX_TURN_AGE_MS)) return { resume: false, reason: "STALE" };
  return { resume: true, turnId: t.id, messageIds: rows.map((r) => r!.id) };
}

// ─────────────────────────── 5. Ý định mua ───────────────────────────

const PHONE_RE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}/;
/** Ranh giới chữ an toàn với tiếng Việt (`\b` của JS chỉ hiểu chữ ASCII) — nhóm bắt tiền tố, KHÔNG nhìn-ngược (Safari < 16.4). */
const L = String.raw`(?:^|[^\p{L}\d])`;
const R = String.raw`(?=$|[^\p{L}\d])`;
const BUY_RES: readonly RegExp[] = [
  new RegExp(String.raw`${L}(?:lấy|lay|mua|đặt|dat|order)\s*\d`, "iu"),
  new RegExp(String.raw`${L}(?:chốt|chot|lên đơn|len don)${R}`, "iu"),
  new RegExp(String.raw`${L}(?:lấy|lay|mua|đặt|dat)\s+(?:luôn|luon|nha|nhé|nhe|đi|di|cho (?:mình|minh|em|chị|chi|anh|tôi|toi|tui))${R}`, "iu"),
  new RegExp(String.raw`${L}(?:ship|gửi|gui|giao)\s+cho\s+(?:mình|minh|em|chị|chi|anh|tôi|toi|tui)${R}`, "iu"),
  // Cả tin chỉ là MỘT số lượng («2k nha», «1kg ạ», «3 hộp») — khách trả lời câu «lấy mấy kg» (ca «2k nha» bị nhường 11/10).
  new RegExp(String.raw`^\s*\d+(?:[.,]\d+)?\s*(?:kg|kí|ký|ki|k|g|hộp|hop|gói|goi|túi|tui|cái|cai|phần|phan|suất|set|combo)\s*(?:nha|nhé|nhe|ạ|a|thôi|thoi|luôn|luon|nhá|em|e|shop|sh)?\s*[.!]*\s*$`, "iu"),
];
const ADDRESS_RE = new RegExp(String.raw`${L}(?:(?:số nhà|sn|đường|duong|ngõ|ngo|hẻm|hem|kiệt|phường|phuong|xã|quận|quan|huyện|huyen|tp|thành phố|tỉnh|tinh)\.?\s*[\p{L}\d]|[pq]\.?\s?\d{1,2}${R})`, "iu");

/**
 * Câu khách có Ý ĐỊNH MUA không: lời chốt («lấy 1kg», «chốt đơn», «mua 2 hộp»), hoặc để lại SĐT / địa chỉ. Luật từ khoá — chỉ dùng để
 * ƯU TIÊN hàng đợi và báo người, KHÔNG dùng để tạo đơn hay tính tiền. HÀM THUẦN.
 */
export function purchaseIntent(text: string): { intent: boolean; kind: "BUY_WORDS" | "PHONE" | "ADDRESS" | null } {
  const s = text.normalize("NFC");
  if (BUY_RES.some((re) => re.test(s))) return { intent: true, kind: "BUY_WORDS" };
  if (PHONE_RE.test(s)) return { intent: true, kind: "PHONE" };
  if (ADDRESS_RE.test(s)) return { intent: true, kind: "ADDRESS" };
  return { intent: false, kind: null };
}

/**
 * Khách có ý định mua TRONG LÚC NHƯỜNG: có NGƯỜI THẬT cầm (nhường do người đã xác minh / tiếp quản tay) ⇒ báo ngay người đó (AI vẫn
 * im); nhường KHÔNG có người thật đứng sau (nguồn gốc mơ hồ / dòng cũ trước 0244) ⇒ AI tiếp ngay — không bao giờ bỏ khách sẵn sàng
 * mua. Không có ý định mua ⇒ giữ luật nhường. HÀM THUẦN.
 */
export function buyIntentDuringPause(i: { intent: boolean; owner: ResponseOwnerState; pauseVerified: boolean }): "NONE" | "NOTIFY_HOLDER" | "AI_CONTINUES" {
  if (!i.intent) return "NONE";
  if (i.owner === "HUMAN_ACTIVE") return "NOTIFY_HOLDER";
  if (i.owner === "TEMPORARY_AI_PAUSE") return i.pauseVerified ? "NOTIFY_HOLDER" : "AI_CONTINUES";
  if (i.owner === "HANDOFF_PENDING") return "NOTIFY_HOLDER";
  return "NONE";
}

// ─────────────────────────── 6. Đếm cho bảng điều khiển + hàng đợi cứu đơn ───────────────────────────

export type OwnershipThread = {
  conversationId: string | null;
  ledger: LedgerMessage[];
  owner: ResponseOwnerState;
  /** Khách đã từ chối nhận tin / từ chối mua (`state.declined`) — hàng đợi cứu đơn bỏ qua. */
  optedOut?: boolean;
  /** Giá trị tham khảo (tổng đơn nháp / giỏ, VND) — `null` = chưa biết (KHÔNG phải 0). */
  valueVnd?: number | null;
};

export type OwnershipMetrics = {
  threads: number;
  customerTurns: number;
  answeredTurns: number;
  /** Lượt khách chưa có câu trả lời hợp lệ (gồm cả lượt đang được AI soạn — `inFlight`). */
  unansweredTurns: number;
  inFlight: number;
  /** Lượt chưa ai trả lời mà tin của nó mang ghi chú «page đã trả lời» — trả lời GIẢ. */
  falseAnswered: number;
  /** Lượt chưa ai trả lời theo LÝ DO chặn (ghi chú của tin cuối lượt). */
  suppressionByReason: Record<string, number>;
  /** Lượt chưa ai trả lời đang nằm ở tay người (nhường / tiếp quản / chờ người). */
  humanBacklog: number;
  /** Thời gian từ tin khách cuối của lượt tới câu trả lời hợp lệ: số mẫu + trung vị / p90 (mẫu < 10 ⇒ `null`). */
  timeToValidResponse: { samples: number; medianMs: number | null; p90Ms: number | null };
  /** Lượt bị chặn, chưa ai trả lời, quá `LOST_AFTER_MS`. */
  lostToSuppression: number;
  /** Tin phía page chưa rõ ai gửi (UNKNOWN) — leo thang cho người kiểm. */
  unknownSender: number;
};

const quantile = (xs: number[], q: number): number | null => {
  if (xs.length < TIMING_MIN_SAMPLE) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

/** Đếm trên nhiều hội thoại. `falseAnsweredNote` = ghi chú «page đã trả lời» của đường xử lý. HÀM THUẦN. */
export function ownershipMetrics(threads: readonly OwnershipThread[], nowMs: number, opts: { falseAnsweredNote: string }): OwnershipMetrics {
  const out: OwnershipMetrics = { threads: threads.length, customerTurns: 0, answeredTurns: 0, unansweredTurns: 0, inFlight: 0, falseAnswered: 0, suppressionByReason: {}, humanBacklog: 0, timeToValidResponse: { samples: 0, medianMs: null, p90Ms: null }, lostToSuppression: 0, unknownSender: 0 };
  const waits: number[] = [];
  for (const th of threads) {
    const byId = new Map(th.ledger.map((m) => [m.id, m]));
    out.unknownSender += th.ledger.filter((m) => m.sender === "UNKNOWN").length;
    for (const t of buildCustomerTurns(th.ledger)) {
      out.customerTurns++;
      if (t.answered) {
        out.answeredTurns++;
        if (t.answeredBy && t.answeredBy.id !== "handled") waits.push(Math.max(0, t.answeredBy.at - t.lastAt));
        continue;
      }
      out.unansweredTurns++;
      const rows = t.messageIds.map((id) => byId.get(id));
      if (rows.some((r) => r?.status === "PENDING")) {
        out.inFlight++;
        continue;
      }
      if (rows.some((r) => r?.note === opts.falseAnsweredNote)) out.falseAnswered++;
      const last = byId.get(t.lastMessageId);
      const reason = last?.note ? last.note.slice(0, 80) : last?.status === "DEAD" ? "DEAD" : "(không ghi chú)";
      out.suppressionByReason[reason] = (out.suppressionByReason[reason] ?? 0) + 1;
      if (th.owner !== "AI_ACTIVE" && th.owner !== "RESOLVED") out.humanBacklog++;
      if (nowMs - t.lastAt > LOST_AFTER_MS) out.lostToSuppression++;
    }
  }
  out.timeToValidResponse = { samples: waits.length, medianMs: quantile(waits, 0.5), p90Ms: quantile(waits, 0.9) };
  return out;
}

export type RescueCandidate = {
  conversationId: string | null;
  turnId: string;
  lastMessageId: string;
  ageMs: number;
  intentKind: "BUY_WORDS" | "PHONE" | "ADDRESS";
  /** Lý do AI không trả lời (ghi chú của tin cuối lượt). */
  blockedBy: string;
  owner: ResponseOwnerState;
  valueVnd: number | null;
};

/**
 * HÀNG ĐỢI CỨU ĐƠN: lượt khách MỞ có ý định mua, AI đã bị chặn (tin bị chốt SKIPPED / DEAD), chưa ai trả lời hợp lệ, khách không
 * từ chối. Mỗi hội thoại MỘT dòng (lượt mở là duy nhất) ⇒ không trùng. Xếp: chờ LÂU nhất trước, cùng tuổi thì giá trị lớn trước
 * (giá trị chưa biết đứng sau giá trị đã biết). HÀM THUẦN.
 */
export function rescueCandidates(threads: readonly OwnershipThread[], nowMs: number): RescueCandidate[] {
  const out: RescueCandidate[] = [];
  for (const th of threads) {
    if (th.optedOut) continue;
    const t = openTurnOf(buildCustomerTurns(th.ledger));
    if (!t) continue;
    const rows = t.messageIds.map((id) => th.ledger.find((m) => m.id === id)).filter((m): m is LedgerMessage => Boolean(m) && !m?.mediaOnly);
    if (!rows.length || rows.some((r) => r.status === "PENDING" || r.status === "DONE")) continue;
    const hit = rows.map((r) => purchaseIntent(r.text ?? "")).find((x) => x.intent);
    if (!hit?.kind) continue;
    const last = rows[rows.length - 1];
    out.push({ conversationId: th.conversationId, turnId: t.id, lastMessageId: t.lastMessageId, ageMs: Math.max(0, nowMs - t.lastAt), intentKind: hit.kind, blockedBy: last.note ?? last.status ?? "", owner: th.owner, valueVnd: th.valueVnd ?? null });
  }
  return out.sort((a, b) => b.ageMs - a.ageMs || (b.valueVnd ?? -1) - (a.valueVnd ?? -1) || a.turnId.localeCompare(b.turnId));
}
