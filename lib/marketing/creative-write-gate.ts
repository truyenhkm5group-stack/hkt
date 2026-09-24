import type { AdsWriteMode } from "@/lib/constants/ads-write";
import { CREATIVE_HARD_LIMITS, CREATIVE_WRITE_DENIAL_REASON, type CreativeWriteAction, type CreativeWriteDenial } from "@/lib/constants/creative-loop";

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
 *   → WRONG_CAMPAIGN → NOT_OUR_AD (tắt · tiêu thêm) → TOO_LATE (tạo)
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

const CREATE_ACTIONS: readonly CreativeWriteAction[] = ["UPLOAD_IMAGE", "CREATE_CREATIVE", "CREATE_ADSET", "CREATE_AD"];

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
  if (i.targetCampaignId !== null && i.targetCampaignId !== i.testCampaignId) {
    return deny("WRONG_CAMPAIGN", `(Nhắm vào ${i.targetCampaignId}, chiến dịch test là ${i.testCampaignId}.)`);
  }
  if (tao && i.templateCampaignId !== i.testCampaignId) {
    return deny("WRONG_CAMPAIGN", i.templateCampaignId === null ? "(Không đọc được mẩu mẫu thuộc chiến dịch nào.)" : `(Mẩu mẫu nằm ở chiến dịch ${i.templateCampaignId}.)`);
  }

  if ((tat || them) && !i.ourAdset) return deny("NOT_OUR_AD");

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
