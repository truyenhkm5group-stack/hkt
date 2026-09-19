/**
 * SỔ ĐĂNG KÝ MÔ HÌNH + MÔ PHỎNG ĐỊNH TUYẾN.
 *
 * Bài kiểm này canh BA điều, và cả ba đều là chỗ một bản sửa "vô hại" sau này có thể phá lặng lẽ:
 *
 *   1. Sổ đăng ký không được nói về một nhà cung cấp mà kho mã KHÔNG có adapter.
 *   2. Mô phỏng phải TẤT ĐỊNH và phải giữ HAI CHIỀU tách rời (rủi ro → người, độ khó → mô hình).
 *   3. Logic nghiệp vụ không được rẽ nhánh theo TÊN nhà cung cấp — đó là điều đặc tả cấm thẳng,
 *      và là thứ chỉ quét mã nguồn mới bắt được.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { HUMAN_ONLY_INTENTS } from "@/lib/ai-workforce/agents/sales/understand";
import { providerNames } from "@/lib/ai-workforce/providers";
import { MODEL_PROVIDERS, MODEL_REGISTRY, MODEL_ROLES, enabledFor, priceKey, registryFor } from "@/lib/constants/model-registry";
import {
  RISK_INTENTS_TO_HUMAN,
  ROUTE_LANES,
  ROUTE_LANE_LABEL,
  SIM_THRESHOLDS,
  businessRiskOf,
  complexityOf,
  isRuleOnlyEligible,
  simulateRoute,
  type RouterSimInput,
} from "@/lib/constants/router-sim";

/** Lượt "sạch" nhất có thể: luật tự tin, đã có mẫu mã, không rủi ro. Mọi ca dưới đây sửa từ đây ra. */
function luot(p: Partial<RouterSimInput> = {}): RouterSimInput {
  return {
    intents: ["PRODUCT_QUESTION"],
    ruleConfidence: 0.9,
    hasProduct: true,
    hasVariant: true,
    quotedTotal: null,
    humanTakeover: false,
    handoffReason: "",
    hasImage: false,
    customerTurns: 2,
    ...p,
  };
}

test("sổ đăng ký mô hình: khai đúng thứ có thật", () => {
  // ── Không khai một nhà cung cấp mà kho mã không gọi được ──
  // Một dòng sổ trỏ tới adapter không tồn tại sẽ đi qua typecheck, qua lint, rồi chết lúc chạy —
  // hoặc tệ hơn: làm bảng chi phí in ra một làn không bao giờ chạy được.
  for (const ten of MODEL_PROVIDERS) {
    assert.ok(providerNames().includes(ten), `sổ khai nhà cung cấp "${ten}" nhưng không có adapter nào đăng ký tên đó`);
  }
  for (const m of MODEL_REGISTRY) {
    assert.ok((MODEL_PROVIDERS as readonly string[]).includes(m.provider), `${m.provider} không có trong danh sách nhà cung cấp`);
    assert.ok((MODEL_ROLES as readonly string[]).includes(m.role));
    // Lý do có mặt là BẮT BUỘC: một dòng sổ không giải thích được vì sao nó ở đó thì người sau
    // không dám xoá, và sổ cứ dài thêm mãi.
    assert.ok(m.note.trim().length > 20, `dòng ${m.provider}/${m.role} phải khai vì sao nó có mặt`);
  }

  // ── Một (nhà cung cấp, vai trò) chỉ được một dòng ──
  // Hai dòng trùng thì `MODEL_REGISTRY.find()` trong trình mô phỏng lấy dòng đầu một cách tuỳ tiện,
  // và bảng tiền sẽ đổi theo thứ tự khai — một thứ không ai coi là có ý nghĩa.
  const khoa = MODEL_REGISTRY.map((m) => `${m.provider}/${m.role}`);
  assert.equal(new Set(khoa).size, khoa.length, "không được có hai dòng cùng nhà cung cấp + vai trò");

  // ── Champion đang chạy phải BẬT, thách thức phải TẮT ──
  assert.ok(enabledFor("ROUTINE").length > 0, "phải có ít nhất một mô hình việc-thường đang bật, nếu không dây chuyền thật không có gì để chạy");
  for (const m of MODEL_REGISTRY.filter((x) => x.provider === "google")) {
    assert.equal(m.enabled, false, "Gemini là THÁCH THỨC — bật nó trong sổ là đưa một mô hình chưa ai chấm vào đường chạy");
  }

  // ── Ảnh chỉ đi được qua mô hình CÓ MẮT ──
  // Mô phỏng gửi mọi lượt có ảnh vào làn GEMINI_COMPLEX; nếu dòng sổ ấy khai không đọc được ảnh
  // thì hai tệp đang nói hai điều khác nhau, và bảng phân bổ trở thành một lời hứa suông.
  const geminiKho = MODEL_REGISTRY.find((m) => m.provider === "google" && m.role === "COMPLEX");
  assert.ok(geminiKho?.supportsVision, "làn dành cho ảnh phải trỏ tới mô hình khai đọc được ảnh");

  assert.equal(priceKey("google", "gemini-x"), "google:gemini-x");
  assert.equal(registryFor("PREMIUM").length, 0, "chưa khai mô hình PREMIUM nào — và nó KHÔNG được nằm trên đường chat khách");
});

