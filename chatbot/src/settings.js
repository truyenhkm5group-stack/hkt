import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { DEFAULT_AI_PRICES, DEFAULT_USD_VND, aiScope } from "./aicost.js";

export const DEFAULT_DELIVERY_DAYS = "5–7";

/**
 * Cai dat rieng tung page, sua tu app quan ly, luu data/pages.json:
 * {
 *   "<page_id>": {
 *     enabled: true,            // bat/tat bot cho page
 *     dryRun: false,            // chi log, khong gui (rieng page nay)
 *     extraPrompt: "",          // huong dan rieng cho page (giong dieu, uu dai, dia chi...)
 *     model: "",                // override GEMINI_MODEL
 *     temperature: null,        // override
 *     humanTakeoverMinutes: null,
 *     replyToComments: null,
 *     sendProductImages: null,
 *     updatedAt: 0
 *   }
 * }
 */
const DEFAULTS = {
  displayName: "", // ten hien thi tu dat (trong = dung ten that tu Pancake)
  enabled: true,
  dryRun: false,
  extraPrompt: "",
  model: "",
  temperature: null,
  humanTakeoverMinutes: null,
  minCustomerMessages: null,
  replyToComments: null,
  commentMode: "", // "" = theo COMMENT_MODE chung | off | public | inbox
  orderSync: null, // null = theo ORDER_SYNC chung
  sendProductImages: null,
  // Khuyen mai chi ap dung cho nhung hoi thoai da duoc nhan vien ban tin khuyen mai
  // Bang size rieng cua page (JSON): [{ h:[minCm,maxCm], w:[[minKg,maxKg,"size"],...] }]
  afterOrderText: "", // tin gui them ngay sau ban tom tat chot don
  splitMessages: false, // tach cau tra loi thanh nhieu tin ngan nhu nhan vien chat
  customerTitle: "", // cach goi khach: "chi" (mac dinh) hoac "anh" cho page do nam
  ownPrompt: false, // true = page dung rieng huong dan cua minh, KHONG dung kich ban chung (vd page ban do nam)
  sizeChart: "",
  sizeNote: "", // ghi chu kem theo khi bao size (vd quy doi size VN)
  saleEnabled: false,
  saleTrigger: "", // tu khoa nhan biet trong tin cua shop, cach nhau bang |
  salePrompt: "", // huong dan/bang gia chi dung khi hoi thoai dang chay khuyen mai
  defaultProduct: "", // ma mau CHU LUC cua page (vd "Q002"): hoi thoai khong neu ma nao thi ghi don theo ma nay
  saleModels: "", // ma mau DUOC xa kho (vd "Q002" hoac "Q002|Q001"); trong = moi mau. Mau khac giu gia thuong
  // --- Bam khach chua chot (sales agent, src/salesagent.js) ---
  followupEnabled: false, // cho phep bam khach cua page nay (bam tay tu app)
  followupAuto: false, // tu dong bam theo lich, khong can bam nut
  followupMaxTouches: 3, // moi khach bam toi da may lan roi thoi
  followupDelays: "", // moc im lang toi thieu (gio) cho tung lan, vd "20,72,168"; trong = 20,72,168
  followupQuietFrom: 21, // gio yen tinh: khong nhan tu 21h...
  followupQuietTo: 8, // ...den 8h sang (gio Viet Nam)
  followupDailyLimit: 50, // toi da bao nhieu tin bam moi ngay cho page nay
  followupExtra: "", // yeu cau rieng cua shop cho tin bam (vd "nhac mien ship khi lay 2 cai")
  followupStages: "", // chi bam nhung giai doan nay (vd "phone_no_order,size_no_phone"); trong = tat ca
};

