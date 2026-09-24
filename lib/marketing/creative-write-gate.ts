import type { AdsWriteMode } from "@/lib/constants/ads-write";
import {
  CREATIVE_HARD_LIMITS,
  CREATIVE_WRITE_DENIAL_REASON,
  SCALE_ELIGIBLE_VERDICTS,
  type CreativeVerdict,
  type CreativeWriteAction,
  type CreativeWriteDenial,
  type ScaleWriteAction,
} from "@/lib/constants/creative-loop";

/**
 * ═══════════ CỔNG GHI CỦA VÒNG MẪU — HÀM THUẦN, CÙNG TINH THẦN `gateAdsWrite` ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §2–§3. Mẫu thiết kế: `lib/marketing/ads-write-gate.ts`.
 *
 * Không đọc CSDL, không đọc đồng hồ (giờ hiện tại là THAM SỐ), không gọi mạng, không đọc biến môi
 * trường — nơi gọi đọc `adsWriteHardEnabled()` / `adsWriteMode()` rồi truyền xuống. Vào là một bản
 * khai tình trạng, ra là CHO hay KHÔNG kèm mã chặn. Nhờ vậy mọi tổ hợp chặn được kiểm bằng vài dòng
 * chữ, không cần Facebook.
 *
 * ─── HÀM NÀY KHÔNG PHẢI HÀNG RÀO CUỐI CÙNG ───
 *
 * Ba lớp chặn tiêu quá, độc lập nhau (§3): (a) cổng này từ chối trước khi gọi · (b) nhóm test mang
 * ngân sách TRỌN ĐỜI + `end_time`, Facebook tự dừng kể cả khi ERP chết · (c) `graphPost` đọc LẠI
 * `ADS_WRITE_ENABLED` ngay trước lời gọi mạng. Cổng tin bản khai của nơi gọi; lớp (c) thì không.
 *
 * ─── THỨ TỰ CÁC CHỐT LÀ MỘT PHẦN CỦA THIẾT KẾ (bài kiểm khoá nó) ───
 *
 *   HARD_DISABLED → MODE_OFF → CONFIG_INCOMPLETE
 *   → NOT_APPROVED → APPROVAL_MISMATCH (tạo · tiêu thêm)
 *   → WRONG_CAMPAIGN → NOT_OUR_AD (tắt · tiêu thêm · bật chiến dịch riêng) → TOO_LATE (tạo)
 *   → OVER_VARIANT_BUDGET → OVER_BATCH_SIZE → OVER_DAILY_CAP (tạo, khi mẫu chưa có nhóm)
 *   → NO_KILL_RULE (máy tắt theo luật) → NOT_PROMISING → OVER_EXTENSION_CAP (tiêu thêm)
 *
 * Chốt cứng env đứng trước tất cả: câu trả lời cho *"có tổ hợp cấu hình nào lỡ tiêu tiền thật
 * không"* là KHÔNG, vì nhánh đầu tiên không đọc gì ngoài một biến môi trường. Phiếu duyệt đứng trước
 * chiến dịch và tiền: chưa ai cho phép thì hỏi tiếp "tiêu vào đâu, bao nhiêu" là vô nghĩa.
 */

/**
 * Ai tắt, vì sao. Ba đường, ba căn cứ:
 *  · `KILL_RULE` — máy tắt theo một luật tắt mà lượt duyệt lô đã khoá sẵn. Phải có luật kích hoạt.
 *  · `HUMAN`     — người bấm tắt tay. Không cần luật: người là căn cứ.
 *  · `CLEANUP`   — máy dọn một nhóm do CHÍNH nó vừa tạo mà đăng dở (tạo mẩu hỏng / quá giờ).
 * Cả ba chỉ làm GIẢM tiền, nên không đụng trần tiền nào.
 */
export type CreativePauseKind = "KILL_RULE" | "HUMAN" | "CLEANUP";