test("mô phỏng định tuyến: tất định, hai chiều tách rời", () => {
  // ── ① TẤT ĐỊNH ──
  // Không đọc CSDL, không đọc đồng hồ, không ngẫu nhiên. Chạy hai lần ra cùng kết quả, nếu không
  // thì mọi bảng phân bổ đều là một lần bốc thăm và không so sánh được với lần chạy trước.
  const ca: RouterSimInput[] = [
    luot(),
    luot({ ruleConfidence: null }),
    luot({ ruleConfidence: 0.3, hasProduct: false }),
    luot({ intents: ["COMPLAINT"] }),
    luot({ hasImage: true }),
    luot({ humanTakeover: true }),
    luot({ quotedTotal: 499_000, hasVariant: false }),
    luot({ customerTurns: 20, intents: ["PRICE_QUESTION", "SHIPPING_QUESTION"] }),
  ];
  for (const c of ca) {
    assert.deepEqual(simulateRoute(c), simulateRoute(c), "cùng đầu vào phải ra cùng kết quả");
    assert.ok((ROUTE_LANES as readonly string[]).includes(simulateRoute(c).lane));
    assert.ok(simulateRoute(c).why.length > 0, "mọi làn phải nói được VÌ SAO — một bảng không có lý do thì không ai sửa được gì từ nó");
  }

  // ── ② RỦI RO ĐI VỀ NGƯỜI, KHÔNG ĐI LÊN MÔ HÌNH ĐẮT HƠN ──
  // Đây là lỗi đắt nhất một bộ định tuyến có thể mắc: một khiếu nại KHÔNG khó hiểu, nó dễ hiểu và
  // phải về tay người. Ca dưới cố tình DỄ tối đa (luật tự tin 0.95, đã có mẫu mã) để nếu nhánh rủi
  // ro bị gộp vào thang độ khó thì nó sẽ rơi thẳng vào làn rẻ và bài kiểm đỏ.
  const khieuNai = simulateRoute(luot({ intents: ["COMPLAINT"], ruleConfidence: 0.95 }));
  assert.equal(khieuNai.lane, "HUMAN", "khiếu nại phải về tay người dù luật rất tự tin");
  assert.ok(khieuNai.complexity < SIM_THRESHOLDS.complex, "và nó KHÔNG được ghi là 'khó' — rủi ro không phải độ khó");
  assert.equal(isRuleOnlyEligible(luot({ intents: ["COMPLAINT"], ruleConfidence: 0.95 })), false);

  // ── ③ KHÓ ĐI LÊN MÔ HÌNH, KHÔNG ĐI VỀ NGƯỜI ──
  // Chiều ngược lại cũng phải giữ: đẩy mọi thứ khó về người thì bộ định tuyến chỉ là một cái công
  // tắc tắt, và hàng đợi nhân viên sẽ ngập.
  const kho = simulateRoute(luot({ ruleConfidence: null, hasProduct: false, customerTurns: 20 }));
  assert.equal(kho.lane, "ANTHROPIC_COMPLEX", "việc khó mà không rủi ro thì gọi mô hình mạnh hơn, không gọi người");
  assert.ok(kho.businessRisk < SIM_THRESHOLDS.riskToHuman);

  // ── ④ NGƯỜI ĐÃ VÀO CẦM ⇒ MÁY ĐỨNG NGOÀI ──
  assert.equal(simulateRoute(luot({ humanTakeover: true, ruleConfidence: 0.99 })).lane, "HUMAN");

  // ── ⑤ LUẬT TỰ ĐỦ ⇒ KHÔNG GỌI MÔ HÌNH ──
  assert.equal(simulateRoute(luot()).lane, "RULE_ONLY");
  // Ngay dưới ngưỡng thì KHÔNG được coi là đủ: ngưỡng phải là một cái vạch, không phải một gợi ý.
  assert.equal(simulateRoute(luot({ ruleConfidence: SIM_THRESHOLDS.ruleConfident - 0.01 })).lane, "OPENAI_ROUTINE");
  assert.equal(simulateRoute(luot({ ruleConfidence: SIM_THRESHOLDS.ruleConfident })).lane, "RULE_ONLY");
  // CHƯA BIẾT độ tin KHÔNG phải độ tin 0 và cũng không phải "đủ tin" — nó là dấu hiệu KHÓ.
  assert.equal(isRuleOnlyEligible(luot({ ruleConfidence: null })), false);
  assert.ok(complexityOf(luot({ ruleConfidence: null })) > complexityOf(luot()));

  // ── ⑥ ĐỐI CHỨNG CHỈ ĐỔI NHÀ CUNG CẤP, KHÔNG BAO GIỜ ĐỔI NẤC ──
  // So hai nhà cung cấp trên hai nấc khác nhau là một phép so vô nghĩa; nếu cờ `challenger` đổi
  // được nấc thì mọi con số "Gemini rẻ hơn" chỉ đang nói "nấc rẻ thì rẻ hơn nấc đắt".
  const nacCua: Record<string, string> = {
    RULE_ONLY: "RULE", HUMAN: "HUMAN",
    OPENAI_ROUTINE: "ROUTINE", GEMINI_ROUTINE: "ROUTINE",
    ANTHROPIC_COMPLEX: "COMPLEX", GEMINI_COMPLEX: "COMPLEX",
  };
  for (const c of ca) {
    const a = simulateRoute(c);
    const b = simulateRoute(c, { challenger: true });
    assert.equal(nacCua[a.lane], nacCua[b.lane], `đối chứng đổi nấc ở ca ${JSON.stringify(c.intents)} — phép so sẽ vô nghĩa`);
    assert.equal(a.ruleOnlyEligible, b.ruleOnlyEligible, "cờ đối chứng không được đổi câu trả lời 'luật có đủ không'");
    assert.equal(a.complexity, b.complexity);
    assert.equal(a.businessRisk, b.businessRisk);
  }

  // ── ⑦ MỌI LÀN PHẢI CÓ NHÃN TIẾNG VIỆT ──
  for (const lan of ROUTE_LANES) assert.ok(ROUTE_LANE_LABEL[lan]?.length > 0);
});

