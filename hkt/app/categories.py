"""
Hệ thống danh mục (chart of categories) cho shop bán hàng online.

Mỗi danh mục thuộc về một NHÓM KẾ TOÁN (grp). Nhóm quyết định danh mục
được đưa vào dòng nào của Báo cáo kết quả kinh doanh (theo mẫu B02-DN của
Thông tư 200, rút gọn cho hộ kinh doanh cá thể - Thông tư 88/2021/TT-BTC).

Số hiệu tài khoản (account) chỉ mang tính tham chiếu để người dùng quen hệ
thống tài khoản kế toán Việt Nam dễ đối chiếu.

kind:  'in'  = thường là tiền vào (ghi có)
       'out' = thường là tiền ra (ghi nợ)
       'any' = có thể cả hai chiều
"""

# (code, name, account, kind, description)
GROUPS = [
    ("REVENUE", "Doanh thu bán hàng", "511", "in",
     "Tiền khách hàng, sàn TMĐT, đơn vị vận chuyển (COD) thanh toán cho shop."),
    ("REVENUE_DEDUCTION", "Giảm trừ doanh thu", "521", "out",
     "Hoàn tiền, trả hàng, chiết khấu, giảm giá cho khách."),
    ("COGS", "Giá vốn hàng bán", "632", "out",
     "Tiền nhập hàng, chi phí đưa hàng về kho."),
    ("SELLING", "Chi phí bán hàng", "641", "out",
     "Chi phí phát sinh để bán được hàng: ship, đóng gói, quảng cáo, phí sàn."),
    ("ADMIN", "Chi phí quản lý", "642", "out",
     "Chi phí vận hành chung: lương, mặt bằng, điện nước, phần mềm."),
    ("FIN_INCOME", "Doanh thu tài chính", "515", "in",
     "Lãi tiền gửi, lãi cho vay."),
    ("FIN_EXPENSE", "Chi phí tài chính", "635", "out",
     "Phí ngân hàng, lãi vay."),
    ("OTHER_INCOME", "Thu nhập khác", "711", "in",
     "Các khoản thu không thuộc hoạt động kinh doanh chính."),
    ("OTHER_EXPENSE", "Chi phí khác", "811", "out",
     "Các khoản chi bất thường: phạt, bồi thường, mất mát."),
    ("TAX", "Thuế thu nhập / thuế khoán", "821", "out",
     "Thuế GTGT + TNCN của hộ kinh doanh đã nộp (không tính lệ phí môn bài)."),
    ("NON_PL", "Không tính vào lãi/lỗ", "", "any",
     "Giao dịch chỉ ảnh hưởng Bảng cân đối (vốn, vay, chuyển nội bộ, mua tài sản)."),
    ("UNCLASSIFIED", "Chưa phân loại", "", "any",
     "Cần người dùng gán nhãn."),
]

# Thứ tự nhóm xuất hiện trong báo cáo và giao diện
GROUP_ORDER = [g[0] for g in GROUPS]

