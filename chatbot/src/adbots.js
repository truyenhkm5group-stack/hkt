import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { normalizeAdBotPayload, pickAdBot } from "./adpersona.js";

/**
 * Kho "bot rieng theo quang cao" tren dia (data/ad-bots.json) + so quan sat ad_id bot da gap.
 *
 * ERP la nguon DUY NHAT cua danh sach: moi lan day la THAY CA BO (ERP biet camp nao da tat / doi mau).
 * So quan sat (data/ad-seen.json) tra loi "khach den tu quang cao nao ma chua co bot rieng" — ad_id la
 * khong duoc bien mat im lang, ERP doc lai qua GET /api/erp/ad-bots de hien ra man hinh.
 * Hoi thoai da tung gan voi mot quang cao thi NHO lai (Pancake co the khong gui lai ad_id o moi goi tin).
 */

const MAX_SEEN = 500;
const MAX_CONV = 5000;

class AdBots {
  constructor() {
    this.file = path.join(config.dataDir, "ad-bots.json");
    this.seenFile = path.join(config.dataDir, "ad-seen.json");
    this.bots = {};
    this.syncedAt = null;
    this.seen = {};
    this.convAds = new Map();
    this._seenDirty = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.bots = j.bots && typeof j.bots === "object" ? j.bots : {};
        this.syncedAt = j.syncedAt || null;
      }
    } catch (e) {
      log.warn("Khong doc duoc ad-bots.json:", e.message);
    }
    try {
      if (fs.existsSync(this.seenFile)) this.seen = JSON.parse(fs.readFileSync(this.seenFile, "utf8")) || {};
    } catch {
      this.seen = {};
    }
  }

  _write(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  /** ERP day ca bo. Hinh dang sai -> nem loi, KHONG ghi gi (giu bo cu). */
  replaceAll(payload) {
    const { bots, skipped } = normalizeAdBotPayload(payload);
    this.bots = bots;
    this.syncedAt = new Date().toISOString();
    this._write(this.file, { syncedAt: this.syncedAt, bots });
    const n = Object.keys(bots).length;
    log.info(`Bot theo quang cao: nhan ${n} bot tu ERP${skipped ? ` (bo ${skipped} dong khong hop le)` : ""}`);
    return { count: n, skipped, syncedAt: this.syncedAt };
  }

  /** Nho ad_id cua hoi thoai, tra ve danh sach day du (cu -> moi). */
  rememberConversation(conversationId, adIds) {
    const key = String(conversationId || "");
    const cur = this.convAds.get(key) || [];
    const merged = [...cur.filter((x) => !(adIds || []).includes(x)), ...(adIds || [])];
    if (key && merged.length) {
      this.convAds.delete(key);
      this.convAds.set(key, merged.slice(-5));
      if (this.convAds.size > MAX_CONV) this.convAds.delete(this.convAds.keys().next().value);
    }
    return merged;
  }

  /** Chon bot cho hoi thoai + ghi so quan sat. */
  resolve(pageId, conversationId, adIds) {
    const all = this.rememberConversation(conversationId, adIds);
    if (!all.length) return null;
    const bot = pickAdBot(all, this.bots);
    const adId = all[all.length - 1];
    const s = this.seen[adId] || { count: 0, firstAt: new Date().toISOString() };
    s.count += 1;
    s.lastAt = new Date().toISOString();
    s.pageId = String(pageId || "");
    s.matched = bot ? bot.adId : null;
    this.seen[adId] = s;
    const keys = Object.keys(this.seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => String(this.seen[a].lastAt).localeCompare(String(this.seen[b].lastAt)));
      for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete this.seen[k];
    }
    this._scheduleSeenSave();
    return bot;
  }

  _scheduleSeenSave() {
    if (this._seenDirty) return;
    this._seenDirty = true;
    const t = setTimeout(() => {
      this._seenDirty = false;
      try {
        this._write(this.seenFile, this.seen);
      } catch (e) {
        log.warn("Khong ghi duoc ad-seen.json:", e.message);
      }
    }, 30_000);
    t.unref?.();
  }

  get(adId) {
    return this.bots[String(adId || "")] || null;
  }

  status() {
    const bots = Object.values(this.bots).map((b) => ({ adId: b.adId, productCode: b.productCode, campaignName: b.campaignName, adName: b.adName }));
    return { syncedAt: this.syncedAt, count: bots.length, bots, seen: this.seen };
  }
}

export const adBots = new AdBots();