export type CreativeGateInput = {
  /** `ADS_WRITE_ENABLED` đọc THẲNG từ biến môi trường ở tầng gọi. */
  hardEnabled: boolean;
  /** Nấc ĐÃ kẹp bằng `clampAdsWriteMode`. Vòng mẫu chỉ chạy ở `COPILOT`. */
  mode: AdsWriteMode;
  action: CreativeWriteAction;
  /** Đủ bốn trường đăng (fanpage · tài khoản · chiến dịch test · mẩu mẫu). */
  configComplete: boolean;
  /**
   * Có căn cứ cho phép chưa — nghĩa theo hành động:
   *  · tạo (tải ảnh · bài · nhóm · mẩu): lô `APPROVED` và có `approval_digest`;
   *  · tiêu thêm: người đã bấm với một phiếu hợp lệ;
   *  · máy tắt theo luật / dọn dẹp: lô có `approval_digest` (lượt duyệt đã khoá bộ luật tắt);
   *  · người tắt tay: người đã bấm xác nhận.
   */
  approved: boolean;
  /** Digest tính lại từ CSDL khớp `approval_digest` (tạo · tiêu thêm). */
  approvalMatches: boolean;
  testCampaignId: string;
  /** Chiến dịch mà lượt ghi nhắm tới. Tạo nhóm: BẮT BUỘC có. Tắt / tiêu thêm: `null` = không đọc (bỏ qua). */
  targetCampaignId: string | null;
  /** Chiến dịch của mẩu mẫu (chỉ xét khi tạo). `null` = không đọc được ⇒ không chứng minh được ⇒ chặn. */
  templateCampaignId: string | null;
  /**
   * CHIẾN DỊCH RIÊNG mà vòng đã tạo cho CHÍNH mẫu này (mỗi bài một chiến dịch, §5i) — đọc từ
   * `creative_variants.fb_campaign_id`. Tạo nhóm vào đúng chiến dịch này là hợp lệ như vào chiến dịch
   * test; bật chiến dịch CHỈ được với đúng id này. Vắng / `null` = mẫu chưa có chiến dịch riêng.
   */
  ownCampaignId?: string | null;
  /** Tắt / tiêu thêm: nhóm này có trong `creative_variants` (do vòng tạo) không. */
  ourAdset: boolean;
  now: Date;
  /** Giờ bắt đầu chạy của lô. */
  startAt: Date;
  /** Ngân sách trọn đời một mẫu — lấy từ ẢNH CHỤP cấu hình của lô, chưa kẹp. */
  budgetPerVariantVnd: number;
  /** Số mẫu của lô ĐÃ có nhóm (không tính mẫu đang xét, không tính mẫu đăng lỗi). */
  publishedInBatch: number;
  batchSize: number;
  /** Tổng tiền test đã cam kết cho ngày chạy — đếm trên SỔ `creative_fb_actions`, không trên cấu hình. */
  committedDayVnd: number;
  /** Mẫu đang xét đã có nhóm chưa. Có rồi ⇒ tiền đã được tính lúc tạo nhóm, bước tạo mẩu không đếm lại. */
  variantHasAdset: boolean;
  pauseKind: CreativePauseKind | null;
  /** Máy tắt theo luật: có luật tắt nào CỦA ẢNH CHỤP LÔ kích hoạt không. */
  killRuleFired: boolean;
  /** Tiêu thêm: mẫu đang ở phán quyết `PROMISING` theo luật giữ. */
  promising: boolean;
  /** Tiêu thêm: số tiền xin cộng thêm lượt này. */
  extensionVnd: number;
  /** Tiêu thêm: tổng đã cộng hôm nay, toàn shop (đếm trên sổ). */
  extendedTodayVnd: number;
};

export type CreativeGateResult = { ok: true } | { ok: false; denial: CreativeWriteDenial; reason: string };

