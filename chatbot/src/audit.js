import { config } from "./config.js";
import { log } from "./logger.js";
import { orderSync } from "./orders.js";
import { generateReply } from "./ai.js";
import { settings } from "./settings.js";
import { sortChrono, stripHtml, sleep } from "./util.js";

/**
 * Doi chieu don POS voi tin nhan khach (dia chi giao hang).
 * Hai phep kiem tra, deu khong bat buoc dung AI:
 *  1) Trong don: phan "so nha/duong" co ghi ro tinh/huyen/xa khac voi tinh/huyen/xa da chon khong
 *  2) Voi chat: tinh/huyen/xa khach noi trong tin nhan co khac tren don khong
 * Chi bao lech o cap tinh/huyen/xa (cho khac cach viet so nha thi ghi chu, khong coi la sai).
 */

const STATUS_NAMES = { 0: "Mới", 1: "Đã xác nhận", 2: "Đã gửi hàng", 3: "Đang giao hàng", 4: "Đã nhận", 5: "Đã đối soát", 6: "Đã hủy", 7: "Đang hoàn", 8: "Đã hoàn", 9: "Đã xóa", 11: "Chờ hàng", 12: "Đang đóng hàng", 15: "Đang chuyển hàng", 16: "Giao không thành công", 17: "Đã thu tiền" };

const ADDRESS_HINT = /(so nha|sn\b|thon|xom|ap\b|to\b|khu|duong|pho\b|ngo\b|ngach|hem|xa\b|phuong|thi tran|tt\b|huyen|quan\b|thanh pho|tp\b|tinh\b|dia chi|dc\b)/;
const ADMIN_KEYWORD = /\b(xa|phuong|thi tran|thi xa|huyen|quan|thanh pho|tinh|tp|tt)\b/;

/** Bo dau nhung GIU nguyen so ky tu de con anh xa vi tri ve chuoi goc */
function nodKeep(s) {
  return [...String(s || "")]
    .map((c) => {
      const n = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
      return n.length ? n[0] : c;
    })
    .join("");
}
function nod(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
}
function norm(s) {
  return nod(s).replace(/[^a-z0-9\s/]/g, " ").replace(/\s+/g, " ").trim();
}
/**
 * Bo dau, bo tu chi cap hanh chinh O DAU TEN va bo khoang trang: "Thị trấn Chư Prông" -> "chuprong".
 * CHI bo o dau ten, khong bo giua ten, neu khong "Xã Dương Quan" se thanh "duong" roi khop nham
 * vao "xóm đường ổi" cua khach.
 */
function tight(s) {
  let v = norm(s);
  for (;;) {
    const cut = v.replace(/^(tinh|thanh pho|tp|quan|huyen|thi xa|tx|thi tran|tt|xa|phuong)\s+/, "");
    if (cut === v) break;
    v = cut;
  }
  return v.replace(/[^a-z0-9]/g, "");
}

const CHAT_ADDRESS_SCHEMA = {
  type: "object",
  properties: {
    has_address: { type: "boolean", description: "Khách có đưa địa chỉ nhận hàng trong hội thoại không" },
    address: { type: "string", description: "Địa chỉ khách đưa, chép nguyên văn, gộp các mảnh khách nhắn rời; rỗng nếu không có" },
    changed_later: { type: "boolean", description: "Khách có đổi/sửa lại địa chỉ ở tin nhắn sau không" },
    note: { type: "string", description: "Ghi chú ngắn nếu khách dặn thêm về giao hàng" },
  },
  required: ["has_address", "address"],
};

export class OrderAudit {
  constructor() {
    this.job = null;
    this.results = new Map(); // orderId -> ket qua doi chieu gan nhat
  }

