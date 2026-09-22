/**
 * ═══════════ BẬC THANG TỰ CHỦ — LÊN BẰNG SỐ ĐO, XUỐNG TỰ ĐỘNG ═══════════
 *
 * `AgentMode` (`lib/constants/ai.ts`) khai MÁY ĐƯỢC PHÉP LÀM GÌ. Sổ này khai thứ còn thiếu, và
 * là thứ duy nhất làm cho "phòng Sales AI tự vận hành, chủ shop không phải can thiệp" trở thành
 * một câu an toàn thay vì một canh bạc: **máy được lên bậc theo điều kiện nào, và tự tụt xuống
 * khi nào.**
 *
 * ─── VÌ SAO PHANH PHẢI TỰ ĐỘNG ───
 *
 * "Không cần chủ shop can thiệp" có hai nghĩa, và chúng đối nghịch nhau:
 *
 *   · chủ shop không phải bấm từng tin  — thứ anh muốn;
 *   · chủ shop không nhìn thấy khi hỏng — thứ giết một shop.
 *
 * Một hệ tự chạy mà chỉ có người mới hạ được bậc của nó thì nghĩa thứ hai đã xảy ra: đúng vào
 * lúc nó cần bị dừng là lúc không ai đang nhìn. Nên PHANH phải là hàm thuần của số đo, đọc ra
 * lúc xem, và luôn được quyền TỤT — hệt như luật 26 làm với leo thang SLA: chỉ NÂNG mức khẩn,
 * ở đây chỉ HẠ mức quyền.
 *
 * Bất đối xứng là cố ý và không được phép làm ngược:
 *   LÊN bậc  — cần NGƯỜI bấm, cần đủ mẫu, cần mọi cổng xanh. Chậm, và đúng là phải chậm.
 *   XUỐNG bậc — MÁY tự làm, ngay khi một cổng đỏ, không đợi ai.
 *
 * ─── VÌ SAO KHÔNG CÓ NGƯỠNG MẶC ĐỊNH CHO "ĐẠT" ───
 *
 * Có, và đó là khác biệt với luật 38 (đích kinh doanh không được hard-code). Ngưỡng ở đây KHÔNG
 * phải đích kinh doanh — chúng là **điều kiện an toàn để trao quyền cho một cái máy nhắn tin với
 * người lạ**. Một cái đích doanh thu sai thì báo cáo xấu; một ngưỡng an toàn sai thì khách nhận
 * tin bịa. Nên chúng nằm trong mã nguồn, đi qua cổng kiểm thử, và đổi phải có commit.
 */
import type { AgentMode } from "@/lib/constants/ai";

/**
 * Bốn nấc, và ba trong bốn nấc ấy đã tồn tại ở `AgentMode`. Sổ này KHÔNG phát minh nấc mới —
 * nó gắn ĐIỀU KIỆN vào các nấc đã có. Khai một nấc thứ năm ở đây mà `AgentMode` không có là
 * cách chắc chắn nhất để màn hình và máy tính quyền nói hai chuyện khác nhau.
 */
export const AUTONOMY_RUNGS: AgentMode[] = ["OFF", "SHADOW", "COPILOT", "AUTO"];

export type AutonomyGate = {
  /** Khoá ổn định — đi vào ghi chú kiểm toán, đừng đổi. */
  key: string;
  label: string;
  /** Câu hỏi cổng này trả lời, viết cho người đọc chứ không cho máy. */
  asks: string;
  /**
   * Vì sao cổng này tồn tại. Một cổng không giải thích được lý do là một cổng sẽ bị ai đó nới
   * ra vào một chiều thứ Sáu để "cho nó chạy".
   */
  why: string;
};

/**
 * SÁU CỔNG. Mỗi cổng trả lời một câu hỏi khác nhau, và không cổng nào thay được cổng khác —
 * đó là lý do chúng không được gộp thành một điểm tổng. Gộp lại thì một cổng đỏ bị ba cổng xanh
 * che mất, đúng lúc cái đỏ mới là cái đáng đọc (cùng lý do luật 52 tách bốn câu hỏi về webhook).
 */
