#!/usr/bin/env node
/**
 * ops "bot-order-describe" — CAU BOT NHA SE NOI ve <= 5 don POS, CHI DOC (23/10/2026, sau PR pos-reship-bot-truth).
 *
 * Vi sao: bot nha nay hoi ERP (cua noi bo /api/internal/shipment-state) de noi dung chang van don theo chung tu Viettel Post. Can
 * xac nhan tren production ma KHONG nhan tin thu vao hoi thoai that (luat: khong gui tin thu cho khach that) va khong ai cam khoa bot.
 * Script chay TRONG container erp-chatbot: doc don POS bang CHINH duong cua bot (orderSync, khoa POS cua bot), goi erpOrderView that
 * (route that, ADMIN_TOKEN that, ERP_INTERNAL_URL that) roi in dung cau describeOrder ma bot dua vao prompt.
 *
 * Khong ghi gi, khong gui tin. Kenh [ops:tom-tat] (CONG KHAI): ban rut gon (trang thai + ma van don + chang) — khong ten / SDT /
 * tien / ten hang. Cau day du chi o phan MA HOA cua luot chay.
 */
import { config } from "../src/config.js";
import { describeOrder, erpOrderView, orderSync } from "../src/orders.js";
import { parseOrderIds, publicLine } from "./order-describe-lib.js";

const tomTat = (s) => console.log(`[ops:tom-tat] ${s}`);

async function main() {
  const args = parseOrderIds(process.argv.slice(2));
  if (args.error) {
    tomTat(`bot-order-describe: DỪNG — ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (!orderSync.enabled) {
    tomTat("bot-order-describe: POS của bot chưa bật — không đọc được đơn");
    process.exitCode = 1;
    return;
  }
  const orders = [];
  for (const id of args.ids) {
    try {
      const d = await orderSync._call("GET", `/shops/${config.pos.shopId}/orders/${id}`);
      const o = d?.data && typeof d.data === "object" ? d.data : d;
      if (o?.id) orders.push(o);
      else tomTat(`đơn ${id}: POS không trả đơn`);
    } catch (e) {
      tomTat(`đơn ${id}: đọc POS lỗi — ${String(e instanceof Error ? e.message : e).replace(/\d{9,}/g, "#").slice(0, 120)}`);
    }
  }
  const view = await erpOrderView(orders);
  tomTat(`bot-order-describe · đọc ${orders.length}/${args.ids.length} đơn · ERP trả ${Object.keys(view.byOrder).length} lần gửi chính · ${Object.keys(view.byCode).length} mã có chứng từ`);
  for (const o of orders) {
    const sentence = describeOrder(o, view);
    console.log(`đơn ${o.id} (đầy đủ): ${sentence}`);
    tomTat(publicLine(sentence));
  }
}

main().catch((e) => {
  console.error("bot-order-describe lỗi:", e instanceof Error ? e.message : e);
  tomTat("bot-order-describe: LỖI — chi tiết trong phần mã hoá");
  process.exitCode = 1;
});