# (code, name, grp, kind, description)
CATEGORIES = [
    # ---- Doanh thu (511)
    ("DT_BAN_HANG", "Doanh thu bán hàng", "REVENUE", "in",
     "Khách chuyển khoản mua hàng, sàn TMĐT/đơn vị vận chuyển trả tiền COD."),
    ("DT_DICH_VU", "Doanh thu dịch vụ", "REVENUE", "in",
     "Thu từ dịch vụ kèm theo (gia công, lắp đặt, tư vấn...)."),
    # ---- Giảm trừ doanh thu (521)
    ("HOAN_TIEN", "Hoàn tiền / trả hàng", "REVENUE_DEDUCTION", "out",
     "Trả lại tiền cho khách do trả hàng, huỷ đơn."),
    ("CHIET_KHAU", "Chiết khấu / giảm giá", "REVENUE_DEDUCTION", "out",
     "Chiết khấu thương mại, giảm giá hàng bán trả bằng tiền."),
    # ---- Giá vốn (632)
    ("MUA_HANG", "Nhập hàng hoá", "COGS", "out",
     "Trả tiền nhà cung cấp mua hàng để bán. Tiền NCC hoàn lại cũng gán ở đây (giảm giá vốn)."),
    ("VAN_CHUYEN_MUA", "Vận chuyển hàng mua về", "COGS", "out",
     "Phí ship/nhập khẩu để đưa hàng về kho - tính vào giá gốc hàng tồn kho."),
    ("NGUYEN_LIEU", "Nguyên vật liệu sản xuất", "COGS", "out",
     "Nguyên liệu để tự sản xuất/chế biến sản phẩm bán ra."),
    # ---- Chi phí bán hàng (641)
    ("VAN_CHUYEN_BAN", "Phí giao hàng cho khách", "SELLING", "out",
     "Trả cho GHN, GHTK, Viettel Post, J&T... để giao hàng cho khách."),
    ("DONG_GOI", "Bao bì, đóng gói", "SELLING", "out",
     "Thùng, túi, băng keo, tem nhãn..."),
    ("QUANG_CAO", "Quảng cáo, marketing", "SELLING", "out",
     "Facebook/Meta Ads, Google Ads, TikTok Ads, Shopee Ads, KOL..."),
    ("PHI_SAN", "Phí sàn TMĐT", "SELLING", "out",
     "Phí cố định, phí thanh toán, phí dịch vụ của Shopee/Lazada/TikTok Shop."),
    ("HOA_HONG", "Hoa hồng / affiliate", "SELLING", "out",
     "Hoa hồng cộng tác viên, tiếp thị liên kết."),
    ("KHUYEN_MAI", "Quà tặng, khuyến mãi", "SELLING", "out",
     "Voucher, quà tặng kèm, hàng mẫu."),
    ("CP_BAN_HANG_KHAC", "Chi phí bán hàng khác", "SELLING", "out", ""),
    # ---- Chi phí quản lý (642)
    ("LUONG", "Lương, thuê nhân công", "ADMIN", "out",
     "Lương nhân viên, thuê người đóng gói, thuê chốt đơn."),
    ("THUE_MAT_BANG", "Thuê mặt bằng / kho", "ADMIN", "out", ""),
    ("DIEN_NUOC_INTERNET", "Điện, nước, internet, điện thoại", "ADMIN", "out", ""),
    ("PHAN_MEM", "Phần mềm, công cụ", "ADMIN", "out",
     "Phần mềm bán hàng, Canva, ChatGPT, tên miền, hosting..."),
    ("VAN_PHONG_PHAM", "Văn phòng phẩm, dụng cụ nhỏ", "ADMIN", "out",
     "Dụng cụ, thiết bị giá trị nhỏ dùng ngay."),
    ("LE_PHI_MON_BAI", "Lệ phí môn bài, phí, lệ phí", "ADMIN", "out",
     "Lệ phí môn bài và các loại phí/lệ phí nhà nước (TT200 hạch toán vào 642)."),
    ("CP_QUAN_LY_KHAC", "Chi phí quản lý khác", "ADMIN", "out", ""),
    # ---- Tài chính (515 / 635)
    ("LAI_NGAN_HANG", "Lãi tiền gửi", "FIN_INCOME", "in", ""),
    ("PHI_NGAN_HANG", "Phí ngân hàng", "FIN_EXPENSE", "out",
     "Phí chuyển khoản, phí SMS banking, phí quản lý tài khoản, phí thường niên."),
    ("LAI_VAY", "Lãi vay", "FIN_EXPENSE", "out",
     "Chỉ phần LÃI. Phần gốc vay gán vào 'Trả nợ gốc vay'."),
    # ---- Khác (711 / 811)
    ("THU_KHAC", "Thu nhập khác", "OTHER_INCOME", "in",
     "Tiền bồi thường, thanh lý tài sản, thu nợ khó đòi..."),
    ("CHI_KHAC", "Chi phí khác", "OTHER_EXPENSE", "out", ""),
    ("PHAT_BOI_THUONG", "Phạt, bồi thường", "OTHER_EXPENSE", "out", ""),
    # ---- Thuế (821)
    ("THUE_KHOAN", "Thuế GTGT + TNCN đã nộp", "TAX", "out",
     "Thuế khoán / thuế theo doanh thu của hộ kinh doanh nộp cho Kho bạc."),
    # ---- Không tính vào lãi/lỗ
    ("VON_GOP", "Chủ shop góp vốn", "NON_PL", "in",
     "Tiền cá nhân bỏ vào tài khoản shop (TK 411)."),
    ("RUT_VON", "Chủ shop rút tiền cá nhân", "NON_PL", "out",
     "Rút lợi nhuận / tiền cá nhân ra khỏi shop. KHÔNG phải chi phí."),
    ("VAY_NHAN", "Nhận tiền vay", "NON_PL", "in", "Tiền vay ngân hàng, người thân (TK 341)."),
    ("TRA_NO_GOC", "Trả nợ gốc vay", "NON_PL", "out", "Phần gốc. Lãi gán vào 'Lãi vay'."),
    ("CHUYEN_NOI_BO", "Chuyển giữa tài khoản của mình", "NON_PL", "any",
     "Chuyển sang tài khoản/ví khác của chính shop, rút tiền mặt để nhập quỹ."),
    ("THU_HO_CHI_HO", "Thu hộ / chi hộ", "NON_PL", "any",
     "Tiền đi qua tài khoản nhưng không phải của shop (mua giúp, trả giúp)."),
    ("MUA_TAI_SAN", "Mua tài sản, thiết bị lớn", "NON_PL", "out",
     "Máy tính, máy in, kệ hàng... giá trị lớn dùng nhiều năm (TK 211/242) - phân bổ dần, không tính chi phí một lần."),
    ("DAT_COC_NCC", "Đặt cọc / tạm ứng cho nhà cung cấp", "NON_PL", "out",
     "Chuyển thành giá vốn khi nhận hàng (TK 331)."),
    # ---- Chưa phân loại
    ("CHUA_PHAN_LOAI", "Chưa phân loại", "UNCLASSIFIED", "any", ""),
]

