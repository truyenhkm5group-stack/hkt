import { config } from "./config.js";
import { log } from "./logger.js";
import { catalog } from "./catalog.js";
import { generateReply } from "./ai.js";
import { store } from "./store.js";
import { sleep } from "./util.js";
import { settings } from "./settings.js";

/**
 * Ghi don hang bot da chot vao Pancake POS:
 * - Trich xuat don (mau, mau sac, size, so luong, ten, SDT, dia chi) tu hoi thoai bang Gemini (JSON co cau truc)
 * - Map mau/mau sac/size -> variation_id trong POS
 * - Chuan hoa dia chi theo danh muc tinh/huyen/xa cua Pancake (sua loi chinh ta, thieu cap)
 * - Tim don nhap (status 0) da gan voi hoi thoai -> cap nhat; chua co -> tao moi. Khong bao gio xac nhan don.
 */

const B = "https://pos.pages.fm/api/v1";

export const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Bo tien to hanh chinh de so khop ("Huyện Ngọc Lặc" ~ "ngoc lac", "TP Hải Phòng" ~ "hai phong")
const PREFIX_RE = /^(tinh|thanh pho|tp|t p|huyen|quan|q|thi xa|tx|thi tran|tt|xa|phuong|p|dac khu|khu vuc|h)\s+/;
export const stripAdmin = (s) => {
  let t = norm(s);
  for (let i = 0; i < 2; i++) t = t.replace(PREFIX_RE, "");
  return t.trim();
};

/** Ten rut gon de do "co xuat hien nguyen van trong cau khong": "Huyện Lý Sơn" -> "lyson" */
export const litKey = (s) => stripAdmin(s).replace(/[^a-z0-9]/g, "");

/** Tim phan tu khop nhat theo ten. Tra ve { item, score } (score 0..1) */
export function fuzzyFind(list, query, nameKey = "name") {
  const q = stripAdmin(query);
  if (!q) return { item: null, score: 0 };
  let best = { item: null, score: 0 };
  for (const it of list) {
    const n = stripAdmin(it[nameKey]);
    let score = 0;
    if (n === q) score = 1;
    else if (n.includes(q) || q.includes(n)) score = 0.85;
    else {
      const a = new Set(n.split(" ")), b = q.split(" ");
      const hit = b.filter((w) => a.has(w)).length;
      score = hit ? (hit / Math.max(a.size, b.length)) * 0.8 : 0;
      // loi chinh ta nhe: so sanh khong dau, cho phep 1-2 ky tu khac
      if (score < 0.6 && Math.abs(n.length - q.length) <= 2 && n.length > 3) {
        let diff = 0;
        for (let i = 0; i < Math.min(n.length, q.length); i++) if (n[i] !== q[i]) diff++;
        diff += Math.abs(n.length - q.length);
        if (diff <= 2) score = 0.7;
      }
    }
    if (score > best.score) best = { item: it, score };
  }
  return best;
}

/**
 * SDT co that su xuat hien trong doan hoi thoai khong (khach go "097 129 1509", "+84971291509", "0971291509"...).
 * Dung de chan truong hop AI tu bia SDT khi khach chua kip gui.
 */
export function phoneInText(text, phone) {
  const digits = String(text || "").replace(/\D/g, "");
  const p = String(phone || "");
  if (!/^0\d{9}$/.test(p)) return false;
  const bare = p.slice(1); // 9 so, bo so 0 dau
  return digits.includes(p) || digits.includes("84" + bare) || digits.includes(bare);
}

export function normalizePhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("84") && d.length === 11) d = "0" + d.slice(2);
  if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
  return /^0\d{9}$/.test(d) ? d : "";
}

const EXTRACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    ready: { type: "BOOLEAN", description: "true CHỈ KHI khách đã chốt mua và đã có đủ: mẫu + màu + size + số lượng + họ tên + số điện thoại + địa chỉ giao hàng" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING", description: "Mã sản phẩm trong danh mục (ví dụ Q004, X001)" },
          color: { type: "STRING", description: "Màu đúng như trong danh mục (ví dụ Đỏ, Nâu, Đen)" },
          size: { type: "STRING", description: "Size (M, L, XL, 2XL)" },
          quantity: { type: "INTEGER" },
        },
        required: ["code", "quantity"],
      },
    },
    customer_name: { type: "STRING" },
    phone: { type: "STRING" },
    address: { type: "STRING", description: "Địa chỉ giao hàng đúng như khách ghi (không sửa)" },
    agreed_total: { type: "INTEGER", description: "Tổng tiền đã chốt với khách (VNĐ), gồm cả ship nếu có; 0 nếu chưa rõ" },
    free_shipping: { type: "BOOLEAN" },
    note: { type: "STRING", description: "Ghi chú khác khách dặn (giao giờ, gọi trước...)" },
    missing: { type: "STRING", description: "Nếu ready=false: còn thiếu gì" },
  },
  required: ["ready", "items"],
};

