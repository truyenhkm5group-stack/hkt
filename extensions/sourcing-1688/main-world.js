/*
 * Chạy TRONG trang (world MAIN) — chỉ ở đây đọc được biến `window.context` mà 1688 nhúng sẵn. Không tự làm gì: chỉ trả lời khi
 * content.js hỏi (sau khi NGƯỜI bấm nút), và chỉ trả các nhánh trong danh sách CHO PHÉP dưới đây — nhánh người xem (buyerModel,
 * loginId, *Sign, token…) không bao giờ rời trang. Không đọc chữ hiển thị trên trang: bản dịch của trình duyệt sửa chữ hiển thị,
 * không sửa dữ liệu này.
 *
 * GIỮ Y HỆT `PICK_PATHS_1688` trong lib/sourcing/capture-1688.ts — bài kiểm tests/sourcing-capture.test.ts so hai danh sách.
 */
(() => {
  const PICK_PATHS = [
    "result.data.gallery.fields.subject",
    "result.data.gallery.fields.mainImage",
    "result.data.Root.fields.dataJson.tempModel.offerId",
    "result.data.Root.fields.dataJson.tempModel.offerTitle",
    "result.data.Root.fields.dataJson.tempModel.companyName",
    "result.data.Root.fields.dataJson.offerBaseInfo.sellerWinportUrl",
    "result.data.Root.fields.dataJson.skuModel.skuProps",
    "result.data.Root.fields.dataJson.skuModel.skuInfoMap",
    "result.data.Root.fields.dataJson.skuModel.skuInfoMapOriginal",
    "result.data.Root.fields.dataJson.orderParamModel.orderParam.beginNum",
    "result.data.Root.fields.dataJson.orderParamModel.orderParam.skuParam",
    "result.data.mainPrice.fields.priceModel.currentPrices",
    "result.data.mainPrice.fields.priceModel.originalPrices",
    "result.data.mainPrice.fields.finalPriceModel.onHandPrice",
    "result.data.mainPrice.fields.finalPriceModel.onHandPriceTypeText",
    "result.data.mainPrice.fields.finalPriceModel.tradeWithoutPromotion.offerBeginAmount",
    "result.data.mainPrice.fields.finalPriceModel.tradeWithoutPromotion.offerPriceRanges",
    "result.data.productTitle.fields.shopInfo.companyName",
    "result.data.productTitle.fields.shopInfo.byrRepeatRate3m",
    "result.data.productTitle.fields.shopInfo.sellerSlrServiceScore",
    "result.data.productTitle.fields.rateInfo.goodRates",
    "result.data.shippingServices.fields.location",
    "result.data.shippingServices.fields.deliveryLimitText",
    "result.data.productPackInfo.fields.unitWeight",
    "result.global.globalData.model.consignModel.hasConsignPrice",
  ];

  function pick(root, path) {
    let o = root;
    for (const k of path.split(".")) {
      if (!o || typeof o !== "object" || Array.isArray(o) || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
      o = o[k];
    }
    return o;
  }

  window.addEventListener("vnx-sourcing:request", (ev) => {
    const nonce = ev && ev.detail && typeof ev.detail.nonce === "string" ? ev.detail.nonce : null;
    if (!nonce) return;
    const ctx = window.context;
    const picks = {};
    let found = false;
    if (ctx && typeof ctx === "object") {
      for (const p of PICK_PATHS) {
        const v = pick(ctx, p);
        if (v !== undefined) {
          // Sao qua JSON: chỉ dữ liệu thuần, không hàm, không tham chiếu tới đối tượng của trang.
          picks[p] = JSON.parse(JSON.stringify(v));
          found = true;
        }
      }
    }
    window.dispatchEvent(new CustomEvent("vnx-sourcing:response", { detail: JSON.stringify({ nonce, found, picks }) }));
  });
})();