export const AUTONOMY_GATES: AutonomyGate[] = [
  {
    key: "SAMPLE",
    label: "Đủ mẫu để kết luận",
    asks: "Đã có bao nhiêu lượt để nhìn?",
    why: "Mười lượt đúng không nói gì về lượt thứ mười một. Dưới ngưỡng mẫu thì mọi tỷ lệ bên dưới là CHƯA ĐỦ DỮ LIỆU, không phải ĐẠT.",
  },
  {
    key: "HUMAN_GRADED",
    label: "Người đã chấm tay",
    asks: "Có bao nhiêu lượt được NGƯỜI mở ra xem và cho điểm?",
    why: "Năm chiều chất lượng (hiểu đúng ý, đúng sản phẩm, đúng giọng) không có nguồn sự thật nào trong ERP. Máy không tự chấm được, và tuyệt đối không lấy chính mô hình đang đo làm giám khảo.",
  },
  {
    key: "NO_FABRICATION",
    label: "Không lượt nào bịa",
    asks: "Có lượt nào bị chấm là bịa đặt hoặc phá luật nghiệp vụ không?",
    why: "Đây là cổng DUY NHẤT có ngưỡng tuyệt đối. Một câu bịa giá hoặc hứa hàng không có là một khách mất niềm tin — không có tỷ lệ nào của nó là chấp nhận được.",
  },
  {
    key: "USABLE_RATE",
    label: "Tỷ lệ dùng được",
    asks: "Bao nhiêu phần câu máy soạn được gửi nguyên văn hoặc chỉ sửa nhẹ?",
    why: "Đo cái máy làm được, chứ không đo cái máy tránh được. Một máy luôn chuyển người có 0 lỗi và 0 giá trị.",
  },
  {
    key: "COST_KNOWN",
    label: "Chi phí đo được",
    asks: "Mọi lượt gọi mô hình trong kỳ có định giá được không?",
    why: "Chưa khai đơn giá thì chi phí mỗi đơn là CHƯA BIẾT, và trao quyền tự chạy cho một thứ chưa biết tốn bao nhiêu là ký một tờ séc trắng.",
  },
  {
    key: "SAFETY_SWITCHES",
    label: "Chặn cứng còn nguyên",
    asks: "Các công tắc chặn cứng ở tầng môi trường có đúng như khai không?",
    why: "Nấc trong CSDL chỉ là lời xin phép. Nếu chặn cứng đã bị nới ra bằng tay ở đâu đó, cả bậc thang này thành trang trí.",
  },
];

/** Ngưỡng để LÊN một nấc. Nấc càng cao càng đòi nhiều — và `AUTO` đòi cả những thứ chưa có. */
export type RungRequirement = {
  /** Số lượt tối thiểu trong kỳ đo. */
  minSample: number;
  /** Số lượt phải được NGƯỜI chấm tay. */
  minHumanGraded: number;
  /** Tỷ lệ dùng được tối thiểu (0..1). `null` = cổng này chưa áp cho nấc ấy. */
  minUsableRate: number | null;
  /** Số lượt bị chấm là bịa / phá luật được phép. Luôn là 0 từ COPILOT trở lên. */
  maxFabrications: number;
  /** Chi phí mỗi lượt có bắt buộc đo được không. */
  requireKnownCost: boolean;
};

/**
 * `OFF` và `SHADOW` không có điều kiện vào: chúng không chạm tới khách. `COPILOT` bắt đầu có
 * điều kiện vì một NGƯỜI sẽ đọc rồi bấm gửi. `AUTO` là nấc duy nhất mà một câu chữ tới người lạ
 * mà không ai đọc trước — nên nó đòi gấp ba mẫu và tuyệt đối không lượt bịa nào.
 */
export const RUNG_REQUIREMENTS: Partial<Record<AgentMode, RungRequirement>> = {
  COPILOT: { minSample: 30, minHumanGraded: 30, minUsableRate: 0.7, maxFabrications: 0, requireKnownCost: false },
  AUTO: { minSample: 300, minHumanGraded: 100, minUsableRate: 0.9, maxFabrications: 0, requireKnownCost: true },
};

