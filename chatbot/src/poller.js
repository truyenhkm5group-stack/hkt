import { config } from "./config.js";
import { store } from "./store.js";
import { log } from "./logger.js";
import { sleep, parseTs, stripHtml } from "./util.js";
import { AUTO_NOTE_RE } from "./bot.js";
import { settings } from "./settings.js";

/**
 * Che do POLL: dung khi chua duoc Pancake bat webhook.
 * Moi POLL_INTERVAL_SEC giay, lay 60 hoi thoai moi nhat; hoi thoai nao co updated_at thay doi
 * va tin cuoi do khach gui thi day vao hang doi de tra loi.
 * Lan chay dau tien chi ghi nhan trang thai, khong tra loi tin cu (tranh spam khach).
 */
const SO_TRANG_POLL = 5; // toi da 5 trang x 60 = 300 hoi thoai moi nhat khi dang ban tin hang loat

export function startPoller(bot) {
  let firstRun = Object.keys(store.state.convUpdatedAt).length === 0;
  let stopped = false;

  async function tick() {
    for (const [pageId, client] of bot.clients) {
      const eff = settings.effective(pageId);
      if (!eff.enabled) continue;
      const types =
        eff.commentMode !== "off" ? ["INBOX", "COMMENT"] : ["INBOX"];
      for (const type of types) {
        try {
          // Moi lan chi doc 60 hoi thoai moi nhat. Khi shop ban tin hang loat (vd tin xa kho gui hang tram khach),
          // hon 60 hoi thoai doi trong 1 nhip poll -> khach vua nhan tin bi day xuong duoi vi tri 60 va KHONG AI THAY.
          // Vi vay: neu ca trang deu co thay doi thi lat tiep trang sau (toi da SO_TRANG_POLL trang).
          // Su co 2026-09-19 page Linh Tay Luxury: khach Hang Pham / Hang Thu cho 13-17 phut khong duoc tra loi.
          let last;
          let conMoi = true;
          for (let trang = 0; trang < SO_TRANG_POLL && conMoi; trang++) {
            const data = await client.getConversations({
              type,
              order_by: "updated_at",
              last_conversation_id: last,
            });
            const list = data.conversations || [];
            if (!list.length) break;
            last = list[list.length - 1].id;
            conMoi = true;
            let soMoi = 0;
            for (const conv of list) {
              const prev = store.getConvUpdatedAt(conv.id);
              if (prev === conv.updated_at) continue;
              soMoi++;
              store.setConvUpdatedAt(conv.id, conv.updated_at);
              if (firstRun) continue;
              // Hoi thoai lan dau bot thay (vd vua bat che do binh luan, hoac bot tat mot thoi gian) ma da cu -> bo qua,
              // tranh tra loi hang loat tin cu cua khach
              const ageMin = (Date.now() - parseTs(conv.updated_at)) / 60000;
              if (ageMin > config.pollMaxAgeMin) {
                log.debug(
                  `[poll ${pageId}] Bo qua hoi thoai ${conv.id} cu ${Math.round(ageMin)} phut`,
                );
                continue;
              }
              let force = false;
              if (String(conv.last_sent_by?.id) === pageId) {
                // Binh thuong: page (bot/nhan vien) vua tra loi -> bo qua.
                // Ngoai le: Pancake vua gan NHAN TU DONG de len tin cua khach (vd khach gui dia chi + SDT xong
                // Pancake danh dau "Da dat hang") -> khach van dang cho bot chot don. Doc lai tin de tra loi bu.
                if (!AUTO_NOTE_RE.test(stripHtml(conv.snippet || ""))) continue;
                const need = await bot
                  .needsCatchUp(client, conv.id, pageId)
                  .catch(() => null);
                if (!need) continue;
                force = true;
                log.info(
                  `[poll ${pageId}] Hoi thoai ${conv.id} (${conv.from?.name}): nhan tu dong cua Pancake de len tin khach -> tra loi bu de chot don`,
                );
              }
              if (bot.isPaused(conv.tags, pageId)) continue;
              log.info(
                `[poll ${pageId}] Hoi thoai ${conv.id} (${conv.from?.name}) co tin moi: ${(conv.snippet || "").slice(0, 80)}`,
              );
              bot.queue.push(`${pageId}:${conv.id}`, {
                pageId,
                conversationId: conv.id,
                type: String(conv.type || type).toUpperCase(),
                customerName: conv.from?.name,
                tags: conv.tags,
                force,
              });
            }
            // Trang nay con nhieu hoi thoai vua doi -> nhieu kha nang trang sau cung con, lat tiep
            conMoi = soMoi >= list.length - 2 && list.length >= 60;
            if (conMoi)
              log.debug(
                `[poll ${pageId}] ca trang ${trang + 1} deu co tin moi (${soMoi}/${list.length}) -> doc tiep trang sau`,
              );
          }
        } catch (e) {
          log.error(`[poll ${pageId}] Loi lay hoi thoai:`, e.message);
        }
      }
    }
    if (firstRun) {
      log.info(
        "Poll: da ghi nhan trang thai ban dau, se tra loi cac tin moi tu bay gio",
      );
      firstRun = false;
    }
  }

  (async () => {
    log.info(`Che do poll bat, moi ${config.pollIntervalSec}s`);
    while (!stopped) {
      await tick();
      await sleep(config.pollIntervalSec * 1000);
    }
  })();

  return () => {
    stopped = true;
  };
}
