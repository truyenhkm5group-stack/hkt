import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

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
      defaultProduct: p.defaultProduct || "",
    };
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