class Settings {
  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, "pages.json");
    this.globalFile = path.join(config.dataDir, "global.json");
    this.pages = {};
    // Cai dat chung doi duoc luc chay (ghi de .env): { dryRun: true|false|null }
    this.global = { dryRun: null };
    this.globalPromptFile = config.systemPromptFile;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) this.pages = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
    } catch (e) {
      log.warn("Khong doc duoc pages.json:", e.message);
    }
    try {
      if (fs.existsSync(this.globalFile)) Object.assign(this.global, JSON.parse(fs.readFileSync(this.globalFile, "utf8")) || {});
    } catch (e) {
      log.warn("Khong doc duoc global.json:", e.message);
    }
  }

  /** DRY_RUN chung dang hieu luc: gia tri doi trong app > .env */
  globalDryRun() {
    return this.global.dryRun ?? config.dryRun;
  }

  /** Bang gia AI (USD / 1 trieu token) + ty gia — mac dinh trong ma, ghi de sua trong app (global.json). */
  aiPricing() {
    const prices = { ...DEFAULT_AI_PRICES, ...(this.global.aiPrices || {}) };
    const usdVnd = Number(this.global.usdVnd) > 0 ? Number(this.global.usdVnd) : DEFAULT_USD_VND;
    return { prices, usdVnd };
  }

  setAiPricing({ aiPrices, usdVnd }) {
    if (aiPrices !== undefined) {
      if (!aiPrices || typeof aiPrices !== "object" || Array.isArray(aiPrices)) throw new Error("Bang gia AI khong hop le");
      const clean = {};
      for (const [model, p] of Object.entries(aiPrices)) {
        const key = String(model).trim().toLowerCase();
        if (!key || key.length > 80) continue;
        const nums = ["input", "cached", "output"].map((k) => Number(p?.[k]));
        if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1000)) throw new Error(`Gia cua ${key} khong hop le`);
        clean[key] = { input: nums[0], cached: nums[1], output: nums[2] };
      }
      this.global.aiPrices = clean;
    }
    if (usdVnd !== undefined) {
      const n = Number(usdVnd);
      if (!Number.isFinite(n) || n < 1000 || n > 100000) throw new Error("Ty gia USD -> VND khong hop le");
      this.global.usdVnd = Math.round(n);
    }
    fs.writeFileSync(this.globalFile, JSON.stringify(this.global, null, 2));
    return this.aiPricing();
  }

  /**
   * TIEN THUC TRA API (hoa don cua nha cung cap AI) chu shop nhap tay theo khoang ngay — bot khong doc duoc hoa don
   * Google bang khoa API, nen day la cach duy nhat co so tien that. Toi da 24 dong, moi dong mot khoang.
   */
  aiBills() {
    return Array.isArray(this.global.aiBills) ? this.global.aiBills : [];
  }

  setAiBills(list) {
    if (!Array.isArray(list)) throw new Error("Danh sach hoa don khong hop le");
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const clean = list.slice(0, 24).map((b) => {
      const from = String(b?.from || "");
      const to = String(b?.to || "");
      const amountVnd = Math.round(Number(b?.amountVnd));
      if (!day.test(from) || !day.test(to) || from > to) throw new Error("Khoang ngay khong hop le (tu ngay <= den ngay)");
      if (!Number.isFinite(amountVnd) || amountVnd < 0 || amountVnd > 1e10) throw new Error("So tien khong hop le");
      return { from, to, amountVnd, note: String(b?.note || "").slice(0, 120) };
    });
    this.global.aiBills = clean;
    fs.writeFileSync(this.globalFile, JSON.stringify(this.global, null, 2));
    return clean;
  }

  /**
   * THOI GIAN GIAO HANG bot hen khach ("5–7" ngay). Mot cho duy nhat: dua vao prompt va sua lai moi cau hen so ngay
   * khac trong tra loi (prompt chung / huong dan rieng cu con ghi "2–4 ngay"). Chu shop doi 30/09/2026: 5–7 ngay.
   */
  deliveryDays() {
    return String(this.global.deliveryDays || DEFAULT_DELIVERY_DAYS);
  }

  setDeliveryDays(v) {
    const m = String(v || "").trim().match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2]) || Number(m[2]) > 60) throw new Error("Thoi gian giao hang phai dang 5-7 (ngay)");
    this.global.deliveryDays = `${Number(m[1])}–${Number(m[2])}`;
    fs.writeFileSync(this.globalFile, JSON.stringify(this.global, null, 2));
    return this.deliveryDays();
  }

  /**
   * BOT LEN DON (orderbot.js): bat/tat va so phut CHO khach nhan not thong tin truoc khi dua vao hang "can duyet".
   * Mac dinh BAT, cho 120 phut. Bat thi luong ghi don cu (sau cau tom tat chot don) nhuong han cho bot nay.
   */
  orderBot() {
    const o = this.global.orderBot || {};
    // autoConfirm: MAC DINH TAT — chu shop tu bat. Bat thi don CHAC CHAN (dia chi khop du cap, san pham khop POS,
    // khach chot tong tien, khong co don khac) duoc chuyen "Moi" -> "Da xac nhan"; con lai van la don nhap.
    return { enabled: o.enabled !== false, waitMinutes: Number(o.waitMinutes) > 0 ? Number(o.waitMinutes) : 120, autoConfirm: o.autoConfirm === true };
  }

  setOrderBot({ enabled, waitMinutes, autoConfirm }) {
    const cur = this.orderBot();
    const next = { ...cur };
    if (enabled !== undefined) next.enabled = !!enabled;
    if (autoConfirm !== undefined) next.autoConfirm = autoConfirm === true;
    if (waitMinutes !== undefined) {
      const n = Math.round(Number(waitMinutes));
      if (!Number.isFinite(n) || n < 10 || n > 24 * 60) throw new Error("Thoi gian cho phai tu 10 den 1440 phut");
      next.waitMinutes = n;
    }
    this.global.orderBot = next;
    fs.writeFileSync(this.globalFile, JSON.stringify(this.global, null, 2));
    return this.orderBot();
  }

  /** Bat/tat DRY_RUN chung ngay luc chay (null = quay ve gia tri trong .env) */
  setGlobalDryRun(value) {
    this.global.dryRun = value === null || value === undefined ? null : !!value;
    fs.writeFileSync(this.globalFile, JSON.stringify(this.global, null, 2));
    log.warn(`DRY_RUN chung -> ${this.globalDryRun() ? "BAT (chi log, khong gui)" : "TAT (bot GUI THAT cho khach)"}${this.global.dryRun === null ? " (theo .env)" : " (doi trong app)"}`);
    return this.globalDryRun();
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.pages, null, 2));
  }

  get(pageId) {
    return { ...DEFAULTS, ...(this.pages[String(pageId)] || {}) };
  }

  update(pageId, patch) {
    const id = String(pageId);
    const cur = this.pages[id] || {};
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS)) continue;
      next[k] = v === "" && (k === "temperature" || k === "humanTakeoverMinutes" || k === "minCustomerMessages") ? null : v;
      if (k === "displayName") next[k] = String(v || "").trim();
    }
    next.updatedAt = Date.now();
    this.pages[id] = next;
    this._save();
    log.info(`[${id}] Cap nhat cai dat page: ${Object.keys(patch || {}).join(", ")}`);
    return this.get(id);
  }

  /** Gia tri hieu luc (page override -> global) */
  effective(pageId) {
    const p = this.get(pageId);
    return {
      enabled: p.enabled !== false,
      dryRun: this.globalDryRun() || !!p.dryRun,
      extraPrompt: p.extraPrompt || "",
      model: p.model || config.gemini.model,
      temperature: p.temperature ?? config.gemini.temperature,
      humanTakeoverMinutes: p.humanTakeoverMinutes ?? config.humanTakeoverMinutes,
      minCustomerMessages: Math.max(1, Number(p.minCustomerMessages ?? config.minCustomerMessages) || 1),
      commentMode: ["off", "public", "inbox"].includes(p.commentMode) ? p.commentMode : config.commentMode,
      commentPublicText: config.commentPublicText,
      orderSync: p.orderSync ?? config.orderSync,
      replyToComments: (["off", "public", "inbox"].includes(p.commentMode) ? p.commentMode : config.commentMode) !== "off",
      sendProductImages: p.sendProductImages ?? config.sendProductImages,
      // Khuyen mai chi ap cho hoi thoai da co tin cua shop chua tu khoa saleTrigger
      afterOrderText: p.afterOrderText || "",
      splitMessages: !!p.splitMessages,
      customerTitle: p.customerTitle || "",
      ownPrompt: !!p.ownPrompt,
      sizeChart: p.sizeChart || "",
      sizeNote: p.sizeNote || "",
      saleEnabled: !!p.saleEnabled,
      saleTrigger: p.saleTrigger || "",
      salePrompt: p.salePrompt || "",
      saleModels: p.saleModels || "",
      // Hoi thoai den tu quang cao test co bot rieng (bot.js dat vao aiScope): mau cua camp la mau mac dinh
      // CHO RIENG hoi thoai do — moi cho dung defaultProduct (chan nham ma, ghi don, gui anh) tu theo camp.
      defaultProduct: this.scopedAdProduct(pageId) || p.defaultProduct || "",
    };
  }

  /** Mau cua bot quang cao dang ap cho luot xu ly hien tai (cung page), hoac "". */
  scopedAdProduct(pageId) {
    const s = aiScope.getStore();
    if (!s?.adBot?.productCode || String(s.adBotPageId) !== String(pageId)) return "";
    return s.adBot.productCode;
  }

  readGlobalPrompt() {
    return fs.readFileSync(this.globalPromptFile, "utf8");
  }

  writeGlobalPrompt(text) {
    // giu ban sao cu de lo tay con khoi phuc duoc
    const bak = path.join(config.dataDir, "system.md.bak");
    try {
      fs.copyFileSync(this.globalPromptFile, bak);
    } catch {}
    fs.writeFileSync(this.globalPromptFile, text);
    log.info("Da cap nhat prompts/system.md (ban cu: data/system.md.bak)");
  }
}

export const settings = new Settings();