  /** Danh sach don theo trang thai, moi nhat truoc, dung khi qua cu */
  async listOrders({ status = 1, fromMs, maxOrders = 200 }) {
    const out = [];
    for (let page = 1; page <= 40; page++) {
      const d = await orderSync._call("GET", `/shops/${config.pos.shopId}/orders`, null, { status, page_size: 50, page_number: page });
      const list = d.data || [];
      if (!list.length) break;
      let stop = false;
      for (const o of list) {
        const at = Date.parse(String(o.inserted_at || "").replace(/(\.\d+)?$/, "Z"));
        if (fromMs && Number.isFinite(at) && at < fromMs) {
          stop = true;
          break;
        }
        out.push(o);
        if (out.length >= maxOrders) {
          stop = true;
          break;
        }
      }
      if (stop || page >= Number(d.total_pages || 1)) break;
      await sleep(250);
    }
    return out;
  }

  /** Gop tin nhan thanh doan de doi chieu */
  chatTextOf(messages, pageId) {
    const list = sortChrono(messages || []);
    const lines = [];
    for (const m of list) {
      const txt = stripHtml(m.original_message || m.message || "").replace(/\s+/g, " ").trim();
      if (!txt) continue;
      if (/Đã thêm nhãn tự động|đặt giai đoạn của khách hàng/i.test(txt)) continue;
      lines.push(`${String(m.from?.id || "") === String(pageId) ? "Shop" : "Khách"}: ${txt}`);
    }
    return lines.slice(-40).join("\n");
  }

  /** Cac cau khach noi co dang dia chi (khong ton token) */
  addressLinesOf(chatText) {
    const lines = String(chatText || "").split("\n").filter((l) => l.startsWith("Khách:"));
    const picked = lines.filter((l) => ADDRESS_HINT.test(norm(l)));
    return (picked.length ? picked : lines.slice(-6)).map((l) => l.replace(/^Khách:\s*/, "")).join(" ; ");
  }

  /** Cat lay phan so nha/duong, giu nguyen dau tieng Viet */
  cutStreet(raw, names) {
    const parts = String(raw).split(/\s*[,;]\s*/);
    if (parts.length > 1) {
      const keep = parts.filter((seg) => {
        const t = tight(seg);
        if (!t) return false;
        if (names.some((n) => n && tight(n) === t)) return false;
        return !ADMIN_KEYWORD.test(norm(seg));
      });
      if (keep.length) return keep.join(", ").trim();
    }
    const flat = nodKeep(raw);
    const m = flat.match(/\b(xa|phuong|thi tran|thi xa|huyen|quan|thanh pho|tinh)\b/);
    if (m && m.index > 2) return raw.slice(0, m.index).replace(/[\s,;.-]+$/, "").trim();
    return String(raw).trim();
  }

