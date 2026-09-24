import { config } from "./config.js";
import { log } from "./logger.js";
import { settings } from "./settings.js";
import { store } from "./store.js";
import { catalog } from "./catalog.js";
import { generateReply, generateWithTools, listModels } from "./ai.js";
import { HANDOFF } from "./bot.js";
import { stripHtml, stripMarkdown, sortChrono } from "./util.js";

/**
 * Tro ly AI quan tri: chu shop chat bang tieng Viet, tro ly goi "cong cu" de doc/sua cai dat bot.
 * - Thay doi nho (bat/tat page, huong dan rieng, model...) lam ngay va bao lai.
 * - Thay doi lon (ghi de prompt chung, gui tin cho khach) -> tao "pending" va phai duoc xac nhan.
 */

const pending = new Map(); // id -> { type, pageId, text, cid, createdAt }
let pendingSeq = 1;

const PAGE_PARAM = { type: "STRING", description: "Tên hoặc ID page (ví dụ 'Hoa Trà', 'Linh Tây Luxury', '1107001939161360'). Dùng 'all' cho tất cả page." };

export const FUNCTIONS = [
  { name: "list_pages", description: "Liệt kê các page bot đang quản lý kèm trạng thái (bật/tắt, dry run, hướng dẫn riêng, model) và thống kê 7 ngày.", parameters: { type: "OBJECT", properties: {} } },
  { name: "get_page", description: "Xem chi tiết cài đặt hiện tại + 10 lần bot trả lời gần nhất của một page.", parameters: { type: "OBJECT", properties: { page: PAGE_PARAM }, required: ["page"] } },
  {
    name: "update_page_settings",
    description: "Sửa cài đặt của một page (hoặc 'all'). Chỉ truyền những trường cần đổi. Thay đổi có hiệu lực ngay.",
    parameters: {
      type: "OBJECT",
      properties: {
        page: PAGE_PARAM,
        enabled: { type: "BOOLEAN", description: "Bật/tắt bot trên page" },
        dryRun: { type: "BOOLEAN", description: "true = bot chỉ ghi log, không gửi tin cho khách" },
        commentMode: { type: "STRING", description: "Cách xử lý bình luận dưới bài viết: 'off' = không trả lời, 'public' = trả lời công khai ngắn, 'inbox' = nhắn riêng vào inbox (báo giá đầy đủ) + một câu công khai 'shop đã nhắn tin'. Chuỗi rỗng = theo mặc định chung" },
        sendProductImages: { type: "BOOLEAN", description: "Bot gửi ảnh sản phẩm cho khách" },
        model: { type: "STRING", description: "Model AI (Gemini: gemini-2.5-flash...; ChatGPT: gpt-4.1-mini, gpt-4.1, gpt-5-mini). Chuỗi rỗng = mặc định" },
        temperature: { type: "NUMBER", description: "0–1, thấp = chắc chắn, cao = sáng tạo" },
        humanTakeoverMinutes: { type: "NUMBER", description: "Số phút bot im lặng sau khi nhân viên thật trả lời trong hội thoại. 0 = bot luôn trả lời (chỉ bỏ qua khi nhân viên đã trả lời đúng tin đó rồi)" },
        minCustomerMessages: { type: "NUMBER", description: "Bot bắt đầu trả lời từ tin thứ mấy của khách. 1 = trả lời ngay tin đầu; 2 = để Pancake tự động trả lời tin đầu (gửi ảnh/báo giá), bot vào từ tin thứ 2" },
        displayName: { type: "STRING", description: "Tên hiển thị của page trong app và trong lời chào của bot (chuỗi rỗng = dùng tên thật từ Pancake)" },
        orderSync: { type: "BOOLEAN", description: "Khi bot chốt đơn xong có tự ghi đơn nháp vào POS (sản phẩm, SĐT, địa chỉ chuẩn hoá) không" },
      },
      required: ["page"],
    },
  },
  {
    name: "set_page_instructions",
    description: "Ghi đè toàn bộ 'Hướng dẫn riêng cho page' (văn bản markdown ngắn: cách xưng hô, địa chỉ, ưu đãi, mẫu chủ lực, câu trả lời mẫu...). Dùng khi cần viết lại từ đầu; muốn thêm dòng thì dùng append_page_instructions.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, text: { type: "STRING", description: "Nội dung hướng dẫn mới, đầy đủ" } }, required: ["page", "text"] },
  },
  {
    name: "append_page_instructions",
    description: "Thêm các dòng vào cuối 'Hướng dẫn riêng cho page' mà không xoá nội dung cũ.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, text: { type: "STRING", description: "Các dòng cần thêm (gạch đầu dòng)" } }, required: ["page", "text"] },
  },
  {
    name: "remove_from_page_instructions",
    description: "Xoá những dòng trong 'Hướng dẫn riêng cho page' có chứa một cụm từ.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, contains: { type: "STRING", description: "Cụm từ nhận diện dòng cần xoá" } }, required: ["page", "contains"] },
  },
  { name: "get_global_prompt", description: "Đọc prompt chung (prompts/system.md) áp dụng cho mọi page: vai trò, chính sách ship/đổi trả, bảng size, quy trình chốt đơn, khi nào chuyển nhân viên.", parameters: { type: "OBJECT", properties: {} } },
  {
    name: "propose_global_prompt_change",
    description: "Tạo bản đề xuất sửa prompt chung theo yêu cầu (KHÔNG áp dụng ngay). Trả về id đề xuất và bản xem trước; phải hỏi chủ shop xác nhận rồi gọi apply_pending.",
    parameters: { type: "OBJECT", properties: { instruction: { type: "STRING", description: "Yêu cầu sửa, ví dụ 'đổi phí ship thành 25k, miễn ship từ 400k'" } }, required: ["instruction"] },
  },
  { name: "apply_pending", description: "Áp dụng một đề xuất đang chờ (sau khi chủ shop đã đồng ý rõ ràng).", parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] } },
  {
    name: "test_bot_reply",
    description: "Xem bot của một page sẽ trả lời thế nào với một tin nhắn của khách (không gửi gì cho khách thật). Dùng để kiểm tra sau khi chỉnh.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, message: { type: "STRING", description: "Tin nhắn giả lập của khách" } }, required: ["page", "message"] },
  },
  { name: "get_catalog", description: "Xem danh mục sản phẩm đang đồng bộ từ Pancake POS (mã, tên, giá, màu, size, tình trạng).", parameters: { type: "OBJECT", properties: {} } },
  { name: "refresh_catalog", description: "Đồng bộ lại sản phẩm từ POS ngay.", parameters: { type: "OBJECT", properties: {} } },
  { name: "list_models", description: "Liệt kê model Gemini có thể dùng.", parameters: { type: "OBJECT", properties: {} } },
  {
    name: "list_conversations",
    description: "Xem các hội thoại mới nhất của page trên Pancake (khách, tin cuối, ai trả lời cuối, bot có đang tắt cho khách đó không).",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, limit: { type: "NUMBER" } }, required: ["page"] },
  },
  {
    name: "read_conversation",
    description: "Đọc nội dung một hội thoại (cần conversation_id từ list_conversations).",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, conversation_id: { type: "STRING" } }, required: ["page", "conversation_id"] },
  },
  {
    name: "pause_bot_for_conversation",
    description: "Tắt (paused=true) hoặc bật lại (paused=false) bot cho một khách cụ thể bằng cách gắn/gỡ tag tắt bot trên hội thoại.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, conversation_id: { type: "STRING" }, paused: { type: "BOOLEAN" } }, required: ["page", "conversation_id", "paused"] },
  },
  {
    name: "catch_up_unanswered",
    description: "Quét lại và cho bot TRẢ LỜI NỐT các tin khách chưa được trả lời trong N giờ qua (dùng khi bot vừa bị lỗi, hết credit, hoặc mới bật lại). Đặt dry_scan=true để chỉ đếm xem còn bao nhiêu khách đang chờ mà chưa trả lời ai. Bỏ trống page để làm cho tất cả page đang bật bot.",
    parameters: { type: "OBJECT", properties: { page: { type: "STRING", description: "Tên page; bỏ trống = tất cả page đang bật" }, hours: { type: "NUMBER", description: "Số giờ nhìn lại, mặc định 6, tối đa 72" }, dry_scan: { type: "BOOLEAN", description: "true = chỉ đếm, không trả lời" } }, required: [] },
  },
  {
    name: "propose_send_message",
    description: "Đề xuất gửi một tin nhắn THẬT cho khách trong hội thoại (không gửi ngay; trả về id để chủ shop xác nhận rồi apply_pending). Tin được xử lý y như bot: có thể chèn [[IMG:mã]] hoặc [[IMG:mã:màu]] để gửi kèm ảnh sản phẩm thật, markdown sẽ bị bỏ.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, conversation_id: { type: "STRING" }, text: { type: "STRING" } }, required: ["page", "conversation_id", "text"] },
  },
  {
    name: "analyze_recent_conversations",
    description: "Đọc các hội thoại gần đây của page trên Pancake, đánh giá bot/nhân viên đang trả lời khách thế nào, câu hỏi nào chưa được trả lời tốt, và đề xuất dòng hướng dẫn nên thêm. Dùng khi người dùng hỏi 'bot đang chat thế nào', 'có gì cần cải thiện'.",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, limit: { type: "NUMBER", description: "Số hội thoại đọc (mặc định 8, tối đa 15)" } }, required: ["page"] },
  },
  {
    name: "set_global_dry_run",
    description: "Tạo đề xuất BẬT/TẮT chế độ 'chỉ log' (DRY_RUN) chung cho toàn hệ thống. enabled=false nghĩa là bot bắt đầu GỬI THẬT cho khách trên mọi page đang bật. Không áp dụng ngay: trả về pendingId, phải hỏi chủ shop xác nhận rồi gọi apply_pending.",
    parameters: { type: "OBJECT", properties: { enabled: { type: "BOOLEAN", description: "true = chỉ log, không gửi; false = gửi thật" } }, required: ["enabled"] },
  },
  {
    name: "identify_product_in_image",
    description: "So sánh ẢNH NGƯỜI DÙNG VỪA GỬI trong cuộc trò chuyện này với ảnh thật của từng mẫu/màu trong POS để xác định đó là mẫu nào, màu gì (hoặc shop không có). LUÔN dùng công cụ này khi người dùng gửi ảnh sản phẩm và hỏi 'đây là mẫu gì', 'khách gửi ảnh này thì bot nhận ra không'. Không cần tham số.",
    parameters: { type: "OBJECT", properties: { note: { type: "STRING", description: "(tuỳ chọn) gợi ý thêm, ví dụ 'khách nói là màu đỏ đô'" } } },
  },
  {
    name: "sync_order_to_pos",
    description: "Ghi (hoặc cập nhật) đơn nháp trong POS từ một hội thoại đã chốt đơn: trích xuất mẫu/màu/size/số lượng, tên, SĐT, địa chỉ (chuẩn hoá tỉnh/huyện/xã) rồi ghi vào đơn nháp gắn với hội thoại đó. Dùng khi chủ shop hỏi 'sao đơn này chưa vào POS', 'ghi đơn của khách X vào POS'. Cần conversation_id (tìm bằng list_conversations theo tên khách).",
    parameters: { type: "OBJECT", properties: { page: PAGE_PARAM, conversation_id: { type: "STRING" } }, required: ["page", "conversation_id"] },
  },
  { name: "get_logs", description: "Xem nhật ký hoạt động gần nhất của bot (lỗi, tin đã trả lời...).", parameters: { type: "OBJECT", properties: { limit: { type: "NUMBER" } } } },
];

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").trim();

