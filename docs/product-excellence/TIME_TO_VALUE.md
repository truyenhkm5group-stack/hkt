# Time-to-Value — định nghĩa chuỗi mốc và câu đo (08/10/2026)

*Sứ mệnh `product-excellence-baseline` · R0 · đọc mã ở `origin/main` `36b7791b`. Tài liệu này KHÔNG chứa số đo production. Câu SQL
ở §3 là CHỈ ĐỌC, mỗi khối MỘT câu lệnh, chạy qua ops `db-query` trên CSDL NHÀ. Kết quả theo tổ chức thuộc phần MÃ HOÁ của lượt
chạy; dòng tóm tắt công khai chỉ mang số đếm (AGENTS §5, kho PUBLIC). Không câu nào đọc SĐT, email, tên người hay nội dung tin.*

## 1. Chuỗi mốc

Chuỗi sứ mệnh yêu cầu: signup → page kết nối đầu tiên → tin khách đầu tiên → AI trả lời đầu tiên → order candidate đầu tiên → đơn
thành công đầu tiên. Nền tảng ĐÃ có sổ mốc ghi một lần `platform_org_milestones` (`db/schema.ts:5445-5455`, định nghĩa ở
`lib/platform/saas-metrics.ts:254-296`, đường ghi `lib/platform/saas-ledger.ts:212-280`). Tài liệu này dùng lại sổ đó, không dựng
sổ thứ hai.

| # | Mốc sứ mệnh | Mốc trong sổ | Chứng từ thật | CSDL | Đo được hôm nay? |
|---|---|---|---|---|---|
| M0 | Signup | `SIGNED_UP` | `platform_organizations.created_at` | nhà | **có** — Q1, Q2 |
| M1 | Page kết nối đầu tiên | `CHANNEL_CONNECTED` | `org_connections` của khoá kênh bán đang ACTIVE, `activated_at` (`saas-ledger.ts:214-218`) | tổ chức → sổ nhà | **có, với lỗ**: khoá kênh bán chỉ gồm 3 khoá Pancake + `facebook-messenger` (`saas-metrics.ts:302`). Zalo OA (`zalo-oa`) và ô chat web KHÔNG BAO GIỜ đạt mốc này |
| M1b | (bổ trợ) Page Messenger trực tiếp đầu tiên | — | `platform_messenger_pages.created_at` (`db/schema.ts:5164-5171`) | nhà | **có** — Q6 |
| M2 | Tin khách đầu tiên | `FIRST_CONVERSATION` | `min(sales_chat_conversations.created_at)`, kênh ≠ TEST, bỏ hội thoại do lượt nhập lịch sử tạo (`saas-ledger.ts:222`) | tổ chức → sổ nhà | **có** — mốc MỞ hội thoại, sát với tin đầu tiên |
| M3 | AI trả lời đầu tiên | `FIRST_AI_REPLY` (= «đã kích hoạt», `saas-metrics.ts:296`) | hội thoại kênh thật có `ai_calls > 0` — mốc MỞ hội thoại đó, tức CẬN DƯỚI của câu AI đầu tiên (`saas-ledger.ts:223`) | tổ chức → sổ nhà | **có, là cận dưới**. Bổ trợ Q7 từ sổ AI (gồm cả khung thử) |
| M4 | Order candidate đầu tiên | — (chưa có mốc) | Hôm nay «candidate» là đơn nháp NEW: `sales_chat_conversations.draft_order_id` (`lib/sales-chatbot/engine.ts:1027`) và sự kiện `order.drafted` của máy ghi đơn (`lib/sales-chatbot/order-sync.ts:761`) | tổ chức | **không** — cần công cụ §4 |
| M5 | Đơn AI đầu tiên | `FIRST_AI_ORDER` | `orders` nối `sales_chat_conversations.order_id` (`saas-ledger.ts:224`) — `order_id` chỉ được đặt khi BOT chốt (`engine.ts:1028`) | tổ chức → sổ nhà | **có, với lỗ** (SUY LUẬN từ đọc mã): đơn do máy ghi từ hội thoại nhân viên mang `orders.sales_conversation_id` + `state.sync`, không thấy đường nào đặt `order_id` của hội thoại ⇒ shop chốt chủ yếu qua đường đó (HSLC) có thể không bao giờ đạt mốc này |
| M6 | Đơn thành công đầu tiên | `FIRST_DELIVERED_AI_ORDER` | đơn AI đầu tiên có `ORDER_OUTCOME = DELIVERED`; mốc là lúc ĐẶT đơn ấy, không phải lúc giao (`saas-metrics.ts:287-291`) | tổ chức → sổ nhà | **có**, cùng lỗ với M5 |