/**
 * ĐIỀU KIỆN TỤT BẬC — đọc ra lúc xem, KHÔNG ghi vào CSDL.
 *
 * Cùng lý do luật 26 giữ leo thang SLA là hàm thuần: mức phanh là hàm của số đo, nên nó luôn
 * đúng tới từng giây, tốn 0 dòng bảng, và không có cách nào để một dòng cũ trong CSDL nói rằng
 * mọi thứ vẫn ổn trong khi số đo hiện tại nói ngược lại.
 *
 * Ngưỡng tụt LỎNG HƠN ngưỡng lên (0,5 so với 0,7) là cố ý: nếu hai ngưỡng bằng nhau thì hệ sẽ
 * rung — lên, tụt, lên, tụt quanh đúng một con số — và mỗi lần rung là một lần đổi hành vi với
 * khách thật.
 */
export const DEMOTION_TRIGGERS = {
  /** Một lượt bị chấm là bịa ⇒ tụt ngay, không cần lượt thứ hai. */
  anyFabrication: true,
  /** Tỷ lệ dùng được rơi dưới mức này (trên mẫu đủ lớn) ⇒ tụt. */
  usableRateFloor: 0.5,
  /** Mẫu tối thiểu để một tỷ lệ tồi được coi là bằng chứng, chứ không phải xui. */
  minSampleToDemote: 20,
  /** Vượt trần chi phí ngày ⇒ tụt về SHADOW: vẫn học được, mà không tiêu thêm đường gửi. */
  demoteOnCostCap: true,
} as const;

export const DEMOTION_REASONS = ["FABRICATION", "USABLE_RATE_FLOOR", "COST_CAP", "COST_UNKNOWN", "HARD_LIMIT_MISMATCH"] as const;
export type DemotionReason = (typeof DEMOTION_REASONS)[number];

export const DEMOTION_REASON_LABEL: Record<DemotionReason, string> = {
  FABRICATION: "Có lượt bị chấm là bịa đặt hoặc phá luật",
  USABLE_RATE_FLOOR: "Tỷ lệ dùng được rơi dưới sàn",
  COST_CAP: "Chạm trần chi phí mỗi ngày",
  COST_UNKNOWN: "Chi phí không đo được — chưa khai đơn giá mô hình",
  HARD_LIMIT_MISMATCH: "Nấc trong CSDL không khớp chặn cứng ở tầng môi trường",
};

/** Nấc ngay dưới. `OFF` không tụt được nữa. HÀM THUẦN. */
export function rungBelow(mode: AgentMode): AgentMode {
  const i = AUTONOMY_RUNGS.indexOf(mode);
  return i <= 0 ? "OFF" : AUTONOMY_RUNGS[i - 1];
}

export type AutonomyReading = {
  /** Số lượt trong kỳ đo. */
  sample: number;
  /** Số lượt NGƯỜI đã chấm. */
  humanGraded: number;
  /** Số lượt bị chấm là bịa / phá luật. */
  fabrications: number;
  /** Tỷ lệ dùng được, `null` khi mẫu số rỗng — KHÔNG phải 0. */
  usableRate: number | null;
  /** Số lượt gọi mô hình chưa định giá được. > 0 ⇒ chi phí là CHƯA BIẾT. */
  unpricedCalls: number;
  /** Đã chạm trần chi phí ngày chưa. */
  costCapHit: boolean;
  /** Chặn cứng ở môi trường có khớp nấc đang khai không. */
  hardLimitsConsistent: boolean;
};

export type AutonomyVerdict = {
  /** Nấc máy PHẢI chạy ở, sau khi áp phanh. Không bao giờ cao hơn nấc đang khai. */
  effective: AgentMode;
  /** Có bị phanh không, và vì sao. Rỗng = không phanh. */
  demotedBy: DemotionReason[];
  /** Nấc kế tiếp có mở được không — và nếu không thì thiếu cổng nào. */
  nextRung: AgentMode | null;
  blocking: string[];
};