/**
 * Hành động TẠO của đường đăng. `CREATE_CAMPAIGN` (chiến dịch riêng, TẮT) và `ACTIVATE_CAMPAIGN` (công tắc
 * tổng, bước cuối) đứng chung nhóm: cùng đòi lô đã duyệt + digest khớp, cùng bị chặn sau giờ chạy.
 */
const CREATE_ACTIONS: readonly CreativeWriteAction[] = ["UPLOAD_IMAGE", "CREATE_CREATIVE", "CREATE_CAMPAIGN", "CREATE_ADSET", "CREATE_AD", "ACTIVATE_CAMPAIGN"];

export function isCreateAction(a: CreativeWriteAction): boolean {
  return CREATE_ACTIONS.includes(a);
}

function deny(denial: CreativeWriteDenial, extra = ""): CreativeGateResult {
  return { ok: false, denial, reason: extra ? `${CREATIVE_WRITE_DENIAL_REASON[denial]} ${extra}` : CREATIVE_WRITE_DENIAL_REASON[denial] };
}

const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;

export type CreativeGatePrefixInput = Pick<CreativeGateInput, "hardEnabled" | "mode" | "action" | "configComplete" | "approved" | "approvalMatches">;

/**
 * NĂM CHỐT ĐẦU — chỉ cần những gì đã có trong CSDL và biến môi trường.
 *
 * Nơi gọi dùng nó để quyết có nên ĐỌC mẩu mẫu trên Facebook hay không: đường ghi đang tắt hoặc lô
 * chưa duyệt thì không tiêu một lượt gọi API nào. `gateCreativeWrite` gọi lại CHÍNH hàm này ở đầu,
 * nên hai đường không thể lệch thứ tự.
 */
export function gateCreativeWritePrefix(i: CreativeGatePrefixInput): CreativeGateResult {
  if (!i.hardEnabled) return deny("HARD_DISABLED");
  // Vòng mẫu chạy ĐÚNG nấc COPILOT (chủ shop chốt 24/09). `AUTO` đã bị kẹp xuống ở hằng số; mọi giá
  // trị khác COPILOT đều là "không được ghi", không phải "ghi theo kiểu khác".
  if (i.mode !== "COPILOT") return deny("MODE_OFF");
  if (!i.configComplete) return deny("CONFIG_INCOMPLETE");
  if (!i.approved) return deny("NOT_APPROVED");
  if ((isCreateAction(i.action) || i.action === "EXTEND_ADSET") && !i.approvalMatches) return deny("APPROVAL_MISMATCH");
  return { ok: true };
}