Ba điều phải nhớ khi đọc số:
1. **Sổ mốc chỉ được ghi khi có lượt chụp** (`captureSaasSnapshot`: job `alerts` của nhà ≤ 1 lần / 6 giờ + lượt mở `/platform/saas`,
   `docs/productization/11_SAAS_METRICS_SPEC.md` §1). Q5 phải chạy TRƯỚC: lượt quét cuối cũ thì mốc vắng nghĩa là CHƯA ĐO, không
   phải «chưa đạt».
2. **Chỉ quét tổ chức `ACTIVE`, không phải nhà** (`saas-ledger.ts:260`). Tổ chức bị đình chỉ trước khi đạt mốc sẽ không bao giờ có mốc.
3. **Trung vị dưới 3 tổ chức là `null`** (`SAAS_MEDIAN_MIN_SAMPLE = 3`, `saas-metrics.ts:305`). Q4 in `n` cạnh trung vị — n < 3 thì
   không kết luận.

## 2. Định nghĩa chỉ số

| Chỉ số | Công thức | Grain | Khi chưa biết |
|---|---|---|---|
| TTV-k | `reached_at(Mk) − created_at` (giờ) cho từng workspace | workspace | mốc vắng ⇒ `—`, KHÔNG phải 0 và không vào trung vị |
| Tỷ lệ tới mốc k | số workspace có Mk / số workspace `ACTIVE` không phải nhà, tách theo nguồn tạo | phân nhóm | mẫu số 0 ⇒ `—` |
| Trung vị TTV-k | `percentile_cont(0.5)` trên các workspace đã đạt Mk | phân nhóm | n < 3 ⇒ không kết luận |

Phân nhóm bắt buộc: workspace TỰ ĐĂNG KÝ (`platform_organizations.brand IS NOT NULL` — chỉ ghi khi khách tự đăng ký,
chú thích cột `brand`, `db/schema.ts:4855-4861`; đối chiếu thêm `platform_accounts.source = 'SIGNUP'`) tách khỏi workspace người vận hành tạo
hộ. Gộp hai nhóm làm trung vị vô nghĩa: người vận hành cấu hình hộ thì «nối kênh» nhanh vì người vận hành làm.

Mốc âm (mốc trước cả lúc tạo — ví dụ sản phẩm do mẫu ngành gieo cùng giao dịch tạo) được IN RA và ĐẾM RIÊNG, không kẹp về 0 ngoài
dung sai, không bỏ (cùng tinh thần AGENTS 64).

## 3. Câu SQL chỉ đọc cho CSDL nhà (Integration Lead chạy qua `db-query`)

### Q1 — Workspace, nguồn tạo, thuê bao sống
```sql
select o.code, o.brand, o.status, o.plan, o.pilot_stage, o.publish_state,
       to_char(o.created_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') as tao_luc_vn,
       a.account_type, a.source as nguon_tai_khoan,
       (select string_agg(s.product_key || ':' || s.state || ':' || s.source, ', ' order by s.product_key)
          from platform_product_subscriptions s
         where s.org_code = o.code and s.ended_at is null) as thue_bao_song
from platform_organizations o
left join platform_accounts a on a.id = o.account_id
where not o.is_home
order by o.created_at;
```

