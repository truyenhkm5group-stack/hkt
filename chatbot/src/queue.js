import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Gom tin nhan theo hoi thoai:
 * - Khach thuong gui nhieu tin ngan lien tiep -> doi DEBOUNCE_MS roi moi xu ly 1 lan
 * - Moi hoi thoai xu ly tuan tu (khong chay song song 2 lan tra loi cho cung 1 khach)
 */
export class ConversationQueue {
  constructor(handler) {
    this.handler = handler;
    this.pending = new Map(); // key -> { timer, payload }
    this.running = new Map(); // key -> Promise
  }

  push(key, payload) {
    const cur = this.pending.get(key);
    if (cur) {
      clearTimeout(cur.timer);
      cur.payload = { ...cur.payload, ...payload, count: (cur.payload.count || 1) + 1 };
    } else {
      this.pending.set(key, { payload: { ...payload, count: 1 } });
    }
    const entry = this.pending.get(key);
    entry.timer = setTimeout(() => this._flush(key), config.debounceMs);
  }

  _flush(key) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const prev = this.running.get(key) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.handler(key, entry.payload))
      .catch((e) => log.error(`Loi xu ly hoi thoai ${key}:`, e));
    this.running.set(key, run);
    run.finally(() => {
      if (this.running.get(key) === run) this.running.delete(key);
    });
  }
}