test("luật chuyển người của mô phỏng phải PHỦ luật của dây chuyền đang chạy", () => {
  // Hai danh sách cố ý KHÔNG dính vào nhau (sửa mô phỏng không được đổi hành vi thật), nên phải có
  // một bài kiểm giữ chúng không trôi xa nhau. Chiều PHỦ là chiều an toàn: mô phỏng được phép cẩn
  // trọng HƠN dây chuyền thật, nhưng không bao giờ được lỏng hơn.
  for (const y of HUMAN_ONLY_INTENTS) {
    assert.ok(
      (RISK_INTENTS_TO_HUMAN as readonly string[]).includes(y),
      `ý định "${y}" bắt buộc về người ở dây chuyền thật nhưng mô phỏng lại cho máy xử — mô phỏng đang lỏng hơn thực tế`,
    );
    assert.ok(businessRiskOf(luot({ intents: [y] })) >= SIM_THRESHOLDS.riskToHuman);
    assert.equal(simulateRoute(luot({ intents: [y] })).lane, "HUMAN");
  }
});

test("logic nghiệp vụ KHÔNG được rẽ nhánh theo tên nhà cung cấp", () => {
  /*
    Đặc tả cấm thẳng: "Business logic không được phụ thuộc: if provider == openai / anthropic /
    google". Lý do không phải thẩm mỹ — một nhánh như vậy nghĩa là đổi nhà cung cấp phải sửa logic
    bán hàng, và phần logic ấy sẽ hành xử khác nhau tuỳ hoá đơn của tháng đó.

    CHỖ ĐƯỢC PHÉP biết tên, và chỉ ba chỗ:
      · `lib/ai-workforce/providers/*` — chính các adapter, tên là danh tính của chúng;
      · `lib/constants/*` — các BẢN KHAI năng lực (sổ mẫu, danh sách chỉ-ở-bóng, bảng làn);
      · `lib/ai/*` — tầng AI có sẵn của ERP, vốn đã là một bộ chọn nhà cung cấp.

    Quét MÃ ĐÃ VÀO KHO (`git ls-files`) chứ không quét đĩa: một tệp chưa commit không chạy trên
    production, và một tệp đã commit thì chạy dù đĩa của ai đó có gì.
  */
  // Bắt phép SO SÁNH một biểu thức với tên nhà cung cấp, ở cả hai chiều và cả ba dấu (== === !==).
  const TEN = "(openai|anthropic|google|gemini)";
  const xau = `(provider|nhaCungCap)[a-zA-Z]*[[:space:]]*[!=]==?[[:space:]]*["'\`]${TEN}|["'\`]${TEN}["'\`][[:space:]]*[!=]==?[[:space:]]*[a-zA-Z.]*(provider|Provider)`;

  // MỘT lượt `git grep` trên cây HEAD thay vì `git show` từng tệp: cùng một phép quét trên mã ĐÃ
  // VÀO KHO, nhưng không đẻ ra một tiến trình cho mỗi tệp.
  let ket = "";
  try {
    ket = execFileSync("git", ["grep", "-n", "-I", "-E", "-i", xau, "HEAD", "--", "lib", "app", "components"], { encoding: "utf-8" });
  } catch (e) {
    // `git grep` thoát 1 khi KHÔNG khớp gì — đó là kết quả mong muốn, không phải lỗi.
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) throw e;
    ket = err.stdout ?? "";
  }

  const pham = ket
    .split("\n")
    .filter(Boolean)
    // `git grep HEAD -- …` in ra "HEAD:<đường dẫn>:<dòng>:<nội dung>".
    .map((d) => d.replace(/^HEAD:/, ""))
    .filter((d) => {
      const duongDan = d.slice(0, d.indexOf(":"));
      const noiDung = d.slice(d.indexOf(":", d.indexOf(":") + 1) + 1);
      if (duongDan.startsWith("lib/ai-workforce/providers/") || duongDan.startsWith("lib/constants/") || duongDan.startsWith("lib/ai/")) return false;
      // Chú thích không phải mã — một dòng giải thích VÌ SAO không được làm vậy thì phải nói ra được.
      return !/^\s*(\/\/|\*|\/\*)/.test(noiDung);
    });

  assert.deepEqual(pham, [], `logic nghiệp vụ rẽ nhánh theo tên nhà cung cấp:\n${pham.join("\n")}`);
});
