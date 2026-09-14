# Bản phát hành 12/09/2026 — Tách miền CSKH / giao vận + hành động nhanh trên dòng

SHA ứng viên: `fd83d5b` (nhánh `claude/cskh-workqueue-cleanup`, đã gộp vào `main`).
Bản đang chạy trước đó: `2a51d89` (deploy #238).

Đặc tả luật: `lib/constants/cs-domain.ts` · Bài kiểm khoá: `tests/cs-workqueue.test.ts`.

---

## 1. Việc bản này làm

1. Case sinh từ **trạng thái vận chuyển** rời khỏi hàng đợi CSKH và thuộc về **Vận đơn & care**:
   `DELIVERY_FAILED` (luôn luôn), `WRONG_ADDRESS` / `WRONG_PHONE` **khi đơn đang có vận đơn chưa
   kết thúc**. Không xoá dữ liệu: bộ lọc **Miền** trên `/cs` vẫn tra ra chúng.
2. Một sự việc chỉ sinh **một** dòng việc: case giao vận không còn đẻ thêm thông báo `CS_CASE` /
   `CS_CASE_GROUP` bên cạnh `SHIPMENT_FAILED` và dòng care của chính kiện đó.
3. Mọi con số "tồn đọng CSKH" (thẻ đầu trang, hàng đợi việc, khâu `LEAD` của bảng điều hành) chỉ
   đếm miền CSKH.
4. Mỗi loại case có 1–3 nút làm việc ngay trên dòng, cộng ghi chú nhanh và hẹn lại.

## 2. Đo trên production TRƯỚC khi deploy

Chạy bằng **Actions → "Vận hành ERP trên VPS" → `db-query`**, dán từng câu vào ô `arg`
(một câu mỗi lần chạy — CTE không tồn tại sang câu sau).

### 2.1 Tổng case còn phải làm, tách theo miền và theo loại

```sql
with c as (
  select cc.kind,
         (cc.kind = 'DELIVERY_FAILED'
          or (cc.kind in ('WRONG_ADDRESS','WRONG_PHONE')
              and exists (select 1 from shipments s
                           where s.order_id = cc.order_id and s.is_final = false))) as la_giao_van
    from cs_cases cc
   where cc.status in ('OPEN','IN_PROGRESS')
)
select coalesce(kind, '— TỔNG —') as loai,
       count(*)::int                                as tong,
       count(*) filter (where la_giao_van)::int     as thuoc_giao_van,
       count(*) filter (where not la_giao_van)::int as con_lai_cskh
  from c
 group by rollup(kind)
 order by tong desc;
```

Đọc kết quả: dòng `— TỔNG —` cho ba con số của báo cáo — **tổng case CSKH trước**,
**số case bị loại khỏi CSKH**, **số case CSKH thật còn lại**. Các dòng còn lại là breakdown theo
loại.

### 2.2 Số việc bị trùng giữa hai module

```sql
select count(*)::int as case_giao_van_dang_co_kien_chay
  from cs_cases cc
  join shipments s on s.order_id = cc.order_id and s.is_final = false
 where cc.status in ('OPEN','IN_PROGRESS')
   and cc.kind in ('DELIVERY_FAILED','WRONG_ADDRESS','WRONG_PHONE');
```

Mỗi dòng đếm được ở đây trước bản này là **hai** work item cho cùng một kiện (một ở CSKH, một ở
hàng đợi care / `SHIPMENT_FAILED`); sau bản này còn **một**.

### 2.3 Mẫu thật để chứng minh phân loại đúng

```sql
select cc.id, cc.kind, cc.status, coalesce(nullif(cc.assignee,''),'(chưa ai nhận)') as phu_trach,
       cc.created_by, left(cc.title, 70) as tieu_de,
       s.vtp_order_number, s.stage::text as chang_dvvc, s.is_final
  from cs_cases cc
  left join shipments s on s.order_id = cc.order_id and s.is_final = false
 where cc.status in ('OPEN','IN_PROGRESS')
 order by (cc.kind = 'DELIVERY_FAILED') desc, cc.created_at desc
 limit 25;
```

Kỳ vọng: mọi dòng `DELIVERY_FAILED` có `created_by = 'failed-delivery-bot'`; mọi dòng
`WRONG_ADDRESS` / `WRONG_PHONE` **có** `vtp_order_number` là case chuyển sang giao vận, **không có**
thì ở lại CSKH.

## 3. Deploy

Bản này **KHÔNG tự deploy**: workflow `Deploy ERP to VPS` chỉ chạy bằng `workflow_dispatch`.
Vào Actions → **Deploy ERP to VPS** → Run workflow trên `main` (`reset_env` để nguyên `false`),
xác nhận SHA của run đúng bằng `fd83d5b`, và chờ run xanh.

Migration `0067_cs_workqueue` tự áp lúc app khởi động: thêm `cs_cases.follow_up_at` và bảng
`cs_case_events`. Viết tay, idempotent, chỉ CỘNG THÊM — không sửa dòng dữ liệu nào đang có.

## 4. Kiểm tra SAU deploy

1. `GET /api/health` → `commit` bằng `fd83d5b`.
2. Chạy lại **2.1**. Ba con số phải **y hệt** lần đo trước: bản này không đổi dữ liệu, chỉ đổi chỗ
   hiển thị và chỗ đếm. Lệch nghĩa là có job vừa tạo/đóng case, không phải bản này làm.
3. `/cs` — không còn dòng "Giao không thành · liên hệ khách"; dải thông báo ở đầu trang nói đúng số
   case đã chuyển sang Vận đơn & care; thẻ "Còn phải làm" bằng cột `con_lai_cskh` của 2.1.
4. `/cs?domain=LOGISTICS` — vẫn tra ra đủ số case đó, mỗi dòng có nút **Mở care vận đơn**.
5. `/shipments` — các kiện tương ứng vẫn nằm đúng rổ (Giao thất bại / Khách không nghe máy / Chờ
   giao lại), số "cần care" không giảm.
6. Bấm thử trên `/cs`: **Nhận việc**, **Đã liên hệ**, **Hẹn lại** (chọn "+2 giờ"), **+ Ghi chú** —
   kết quả phải hiện ngay tại dòng, không nhảy trang; mở lại **Xem bằng chứng** thấy lịch sử vừa ghi.