UNCLASSIFIED_CODE = "CHUA_PHAN_LOAI"

# Các quy tắc gán nhãn tự động mặc định.
# (name, pattern, match_type, direction, category_code, priority, field)
# pattern với match_type='contains': các từ khoá cách nhau bởi '|', so khớp
# trên chuỗi đã bỏ dấu + viết thường. field = 'all' (nội dung + đối tác),
# 'description' hoặc 'counterparty'. Chuỗi "{owner}" trong pattern được thay
# bằng tên chủ tài khoản trong Cài đặt (tự điền khi nhập sao kê).
# priority nhỏ hơn = xét trước.
DEFAULT_RULES = [
    # Chủ tài khoản chuyển cho chính mình (tài khoản/ví khác) - không phải doanh thu/chi phí
    ("Chuyển tiền cho chính mình", "{owner}", "contains", "any", "CHUYEN_NOI_BO", 5, "counterparty"),
    ("Trả nợ thẻ tín dụng", "thu no the tin dung|tra no the tin dung|the tin dung|credit card", "contains", "out", "TRA_NO_GOC", 8, "all"),
    # Ngân hàng
    ("Lãi tiền gửi", "lai tien gui|tra lai|lai nhap goc|lai suat|interest", "contains", "in", "LAI_NGAN_HANG", 10, "all"),
    ("Phí ngân hàng", "phi sms|sms banking|phi chuyen tien|phi chuyen khoan|phi quan ly tai khoan|phi thuong nien|phi duy tri|phi giao dich|phi dich vu ngan hang|phi dv nh|phi ck|phi tin nhan", "contains", "out", "PHI_NGAN_HANG", 10, "all"),
    ("Nộp thuế", "nop thue|kho bac|thue gtgt|thue tncn|thue khoan|tong cuc thue|cuc thue|chi cuc thue", "contains", "out", "THUE_KHOAN", 10, "all"),
    ("Lệ phí môn bài", "mon bai|le phi", "contains", "out", "LE_PHI_MON_BAI", 12, "all"),
    # Hoàn tiền
    ("Hoàn tiền khách", "hoan tien|hoan lai|refund|tra lai tien|huy don|tra hang", "contains", "out", "HOAN_TIEN", 20, "all"),
    # Quảng cáo
    ("Quảng cáo", "facebook|fb ads|meta platforms|metaplatforms|google ads|google*|tiktok ads|shopee ads|quang cao|ads", "contains", "out", "QUANG_CAO", 30, "all"),
    # Sàn TMĐT trả tiền cho shop
    ("Sàn TMĐT thanh toán", "shopee|lazada|tiktok shop|tiktokshop|sendo|tiki|ecommerce|payout", "contains", "in", "DT_BAN_HANG", 40, "all"),
    ("Phí sàn", "shopee|lazada|tiktok shop|sendo|tiki|phi san|phi dich vu san", "contains", "out", "PHI_SAN", 41, "all"),
    # Đơn vị vận chuyển: tiền vào = COD thu hộ, tiền ra = phí ship
    ("Vận chuyển COD về", "ghn|giao hang nhanh|ghtk|giao hang tiet kiem|viettel post|viettelpost|vtp|j&t|jt express|jnt|ninja van|ninjavan|best express|ahamoke|ahamove|grab|cod", "contains", "in", "DT_BAN_HANG", 50, "all"),
    ("Phí ship", "ghn|giao hang nhanh|ghtk|giao hang tiet kiem|viettel post|viettelpost|vtp|j&t|jt express|jnt|ninja van|ninjavan|best express|ahamove|grab|phi ship|phi van chuyen|giao hang", "contains", "out", "VAN_CHUYEN_BAN", 51, "all"),
    # Nhập hàng
    ("Nhập hàng", "nhap hang|mua hang|lay hang|tien hang|thanh toan hang|tt hang|don hang ncc|nha cung cap|xuong|1688|taobao|alibaba", "contains", "out", "MUA_HANG", 60, "all"),
    ("Đóng gói", "thung carton|bao bi|tui zip|bang keo|dong goi|tem nhan|hop giay", "contains", "out", "DONG_GOI", 61, "all"),
    # Quản lý
    ("Điện nước internet", "dien luc|evn|tien dien|tien nuoc|cap nuoc|internet|fpt telecom|vnpt|viettel telecom|cuoc dien thoai|nap tien dien thoai|wifi", "contains", "out", "DIEN_NUOC_INTERNET", 55, "all"),
    ("Thuê mặt bằng", "thue nha|tien nha|mat bang|thue kho|tien kho|tien phong", "contains", "out", "THUE_MAT_BANG", 55, "all"),
    ("Lương", "luong|tra luong|tien cong|thuong tet", "contains", "out", "LUONG", 55, "all"),
    ("Phần mềm", "phan mem|subscription|canva|openai|chatgpt|kiotviet|sapo|haravan|nhanh.vn|pancake|hosting|ten mien|domain|google workspace|microsoft", "contains", "out", "PHAN_MEM", 70, "all"),
    # Vốn / vay / nội bộ
    ("Góp vốn", "gop von|bo von|von kinh doanh", "contains", "in", "VON_GOP", 80, "all"),
    ("Rút vốn", "rut von|chi tieu ca nhan|tieu ca nhan", "contains", "out", "RUT_VON", 80, "all"),
    ("Nhận vay", "vay|giai ngan", "contains", "in", "VAY_NHAN", 81, "all"),
    ("Trả nợ gốc", "tra no|tra goc|tra tien vay|thanh toan khoan vay", "contains", "out", "TRA_NO_GOC", 81, "all"),
    ("Chuyển nội bộ", "chuyen noi bo|tiet kiem|momo|zalopay|vnpay vi|shopeepay|nap vi|rut tien mat|atm", "contains", "any", "CHUYEN_NOI_BO", 85, "all"),
    # Khách chuyển khoản mua hàng (chung nhất - xét cuối)
    ("Khách thanh toán", "thanh toan|tt don|don hang|mua|ck|chuyen khoan|chuyen tien|tien hang", "contains", "in", "DT_BAN_HANG", 90, "all"),
]

DEFAULT_SETTINGS = {
    "shop_name": "Shop của tôi",
    "bank_name": "MB Bank",
    "account_no": "",
    "owner_name": "",
    # Thuế hộ kinh doanh (ngành phân phối, cung cấp hàng hoá): GTGT 1%, TNCN 0,5% trên doanh thu
    "tax_vat_rate": "1.0",
    "tax_pit_rate": "0.5",
    # Ngưỡng doanh thu/năm phải nộp thuế GTGT/TNCN (từ 01/01/2026: 200 triệu)
    "tax_threshold_year": "200000000",
}


def category_map():
    return {c[0]: {"code": c[0], "name": c[1], "grp": c[2], "kind": c[3], "description": c[4]}
            for c in CATEGORIES}


def group_map():
    return {g[0]: {"code": g[0], "name": g[1], "account": g[2], "kind": g[3], "description": g[4]}
            for g in GROUPS}