### Q2 — Giờ từ lúc tạo tới từng mốc, từng workspace
```sql
select o.code, o.brand, a.source as nguon_tai_khoan, o.status,
  round((extract(epoch from (max(m.reached_at) filter (where m.milestone = 'CHANNEL_CONNECTED') - o.created_at)) / 3600.0)::numeric, 1) as h_noi_kenh,
  round((extract(epoch from (max(m.reached_at) filter (where m.milestone = 'CATALOG_IMPORTED') - o.created_at)) / 3600.0)::numeric, 1) as h_co_san_pham,
  round((extract(epoch from (max(m.reached_at) filter (where m.milestone = 'FIRST_CONVERSATION') - o.created_at)) / 3600.0)::numeric, 1) as h_tin_khach_dau,
  round((extract(epoch from (max(m.reached_at) filter (where m.milestone = 'FIRST_AI_REPLY') - o.created_at)) / 3600.0)::numeric, 1) as h_ai_tra_loi_dau,
  round((extract(epoch from (max(m.reached_at) filter (where m.milestone = 'FIRST_AI_ORDER') - o.created_at)) / 3600.0)::numeric, 1) as h_don_ai_dau,
  round((extract(epoch from (max(m.reached_at) filter (where m.milestone = 'FIRST_DELIVERED_AI_ORDER') - o.created_at)) / 3600.0)::numeric, 1) as h_don_giao_dau
from platform_organizations o
left join platform_accounts a on a.id = o.account_id
left join platform_org_milestones m on m.org_code = o.code
where not o.is_home
group by o.code, o.brand, a.source, o.status, o.created_at
order by o.created_at;
```

### Q3 — Phễu kích hoạt theo nhóm tạo
```sql
select case when o.brand is not null then 'tu_dang_ky' else 'nguoi_van_hanh_tao' end as nhom,
       count(distinct o.code) as so_workspace,
       count(distinct m.org_code) filter (where m.milestone = 'CHANNEL_CONNECTED') as noi_kenh,
       count(distinct m.org_code) filter (where m.milestone = 'CATALOG_IMPORTED') as co_san_pham,
       count(distinct m.org_code) filter (where m.milestone = 'FIRST_CONVERSATION') as tin_khach_dau,
       count(distinct m.org_code) filter (where m.milestone = 'FIRST_AI_REPLY') as ai_tra_loi_dau,
       count(distinct m.org_code) filter (where m.milestone = 'FIRST_AI_ORDER') as don_ai_dau,
       count(distinct m.org_code) filter (where m.milestone = 'FIRST_DELIVERED_AI_ORDER') as don_giao_dau
from platform_organizations o
left join platform_org_milestones m on m.org_code = o.code
where not o.is_home and o.status = 'ACTIVE'
group by 1
order by 1;
```

### Q4 — Trung vị giờ tới từng mốc, kèm cỡ mẫu và số mốc âm
```sql
select case when o.brand is not null then 'tu_dang_ky' else 'nguoi_van_hanh_tao' end as nhom,
       m.milestone,
       count(*) as n,
       count(*) filter (where m.reached_at < o.created_at) as so_moc_am,
       round((percentile_cont(0.5) within group (order by (extract(epoch from (m.reached_at - o.created_at)) / 3600.0)::float8))::numeric, 1) as trung_vi_gio,
       round((min(extract(epoch from (m.reached_at - o.created_at))) / 3600.0)::numeric, 1) as nhanh_nhat_gio,
       round((max(extract(epoch from (m.reached_at - o.created_at))) / 3600.0)::numeric, 1) as cham_nhat_gio
from platform_org_milestones m
join platform_organizations o on o.code = m.org_code
where not o.is_home and m.milestone <> 'SIGNED_UP'
group by 1, 2
order by 1, min(m.reached_at);
```
Đọc: `n < 3` ⇒ in «—» thay cho trung vị khi đưa vào báo cáo.