const ADDRESS_SCHEMA = {
  type: "OBJECT",
  properties: {
    province: { type: "STRING", description: "Tên tỉnh/thành phố (đã sửa chính tả, viết đầy đủ, ví dụ 'Thanh Hóa', 'Hồ Chí Minh')" },
    district: { type: "STRING", description: "Tên quận/huyện/thị xã/thành phố thuộc tỉnh, đã sửa chính tả; rỗng nếu khách không ghi" },
    commune: { type: "STRING", description: "Tên xã/phường/thị trấn, đã sửa chính tả; rỗng nếu không ghi" },
    street: { type: "STRING", description: "Số nhà, ngõ, đường, thôn/xóm (phần còn lại, giữ nguyên cách khách ghi)" },
  },
  required: ["province", "street"],
};

/** Ten trang thai don POS (khop audit.js) va trang thai ben van chuyen -> tieng Viet de bot noi voi khach */
export const ORDER_STATUS_VI = { 0: "Mới (chưa xác nhận)", 1: "Đã xác nhận, đang chuẩn bị hàng", 2: "Đã gửi hàng cho đơn vị vận chuyển", 3: "Đang giao hàng", 4: "Đã nhận hàng", 5: "Đã đối soát", 6: "Đã hủy", 7: "Đang hoàn", 8: "Đã hoàn", 9: "Đã xóa", 11: "Chờ hàng", 12: "Đang đóng hàng", 15: "Đang chuyển hàng", 16: "Giao không thành công", 17: "Đã thu tiền", 20: "Đã đối soát" };
const PARTNER_STATUS_VI = { on_the_way: "đang trên đường giao", picked_up: "đã lấy hàng", delivering: "đang giao", delivered: "đã giao thành công", waiting_pickup: "chờ lấy hàng", returning: "đang chuyển hoàn", returned: "đã hoàn về shop", delivery_failed: "giao không thành công" };

function fmtNgay(s) {
  const t = Date.parse(String(s || "").replace(/(\.\d+)?Z?$/, "Z"));
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }) : "";
}

/** Mo ta 1 don POS thanh 1 dong cho bot doc (trang thai, van don, ngay gui, tien thu ho) */
export function describeOrder(o) {
  const st = ORDER_STATUS_VI[Number(o.status)] || o.status_name || `trạng thái ${o.status}`;
  const items = (o.items || []).map((it) => `${it.quantity || 1} x ${it.variation_info?.display_id || it.variation_info?.name || it.product_name || "sp"}`).join(", ");
  const parts = [`Đơn #${o.id}: ${st}`];
  if (items) parts.push(`gồm ${items}`);
  const p = o.partner;
  if (p && (p.order_number_vtp || p.extend_code)) {
    const ma = p.order_number_vtp || p.extend_code;
    const dvvc = p.order_number_vtp ? "Viettel Post" : "đơn vị vận chuyển";
    const tt = PARTNER_STATUS_VI[p.partner_status] || "";
    parts.push(`mã vận đơn ${ma} (${dvvc}${tt ? ", " + tt : ""})`);
  }
  if (p?.picked_up_at) parts.push(`bưu tá đã lấy hàng ngày ${fmtNgay(p.picked_up_at)}`);
  else if (o.time_send_partner) parts.push(`gửi đi ngày ${fmtNgay(o.time_send_partner)}`);
  else if (o.inserted_at) parts.push(`tạo ngày ${fmtNgay(o.inserted_at)}`);
  if (o.estimate_delivery_date) parts.push(`dự kiến giao ${fmtNgay(o.estimate_delivery_date)}`);
  const thu = Number(o.money_to_collect ?? o.cod ?? 0);
  if (thu > 0) parts.push(`thu hộ ${thu.toLocaleString("vi-VN")}đ`);
  return parts.join(" – ");
}