/**
 * PHANH + CỔNG LÊN BẬC, MỘT HÀM THUẦN.
 *
 * Không đọc CSDL, không ghi gì, chạy hai lần ra cùng kết quả — nên màn hình, dây chuyền và bài
 * kiểm đọc CÙNG một luật, và không có bản thứ hai nào để trôi xa khỏi bản này.
 *
 * `effective` chỉ HẠ, không bao giờ NÂNG: một số đo đẹp không tự trao thêm quyền cho máy. Lên
 * bậc là việc của người bấm, và `nextRung` chỉ nói cho người ấy biết cửa đã mở hay chưa.
 */
export function evaluateAutonomy(declared: AgentMode, reading: AutonomyReading): AutonomyVerdict {
  const demotedBy: DemotionReason[] = [];

  // Chặn cứng lệch nấc khai ⇒ tin vào chặn cứng. Nó ở tầng môi trường, sửa được bằng một câu SQL
  // thì không còn là chặn cứng nữa.
  if (!reading.hardLimitsConsistent) demotedBy.push("HARD_LIMIT_MISMATCH");

  // Chỉ phanh những nấc thật sự chạm tới khách. SHADOW/OFF không có gì để phanh.
  const chamKhach = declared === "COPILOT" || declared === "AUTO";
  if (chamKhach) {
    if (DEMOTION_TRIGGERS.anyFabrication && reading.fabrications > 0) demotedBy.push("FABRICATION");
    if (
      reading.usableRate !== null &&
      reading.sample >= DEMOTION_TRIGGERS.minSampleToDemote &&
      reading.usableRate < DEMOTION_TRIGGERS.usableRateFloor
    ) {
      demotedBy.push("USABLE_RATE_FLOOR");
    }
    if (DEMOTION_TRIGGERS.demoteOnCostCap && reading.costCapHit) demotedBy.push("COST_CAP");
    // Chi phí không đo được chỉ phanh nấc AUTO. Ở COPILOT vẫn có người đọc từng tin trước khi
    // gửi, nên một hoá đơn chưa đo được là việc phải đi khai giá, không phải lý do dừng bán hàng.
    if (declared === "AUTO" && reading.unpricedCalls > 0) demotedBy.push("COST_UNKNOWN");
  }

  const effective = demotedBy.length ? rungBelow(declared) : declared;

  // ── Cửa lên nấc kế tiếp ──
  const i = AUTONOMY_RUNGS.indexOf(effective);
  const nextRung = i >= 0 && i < AUTONOMY_RUNGS.length - 1 ? AUTONOMY_RUNGS[i + 1] : null;
  const blocking: string[] = [];
  const yeuCau = nextRung ? RUNG_REQUIREMENTS[nextRung] : undefined;
  if (nextRung && yeuCau) {
    if (reading.sample < yeuCau.minSample) blocking.push(`Cần ${yeuCau.minSample} lượt, mới có ${reading.sample}`);
    if (reading.humanGraded < yeuCau.minHumanGraded) {
      blocking.push(`Cần ${yeuCau.minHumanGraded} lượt người chấm tay, mới có ${reading.humanGraded}`);
    }
    if (reading.fabrications > yeuCau.maxFabrications) {
      blocking.push(`${reading.fabrications} lượt bị chấm là bịa — ngưỡng là ${yeuCau.maxFabrications}`);
    }
    if (yeuCau.minUsableRate !== null) {
      // Mẫu số rỗng ⇒ CHƯA ĐỦ DỮ LIỆU, không phải "không đạt". Hai câu ấy dẫn tới hai việc khác
      // nhau: một cái là đi chạy thêm, cái kia là đi sửa máy.
      if (reading.usableRate === null) blocking.push("Chưa có lượt nào được quyết định — tỷ lệ dùng được là CHƯA BIẾT");
      else if (reading.usableRate < yeuCau.minUsableRate) {
        blocking.push(`Tỷ lệ dùng được ${(reading.usableRate * 100).toFixed(0)}% dưới ngưỡng ${(yeuCau.minUsableRate * 100).toFixed(0)}%`);
      }
    }
    if (yeuCau.requireKnownCost && reading.unpricedCalls > 0) {
      blocking.push(`${reading.unpricedCalls} lượt gọi mô hình chưa định giá được — chi phí mỗi đơn là CHƯA BIẾT`);
    }
  }

  return { effective, demotedBy, nextRung, blocking };
}
