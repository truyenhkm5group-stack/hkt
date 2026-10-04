# 17 · Sổ rủi ro — chương trình AI Sales Agent

> Mỗi dòng: rủi ro · khả năng · tác động · đang chặn bằng gì · việc còn lại · người quyết. Đo 04/10/2026. Nợ kỹ thuật chi
> tiết ở `TECH_DEBT.md` (mã TD-xx); dòng nào trùng ghi mã TD.

| Mã | Rủi ro | Khả năng | Tác động | Đang chặn bằng | Còn lại | Ai quyết |
|---|---|---|---|---|---|---|
| R-1 | Bot nói sai giá / bán quá tồn với khách thật | Thấp | Cao | Lõi đơn tự tính lại đơn giá + kiểm tồn trong giao dịch (#525); cờ «giá không căn cứ» trong Phát lại | Theo dõi tỷ lệ cờ ở các lượt phát lại trước khi bật tự động | Kỹ thuật |
| R-2 | Rò dữ liệu chéo tổ chức qua đường mới (kênh, job, đệm) | Thấp | Rất cao | SILO + quét tĩnh S17–S21 + bài tấn công (#532) | Mỗi kênh / bảng mới phải vào ảnh chụp bài tấn công | Kỹ thuật |
| R-3 | Mã dùng chung mang nội dung của một khách (mẫu chiến dịch «HSLC – Wholesale F&B») | Đã xảy ra (dữ liệu mẫu) | Thấp | Chỉ là mẫu, không tự chạy (AGENTS §23), không rẽ nhánh | Đổi tên mẫu thành mẫu ngành (F&B sỉ) khi có khách sỉ thứ hai | Kỹ thuật |
| R-4 | Va số migration giữa các phiên song song | Cao | Vừa (CI đỏ, chặn deploy) | `migration:renumber`, bài kiểm sổ migration; phân vai qua SendMessage | Đẩy và gộp ngay sau khi đánh số | Kỹ thuật |
| R-5 | Kết luận «AI tốt hơn người» trên mẫu không so sánh được | Vừa | Cao (quyết định kinh doanh sai) | Thử nghiệm chia ngẫu nhiên + ghim nhánh; mẫu < ngưỡng ⇒ null | Đủ mẫu mới đọc; không có ngưỡng tự bật tự động | Chủ shop |
| R-6 | Biên lợi nhuận SaaS trông đẹp vì thiếu chi phí | Vừa | Vừa | Chưa khai hạ tầng ⇒ biên gộp «—», chỉ in «chỉ trừ AI» kèm nhãn | Chủ nền tảng khai chi phí | Chủ shop |
| R-7 | Copilot đo nhầm: trả lời tự động của Meta bị coi là câu người | Cao | Thấp | Ghi rõ ở màn hình + tài liệu; trung vị độ giống in cạnh nhãn | Lọc tin tự động khi Pancake đánh dấu được | Kỹ thuật |
| R-8 | Chi phí AI phát lại / copilot ngoài dự tính | Thấp | Thấp | Trần 20 điểm / lượt, một lượt mỗi lúc, đi qua hạn mức AI của tổ chức | — | Chủ shop (hạn mức gói) |
| R-9 | VPS 2 nhân không chịu nhiều tổ chức | Vừa (khi > 5 khách trả tiền) | Cao | `docs/platform/scale-plan.md` | Ngân sách tách máy CSDL, lịch song song có trần | Chủ shop |
| R-10 | Hành vi bot nhà (`chatbot/`, thời trang) và bot đa tổ chức khác nhau | Cao | Vừa | Hai đường riêng, có tài liệu | M10 — dogfood từng page, chủ shop duyệt | Chủ shop |
| R-11 | Câu trả lời của nhân viên không mang danh tính ⇒ không có benchmark theo người | Chắc chắn (hiện tại) | Vừa | Chỉ số theo người khai UNAVAILABLE | M8 hộp thư người trong ERP | Kỹ thuật |
