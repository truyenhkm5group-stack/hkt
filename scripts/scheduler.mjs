/**
 * Bộ lập lịch đồng bộ (chạy như một tiến trình riêng, ví dụ service "scheduler" trong docker-compose).
 * Gọi các API /api/sync/<job> của ERP theo chu kỳ. Không cần build TypeScript.
 */
const BASE = (process.env.ERP_INTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET || "";

const minutes = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ĐỐI CHIẾU SEPAY — CỐ Ý TẮT MẶC ĐỊNH.
//
// `AGENTS.md` mục 7: đổi lịch scheduler phải hỏi chủ shop. Nên job này chỉ chạy khi chủ shop tự
// đặt `SYNC_SEPAY_EVERY_MINUTES` (gợi ý 60). Chưa đặt thì lịch hiện tại không thêm một mục nào.
//
// Và nó chạy CHẠY THỬ: `apply=1` phải khai tường minh. Một job tự ghi vào sổ tiền mỗi giờ là thứ
// phải bật bằng tay sau khi đã nhìn ít nhất một lượt chạy thử.
/*
  SỔ QUYẾT ĐỊNH QUẢNG CÁO — MẶC ĐỊNH TẮT, vì thêm một mục vào lịch là đổi lịch (AGENTS.md mục 7).

  Bật bằng `MARKETING_LEDGER_EVERY_MINUTES` (gợi ý 30). Job chỉ đọc nghiệp vụ và chỉ ghi vào sổ của
  chính nó, nên chạy dày vô hại — khoá duy nhất theo NGÀY biến mọi lượt sau thành cập nhật.

  Chạy 30 phút/lần thay vì một lần mỗi ngày là có lý do: một NGÀY bỏ lỡ thì mất hẳn. Kết luận của
  ngày 12/09 phải tính trên dữ liệu như nó có ngày 12/09, và không dựng lại được từ dữ liệu hôm nay.
*/
const marketingLedgerEvery = Number(process.env.MARKETING_LEDGER_EVERY_MINUTES) || 0;
// Vòng mẫu quảng cáo CHI TIỀN THẬT (ảnh OpenAI, quảng cáo test) — chỉ có trong lịch khi chủ shop đặt biến này.
const creativeLoopEvery = Number(process.env.CREATIVE_LOOP_EVERY_MINUTES) || 0;
const sepayEvery = Number(process.env.SYNC_SEPAY_EVERY_MINUTES) || 0;
const sepayApply = process.env.SYNC_SEPAY_APPLY === "1" ? "&apply=1" : "";

const JOBS = [
  { job: "pancake-orders", every: minutes("SYNC_ORDERS_EVERY_MINUTES", 3), offset: 0.2 },
  { job: "vtp-tracking", every: minutes("SYNC_VTP_EVERY_MINUTES", 10), offset: 1 },
  { job: "pancake-products", every: minutes("SYNC_PRODUCTS_EVERY_MINUTES", 30), offset: 2 },
  { job: "pancake-returns", every: minutes("SYNC_RETURNS_EVERY_MINUTES", 30), offset: 4 },
  { job: "pancake-customers", every: minutes("SYNC_CUSTOMERS_EVERY_MINUTES", 60), offset: 6 },
  { job: "pancake-inventory", every: minutes("SYNC_INVENTORY_EVERY_MINUTES", 60), offset: 8 },
  { job: "facebook-ads", every: minutes("SYNC_ADS_EVERY_MINUTES", 60), offset: 10 },
  { job: "alerts", every: minutes("ALERTS_EVERY_MINUTES", 10), offset: 3 },
  /*
    VIỆC ĐỊNH KỲ PHẢI CÓ AI ĐÓ SINH RA NÓ.

    Định nghĩa việc lặp nằm trong `work_recurrences`, nhưng bản thân nó không tự thành việc. Chạy
    15 phút một lần chứ không một lần mỗi ngày: định nghĩa khai giờ sinh riêng (8 giờ, 17 giờ…), và
    một lượt chạy mỗi ngày sẽ bỏ lỡ mọi giờ không trùng lượt đó. Sinh trùng thì vô hại — khoá tự
    nhiên (recurrence_id, occurrence_key) chặn ở CSDL.
  */
  { job: "work-recurrence", every: minutes("WORK_RECURRENCE_EVERY_MINUTES", 15), offset: 9 },
  /*
    LEO THANG SLA — 30 phút/lần, và nó là job ĐỌC.

    Nó không đổi mức ưu tiên của việc nào (mức leo thang được tính lúc đọc, xem
    `lib/work/escalation.ts`) và không tạo cảnh báo nào. Việc duy nhất nó làm có hậu quả ra bên
    ngoài là gửi MỘT tin Lark cho mỗi phòng có việc vỡ hạn hơn 24 giờ chưa ai nhận — và sổ chống
    gửi lại giới hạn đúng một tin mỗi phòng mỗi ngày. Chạy dày hơn cũng không gửi thêm tin nào;
    30 phút chỉ để tin đầu ngày tới sớm.
  */
  { job: "work-escalation", every: minutes("WORK_ESCALATION_EVERY_MINUTES", 30), offset: 11 },
  /*
    BẢN TIN MARKETING HẰNG NGÀY — 30 phút/lần, và đó KHÔNG phải "gửi 48 tin mỗi ngày".

    Sổ chống gửi lại (`settings["marketing.digest.sent"]`) khoá đúng MỘT bản tin cho mỗi phạm vi
    mỗi NGÀY VIỆT NAM, nên 47 lượt còn lại chỉ đọc rồi thoát. Chạy dày là để bản tin đầu ngày tới
    sớm ngay cả khi máy chủ vừa khởi động lại, chứ không phải để gửi nhiều hơn.

    Bản tin nói về NGÀY HÔM QUA — ngày duy nhất vừa đã đóng vừa còn đáng hành động.
  */
  { job: "marketing-digest", every: minutes("MARKETING_DIGEST_EVERY_MINUTES", 30), offset: 13 },
  /*
    CHỤP ẢNH HIỆU SUẤT — mỗi 6 giờ, và đó là con số chọn có lý do.

    Job chỉ chụp kỳ ĐÃ ĐÓNG và không bao giờ ghi đè, nên chạy dày hơn không tạo thêm dòng nào:
    24 lần trong tuần đều bị chặn ở mệnh đề "kỳ chưa đóng", lần đầu sau nửa đêm Chủ nhật mới ghi.
    Chạy dày là để KHÔNG BỎ LỠ một kỳ nếu máy chủ tình cờ tắt đúng lúc giao tuần — bỏ lỡ một tuần
    thì mất hẳn, vì kỳ đó sẽ không bao giờ được chụp lại.
  */
  { job: "work-snapshot", every: minutes("WORK_SNAPSHOT_EVERY_MINUTES", 360), offset: 19 },
  { job: "cs-chat", every: minutes("SYNC_CHAT_EVERY_MINUTES", 15), offset: 5 },
  { job: "ads-billing", every: minutes("SYNC_ADS_BILLING_EVERY_MINUTES", 30), offset: 12 },
  { job: "landing-sheet", query: "new=1", every: minutes("SYNC_LANDING_FAST_EVERY_MINUTES", 1), offset: 7 }, // near-realtime: nạp nhanh dòng mới
  { job: "landing-sheet", every: minutes("SYNC_LANDING_EVERY_MINUTES", 10), offset: 8.5 }, // đầy đủ: ghép lại theo SĐT, cập nhật dòng đã sửa
  // LỚP TĂNG TỐC PHẢI CÓ NGƯỜI LÀM MỚI, nếu không nó tự mục.
  //
  // `canonical_order_outcome` chỉ được coi là dùng được khi nó MỚI HƠN đơn và vận đơn của nó; đơn cũ
  // hơn thì báo cáo tự tính lại (chậm chứ không sai). Mà `pancake-orders` chạy 3 phút một lần và
  // chạm vào `orders.updated_at`, nên số dòng cũ chỉ có tăng.
  //
  // Đo trên production 09/09/2026: sau 73 phút không ai dựng lại, 80/2.433 dòng đã cũ. Cứ thế thì
  // vài tuần nữa gần như mọi đơn rơi về đường chậm và trang chủ quay lại mức 60 giây của trước P0.3.
  { job: "outcome-materialize", every: minutes("OUTCOME_MATERIALIZE_EVERY_MINUTES", 5), offset: 1.5 },
  // GIỮ ẤM TRANG CHỦ. Đo được: nguội 76-88 giây, ấm ~100ms. Chạy mỗi 4 phút — ngắn hơn TTL 300
  // giây của bảng điều khiển, nên đệm không bao giờ kịp nguội và người mở trang không phải trả giá.
  { job: "dashboard-warm", every: minutes("DASHBOARD_WARM_EVERY_MINUTES", 4), offset: 0.5 },
  // QUY KẾT FANPAGE → MARKETER. Mỗi 30 phút là đủ: nó phục vụ một BÁO CÁO, không phục vụ một màn
  // hình thời gian thực, và mỗi lượt là một phép quét toàn bộ đơn (chuỗi trùng đơn không biết ranh
  // giới kỳ, nên quét hẹp sẽ cho kết quả khác nhau tuỳ tham số — xem lib/attribution/fanpage.ts).
  // Ghi là ghi ĐÈ theo khoá `order_id`, nên chạy trùng nhau cũng không cộng đúp được gì.
  { job: "fanpage-attribution", every: minutes("FANPAGE_ATTRIBUTION_EVERY_MINUTES", 30), offset: 13 },
  /*
    ĐỌC LƯỢT DEPLOY TỪ GITHUB — 15 phút/lần, CHỈ ĐỌC.

    Job này đã chạy được từ lâu nhưng chỉ chạy khi có người bấm, và cái giá đo được ngày 20/09/2026
    là một BÁO ĐỘNG GIẢ: dòng mới nhất trong sổ là 12:11 hôm trước, trong khi GitHub đã có thêm 12
    lượt deploy sau đó — nên `/tech/deployments` kết luận "LỆCH, container có thể chưa khởi động
    lại" trong khi nguyên nhân thật là SỔ CŨ 14 GIỜ. Một cảnh báo chỉ trỏ vào độ tươi của chính nó
    còn tệ hơn không có cảnh báo: người đọc đi khởi động lại máy chủ cho một thứ không hỏng.

    15 phút là chọn theo HẠN MỨC, không theo mong muốn: đường gọi ẩn danh của GitHub cho 60
    request/giờ tính theo IP máy chủ (`ERP_GITHUB_TOKEN` nâng lên 5.000). Mỗi lượt job tốn 1
    request, nên 4 lượt/giờ chiếm 1/15 hạn mức chặt nhất và vẫn còn chỗ cho người bấm tay.

    Idempotent theo khoá (lượt chạy, lần chạy lại) nên chạy trùng không nhân đôi dòng nào, và lượt
    đồng bộ KHÔNG đụng những ô người điền (ghi chú, việc gắn kèm, kết quả nghiệm thu).
  */
  { job: "github-deployments", every: minutes("GITHUB_DEPLOY_SYNC_EVERY_MINUTES", 15), offset: 6.5 },
  /*
    CHÉP TRẠNG THÁI PR VỀ VIỆC TECH — 15 phút/lần, CHỈ ĐỌC.

    Lệch pha với `github-deployments` (offset khác nhau) để hai job không cùng lúc ăn vào hạn mức.

    HẠN MỨC TÍNH THEO GIỜ, KHÔNG THEO LƯỢT — đây là phép tính đã bị bỏ sót một lần. Mỗi lượt tốn
    1 request cho danh sách PR, cộng 3 cho mỗi PR phải đọc chi tiết, và số PR ấy có TRẦN
    (`prDetailBudget`, đi theo chế độ gọi). Ẩn danh: trần 3 ⇒ 10/lượt × 4 lượt = 40/giờ, cộng 4
    của sổ deploy là 44 — còn chừa chỗ dưới hạn mức 60/giờ theo IP. Có token: trần 12 ⇒ 148/giờ
    trên hạn mức 5.000, chiếm 3%.

    Việc vượt trần được HOÃN chứ không cắt: thứ tự là "lâu chưa đọc nhất trước", nên nó xoay vòng.

    15 phút chứ không 3: cột này phục vụ một MÀN HÌNH QUẢN LÝ, không phục vụ một cái cổng. Ai cần
    biết CI vừa đỏ trong vòng một phút thì đọc GitHub, không đọc phép chiếu.
  */
  { job: "github-pr-sync", every: minutes("GITHUB_PR_SYNC_EVERY_MINUTES", 15), offset: 10.5 },
  /*
    ĐÓNG LƯỢT CHẠY AGENT MỒ CÔI — 15 phút/lần.

    Ngưỡng mặc định 45 phút, tức một lượt chạy phải im lặng qua ít nhất ba nhịp trước khi bị đóng.
    Job KHÔNG đụng lượt chạy còn sống: điều kiện là NHỊP TIM đứng im, mà tiến trình còn chạy thì
    còn đập nhịp.

    Vì sao phải có lịch: cổng "không hai lượt song song" đọc chính bảng `tech_agent_runs`, nên một
    tiến trình chết giữa chừng để lại một dòng RUNNING khoá VĨNH VIỄN mọi lượt sau trên cùng việc —
    im lặng, cho tới khi có người biết phải gọi tay. Không lên lịch là chọn hỏng ĐÓNG mà không báo ai.
  */
  { job: "agent-reaper", every: minutes("AGENT_REAPER_EVERY_MINUTES", 15), offset: 14 },
  /*
    MỞ SỰ CỐ CHO JOB HỎNG LIÊN TIẾP — 30 phút/lần.

    Nhịp này KHÔNG quyết định độ nhạy: ngưỡng là BA LƯỢT HỎNG LIÊN TIẾP của chính job kia, nên một
    job chạy mỗi giờ vẫn cần ba tiếng mới đủ, dù bộ quét chạy dày tới đâu. Chạy dày chỉ để sự cố
    hiện ra sớm sau khi đã đủ ngưỡng.

    Chạy trùng vô hại: nhiều nhất một sự cố CHƯA ĐÓNG cho mỗi job, khoá bằng tiêu đề.
  */
  { job: "tech-incident-watch", every: minutes("TECH_INCIDENT_WATCH_EVERY_MINUTES", 30), offset: 16 },
  /*
    CANH KHOÁ AI — 30 phút, lệch 21 phút so với bộ canh job đồng bộ.

    Cùng nhịp với `tech-incident-watch` vì cùng bản chất: nó không đo độ nhạy, ngưỡng mới đo (2
    lượt hỏng liên tiếp thuộc lớp cần-người). Lệch pha để hai bộ canh không cùng lúc mở sự cố và
    cùng lúc ghi vào `tech_incidents`.

    ĐÃ TRẢ GIÁ CHO VIỆC KHÔNG CÓ NÓ: 20/09/2026, tài khoản Anthropic hết credit lúc ~21:30 và
    KHÔNG màn hình nào báo — chỉ lộ ra khi lượt chạy agent thứ 10 dừng ở bước kiểm khoá.
  */
  { job: "ai-incident-watch", every: minutes("AI_INCIDENT_WATCH_EVERY_MINUTES", 30), offset: 21 },
  /*
    ĐẨY TRẠNG THÁI VIỆC — 15 phút, lệch 26 phút.

    Cùng nhịp với `github-pr-sync` (15 phút) vì nó ĐỌC đúng thứ lượt đồng bộ ấy vừa ghi; chạy dày
    hơn chỉ đọc lại cùng một dữ liệu. Lệch 26 để nó luôn chạy SAU lượt chép PR của cùng chu kỳ
    (pr-sync lệch 10.5), chứ không đọc dữ liệu của chu kỳ trước.
  */
  { job: "task-advance-watch", every: minutes("TASK_ADVANCE_EVERY_MINUTES", 15), offset: 26 },
  /*
    ĐỐI CHIẾU SỔ LƯỢT CHẠY AGENT — 60 phút, lệch 33 phút.

    Thưa hơn hẳn các bộ canh khác, và đó là chủ ý: nó trả lời một câu hỏi về QUÁ KHỨ ("lượt chạy
    nào đã mất dòng sổ"), không phải một câu hỏi về hiện tại. Lượt chạy agent là chuyện vài lần
    một ngày, nên hỏi GitHub mỗi mười lăm phút chỉ tốn hạn mức để nhận lại cùng một câu trả lời.

    Lệch 33 để không đứng cùng chỗ với bất kỳ bộ nào đang gọi GitHub (`github-deployments` 6.5 ·
    `github-pr-sync` 10.5): ba lượt gọi cùng lúc thì lần đầu chạm trần hạn mức sẽ hạ cả ba.
  */
  { job: "agent-run-reconcile", every: minutes("AGENT_RUN_RECONCILE_EVERY_MINUTES", 60), offset: 33 },
  // Mục này CHỈ có mặt khi chủ shop đặt SYNC_SEPAY_EVERY_MINUTES — chưa đặt thì lịch không đổi.
  ...(sepayEvery > 0 ? [{ job: "sepay-reconcile", query: `days=2${sepayApply}`, every: sepayEvery, offset: 9 }] : []),
  ...(marketingLedgerEvery > 0 ? [{ job: "marketing-decision-ledger", every: marketingLedgerEvery, offset: 14 }] : []),
  ...(creativeLoopEvery > 0 ? [{ job: "creative-loop", every: creativeLoopEvery, offset: 3 }] : []),
];

const DAILY = [
  { job: "pancake-reconcile", hour: 2, minute: 15 }, // 02:15 giờ Việt Nam
  { job: "vtp-tracking", hour: 3, minute: 0, query: "all=1&limit=2000" },
  { job: "pancake-warehouses", hour: 3, minute: 30 },
  { job: "facebook-ads", hour: 4, minute: 0, query: "days=30" },
  { job: "outreach-build", hour: 8, minute: 30 }, // lập danh sách chăm sóc khách & bán chéo mỗi sáng // đối chiếu lại 30 ngày (Facebook có thể điều chỉnh số liệu muộn)
  // QUÉT đối soát mỗi sáng, CHỈ ĐỌC — cố ý KHÔNG truyền fix=1.
  //
  // Trước đây lệch dữ liệu chỉ lộ ra khi có người bấm tay, nên 70 vận đơn lệch ảnh chụp nằm im
  // nhiều ngày. Quét tự động thì chúng hiện ra ở Chất lượng dữ liệu ngay hôm sau.
  //
  // Vì sao KHÔNG tự sửa: sửa dữ liệu production không có người xem là đúng loại việc phải hỏi chủ
  // shop (AGENTS.md mục 7). Máy phát hiện, người quyết định.
  { job: "data-check", hour: 6, minute: 30 },
];

const log = (...args) => console.log(new Date().toISOString(), "[scheduler]", ...args);

async function trigger(job, query = "") {
  const url = `${BASE}/api/sync/${job}?wait=0${query ? `&${query}` : ""}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "x-cron-secret": SECRET } });
    const body = await res.json().catch(() => ({}));
    log(job, res.status, body.message || (body.started ? "started" : JSON.stringify(body).slice(0, 120)));
  } catch (error) {
    log(job, "lỗi:", error.message);
  }
}

async function waitForApp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // chưa sẵn sàng
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

function vnNow() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: get("hour"), minute: get("minute") };
}

async function main() {
  log("Đang chờ ERP sẵn sàng tại", BASE);
  const ready = await waitForApp();
  if (!ready) log("ERP chưa phản hồi, vẫn tiếp tục thử theo lịch.");

  for (const item of JOBS) {
    setTimeout(() => {
      trigger(item.job, item.query);
      setInterval(() => trigger(item.job, item.query), item.every * 60_000);
    }, item.offset * 60_000);
  }
  log("Lịch chạy:", JOBS.map((j) => `${j.job}/${j.every}p`).join(", "));

  const firedToday = new Set();
  setInterval(() => {
    const { hour, minute } = vnNow();
    for (const d of DAILY) {
      const key = `${d.job}-${new Date().toDateString()}`;
      if (hour === d.hour && minute === d.minute && !firedToday.has(key)) {
        firedToday.add(key);
        trigger(d.job, d.query);
      }
    }
  }, 30_000);
}

main();