### Q5 — Độ tươi của sổ mốc và sổ dùng (chạy TRƯỚC Q2–Q4)
```sql
select (select max(observed_at) from platform_org_milestones) as quet_moc_cuoi,
       (select max(captured_at) from platform_saas_daily) as chup_saas_cuoi,
       (select max(captured_at) from platform_tenant_usage_daily) as chup_dung_cuoi,
       (select min(day) from platform_tenant_usage_daily) as so_dung_tu_ngay,
       (select count(*) from platform_organizations where not is_home and status = 'ACTIVE') as workspace_active;
```

### Q6 — Page Messenger trực tiếp đầu tiên theo workspace
```sql
select org_code, count(*) as so_page, min(created_at) as page_dau_tien, max(updated_at) as cap_nhat_cuoi
from platform_messenger_pages
group by org_code
order by 3;
```
Không chọn `page_name`, `connected_by_email`.

### Q7 — Lượt AI bán hàng đầu tiên theo sổ AI (bổ trợ M3)
```sql
select org_code,
       min(at) filter (where status = 'OK') as ai_ok_dau_tien,
       min(at) filter (where status = 'OK' and conversation_id is not null) as ai_ok_co_hoi_thoai_dau_tien,
       min(at) filter (where status = 'ERROR') as ai_loi_dau_tien,
       count(*) filter (where status = 'OK') as luot_ok,
       count(*) filter (where status = 'ERROR') as luot_loi,
       count(*) filter (where status = 'BLOCKED_QUOTA') as luot_bi_chan,
       string_agg(distinct billing_source, ',') as nguon_tra_tien
from platform_ai_usage
where feature in ('sales_chatbot', 'sales_playbook')
group by org_code
order by 2 nulls last;
```
Giới hạn: sổ AI không mang kênh, nên lượt ở khung thử (TEST) cũng tính. Đây là mốc «AI chạy lần đầu», không phải «AI trả lời khách
thật»; mốc thật là `FIRST_AI_REPLY` ở Q2.

### Q8 — Khách AI đầu tiên (đồng hồ thu V1, ghi từ 07/10)
```sql
select org_code,
       min(occurred_at) filter (where quantity > 0) as khach_ai_dau_tien,
       sum(quantity) as khach_ai_tu_khi_ghi,
       min(recorded_at) as ghi_dau_tien
from platform_usage_events
where product_key = 'chotdon' and metric = 'ai_customers'
group by org_code
order by 2 nulls last;
```
Luôn `sum(quantity)`, không `count(*)`: dòng bí danh mang `quantity = 0` (`docs/saas/AI_COST_WORKLOAD.md` §1).

### Q9 — Hoạt động 14 ngày (tín hiệu giữ chân sớm)
```sql
select org_code,
       count(*) as so_ngay_co_dong,
       count(*) filter (where customer_messages > 0) as ngay_co_tin_khach,
       count(*) filter (where bot_messages > 0) as ngay_ai_tra_loi,
       sum(conversations_started) as hoi_thoai_moi,
       sum(ai_orders) as don_ai,
       min(day) as tu_ngay, max(day) as toi_ngay
from platform_tenant_usage_daily
where day >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 13
group by org_code
order by org_code;
```
Ngày không có dòng là CHƯA ĐO, không phải 0 (`11_SAAS_METRICS_SPEC.md` §10) — luôn đọc `so_ngay_co_dong` trước.

### Q10 — Lần đăng nhập cuối theo workspace
```sql
select org_code, max(last_used_at) as dang_nhap_cuoi, count(distinct user_id) as so_tai_khoan
from platform_identities
group by org_code
order by 2 desc nulls last;
```
Không chọn cột `value` (email / SĐT).

