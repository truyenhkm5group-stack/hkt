import { config } from "./config.js";
import { store } from "./store.js";
import { log } from "./logger.js";
import { settings } from "./settings.js";
import { sleep, parseTs } from "./util.js";

/**
 * Luoi an toan: cu moi phut ra soat lai, hoi thoai nao khach nhan da qua N phut ma
 * CHUA AI tra loi (ca bot lan nhan vien) thi day vao hang doi de bot tra loi.
 *
 * Can thiet vi che do poll chi bat hoi thoai vua doi trang thai trong POLL_MAX_AGE_MIN phut;
 * neu luc do bot dang ban, Gemini loi, hay tin den khong dung nhip thi khach bi bo sot luon.
 */
const CHU_KY_MS = 60 * 1000;
const CUA_SO_GIO = 6; // chi ra soat hoi thoai trong 6 gio gan nhat
const SO_LAN_THU_TOI_DA = 3; // tranh lap vo han voi hoi thoai khong the tra loi (het cua so 24h...)
const SO_TRANG = 8; // moi page doc 8 trang x 60 = 480 hoi thoai moi nhat (tin gui hang loat day khach xuong rat sau)

export function startWatchdog(bot) {
  const phut = Number(config.autoCatchupMinutes || 0);
  if (!phut) {
    log.info("Luoi an toan tra loi bu: TAT (AUTO_CATCHUP_MINUTES=0)");
    return () => {};
  }
  let stopped = false;
  // Chi lo tin den tu luc bot con song lan cuoi (store.lastAlive, ghi moi phut): bot tat/treo 1 tieng roi
  // bat lai thi tra loi bu dung khoang bi tat do (su co 2026-09-12 12:15-13:38 VN: app tat, 11 khach CS1 cho).
  // Khong dao lai tin ton dong cu hon (chu shop: "tu sau rep la duoc, con toi se tu rep cac mess nay").
  const lastAlive = store.getLastAlive();
  const batDau = lastAlive ? lastAlive - 2 * 60 * 1000 : Date.now();
  if (lastAlive && Date.now() - lastAlive > 3 * 60 * 1000) {
    log.warn(`Luoi an toan: bot vua tat ${Math.round((Date.now() - lastAlive) / 60000)} phut, se tra loi bu khach nhan trong khoang do`);
  }
  const soLanThu = new Map(); // messageId cua khach -> so lan da day vao hang doi
  const daXem = new Map(); // conversationId -> updated_at da kiem tra (hoi thoai page gui cuoi)

  async function quetPage(pageId, client, { now, gioiHanDuoi, gioiHanTren }) {
    const eff = settings.effective(pageId);
    if (!eff.enabled) return;
    // Quet ca BINH LUAN (COMMENT) khi page co bat tra loi binh luan: chi quet INBOX thi binh luan
    // "Xin gia" trong luc bot tat khong bao gio duoc tra loi bu (su co 2026-09-14, page CS1: 4 binh luan cho 4-6 tieng)
    const loai = eff.commentMode !== "off" ? ["INBOX", "COMMENT"] : ["INBOX"];
    for (const type of loai) {
      let last;
      try {
        for (let trang = 0; trang < SO_TRANG; trang++) {
          const data = await client.getConversations({ type, order_by: "updated_at", last_conversation_id: last });
          const list = data.conversations || [];
          if (!list.length) break;
          let dung = false;
          for (const conv of list) {
            const at = parseTs(conv.updated_at);
            if (at < gioiHanTren) {
              dung = true;
              break;
            }
            if (at > gioiHanDuoi) continue; // tin vua den, de che do poll lo
            if (bot.isPaused(conv.tags, pageId)) continue;
            if (String(conv.last_sent_by?.id) === String(pageId)) {
              // Page gui cuoi: thuong la da tra loi, NHUNG co the chi la loi chao tu dong cua quang cao
              // Facebook de len cau hoi khach (needsCatchUp se phan biet). Chi xet hoi thoai Pancake danh dau
              // CHUA XEM (automation gui thi khong ai xem; bot/nhan vien tra loi thi seen=true), va moi hoi thoai
              // chi doc lai 1 lan cho moi updated_at de khong goi API lien tuc (xem daXem ben duoi).
              if (conv.seen !== false) continue;
            }
            // Doc lai tin nhan de chac chan bot CHUA tra loi dung tin do. Chi nhin last_sent_by la khong du:
            // khi gui tin bi loi giua chung (vd "(#551) Nguoi nay hien khong co mat") thi Pancake van coi
            // khach la nguoi gui cuoi, luoi an toan bat lai va bot soan lai tu dau -> khach nhan 2-3 tin
            // gan giong nhau (su co 2026-09-12, khach Hoa Nguyen -> khach bo don).
            // Da kiem tra hoi thoai nay o dung updated_at nay va khong co gi phai tra loi -> bo qua,
            // khong goi lai API (tranh 429 khi quet 480 hoi thoai moi phut)
            if (daXem.get(conv.id) === conv.updated_at) continue;
            const tinCho = await bot.needsCatchUp(client, conv.id, pageId).catch(() => null);
            if (!tinCho) {
              daXem.set(conv.id, conv.updated_at);
              continue;
            }
            // Dem theo TIN cua khach, khong theo hoi thoai: tin moi cua khach duoc thu lai tu dau
            const daThu = soLanThu.get(tinCho.id) || 0;
            if (daThu >= SO_LAN_THU_TOI_DA) continue;
            soLanThu.set(tinCho.id, daThu + 1);
            log.warn(`[${pageId}] Luoi an toan: khach "${conv.from?.name || ""}" cho da ${Math.round((now - at) / 60000)} phut chua ai tra loi -> tra loi bu`);
            store.setConvUpdatedAt(conv.id, conv.updated_at);
            bot.queue.push(`${pageId}:${conv.id}`, {
              pageId,
              conversationId: conv.id,
              type: String(conv.type || type).toUpperCase(),
              customerName: conv.from?.name,
              tags: conv.tags,
            });
          }
          last = list[list.length - 1].id;
          if (dung || list.length < 60) break;
        }
      } catch (e) {
        log.warn(`[${pageId}] Luoi an toan loi (${type}): ${e.message}`);
      }
    }
  }

  async function quet() {
    const now = Date.now();
    const gioiHanDuoi = now - phut * 60 * 1000; // tin phai cu hon N phut
    const gioiHanTren = Math.max(now - CUA_SO_GIO * 3600 * 1000, batDau);
    // Quet cac page SONG SONG: tuan tu thi page cuoi danh sach phai cho hang tram request cua cac page truoc
    // (Hoa Tim, Linen CS1 2026-09-16 cho hon 20 phut sau khi bot bat lai)
    await Promise.all([...bot.clients].map(([pageId, client]) => quetPage(pageId, client, { now, gioiHanDuoi, gioiHanTren })));
    store.setLastAlive(now);
    // Don bo nho
    if (daXem.size > 3000) {
      for (const k of [...daXem.keys()].slice(0, daXem.size - 1500)) daXem.delete(k);
    }
    if (soLanThu.size > 2000) {
      for (const k of [...soLanThu.keys()].slice(0, soLanThu.size - 1000)) soLanThu.delete(k);
    }
  }

  (async () => {
    log.info(`Luoi an toan tra loi bu: BAT, khach cho qua ${phut} phut ma chua ai tra loi thi bot tra loi bu`);
    while (!stopped) {
      await quet().catch((e) => log.warn("Luoi an toan loi: " + e.message));
      await sleep(CHU_KY_MS);
    }
  })();

  return () => {
    stopped = true;
  };
}