  /** Bo so dien thoai, ten nguoi nhan thua va cat ngan phan so nha/duong */
  cleanStreet(v) {
    let out = String(v || "")
      .replace(/\b0\d{8,10}\b/g, " ")
      .replace(/\b(sdt|dt|đt|số điện thoại|địa chỉ|dia chi|dc)\b\s*:?/gi, " ")
      .replace(/[\s,;.-]+$/g, "")
      .replace(/^[\s,;.-]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (out.length > 100) out = out.slice(0, 100).replace(/\s+\S*$/, "");
    return out;
  }

  /** Do tinh -> huyen -> xa trong mot doan chu, dua theo danh muc Pancake (khong dung AI) */
  async resolveLocal(raw) {
    let t = tight(raw);
    if (!t) return { ok: false };
    // Tim ten dai nhat xuat hien trong doan chu, roi BO DUNG MOT lan xuat hien do
    // (tranh ten tinh bi cham lai thanh ten huyen, vd "tinh Thanh Hoa" -> "TP Thanh Hoa")
    const pick = (list) => {
      let best = null, key = "";
      for (const it of list || []) {
        const k = tight(it.name);
        if (k.length >= 4 && t.includes(k) && k.length > key.length) {
          best = it;
          key = k;
        }
      }
      if (best) t = t.replace(key, " ");
      return best;
    };
    const province = pick(await orderSync.provinces());
    if (!province) return { ok: false, note: "không thấy tên tỉnh/thành nào" };
    const district = pick(await orderSync.districts(province.id));
    const commune = district ? pick(await orderSync.communes(district.id)) : null;
    // Neu gop nhieu cau chat thi chi lay cau that su chua dia chi de cat so nha/duong
    const segs = String(raw).split(" ; ");
    const best = segs.find((x) => tight(x).includes(tight(province.name))) || segs[segs.length - 1] || raw;
    const street = this.cleanStreet(this.cutStreet(best, [commune?.name, district?.name, province?.name]));
    const parts = [street, commune?.name, district?.name, province?.name].filter(Boolean);
    return {
      ok: !!(province && district),
      province,
      district,
      commune,
      street,
      fullAddress: parts.join(", "),
      confidence: commune ? "cao" : district ? "trung bình (chưa rõ xã/phường)" : "thấp (chưa rõ quận/huyện)",
      note: district ? (commune ? "" : `chưa rõ xã/phường trong ${district.name}`) : `chỉ thấy tỉnh ${province.name}`,
    };
  }

  /** Hoi Gemini dia chi khach dua (chi dung khi khong tu do duoc) */
  async readChatAddress(chatText, order) {
    const sa = order.shipping_address || {};
    const sys = `Bạn đọc hội thoại bán hàng và tìm ĐỊA CHỈ NHẬN HÀNG mà khách đã đưa. Chỉ lấy điều khách tự nói, không lấy địa chỉ do shop đọc lại, không suy đoán, không bịa. Nếu khách nhắn địa chỉ thành nhiều mảnh thì gộp lại. Nếu khách đổi địa chỉ thì lấy địa chỉ MỚI NHẤT và đặt changed_later=true. Nếu khách không đưa địa chỉ thì has_address=false.`;
    const r = await generateReply(sys, [{ role: "user", text: `Địa chỉ đang ghi trên đơn (tham khảo, có thể sai): "${sa.full_address || ""}"\n\nHội thoại:\n${chatText}` }], { temperature: 0, maxOutputTokens: 400, jsonSchema: CHAT_ADDRESS_SCHEMA });
    return r.json || {};
  }

  /** So tinh/huyen/xa da chuan hoa voi tinh/huyen/xa dang chon tren don */
  diffArea(order, resolved, sel = {}) {
    const sa = order.shipping_address || {};
    const diffs = [];
    const cmp = (label, item, orderName, orderId, orderUnit) => {
      if (!item) return;
      // Sau sap nhap 2025: hai don vi cu co the ve cung mot don vi moi -> khong coi la sai
      if (orderId && String(item.id) === String(orderId)) return;
      if (item.new_id && orderUnit?.new_id && String(item.new_id) === String(orderUnit.new_id)) return;
      if (!orderId && tight(item.name) === tight(orderName)) return;
      diffs.push({ field: label, chat: item.name, order: orderName || "(trống)" });
    };
    cmp("Tỉnh/thành", resolved.province, sa.province_name, sa.province_id, sel.province);
    cmp("Quận/huyện", resolved.district, sa.district_name, sa.district_id, sel.district);
    cmp("Xã/phường", resolved.commune, sa.commune_name || sa.commnue_name, sa.commune_id, sel.commune);
    return diffs;
  }

  /** Lay don vi hanh chinh dang chon cua don tu danh muc (de biet ma moi sau sap nhap) */
  async selectedUnits(sa) {
    const out = {};
    try {
      if (sa.province_id) out.province = (await orderSync.provinces()).find((p) => String(p.id) === String(sa.province_id));
      if (sa.province_id && sa.district_id) out.district = (await orderSync.districts(sa.province_id)).find((d) => String(d.id) === String(sa.district_id));
      if (sa.district_id && sa.commune_id) out.commune = (await orderSync.communes(sa.district_id)).find((c) => String(c.id) === String(sa.commune_id));
    } catch {
      /* thieu danh muc thi so theo ten */
    }
    return out;
  }

  status() {
    const j = this.job;
    if (!j) return { running: false, results: [] };
    const { running, done, total, checked, skipped, mismatched, errors, startedAt, current, results, params, useAI } = j;
    return { running, done, total, checked, skipped, mismatched, errors: errors.slice(-10), startedAt, current, params, useAI, results };
  }

  stop() {
    if (this.job) this.job.running = false;
    return this.status();
  }

  start(bot, { days = 7, status = 1, pageId = "", maxOrders = 100, useAI = true } = {}) {
    if (this.job?.running) throw new Error("Dang doi chieu, hay doi hoac bam dung");
    if (!orderSync.enabled) throw new Error("Chua cau hinh POS trong .env");
    const job = { running: true, useAI, done: 0, total: 0, checked: 0, skipped: 0, mismatched: 0, errors: [], startedAt: Date.now(), current: "", results: [], params: { days, status, pageId, maxOrders } };
    this.job = job;
    this._run(bot, job)
      .catch((e) => {
        job.errors.push(e.message);
        log.error("Doi chieu don loi: " + e.message);
      })
      .finally(() => (job.running = false));
    return this.status();
  }

  async _run(bot, job) {
    const { days, status, pageId, maxOrders } = job.params;
    const fromMs = days ? Date.now() - days * 24 * 3600e3 : 0;
    let orders = await this.listOrders({ status, fromMs, maxOrders });
    if (pageId) orders = orders.filter((o) => String(o.page_id) === String(pageId));
    job.total = orders.length;
    log.info(`Doi chieu ${orders.length} don "${STATUS_NAMES[status] || status}" trong ${days} ngay`);
    for (const o of orders) {
      if (!job.running) break;
      job.current = `#${o.id} ${o.bill_full_name || ""}`;
      try {
        const r = await this.checkOrder(bot, o, { useAI: job.useAI });
        job.results.push(r);
        this.results.set(String(o.id), r);
        if (r.verdict === "lech") job.mismatched++;
        else if (r.verdict === "khop") job.checked++;
        else job.skipped++;
      } catch (e) {
        job.errors.push(`#${o.id}: ${e.message}`);
        job.skipped++;
        if (job.useAI && /credit|quota|429|Gemini/i.test(e.message)) {
          job.useAI = false;
          job.errors.push("Tạm ngừng dùng AI, chuyển sang đối chiếu bằng danh mục địa chỉ");
          log.warn("Doi chieu don: tat AI, dung danh muc dia chi");
        }
      }
      job.done++;
    }
    job.current = "";
    log.info(`Doi chieu xong: ${job.checked} khop, ${job.mismatched} lech, ${job.skipped} chua ro`);
  }

  /** Doi chieu 1 don */
  async checkOrder(bot, order, { useAI = true } = {}) {
    const pageId = String(order.page_id || "");
    const sa = order.shipping_address || {};
    const areaName = [sa.commune_name || sa.commnue_name, sa.district_name, sa.province_name].filter(Boolean).join(", ");
    const base = {
      orderId: order.id,
      pageId,
      pageName: bot.pageNames?.[pageId] || order.page?.name || pageId,
      customer: order.bill_full_name || sa.full_name || "",
      phone: order.bill_phone_number || sa.phone_number || "",
      conversationId: order.conversation_id || "",
      status: order.status,
      statusName: STATUS_NAMES[order.status] || order.status_name || "",
      insertedAt: order.inserted_at,
      total: order.total_price,
      orderStreet: sa.address || "",
      orderArea: areaName,
      orderAddress: sa.full_address || "",
      chatAddress: "",
      diffs: [],
      proposed: null,
      source: "",
      verdict: "khong_ro",
      note: "",
    };

    const sel = await this.selectedUnits(sa);
    // Kiem tra 1: trong chinh don. Neu phan so nha/duong co ghi tinh/huyen/xa khac voi cap da chon
    const self = await this.resolveLocal(sa.address || "");
    if (self.ok) {
      const d = this.diffArea(order, self, sel);
      if (d.length) {
        return {
          ...base,
          verdict: "lech",
          source: "trong đơn",
          diffs: d,
          chatAddress: sa.address || "",
          note: "Địa chỉ ghi trong đơn không khớp với tỉnh/huyện/xã đang chọn của đơn",
          proposed: this.buildProposal(sa, self, { rewriteStreet: true }),
        };
      }
    }

    // Kiem tra 2: doi chieu voi tin nhan khach
    if (!order.conversation_id) return { ...base, verdict: "khop", note: "Đơn không gắn hội thoại, chỉ kiểm tra được trong đơn" };
    const client = bot.getClient(pageId);
    if (!client) return { ...base, note: "Chưa có token page này trong bot nên không đọc được tin nhắn" };

    const data = await client.getMessages(order.conversation_id);
    const chatText = this.chatTextOf(data.messages, pageId);
    if (!chatText) return { ...base, note: "Không đọc được tin nhắn của hội thoại" };

    const localRaw = this.addressLinesOf(chatText);
    base.chatAddress = localRaw.slice(0, 300);
    let resolved = await this.resolveLocal(localRaw);
    base.source = "danh mục";
    if (!resolved.ok && useAI && !(this.aiDownUntil > Date.now())) {
      try {
        const g = await this.readChatAddress(chatText, order);
        if (!g.has_address || !String(g.address || "").trim()) return { ...base, chatAddress: "", note: "Khách không đưa địa chỉ trong hội thoại (đơn có thể lấy địa chỉ từ nguồn khác)" };
        base.chatAddress = String(g.address).trim();
        base.changedLater = !!g.changed_later;
        if (g.note) base.note = `Khách dặn: ${g.note}`;
        resolved = await orderSync.resolveAddress(base.chatAddress, { pageName: base.pageName });
        base.source = "AI";
      } catch (e) {
        // Het credit / khong goi duoc Gemini: ngung goi AI 10 phut cho khoi cham
        if (/credit|quota|429|API key|Gemini/i.test(e.message)) this.aiDownUntil = Date.now() + 10 * 60000;
        return { ...base, note: `Không nhờ được AI đọc kỹ (${e.message.slice(0, 80)}), cần xem tay` };
      }
    }
    if (!resolved.ok) return { ...base, note: `Chưa dò được tỉnh/huyện từ lời khách${resolved.note ? " (" + resolved.note + ")" : ""}, cần xem tay` };

    base.resolved = { street: resolved.street, province: resolved.province?.name, district: resolved.district?.name, commune: resolved.commune?.name, fullAddress: resolved.fullAddress, confidence: resolved.confidence };
    const diffs = this.diffArea(order, resolved, sel);
    if (!diffs.length) {
      // Cap hanh chinh dung; chi bao neu so nha/duong khach ghi khong thay trong don
      const st = tight(sa.address || "");
      const inChat = tight(base.chatAddress);
      if (st && st.length >= 5 && inChat && !inChat.includes(st)) base.note = "Tỉnh/huyện/xã khớp, số nhà/đường ghi khác cách khách nhắn, nên xem lại";
      return { ...base, verdict: "khop", note: base.note || "Khớp với tin nhắn khách" };
    }
    // Chi de xuat ghi de khi chinh loi khach co nhac ten xa (hoac huyen neu khong ro xa).
    // Ten so nhu "Phường 13" qua ngan de do nen mien kiem tra.
    const inChatText = tight(base.chatAddress);
    const supported = (unit) => {
      const k = tight(unit?.name || "");
      return !k || k.length < 4 || inChatText.includes(k);
    };
    const trustworthy = resolved.commune ? supported(resolved.commune) : supported(resolved.district);
    return {
      ...base,
      verdict: "lech",
      diffs,
      note: trustworthy ? base.note || "Tỉnh/huyện/xã trên đơn khác nơi khách nhắn" : [base.note, "⚠ Suy ra từ lời khách nhưng khách không ghi rõ tên xã/huyện, cần người xem lại rồi sửa tay"].filter(Boolean).join(" · "),
      proposed: trustworthy ? this.buildProposal(sa, resolved, { rewriteStreet: base.source === "trong đơn" }) : null,
    };
  }

  /** Dia chi de xuat ghi lai; mac dinh GIU NGUYEN so nha/duong cua don cho an toan */
  buildProposal(sa, resolved, { rewriteStreet = false } = {}) {
    // So nha/duong tren don bi rong hoac la chuoi rac thi lay theo loi khach
    const cur = String(sa.address || "").trim();
    // Coi la "khong dung duoc" khi: rong, la chuoi rac, hoac qua cut/khong co ten duong (vd chi co "116")
    const junk = !cur || /không thể|khong the|không xác định|khong xac dinh|^n\/?a$|^none$/i.test(cur) || !/[a-zà-ỹ]{3,}/i.test(cur);
    const street = rewriteStreet || junk ? resolved.street || sa.address : sa.address || resolved.street;
    return {
      full_name: sa.full_name || "",
      phone_number: sa.phone_number || "",
      address: street,
      province_id: resolved.province?.id,
      district_id: resolved.district?.id,
      commune_id: resolved.commune?.id,
      new_province_id: resolved.province?.new_id,
      new_commune_id: resolved.commune?.new_id,
      fullAddress: [street, resolved.commune?.name, resolved.district?.name, resolved.province?.name].filter(Boolean).join(", "),
    };
  }

  /** Ghi dia chi de xuat vao don tren POS (co doc lai de chac chan da ghi) */
  async fix(orderId, { dryRun = settings.globalDryRun() } = {}) {
    const r = this.results.get(String(orderId));
    if (!r) throw new Error("Chưa đối chiếu đơn này, hãy quét lại");
    if (!r.proposed?.province_id) throw new Error("Đơn này chưa có địa chỉ đề xuất đủ tin cậy, cần sửa tay");
    const cur = (await orderSync._call("GET", `/shops/${config.pos.shopId}/orders/${orderId}`))?.data;
    if (!cur) throw new Error("Không đọc được đơn trên POS");
    if (Number(cur.status) !== Number(r.status)) throw new Error(`Đơn đã đổi trạng thái sang "${STATUS_NAMES[cur.status] || cur.status}", không sửa nữa`);
    const old = cur.shipping_address || {};
    const p = r.proposed;
    const noteLine = `[Bot] Sửa địa chỉ theo tin nhắn khách: "${old.full_address || ""}" → "${p.fullAddress}"`;
    if (dryRun) return { ok: true, dryRun: true, orderId, summary: noteLine };
    await orderSync._call("PUT", `/shops/${config.pos.shopId}/orders/${orderId}`, {
      shipping_address: { full_name: p.full_name || old.full_name, phone_number: p.phone_number || old.phone_number, address: p.address, province_id: p.province_id, district_id: p.district_id, commune_id: p.commune_id, new_province_id: p.new_province_id, new_commune_id: p.new_commune_id },
      note: [String(cur.note || "").trim(), noteLine].filter(Boolean).join("\n"),
    });
    const after = (await orderSync._call("GET", `/shops/${config.pos.shopId}/orders/${orderId}`))?.data;
    const now = after?.shipping_address || {};
    const applied = String(now.province_id) === String(p.province_id) && String(now.district_id || "") === String(p.district_id || "") && (!p.commune_id || String(now.commune_id || "") === String(p.commune_id));
    if (!applied) throw new Error(`POS chưa nhận thay đổi (địa chỉ vẫn là "${now.full_address || ""}"), cần sửa tay trên POS`);
    r.verdict = "da_sua";
    r.orderAddress = now.full_address || p.fullAddress;
    r.diffs = [];
    log.info(`Don #${orderId}: ${noteLine}`);
    return { ok: true, orderId, summary: noteLine, address: now.full_address };
  }
}

export const orderAudit = new OrderAudit();
export { STATUS_NAMES };