export class OrderSync {
  constructor() {
    this.geo = { provinces: null, provincesAt: 0, districts: new Map(), communes: new Map() };
  }

  get enabled() {
    return !!(config.pos.shopId && config.pos.apiKey);
  }

  async _call(method, p, body, q = {}) {
    const u = new URL(B + p);
    u.searchParams.set("api_key", config.pos.apiKey);
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(u, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const data = await r.json().catch(() => ({}));
      if ((r.status === 429 || r.status >= 500) && attempt <= 3) {
        await sleep(1000 * attempt);
        continue;
      }
      if (!r.ok || data.success === false) throw new Error(`POS ${method} ${p} loi ${r.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
      return data;
    }
  }

  // ---------- Dia ly ----------
  async provinces() {
    if (!this.geo.provinces || Date.now() - this.geo.provincesAt > 24 * 3600 * 1000) {
      this.geo.provinces = (await this._call("GET", "/geo/provinces")).data || [];
      this.geo.provincesAt = Date.now();
    }
    return this.geo.provinces;
  }
  async districts(provinceId) {
    if (!this.geo.districts.has(provinceId)) this.geo.districts.set(provinceId, (await this._call("GET", "/geo/districts", null, { province_id: provinceId })).data || []);
    return this.geo.districts.get(provinceId);
  }
  async communes(districtId) {
    if (!this.geo.communes.has(districtId)) this.geo.communes.set(districtId, (await this._call("GET", "/geo/communes", null, { district_id: districtId })).data || []);
    return this.geo.communes.get(districtId);
  }

  /**
   * Chuan hoa dia chi khach ghi -> tinh/huyen/xa theo danh muc Pancake + phan duong/so nha.
   * @returns {{ok:boolean, province?:object, district?:object, commune?:object, street:string, fullAddress:string, note:string, confidence:string}}
   */
  async resolveAddress(raw, { pageName = "" } = {}) {
    const provinces = await this.provinces();
    const sys = `Bạn là người tách địa chỉ giao hàng Việt Nam. Từ địa chỉ khách ghi (có thể viết tắt, sai chính tả, thiếu dấu, thiếu cấp), hãy xác định tỉnh/thành, quận/huyện, xã/phường/thị trấn và phần số nhà/đường/thôn. Sửa chính tả theo tên hành chính chuẩn. Danh sách tỉnh/thành hợp lệ: ${provinces.map((p) => p.name).join(", ")}. Nếu không chắc cấp nào thì để rỗng cấp đó, KHÔNG bịa.`;
    const r = await generateReply(sys, [{ role: "user", text: `Địa chỉ khách ghi: "${raw}"` }], { temperature: 0, maxOutputTokens: 300, jsonSchema: ADDRESS_SCHEMA });
    const g = r.json || {};
    const out = { ok: false, street: g.street || raw, fullAddress: raw, note: "", confidence: "thấp", parsed: g };

    const pv = fuzzyFind(provinces, g.province || "");
    if (!pv.item || pv.score < 0.6) {
      out.note = `Không xác định được tỉnh/thành từ "${raw}"`;
      return out;
    }
    out.province = pv.item;
    const dists = await this.districts(pv.item.id);
    // Uu tien huyen/xa co ten XUAT HIEN NGUYEN VAN trong loi khach.
    // Fuzzy de nham cac ten dao chu ("Lý Sơn" -> "Sơn Tịnh"), sai huyen la giao sai noi.
    // Bo mot lan xuat hien cua ten tinh, neu khong "lý sơn quảng ngãi" se ra huyen "TP Quảng Ngãi"
    const litText = litKey(raw).replace(litKey(pv.item.name), " ");
    const litFind = (list, text) => {
      let best = null, key = "";
      for (const it of list || []) {
        const k = litKey(it.name);
        if (k.length >= 4 && text.includes(k) && k.length > key.length) {
          best = it;
          key = k;
        }
      }
      return best;
    };
    const litDistrict = litFind(dists, litText);
    if (litDistrict) {
      out.district = litDistrict;
      const comms = await this.communes(litDistrict.id);
      // Bo mot lan ten huyen roi moi do xa, tranh "huyện Hà Trung" bi doc thanh "Thị trấn Hà Trung"
      const litText2 = litText.replace(litKey(litDistrict.name), " ");
      const litCommune = litFind(comms, litText2) || (fuzzyFind(comms, g.commune || "").score >= 0.8 ? fuzzyFind(comms, g.commune || "").item : null);
      if (litCommune) out.commune = litCommune;
      out.street = (g.street || "").trim() || raw;
      const parts0 = [out.street, out.commune?.name, out.district?.name, out.province?.name].filter(Boolean);
      out.fullAddress = parts0.join(", ");
      out.ok = true;
      out.confidence = out.commune ? "cao" : "trung bình (chưa rõ xã/phường)";
      out.note = out.commune ? "" : `Chưa xác định được xã/phường trong ${out.district.name}`;
      return out;
    }
    let dv = fuzzyFind(dists, g.district || "");
    let cv = { item: null, score: 0 };
    if (dv.item && dv.score >= 0.6) {
      out.district = dv.item;
      const comms = await this.communes(dv.item.id);
      cv = fuzzyFind(comms, g.commune || "");
      if (cv.item && cv.score >= 0.6) out.commune = cv.item;
    } else if (g.commune) {
      // Khach khong ghi huyen (hoac sai): tim xa trong tat ca huyen cua tinh
      for (const d of dists) {
        const comms = await this.communes(d.id);
        const c = fuzzyFind(comms, g.commune);
        if (c.item && c.score > cv.score) {
          cv = c;
          dv = { item: d, score: c.score };
        }
        if (cv.score >= 0.99) break;
      }
      if (cv.item && cv.score >= 0.7) {
        out.district = dv.item;
        out.commune = cv.item;
      }
    }
    // Duong/so nha: bo cac phan da nhan dien khoi chuoi goc neu Gemini khong tach
    out.street = (g.street || "").trim() || raw;
    const parts = [out.street, out.commune?.name, out.district?.name, out.province?.name].filter(Boolean);
    out.fullAddress = parts.join(", ");
    out.ok = !!(out.province && out.district);
    out.confidence = out.commune ? "cao" : out.district ? "trung bình (chưa rõ xã/phường)" : "thấp (chưa rõ quận/huyện)";
    // Toi day nghia la ten huyen/xa KHONG xuat hien nguyen van trong loi khach, chi do gan dung.
    // Danh dau ro de nhan vien kiem tra truoc khi giao, tranh giao nham huyen.
    if (out.district && !litText.includes(litKey(out.district.name))) {
      out.confidence = "thấp (dò gần đúng)";
      out.note = `Khách không ghi rõ tên huyện/xã, hệ thống dò gần đúng ra "${[out.commune?.name, out.district.name].filter(Boolean).join(", ")}"`;
      return out;
    }
    if (!out.district) out.note = `Chỉ xác định được tỉnh ${out.province.name}, chưa rõ quận/huyện`;
    else if (!out.commune) out.note = `Chưa xác định được xã/phường trong ${out.district.name}`;
    return out;
  }

  // ---------- Trich xuat don tu hoi thoai ----------
  async extractOrder(historyText, { pageName = "", defaultCode = "" } = {}) {
    const codes = catalog.products.map((p) => `${p.code} (${p.name}; màu: ${Object.entries(p.attributes).filter(([k]) => /m[àa]u|color/i.test(k)).flatMap(([, v]) => v).join("/") || "-"}; size: ${Object.entries(p.attributes).filter(([k]) => /size/i.test(k)).flatMap(([, v]) => v).join("/") || "-"})`).join("\n");
    const sys = `Bạn trích xuất ĐƠN HÀNG ĐÃ CHỐT từ hội thoại bán hàng giữa shop ${pageName} và khách. Chỉ lấy thông tin khách đã xác nhận mua (mẫu, màu, size, số lượng) và thông tin nhận hàng khách cung cấp. Không suy đoán; thiếu gì thì ready=false và ghi vào missing. SỐ ĐIỆN THOẠI phải là dãy số khách ĐÃ GÕ trong hội thoại, chép lại y nguyên; tuyệt đối không bịa, không lấy số của shop, không tự nghĩ ra số — khách chưa gửi số thì để phone rỗng và ready=false. Mã sản phẩm và màu/size phải lấy đúng theo danh mục:\n${codes}\nTổng tiền và miễn ship lấy theo câu chốt đơn của shop nếu có.`;
    const nhacMacDinh = defaultCode
      ? `\n\nMẪU CHỦ LỰC CỦA PAGE NÀY LÀ ${defaultCode}. Hội thoại không nêu rõ mã sản phẩm nào khác thì code = "${defaultCode}". TUYỆT ĐỐI không tự chọn mã khác chỉ vì nó có trong danh mục.`
      : "";
    const r = await generateReply(sys + nhacMacDinh, [{ role: "user", text: historyText }], { temperature: 0, maxOutputTokens: 600, jsonSchema: EXTRACT_SCHEMA });
    const ex = r.json;
    // CHOT CHAN: ma nao KHONG xuat hien trong hoi thoai thi khong duoc dung -> thay bang ma chu luc cua page.
    // Su co 2026-09-21: page chu luc Q002, ban tom tat chi ghi "1 dam mau Do Do size XL" (khong co ma)
    // -> AI tu chon Q005/Q003/Q004 -> don POS sai mau.
    if (ex && defaultCode && Array.isArray(ex.items)) {
      const text = String(historyText || "").toUpperCase();
      for (const it of ex.items) {
        const ma = String(it.code || "").toUpperCase().replace(/\s+/g, "");
        if (!ma) {
          it.code = defaultCode;
          continue;
        }
        if (ma !== String(defaultCode).toUpperCase() && !text.includes(ma)) {
          log.warn(`Trich xuat don: ma "${it.code}" khong he xuat hien trong hoi thoai -> dung ma chu luc ${defaultCode}`);
          it.code = defaultCode;
        }
      }
    }
    return ex;
  }

  /** Map mau/mau sac/size -> bien the POS */
  mapItems(items) {
    const mapped = [];
    const problems = [];
    for (const it of items || []) {
      const code = norm(it.code);
      const p = catalog.products.find((x) => norm(x.code) === code || norm(x.name) === code) || catalog.products.find((x) => norm(x.code).includes(code) || code.includes(norm(x.code)));
      if (!p) {
        problems.push(`không có mã ${it.code}`);
        continue;
      }
      const color = norm(it.color), size = norm(it.size);
      const vColor = (v) => norm(v.fields["Màu"] || v.fields["Color"] || v.fields["Mau"] || "");
      const vSize = (v) => norm(v.fields["Size"] || v.fields["Kích cỡ"] || "");
      let cands = p.variations;
      if (color) cands = cands.filter((v) => !vColor(v) || vColor(v) === color || vColor(v).includes(color) || color.includes(vColor(v)));
      if (size) cands = cands.filter((v) => !vSize(v) || vSize(v) === size);
      const v = cands[0];
      if (!v) {
        problems.push(`${p.code}: không có biến thể màu "${it.color || "?"}" size "${it.size || "?"}"`);
        continue;
      }
      mapped.push({ variation_id: v.id, quantity: Math.max(1, Number(it.quantity) || 1), display: `${p.name} ${v.fields["Màu"] || ""} ${v.fields["Size"] || ""}`.replace(/\s+/g, " ").trim(), price: v.price });
    }
    return { mapped, problems };
  }

  /**
   * Don nhap (status 0 "Moi") cua khach: tim theo SDT (POS ho tro ?search=), uu tien don gan voi hoi thoai, lay don CU NHAT
   * (don do Pancake/Sheet tu tao truoc). Khong co thi quet 200 don moi nhat theo conversation_id.
   */
  async findDraft(conversationId, phone) {
    // Don nhap do Pancake/Sheet tu tao thuong KHONG gan conversation_id -> uu tien don cu nhat trong 14 ngay (cung SDT hoac cung hoi thoai)
    const pick = (list) => {
      const drafts = (list || []).filter((o) => Number(o.status) === 0);
      if (!drafts.length) return null;
      const recent = drafts.filter((o) => Date.now() - Date.parse(String(o.inserted_at).replace(/Z?$/, "Z")) < 14 * 24 * 3600 * 1000);
      const pool = recent.length ? recent : drafts;
      pool.sort((a, b) => String(a.inserted_at).localeCompare(String(b.inserted_at)));
      return pool[0];
    };
    if (phone) {
      const d = await this._call("GET", `/shops/${config.pos.shopId}/orders`, null, { search: phone, page_size: 50 });
      const hit = pick((d.data || []).filter((o) => normalizePhone(o.bill_phone_number || o.shipping_address?.phone_number) === phone || o.conversation_id === conversationId));
      if (hit) return hit;
    }
    for (let page = 1; page <= 2; page++) {
      const d = await this._call("GET", `/shops/${config.pos.shopId}/orders`, null, { page_size: 100, page_number: page });
      const hit = pick((d.data || []).filter((o) => o.conversation_id === conversationId));
      if (hit) return hit;
      if ((d.data || []).length < 100) break;
    }
    return null;
  }

  /**
   * Don GAN DAY (30 ngay, khong tinh don nhap) cua khach theo SDT trong hoi thoai hoac conversation_id,
   * de bot tra loi "gui hang chua / bao gio nhan / don toi dau" bang du lieu that thay vi noi chung chung.
   */
  async recentOrdersFor(conversationId, phones = []) {
    if (!this.enabled) return [];
    const seen = new Map();
    const list = [...new Set((phones || []).map(normalizePhone).filter(Boolean))].slice(0, 2);
    for (const ph of list) {
      const d = await this._call("GET", `/shops/${config.pos.shopId}/orders`, null, { search: ph, page_size: 20 });
      for (const o of d.data || []) {
        const cung = normalizePhone(o.bill_phone_number || o.shipping_address?.phone_number) === ph || o.conversation_id === conversationId;
        if (cung && o.id && Number(o.status) !== 0 && Number(o.status) !== 9) seen.set(o.id, o);
      }
    }
    const out = [...seen.values()].filter((o) => Date.now() - Date.parse(String(o.inserted_at).replace(/(\.\d+)?Z?$/, "Z")) < 30 * 24 * 3600e3);
    out.sort((a, b) => String(b.inserted_at).localeCompare(String(a.inserted_at)));
    return out.slice(0, 3);
  }

  /** Don DANG XU LY (da xac nhan / dang dong / da gui...) cua khach trong 14 ngay - cung SDT hoac cung hoi thoai */
  async findActiveOrder(conversationId, phone) {
    if (!phone) return null;
    const d = await this._call("GET", `/shops/${config.pos.shopId}/orders`, null, { search: phone, page_size: 30 });
    const dangXuLy = new Set([1, 2, 3, 11, 12, 15]);
    const list = (d.data || []).filter((o) => {
      if (!dangXuLy.has(Number(o.status))) return false;
      const cung = normalizePhone(o.bill_phone_number || o.shipping_address?.phone_number) === phone || o.conversation_id === conversationId;
      const moi = Date.now() - Date.parse(String(o.inserted_at).replace(/(\.\d+)?Z?$/, "Z")) < 14 * 24 * 3600 * 1000;
      return cung && moi;
    });
    list.sort((a, b) => String(b.inserted_at).localeCompare(String(a.inserted_at)));
    return list[0] || null;
  }

  /**
   * Chot don tu hoi thoai -> ghi vao POS. Tra ve { status: "created"|"updated"|"skipped"|"error", orderId?, summary, reason? }
   */
  async syncFromConversation({ pageId, pageName, conversationId, customerName, historyText }) {
    if (!this.enabled) return { status: "skipped", reason: "POS chưa cấu hình" };
    const ex = await this.extractOrder(historyText, { pageName, defaultCode: settings.effective(pageId).defaultProduct || "" });
    if (!ex) return { status: "skipped", reason: "AI không trích xuất được đơn" };
    if (!ex.ready) return { status: "skipped", reason: `chưa đủ thông tin: ${ex.missing || "?"}` };
    const phone = normalizePhone(ex.phone);
    if (!phone) return { status: "skipped", reason: `SĐT không hợp lệ: ${ex.phone}` };
    // CHONG AI BIA SO DIEN THOAI: so phai THAT SU xuat hien trong hoi thoai.
    // Su co 2026-09-07 (don #3843): khach gui SDT dung giay bot tra loi nen lich su chua co so,
    // Gemini bia ra "0337711777" -> tao don moi voi SDT sai thay vi cap nhat don nhap cua khach.
    if (!phoneInText(historyText, phone)) {
      return { status: "skipped", reason: `SĐT ${phone} không có trong hội thoại (AI tự suy ra) — chờ khách gửi lại SĐT` };
    }
    const { mapped, problems } = this.mapItems(ex.items);
    if (!mapped.length) return { status: "skipped", reason: `không map được sản phẩm: ${problems.join("; ")}` };

    const addr = await this.resolveAddress(ex.address || "", { pageName });
    const goods = mapped.reduce((s, m) => s + m.price * m.quantity, 0);
    const agreed = Number(ex.agreed_total) || 0;
    const freeShip = !!ex.free_shipping || mapped.reduce((s, m) => s + m.quantity, 0) >= 2;
    let shipFee = freeShip ? 0 : 25000;
    // Phi ship khac nhau theo mau (Q004 20k tu 12/9/2026, do nam 30k): neu tong khach chot tru tien hang
    // dung bang mot muc ship hop le thi lay muc do, de POS khop voi gia bot da bao khach
    if (!freeShip && agreed > 0 && [20000, 25000, 30000].includes(agreed - goods)) shipFee = agreed - goods;
    // Giam gia = chenh lech giua gia niem yet POS va tong da chot voi khach (neu khach duoc combo/giam)
    const discount = agreed > 0 && agreed < goods + shipFee ? goods + shipFee - agreed : 0;

    const noteLines = [
      `🤖 Bot chốt từ chat (${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}): ${mapped.map((m) => `${m.display} x${m.quantity}`).join(", ")}`,
      agreed ? `Khách chốt tổng ${agreed.toLocaleString("vi-VN")}đ${freeShip ? " (miễn ship)" : " (gồm ship)"}${discount ? `, đã ghi giảm ${discount.toLocaleString("vi-VN")}đ` : ""}` : "",
      `Địa chỉ khách ghi: "${ex.address || ""}" → chuẩn hoá: ${addr.fullAddress} (độ khớp: ${addr.confidence})`,
      addr.note ? `⚠ ${addr.note}, nhân viên kiểm tra lại` : "",
      problems.length ? `⚠ ${problems.join("; ")}` : "",
      ex.note ? `Khách dặn: ${ex.note}` : "",
    ].filter(Boolean);

    const body = {
      conversation_id: conversationId,
      page_id: pageId,
      bill_full_name: ex.customer_name || customerName || "",
      bill_phone_number: phone,
      shipping_address: {
        full_name: ex.customer_name || customerName || "",
        phone_number: phone,
        address: addr.street,
        province_id: addr.province?.id,
        district_id: addr.district?.id,
        commune_id: addr.commune?.id,
        new_province_id: addr.province?.new_id,
        new_commune_id: addr.commune?.new_id,
      },
      items: mapped.map((m) => ({ variation_id: m.variation_id, quantity: m.quantity })),
      is_free_shipping: freeShip,
      shipping_fee: shipFee,
      discount,
      note: noteLines.join("\n"),
    };
    if (config.pos.warehouseId) body.warehouse_id = config.pos.warehouseId;

    const draft = await this.findDraft(conversationId, phone).catch((e) => {
      log.warn("Tim don nhap loi:", e.message);
      return null;
    });
    let res, status;
    if (draft) {
      const oldNote = draft.note ? String(draft.note).trim() + "\n" : "";
      res = await this._call("PUT", `/shops/${config.pos.shopId}/orders/${draft.id}`, { ...body, note: oldNote + body.note });
      status = "updated";
    } else {
      // KHONG tao don moi neu khach nay (cung SDT / cung hoi thoai) da co don DA XAC NHAN trong 14 ngay:
      // nhan vien da xu ly roi, tao them = don trung (su co 2026-09-16: #4452 da xac nhan, bot tao them #4511)
      const daCo = await this.findActiveOrder(conversationId, phone).catch(() => null);
      if (daCo) {
        const lyDo = `khách đã có đơn #${daCo.id} (${ORDER_STATUS_VI[Number(daCo.status)] || daCo.status_name}) - không tạo thêm, nhân viên sửa trên đơn đó nếu cần`;
        log.info(`[${pageId}] ${conversationId}: ${lyDo}`);
        return { status: "skipped", reason: lyDo, orderId: daCo.id };
      }
      res = await this._call("POST", `/shops/${config.pos.shopId}/orders`, body);
      status = "created";
    }
    const orderId = res?.data?.id || draft?.id;
    const summary = `${status === "updated" ? "Cập nhật đơn nháp" : "Tạo đơn nháp"} #${orderId}: ${mapped.map((m) => `${m.display} x${m.quantity}`).join(", ")} | ${body.bill_full_name} ${phone} | ${addr.fullAddress}${addr.ok ? "" : " (⚠ địa chỉ cần kiểm tra)"}`;
    log.info(`[${pageId}] ${conversationId}: ${summary}`);
    store.bumpStat(pageId, "orders");
    return { status, orderId, summary, address: addr, items: mapped, discount, agreed };
  }
}

export const orderSync = new OrderSync();