export function createAssistant(bot) {
  function resolvePages(ref) {
    const r = norm(ref);
    const ids = [...bot.clients.keys()];
    if (!r || r === "all" || r === "tat ca" || r === "*") return ids;
    if (bot.clients.has(String(ref).trim())) return [String(ref).trim()];
    const exact = ids.filter((id) => norm(bot.pageNames.get(id)) === r);
    if (exact.length) return exact;
    const partial = ids.filter((id) => norm(bot.pageNames.get(id)).includes(r) || r.includes(norm(bot.pageNames.get(id))));
    if (partial.length) return partial;
    throw new Error(`Không tìm thấy page "${ref}". Các page: ${ids.map((id) => `${bot.pageNames.get(id)} (${id})`).join(", ")}`);
  }
  const onePage = (ref) => {
    const ids = resolvePages(ref);
    if (ids.length !== 1) throw new Error(`"${ref}" khớp ${ids.length} page: ${ids.map((id) => bot.pageNames.get(id)).join(", ")}. Hãy nói rõ hơn.`);
    return ids[0];
  };
  const pageInfo = (id) => {
    const st = store.getStats(id);
    const days = Object.keys(st).filter((k) => k !== "lastActivity").sort().slice(-7);
    const sum = (k) => days.reduce((n, d) => n + (st[d]?.[k] || 0), 0);
    const e = settings.effective(id);
    return { id, name: bot.pageNames.get(id), enabled: e.enabled, dryRun: e.dryRun, globalDryRun: settings.globalDryRun(), model: e.model, temperature: e.temperature, humanTakeoverMinutes: e.humanTakeoverMinutes, minCustomerMessages: e.minCustomerMessages, commentMode: e.commentMode, orderSync: e.orderSync, sendProductImages: e.sendProductImages, extraPrompt: e.extraPrompt, hasPauseTag: !!bot.pauseTagId(id), last7: { replies: sum("replies"), handoffs: sum("handoffs"), skippedStaff: sum("skippedStaff") }, lastActivity: st.lastActivity ? new Date(st.lastActivity).toLocaleString("vi-VN") : null };
  };

  const tools = {
    list_pages: async () => ({ pages: [...bot.clients.keys()].map(pageInfo) }),
    get_page: async ({ page }) => {
      const id = onePage(page);
      return { ...pageInfo(id), recentReplies: store.getRecent(id).slice(0, 10) };
    },
    update_page_settings: async ({ page, ...patch }) => {
      const ids = resolvePages(page);
      const clean = {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) clean[k] = v;
      if (Object.keys(clean).length === 0) throw new Error("Không có trường nào để sửa");
      for (const id of ids) {
        settings.update(id, clean);
        if ("displayName" in clean) bot.applyPageName(id);
      }
      return { ok: true, updated: ids.map((id) => bot.pageNames.get(id)), changes: clean, note: settings.globalDryRun() && clean.dryRun === false ? "Lưu ý: chế độ chỉ log CHUNG vẫn đang bật nên bot vẫn chưa gửi thật; dùng set_global_dry_run(false) (cần xác nhận) để tắt." : undefined };
    },
    set_page_instructions: async ({ page, text }) => {
      const ids = resolvePages(page);
      for (const id of ids) settings.update(id, { extraPrompt: String(text || "").trim() });
      return { ok: true, updated: ids.map((id) => bot.pageNames.get(id)), extraPrompt: String(text || "").trim() };
    },
    append_page_instructions: async ({ page, text }) => {
      const ids = resolvePages(page);
      const out = {};
      for (const id of ids) {
        const cur = settings.get(id).extraPrompt || "";
        const next = (cur.trim() + "\n" + String(text || "").trim()).trim();
        settings.update(id, { extraPrompt: next });
        out[bot.pageNames.get(id)] = next;
      }
      return { ok: true, extraPrompt: out };
    },
    remove_from_page_instructions: async ({ page, contains }) => {
      const ids = resolvePages(page);
      const key = norm(contains);
      const out = {};
      for (const id of ids) {
        const lines = (settings.get(id).extraPrompt || "").split("\n");
        const kept = lines.filter((l) => !norm(l).includes(key));
        settings.update(id, { extraPrompt: kept.join("\n").trim() });
        out[bot.pageNames.get(id)] = { removed: lines.length - kept.length, extraPrompt: kept.join("\n").trim() };
      }
      return { ok: true, result: out };
    },
    get_global_prompt: async () => ({ text: settings.readGlobalPrompt() }),
    propose_global_prompt_change: async ({ instruction }) => {
      const current = settings.readGlobalPrompt();
      const sys = `Bạn là chuyên gia viết prompt cho chatbot bán hàng tiếng Việt. Sửa văn bản theo yêu cầu, giữ nguyên cấu trúc và các placeholder {{SHOP_NAME}}, {{CATALOG}}, [[HANDOFF]], [[IMG:...]]. Chỉ đổi những gì yêu cầu đề cập, không bịa thêm. Trả về DUY NHẤT văn bản mới hoàn chỉnh, không giải thích, không code block.`;
      const r = await generateReply(sys, [{ role: "user", text: `### Văn bản hiện tại\n${current}\n\n### Yêu cầu\n${instruction}` }], { temperature: 0.3, maxOutputTokens: 4096 });
      const proposed = r.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
      if (proposed.length < 50) throw new Error("AI không tạo được bản đề xuất");
      const id = "P" + pendingSeq++;
      pending.set(id, { type: "global_prompt", text: proposed, createdAt: Date.now() });
      // tom tat khac biet: cac dong thay doi
      const a = current.split("\n"), b = proposed.split("\n");
      const removed = a.filter((l) => l.trim() && !b.includes(l)).slice(0, 15);
      const added = b.filter((l) => l.trim() && !a.includes(l)).slice(0, 15);
      return { pendingId: id, diff: { removed, added }, note: "Chưa áp dụng. Hãy tóm tắt thay đổi cho chủ shop và hỏi xác nhận; khi họ đồng ý thì gọi apply_pending." };
    },
    apply_pending: async ({ id }) => {
      const p = pending.get(String(id));
      if (!p) throw new Error("Không có đề xuất " + id + " (có thể đã áp dụng hoặc hết hạn)");
      if (p.type === "global_prompt") {
        settings.writeGlobalPrompt(p.text);
        pending.delete(id);
        return { ok: true, applied: "prompt chung", backup: "data/system.md.bak" };
      }
      if (p.type === "send_message") {
        const r = await bot.sendComposed(p.pageId, p.cid, p.text);
        pending.delete(id);
        return { ok: true, sentText: r.text, imagesSent: r.imagesSent, imageRefs: r.imageRefs, messageIds: r.messageIds };
      }
      if (p.type === "global_dry_run") {
        const now = settings.setGlobalDryRun(p.value);
        pending.delete(id);
        return { ok: true, globalDryRun: now, note: now ? "Bot chỉ log, không gửi" : "Bot ĐANG GỬI THẬT cho khách trên các page đang bật" };
      }
      throw new Error("Loại đề xuất không hỗ trợ");
    },
    test_bot_reply: async ({ page, message }) => {
      const id = onePage(page);
      const eff = settings.effective(id);
      const sys = bot.buildSystemPrompt(id, { customerName: "Khách test", type: "INBOX" });
      const r = await generateReply(sys, [{ role: "user", text: message }], { model: eff.model, temperature: eff.temperature });
      let text = r.text;
      const handoff = text.includes(HANDOFF);
      text = text.replaceAll(HANDOFF, "");
      const ex = bot.extractImageRequests(text);
      return { page: bot.pageNames.get(id), reply: stripMarkdown(ex.text), handoff, imagesRequested: ex.refs, imagesFound: ex.imageUrls.length };
    },
    get_catalog: async () => ({ enabled: catalog.enabled, updatedAt: catalog.updatedAt ? new Date(catalog.updatedAt).toLocaleString("vi-VN") : null, text: catalog.toPromptText() }),
    refresh_catalog: async () => {
      if (!catalog.enabled) throw new Error("Chưa cấu hình POS");
      const p = await catalog.refresh();
      return { ok: true, products: p.length };
    },
    list_models: async () => ({ models: (await listModels()).map((m) => m.name.replace("models/", "")).filter((n) => config.ai.provider === "openai" || (/^gemini/.test(n) && !/tts|image|transcribe|omni|robotics|computer-use|deep-research|antigravity|banana|customtools/.test(n))) }),
    list_conversations: async ({ page, limit }) => {
      const id = onePage(page);
      const client = bot.getClient(id);
      const r = await client.getConversations({ type: "INBOX", order_by: "updated_at" });
      return {
        page: bot.pageNames.get(id),
        conversations: (r.conversations || []).slice(0, Math.min(Number(limit) || 15, 40)).map((cv) => ({ conversation_id: cv.id, customer: cv.from?.name, lastMessage: stripHtml(cv.snippet || "").slice(0, 120), lastBy: String(cv.last_sent_by?.id) === id ? "page" : "customer", updatedAt: cv.updated_at, botPaused: bot.isPaused(cv.tags, id) })),
      };
    },
    read_conversation: async ({ page, conversation_id }) => {
      const id = onePage(page);
      const r = await bot.getClient(id).getMessages(conversation_id);
      return { customer: r.conv_from?.name, canInbox: r.can_inbox, messages: sortChrono(r.messages).slice(-20).map((x) => ({ at: x.inserted_at, from: bot.isFromPage(x, id) ? (store.isBotMessage(x.id) ? "bot" : x.from?.is_automated ? "automation" : "staff") : "customer", text: stripHtml(x.original_message || x.message).slice(0, 300) || "[đính kèm]" })) };
    },
    catch_up_unanswered: async ({ page, hours, dry_scan }) => {
      const pageId = page ? onePage(page) : "";
      const r = await bot.catchUp({ pageId, hours: Math.max(1, Math.min(72, Number(hours) || 6)), dryScan: !!dry_scan });
      return {
        dang_cho: r.waiting || 0,
        da_cho_bot_tra_loi: r.queued,
        theo_page: (r.pages || []).map((x) => ({ page: x.name, so_khach_cho: x.queued, ghi_chu: x.note || "" })),
        khach: (r.items || []).slice(0, 20).map((x) => ({ page: x.pageName, khach: x.customer, tin: x.snippet })),
      };
    },
    pause_bot_for_conversation: async ({ page, conversation_id, paused }) => {
      const id = onePage(page);
      const tag = bot.pauseTagId(id);
      if (!tag) throw new Error(`Page ${bot.pageNames.get(id)} chưa có tag "${config.botPauseTagName || "BOT OFF"}" trong Pancake`);
      const client = bot.getClient(id);
      if (paused) await client.addTag(conversation_id, tag);
      else await client.removeTag(conversation_id, tag);
      return { ok: true, paused: !!paused };
    },
    propose_send_message: async ({ page, conversation_id, text }) => {
      const id = onePage(page);
      const pid = "P" + pendingSeq++;
      pending.set(pid, { type: "send_message", pageId: id, cid: conversation_id, text: String(text).trim(), createdAt: Date.now() });
      return { pendingId: pid, preview: text, note: "Chưa gửi. Hỏi chủ shop xác nhận rồi gọi apply_pending." };
    },
    analyze_recent_conversations: async ({ page, limit }) => {
      const id = onePage(page);
      const client = bot.getClient(id);
      const n = Math.min(Number(limit) || 8, 15);
      const r = await client.getConversations({ type: "INBOX", order_by: "updated_at" });
      const transcripts = [];
      for (const cv of (r.conversations || []).slice(0, n)) {
        const mm = await client.getMessages(cv.id);
        const lines = sortChrono(mm.messages).slice(-12).map((x) => `${bot.isFromPage(x, id) ? (store.isBotMessage(x.id) ? "BOT" : "PAGE") : "KHÁCH"}: ${stripHtml(x.original_message || x.message).slice(0, 200) || "[đính kèm]"}`);
        transcripts.push(`--- ${cv.from?.name || "khách"} ---\n${lines.join("\n")}`);
      }
      const sys = `Bạn là chuyên gia tối ưu chatbot bán hàng. Phân tích các hội thoại (KHÁCH = khách hàng, BOT = bot tự động, PAGE = nhân viên/automation của shop) và trả lời tiếng Việt, ngắn gọn, gạch đầu dòng: (1) khách hay hỏi gì, (2) chỗ nào trả lời chưa tốt/chậm/thiếu, (3) đề xuất 3–6 dòng hướng dẫn cụ thể nên thêm cho bot (viết sẵn). Không bịa thông tin shop; chỗ cần chủ shop điền ghi [cần điền].`;
      const eff = settings.effective(id);
      const a = await generateReply(sys, [{ role: "user", text: `Page: ${bot.pageNames.get(id)}\nHướng dẫn riêng hiện tại: ${eff.extraPrompt || "(trống)"}\n\n${transcripts.length} hội thoại gần đây:\n${transcripts.join("\n\n")}` }], { temperature: 0.3, maxOutputTokens: 2048 });
      return { page: bot.pageNames.get(id), conversationsRead: transcripts.length, analysis: a.text };
    },
    set_global_dry_run: async ({ enabled }) => {
      const id = "P" + pendingSeq++;
      pending.set(id, { type: "global_dry_run", value: !!enabled, createdAt: Date.now() });
      return { pendingId: id, current: settings.globalDryRun(), proposed: !!enabled, note: enabled ? "Sau khi áp dụng bot chỉ log, không gửi tin cho khách." : "Sau khi áp dụng bot sẽ GỬI THẬT cho khách trên mọi page đang bật (trừ page bật dry run riêng). Hãy hỏi xác nhận rõ ràng." };
    },
    identify_product_in_image: async ({ note } = {}, ctx = {}) => {
      // Lay anh moi nhat nguoi dung gui trong cuoc tro chuyen
      let userImg = null;
      for (let i = (ctx.contents || []).length - 1; i >= 0 && !userImg; i--) {
        const c = ctx.contents[i];
        if (c.role !== "user") continue;
        for (const p of c.parts || []) if (p.inline_data?.data) { userImg = { mimeType: p.inline_data.mime_type, data: p.inline_data.data }; break; }
      }
      if (!userImg) throw new Error("Không thấy ảnh nào trong cuộc trò chuyện. Hãy nhờ người dùng gửi ảnh.");
      const { identifyProduct } = await import("./vision.js");
      const r = await identifyProduct(userImg, { note });
      return { comparedWith: r.comparedWith, matched: r.matched, code: r.code, color: r.color, confidence: r.confidence, result: r.text };
    },
    sync_order_to_pos: async ({ page, conversation_id }) => {
      const id = onePage(page);
      const r = await bot.syncOrderForConversation(id, conversation_id);
      return r;
    },
    get_logs: async ({ limit } = {}) => {
      const { logRing } = await import("./logger.js");
      return { logs: logRing.slice(-Math.min(Number(limit) || 40, 150)).map((e) => `${e.ts.slice(11, 19)} [${e.level}] ${e.msg}`) };
    },
  };

  function systemPrompt(currentPageId) {
    const pages = [...bot.clients.keys()].map((id) => `- ${bot.pageNames.get(id)} (id ${id}): ${settings.effective(id).enabled ? "đang bật" : "đang tắt"}${settings.effective(id).dryRun ? ", dry run" : ""}`).join("\n");
    return `Bạn là trợ lý quản trị của hệ thống bot chat bán hàng (Pancake + Gemini) cho chủ shop. Bạn nói chuyện bằng tiếng Việt, ngắn gọn, thân thiện, xưng "mình" và gọi người dùng là "bạn".

Bạn có các công cụ để đọc và thay đổi cài đặt bot. Nguyên tắc:
- Hiểu ý người dùng rồi GỌI CÔNG CỤ để thực hiện, đừng chỉ hướng dẫn họ tự làm. Sau khi làm xong, báo lại ngắn gọn đã đổi gì, cho page nào.
- Với yêu cầu về cách bot nói chuyện với khách (xưng hô, giọng điệu, câu chào, địa chỉ, ưu đãi, mẫu ưu tiên, câu trả lời cho tình huống cụ thể...): viết thành các dòng hướng dẫn rõ ràng rồi dùng append_page_instructions (thêm) hoặc set_page_instructions (viết lại). Nếu người dùng không nói page nào và có nhiều page, hỏi lại họ muốn áp dụng cho page nào hay tất cả.
- Chính sách chung cho mọi page (phí ship, đổi trả, bảng size, quy trình chốt đơn) nằm ở prompt chung: dùng propose_global_prompt_change, tóm tắt thay đổi, HỎI XÁC NHẬN, chỉ apply_pending khi người dùng đồng ý rõ ràng ("ok", "đồng ý", "áp dụng").
- Gửi tin cho khách thật cũng phải qua propose_send_message + xác nhận. Muốn gửi kèm ảnh sản phẩm thì chèn [[IMG:mã]] hoặc [[IMG:mã:màu]] vào text; hệ thống sẽ upload ảnh thật, không bao giờ gửi mã thô cho khách.
- Bật/tắt chế độ chỉ log chung (DRY_RUN): set_global_dry_run + xác nhận. Trợ lý CÓ quyền làm việc này, không cần sửa .env.
- Sau khi chỉnh cách trả lời, nên chủ động dùng test_bot_reply với một câu hỏi tiêu biểu để cho người dùng thấy kết quả.
- Không bịa cài đặt; nếu không chắc, gọi list_pages/get_page để xem. Nếu công cụ báo lỗi, nói rõ lỗi.
- Khi người dùng gửi ẢNH SẢN PHẨM và hỏi đó là mẫu gì / khách gửi ảnh này bot có nhận ra không: KHÔNG đoán bằng mắt hay bằng tên, hãy gọi identify_product_in_image (nó so ảnh với ảnh thật từng mẫu/màu trong POS) rồi trả lời theo kết quả đó, nêu độ tin cậy. Nếu người dùng nói kết quả sai, gọi lại với note ghi gợi ý của họ, đừng đọc hội thoại khách.
- Người dùng có thể GỬI ẢNH (chụp màn hình hội thoại với khách, tin bot trả lời sai, lỗi trong app, ảnh sản phẩm...). Hãy xem kỹ ảnh: nói ngắn gọn bạn thấy gì, chỉ ra chỗ bot trả lời chưa tốt hoặc lỗi, rồi ĐỀ XUẤT cách khắc phục cụ thể (viết sẵn các dòng hướng dẫn định thêm) và HỎI người dùng có muốn áp dụng không. Chỉ khi họ đồng ý, hoặc đã yêu cầu rõ từ đầu ("sửa đi", "khắc phục luôn", "áp dụng"), mới gọi công cụ để sửa. Ảnh chụp màn hình Pancake thường có tên page/khách ở góc; dùng nó để đoán page nếu chưa rõ.
- TUYỆT ĐỐI không tự bịa thông tin của shop (chất liệu vải, chiều dài, giá, địa chỉ, chính sách...) khi viết hướng dẫn cho bot. Chỉ dùng thông tin có trong prompt chung, danh mục POS, hoặc do người dùng cung cấp; chỗ còn thiếu thì hỏi người dùng hoặc ghi [cần điền].
- Khi người dùng nói bot BỎ SÓT tin khách, "sao chưa trả lời khách này", "trả lời bù đi": bot CÓ quét lại được. Gọi catch_up_unanswered (dry_scan=true để đếm trước, rồi dry_scan=false để bot trả lời). ĐỪNG nói là bot không thể quét ngược quá khứ, và đừng bảo người dùng tự trả lời tay.
- Bot chỉ nhìn thấy các page có trong danh sách dưới đây. Nếu ảnh chụp màn hình có khách của page KHÁC (shop có nhiều page trên Pancake/POS), hãy nói rõ page đó chưa được thêm token vào bot nên bot không thấy và không trả lời được, và hướng dẫn thêm page ở mục "Thêm page" trong app.
- Trả lời dạng văn bản thuần, có thể gạch đầu dòng, không dùng bảng markdown.

Các page hiện có:
${pages}
${currentPageId && bot.clients.has(String(currentPageId)) ? `\nNgười dùng đang mở page "${bot.pageNames.get(String(currentPageId))}" (id ${currentPageId}) trong app. Nếu họ không nói rõ page nào thì hiểu là page này (không cần hỏi lại). Nếu họ hỏi "bot đang chat thế nào", "đang trả lời khách ra sao" thì dùng analyze_recent_conversations cho page này.` : ""}

Thông tin kỹ thuật đúng (đừng đoán khác): bot gửi ảnh sản phẩm qua Pancake, tối đa ${config.maxProductImages} ảnh mỗi lượt, tự chia thành nhiều tin (mỗi tin ${config.imagesPerMessage} ảnh); mã [[IMG:mã]] = tất cả màu của mẫu, [[IMG:mã:màu]] = một màu, [[IMG:ALL]] = tổng hợp mọi mẫu trên POS (1 ảnh/màu, KHÔNG giới hạn số ảnh, chia nhiều tin). Bot trả lời 1 lượt cho mỗi tin khách nhưng có thể gồm nhiều tin nhắn (chữ + các tin ảnh).
Trạng thái chung: model mặc định ${config.ai.model}; chế độ chỉ log (DRY_RUN) chung=${settings.globalDryRun() ? "ĐANG BẬT (mọi page chỉ log, không gửi; tắt bằng set_global_dry_run(false) sau khi chủ shop xác nhận)" : "tắt (bot đang gửi thật trên các page bật)"}; POS ${catalog.enabled ? `đang đồng bộ ${catalog.products.length} sản phẩm` : "chưa cấu hình"}; tag tắt bot: "${config.botPauseTagName || config.botPauseTagId || "chưa đặt"}".`;
  }

  /**
   * Chay 1 luot hoi thoai voi tro ly.
   * @param {{role:'user'|'model', text?:string, parts?:object[]}[]} history  lich su (client giu), luot cuoi la user
   * @returns {{text:string, actions:object[], contents:object[]}}  contents = lich su day du (co functionCall) de client gui lai lan sau
   */
  async function chat(history, { pageId } = {}) {
    const contents = history.map((h) => (h.parts ? { role: h.role, parts: h.parts } : { role: h.role === "model" ? "model" : "user", parts: [{ text: h.text || "" }] }));
    const actions = [];
    let text = "";
    let tokensIn = 0, tokensOut = 0; // de biet moi luot chat voi tro ly ton bao nhieu
    const callCounts = new Map(); // chong goi lap cung 1 cong cu voi cung tham so
    for (let step = 0; step < 8; step++) {
      let r;
      // Gemini thinh thoang tra ve candidate rong (STOP, khong parts) -> thu lai toi da 3 lan
      const usable = (x) => x.parts.some((p) => p.functionCall || (p.text && p.text.trim()));
      for (let tryN = 0; tryN < 3; tryN++) {
        r = await generateWithTools(systemPrompt(pageId), contents, FUNCTIONS, { model: config.assistantModel || config.ai.model, temperature: tryN ? 0.4 : 0.2 });
        tokensIn += Number(r.usage?.promptTokenCount || 0);
        tokensOut += Number(r.usage?.candidatesTokenCount || 0);
        if (usable(r) && r.finishReason !== "MALFORMED_FUNCTION_CALL") break;
        log.warn(`[tro ly] Gemini tra ve khong dung duoc (finishReason=${r.finishReason}, parts=${r.parts.length}), thu lai ${tryN + 1}/3`);
      }
      if (!usable(r) || r.finishReason === "MALFORMED_FUNCTION_CALL") {
        // Van hong -> ep tra loi bang chu, khong goi cong cu
        const f = await generateWithTools(systemPrompt(pageId), contents, FUNCTIONS, { model: config.assistantModel || config.ai.model, toolMode: "NONE" });
        text = f.parts.filter((p) => p.text).map((p) => p.text).join("").trim() || "Mình chưa xử lý được yêu cầu này (AI không phản hồi). Bạn thử nói lại theo cách khác nhé.";
        contents.push({ role: "model", parts: [{ text }] });
        break;
      }
      const calls = r.parts.filter((p) => p.functionCall);
      const texts = r.parts.filter((p) => p.text).map((p) => p.text).join("");
      if (calls.length === 0) {
        text = texts; // rong -> khoi "het luot" ben duoi se ep tra loi bang chu
        contents.push({ role: "model", parts: [{ text }] });
        break;
      }
      contents.push({ role: "model", parts: r.parts });
      const responses = [];
      for (const c of calls) {
        const { name, args } = c.functionCall;
        let result;
        try {
          if (!tools[name]) throw new Error("Không có công cụ " + name);
          const key = name + JSON.stringify(args || {});
          const n = (callCounts.get(key) || 0) + 1;
          callCounts.set(key, n);
          if (n > 2) throw new Error("Đã gọi công cụ này với đúng tham số này rồi. Đừng gọi lại; hãy trả lời người dùng bằng những gì đã có.");
          result = await tools[name](args || {}, { contents });
          actions.push({ name, args, ok: true, result: summarize(result) });
          log.info(`[tro ly] ${name}(${JSON.stringify(args || {}).slice(0, 200)}) -> ok`);
        } catch (e) {
          result = { error: e.message };
          actions.push({ name, args, ok: false, error: e.message });
          log.warn(`[tro ly] ${name} loi: ${e.message}`);
        }
        const fr = { name, response: typeof result === "object" && result !== null ? result : { result } };
        if (c.functionCall.id) fr.id = c.functionCall.id;
        responses.push({ functionResponse: fr });
      }
      contents.push({ role: "user", parts: responses });
      if (texts && step === 7) text = texts;
    }
    // Het luot ma van chua co cau tra loi -> ep AI tong ket bang chu (khong cho goi cong cu nua)
    if (!text.trim()) {
      const r = await generateWithTools(
        systemPrompt(pageId) + "\n\nBạn đã dùng hết lượt gọi công cụ. Hãy TRẢ LỜI NGAY bằng văn bản dựa trên những gì đã có; nếu chưa chắc, nói rõ điều chưa chắc và hỏi lại người dùng.",
        contents,
        FUNCTIONS,
        { model: config.assistantModel || config.ai.model, toolMode: "NONE" }
      );
      text = r.parts.filter((p) => p.text).map((p) => p.text).join("").trim() || "Mình chưa kết luận được. Bạn nói rõ hơn giúp mình nhé.";
      contents.push({ role: "model", parts: [{ text }] });
    }
    const model = config.assistantModel || config.ai.model;
    log.info(`[tro ly] Xong 1 luot tro chuyen (${model}): ${tokensIn} tokens vao, ${tokensOut} tokens ra`);
    return { text: text.trim(), actions, contents, tokensIn, tokensOut, model };
  }

  return { chat, tools, pending };
}

function summarize(r) {
  try {
    const s = JSON.stringify(r);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(r);
  }
}
