# TFT Item Lookup Desktop

Ứng dụng Electron cá nhân để tra cứu thống kê item, cặp item và bộ ba item theo tướng.

## Chạy

```powershell
npm install
npm test
npm start
```

Tạo installer Windows không cần quyền administrator:

```powershell
npm run package:win
```

File cài đặt được tạo trong `dist/TFT Item Lookup Setup 0.1.0.exe`.

## Auto-update

Bản phát hành chính thức dùng `electron-updater` với GitHub Releases. Bản build thường (`npm run package:win`) không bật update để không trỏ nhầm vào repository chưa cấu hình.

Để phát hành bản có auto-update, cần chuẩn bị:

- GitHub repository chứa app và một GitHub token có quyền tạo release.
- Chứng thư Authenticode trong `CSC_LINK` và mật khẩu trong `CSC_KEY_PASSWORD`.
- `TFT_GITHUB_OWNER`, `TFT_GITHUB_REPO` và `GH_TOKEN`.

Sau đó tăng `version` trong `package.json` và chạy:

```powershell
$env:TFT_GITHUB_OWNER = "your-owner"
$env:TFT_GITHUB_REPO = "tft-item-lookup"
$env:GH_TOKEN = "..."
$env:CSC_LINK = "C:\certificates\windows.p12"
$env:CSC_KEY_PASSWORD = "..."
npm run package:release
```

Workflow `.github/workflows/release.yml` đã có sẵn để tự động test, ký số và publish khi push tag dạng `v0.1.1`.

## Nguồn dữ liệu và giới hạn

- Adapter dùng danh sách tướng và trang chi tiết công khai của `tactics.tools`.
- Advanced Explorer hiện có thể yêu cầu Patreon khi chưa đăng nhập; ứng dụng báo rõ trạng thái này thay vì suy diễn dữ liệu.
- `Region`, `Level`, `Item Count`, `Last Round` và `Date` được giữ trong mô hình bộ lọc nhưng đang khóa trên UI vì route công khai của trang chi tiết chưa chứng minh các tham số này được áp dụng.
- Cache nằm trong thư mục `userData` của Electron, TTL 15 phút. Khi request mới lỗi, cache cũ được hiển thị kèm thời điểm cập nhật.
- Không đăng nhập, không vượt CAPTCHA, không gọi URL được chèn từ dữ liệu nguồn; chỉ dùng các host/URL đã cấu hình.
- Giao diện có chế độ tối/sáng, combobox tìm tướng, skeleton loading, sắp xếp bằng bàn phím và trạng thái cache rõ ràng.