### Q11 — Bất biến F-02: workspace tự đăng ký không có thuê bao sống
```sql
select o.brand, a.source as nguon_tai_khoan, count(*) as workspace,
       count(*) filter (where not exists (
         select 1 from platform_product_subscriptions s where s.org_code = o.code and s.ended_at is null
       )) as khong_thue_bao_song
from platform_organizations o
left join platform_accounts a on a.id = o.account_id
where not o.is_home and (o.brand is not null or a.source = 'SIGNUP')
group by o.brand, a.source
order by 1, 2;
```
Sau khi PR F-02 lên production và lượt sửa dữ liệu (nếu chủ shop duyệt) chạy xong, cột `khong_thue_bao_song` phải bằng 0. Đây là
phép kiểm đề xuất A19 của Auditor (`README.md` §4).

## 4. Phần cần CSDL tổ chức — công cụ cần có

`db-query` chỉ mở CSDL nhà (`docs/revenue-os/MASTER_MISSION_STATUS.md` mục «Đo lường phát hiện được»). Ops chỉ đọc theo một tổ
chức đã có: `scripts/org-summary.ts` (mở bằng `getDbForInspection`, ép `ERP_READ_ONLY=1`, không đọc cột dữ liệu người, kết quả mã
hoá). Đề xuất, theo thứ tự rẻ nhất:

| Việc | Đo được gì | Cách | Mức |
|---|---|---|---|
| TV-1 | M4 order candidate đầu tiên · M5 gồm cả đơn máy ghi từ hội thoại nhân viên | Thêm mốc MỚI vào `ACTIVATION_MILESTONES` (ví dụ `FIRST_ORDER_DRAFT`: min `orders.created_at` nối `draft_order_id` hoặc sự kiện `order.drafted`; `FIRST_CHAT_ORDER`: min `orders.created_at` có `sales_conversation_id`, stage ≠ huỷ / xoá). Lượt chụp tự ghi vào sổ nhà, Q2–Q4 tự có thêm cột. **Không đổi định nghĩa `FIRST_AI_ORDER`**: sổ ghi một lần (`ON CONFLICT DO NOTHING`), đổi định nghĩa không sửa được dòng đã ghi và làm hai thời kỳ đứng trên hai luật (cùng tinh thần AGENTS 37, 40) | R1 · PR mã nhỏ trong `lib/platform/saas-*` (sàn HIGH nếu chủ shop thêm `lib/saas/` vào sàn — `RISK_SCALE.md` §7) |
| TV-2 | M1 cho Zalo OA và ô chat web | Thêm `zalo-oa` vào `CHANNEL_CONNECTOR_KEYS` (`saas-metrics.ts:302`); ô chat web không có kết nối — mốc của nó là hội thoại kênh WEB đầu tiên (đã nằm trong M2) | R1 |
| TV-3 | Mốc CHÍNH XÁC tới phút: tin khách đầu tiên (`sales_chat_inbound`), câu AI đầu tiên, lần đầu bị chặn / lỗi | Khối «TTV» trong `scripts/org-summary.ts`: chỉ số đếm + mốc, không nội dung. Lưu ý ghi chép dự án: ops lấy script từ `main` nhưng `lib/` từ image đang chạy ⇒ script chỉ được gọi hàm `lib/` ĐÃ deploy | R1 · PR chỉ-script |
| TV-4 | Lý do kẹt ở từng mốc (chưa có sản phẩm có giá, bot tắt, chưa nối kênh) | `assessReadiness` (`lib/sales-chatbot/readiness-shared.ts:34`) chạy chỉ đọc cho từng workspace kẹt, in mã kiểm + trạng thái | R1 · cùng PR TV-3 |

Câu hỏi cho chủ shop (đích kinh doanh — AGENTS 3.38, máy không tự đặt): TTV tới «AI trả lời khách thật» bao nhiêu giờ thì coi là
đạt? Workspace kẹt ở một mốc bao nhiêu ngày thì cần người gọi hỗ trợ?