export function gateCreativeWrite(i: CreativeGateInput): CreativeGateResult {
  const prefix = gateCreativeWritePrefix(i);
  if (!prefix.ok) return prefix;

  const tao = isCreateAction(i.action);
  const tat = i.action === "PAUSE_ADSET";
  const them = i.action === "EXTEND_ADSET";

  /*
    CHỈ BÊN TRONG CHIẾN DỊCH TEST DO NGƯỜI DỰNG.

    Hai câu hỏi, cùng một mã chặn: lượt ghi này nhắm vào chiến dịch nào, và mẩu mẫu mà máy chép đối
    tượng từ đó nằm ở chiến dịch nào. Mẩu mẫu dời sang một chiến dịch thật của marketer thì mọi nhóm
    máy tạo sẽ chép đúng đối tượng của chiến dịch ấy — nên câu thứ hai quan trọng ngang câu thứ nhất.
  */
  if (i.action === "CREATE_ADSET" && i.targetCampaignId === null) return deny("WRONG_CAMPAIGN", "(Không biết lượt tạo nhóm nhắm vào chiến dịch nào.)");
  // Chiến dịch RIÊNG của chính mẫu này (mỗi bài một chiến dịch, §5i) đứng ngang chiến dịch test.
  const own = i.ownCampaignId ?? null;
  const ourCampaign = own !== null && own !== "" && i.targetCampaignId === own;
  if (i.targetCampaignId !== null && i.targetCampaignId !== i.testCampaignId && !ourCampaign) {
    return deny("WRONG_CAMPAIGN", `(Nhắm vào ${i.targetCampaignId}, chiến dịch test là ${i.testCampaignId}${own ? `, chiến dịch riêng của bài là ${own}` : ""}.)`);
  }
  if (tao && i.templateCampaignId !== i.testCampaignId) {
    return deny("WRONG_CAMPAIGN", i.templateCampaignId === null ? "(Không đọc được mẩu mẫu thuộc chiến dịch nào.)" : `(Mẩu mẫu nằm ở chiến dịch ${i.templateCampaignId}.)`);
  }

  if ((tat || them) && !i.ourAdset) return deny("NOT_OUR_AD");
  // Bật: chỉ đúng chiến dịch riêng vòng đã tạo cho chính mẫu này — không bao giờ chiến dịch test chung.
  if (i.action === "ACTIVATE_CAMPAIGN" && !ourCampaign) return deny("NOT_OUR_AD", "(Chỉ bật được chiến dịch riêng vòng mẫu đã tạo cho chính bài này.)");

  // Đăng sau giờ chạy là chạy một khung ngắn hơn khung đã duyệt: số đo không so được với cả lô.
  if (tao && i.now.getTime() >= i.startAt.getTime()) return deny("TOO_LATE");

  /*
    TIỀN MỚI CHỈ PHÁT SINH Ở MẪU CHƯA CÓ NHÓM.

    Tải ảnh và tạo bài không tốn tiền quảng cáo, nhưng chúng là bước dẫn tới một nhóm: đã biết nhóm
    sẽ bị chặn thì tải ảnh trước cũng chỉ để lại rác trên tài khoản. Nên ba trần tiền xét cho mọi
    bước tạo của một mẫu CHƯA có nhóm — và bỏ qua ở bước tạo mẩu của mẫu đã có nhóm (tiền đã tính).
  */
  if (tao && !i.variantHasAdset) {
    const b = i.budgetPerVariantVnd;
    if (!Number.isInteger(b) || b <= 0) return deny("OVER_VARIANT_BUDGET", `(Ngân sách một mẫu không hợp lệ: ${String(b)}.)`);
    if (b > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) return deny("OVER_VARIANT_BUDGET", `(Xin ${vnd(b)}.)`);
    const tran = Math.min(i.batchSize, CREATIVE_HARD_LIMITS.maxBatchSize);
    if (i.publishedInBatch >= tran) return deny("OVER_BATCH_SIZE", `(Đã đăng ${i.publishedInBatch}/${tran}.)`);
    if (i.committedDayVnd + b > CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd) {
      return deny("OVER_DAILY_CAP", `(Sổ đã ghi ${vnd(i.committedDayVnd)} cho ngày chạy, xin thêm ${vnd(b)}.)`);
    }
  }

  // Máy tắt theo luật: phải có một luật TẮT của ảnh chụp lô kích hoạt. Người tắt tay và dọn dẹp thì không.
  if (tat && (i.pauseKind ?? "KILL_RULE") === "KILL_RULE" && !i.killRuleFired) return deny("NO_KILL_RULE");

  if (them) {
    if (!i.promising) return deny("NOT_PROMISING");
    const e = i.extensionVnd;
    if (!Number.isInteger(e) || e <= 0) return deny("OVER_EXTENSION_CAP", `(Số tiền xin thêm không hợp lệ: ${String(e)}.)`);
    if (e > CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd) return deny("OVER_EXTENSION_CAP", `(Một lượt xin ${vnd(e)}, trần ${vnd(CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd)}.)`);
    if (i.extendedTodayVnd + e > CREATIVE_HARD_LIMITS.maxDailyExtensionVnd) {
      return deny("OVER_EXTENSION_CAP", `(Hôm nay đã cho thêm ${vnd(i.extendedTodayVnd)}, trần ngày ${vnd(CREATIVE_HARD_LIMITS.maxDailyExtensionVnd)}.)`);
    }
  }

  return { ok: true };
}

/* ═══════════ CỔNG CỦA NGOẠI LỆ SCALE MẪU THẮNG (§5g) — HÀM THUẦN ═══════════
 *
 * Sáu hành động `*_SCALE*` không đi qua `gateCreativeWrite`: chúng không có lô, không có khung test,
 * không có mẩu mẫu — chúng có CHIẾN DỊCH MẪU, PHÁN QUYẾT của mẫu thắng, và PHIẾU BẬT. Cùng tinh thần:
 * không đọc CSDL, không đọc đồng hồ, không gọi mạng, không đọc env — nơi gọi truyền mọi thứ xuống.
 *
 * ─── THỨ TỰ CÁC CHỐT (bài kiểm `tests/creative-scale.test.ts` khoá nó) ───
 *
 *   HARD_DISABLED → MODE_OFF → CONFIG_INCOMPLETE → NOT_APPROVED → APPROVAL_MISMATCH (bật)
 *   → NOT_SCALE_TEMPLATE (sao chép) → NOT_OUR_AD (mọi bước sau sao chép)
 *   → [TẮT dừng ở đây: chỉ làm GIẢM tiền] → NOT_WINNER → SCALE_DUPLICATE (sao chép)
 *   → OVER_SCALE_BUDGET (sao chép · đặt ngân sách · bật) → OVER_SCALE_DAILY_CAP (bật)
 *
 * Chốt env + nấc COPILOT đứng ĐẦU: câu trả lời cho "có tổ hợp nào lỡ bật một chiến dịch thật không"
 * vẫn là KHÔNG ở nhánh đầu tiên. Phiếu đứng trước nguồn và tiền (chưa ai cho phép thì hỏi "sao chép gì,
 * bao nhiêu" là vô nghĩa). Nguồn đứng trước phán quyết: sao chép nhầm một chiến dịch của marketer là
 * lỗi nặng hơn scale một mẫu chưa đủ căn cứ.
 */

export type ScaleGateInput = {
  /** `ADS_WRITE_ENABLED` đọc THẲNG từ biến môi trường ở tầng gọi. */
  hardEnabled: boolean;
  /** Nấc ĐÃ kẹp bằng `clampAdsWriteMode`. Chỉ `COPILOT` được ghi. */
  mode: AdsWriteMode;
  action: ScaleWriteAction;
  /** Đã khai tài khoản QC + fanpage + chiến dịch mẫu của loại này. */
  configComplete: boolean;
  /**
   * Có căn cứ cho phép chưa:
   *  · dựng nháp (sao chép · tạo bài · gắn bài · đặt ngân sách): NGƯỜI đã bấm "Dựng nháp" (mọi thứ vẫn TẮT);
   *  · bật: phiếu HMAC hợp lệ của CHÍNH người bấm;
   *  · tắt: người đã bấm xác nhận.
   */
  approved: boolean;
  /** Bật: chiến dịch · ngân sách · bài tính lại từ CSDL VÀ đọc lại từ Facebook khớp đúng phiếu. */
  approvalMatches: boolean;
  /** Sao chép: id chiến dịch sẽ bị sao chép. */
  sourceCampaignId: string | null;
  /** Id chiến dịch mẫu đã khai cho loại này (rỗng = chưa khai). */
  templateCampaignId: string;
  /** Mọi bước SAU sao chép: đối tượng nhắm tới là của bản sao đã ghi trong nháp. */
  ourCopy: boolean;
  /** Phán quyết SỐNG của mẫu gốc. */
  verdict: CreativeVerdict;
  /** Sao chép: dòng nháp này đã từng thử sao chép (có `copy_attempted_at` / id bản sao). */
  alreadyCopied: boolean;
  /** Sao chép: số nháp KHÁC của cùng mẫu đã thử sao chép. */
  otherDraftsForVariant: number;
  /** Ngân sách ngày (VND) của chiến dịch này — chưa kẹp. */
  budgetVnd: number;
  /** Bật: tổng ngân sách ngày của các chiến dịch scale KHÁC đang bật (`ACTIVE`). */
  activeTotalVnd: number;
};

const SCALE_DRAFT_ACTIONS: readonly ScaleWriteAction[] = ["COPY_SCALE_CAMPAIGN", "CREATE_SCALE_CREATIVE", "SET_SCALE_AD_CREATIVE", "SET_SCALE_BUDGET"];

export function isScaleDraftAction(a: ScaleWriteAction): boolean {
  return SCALE_DRAFT_ACTIONS.includes(a);
}

export function gateScaleWrite(i: ScaleGateInput): CreativeGateResult {
  if (!i.hardEnabled) return deny("HARD_DISABLED");
  if (i.mode !== "COPILOT") return deny("MODE_OFF");
  if (!i.configComplete) return deny("CONFIG_INCOMPLETE", "(Thiếu tài khoản QC / fanpage / chiến dịch mẫu của loại này.)");
  if (!i.approved) return deny("NOT_APPROVED", i.action === "ACTIVATE_SCALE" ? "(Bật chiến dịch scale cần phiếu duyệt của chính người bấm.)" : "");
  if (i.action === "ACTIVATE_SCALE" && !i.approvalMatches) return deny("APPROVAL_MISMATCH", "(Chiến dịch nháp, ngân sách hoặc bài quảng cáo đã khác lúc phát phiếu.)");

  const copy = i.action === "COPY_SCALE_CAMPAIGN";
  if (copy) {
    if (!i.templateCampaignId || i.sourceCampaignId !== i.templateCampaignId) {
      return deny("NOT_SCALE_TEMPLATE", `(Xin sao chép ${i.sourceCampaignId ?? "∅"}, mẫu đã khai ${i.templateCampaignId || "∅"}.)`);
    }
  } else if (!i.ourCopy) {
    return deny("NOT_OUR_AD", "(Đối tượng này không phải bản sao do vòng mẫu dựng cho nháp scale này.)");
  }

  // TẮT chỉ làm GIẢM tiền: không phán quyết, không trần nào được giữ tiền chảy.
  if (i.action === "PAUSE_SCALE") return { ok: true };

  if (!SCALE_ELIGIBLE_VERDICTS.includes(i.verdict)) return deny("NOT_WINNER", `(Phán quyết hiện tại: ${i.verdict}.)`);

  if (copy && (i.alreadyCopied || i.otherDraftsForVariant >= CREATIVE_HARD_LIMITS.maxScaleDraftsPerVariant)) {
    return deny("SCALE_DUPLICATE", i.alreadyCopied ? "(Nháp này đã từng sao chép.)" : `(Mẫu đã có ${i.otherDraftsForVariant} nháp.)`);
  }

  if (copy || i.action === "SET_SCALE_BUDGET" || i.action === "ACTIVATE_SCALE") {
    const b = i.budgetVnd;
    if (!Number.isInteger(b) || b <= 0) return deny("OVER_SCALE_BUDGET", `(Ngân sách không hợp lệ: ${String(b)}.)`);
    if (b > CREATIVE_HARD_LIMITS.maxScaleDailyBudgetVnd) return deny("OVER_SCALE_BUDGET", `(Xin ${vnd(b)}/ngày.)`);
  }

  if (i.action === "ACTIVATE_SCALE" && i.activeTotalVnd + i.budgetVnd > CREATIVE_HARD_LIMITS.maxScaleActiveDailyTotalVnd) {
    return deny("OVER_SCALE_DAILY_CAP", `(Đang bật ${vnd(i.activeTotalVnd)}/ngày, xin thêm ${vnd(i.budgetVnd)}.)`);
  }

  return { ok: true };
}
