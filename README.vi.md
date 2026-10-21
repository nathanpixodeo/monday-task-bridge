# Monday Task Bridge

[English](README.md) · [Français](README.fr.md) · Tiếng Việt

Tác giả: **Nhat Nguyen** · Phát triển bởi **Nexkit** · [nathanpixodeo@gmail.com](mailto:nathanpixodeo@gmail.com)

*Đây là bản dịch của README tiếng Anh. Nếu hai bản có chỗ khác nhau, README tiếng Anh là bản chuẩn.*

Cho phép một AI agent (Claude Code, Codex, agy hoặc bất kỳ MCP client nào) đọc task trên monday.com, kèm các update (bình luận trên task) và ảnh gốc, thông qua **Chrome đã đăng nhập của bạn**. Bạn không cần monday API token, không cần app do admin cài, cũng không cần gói monday MCP: chỉ cần đăng nhập monday trong Chrome một lần, extension lo phần còn lại.

Dự án gồm hai phần, đều chạy trên máy tính của bạn:

- **Một Chrome extension** đọc task bằng phiên đăng nhập (session) monday của bạn.
- **Một bridge cục bộ kèm MCP server** để agent của bạn giao tiếp. Bridge chỉ lắng nghe trên `127.0.0.1:3457`.

> **Trạng thái dự án:** Bản prototype cá nhân. Typecheck, build và test tự động đều đạt trên CI, và việc đọc task đã được kiểm tra với task monday thật. Hãy coi `complete` là tín hiệu ở mức cố gắng tối đa (best-effort), và đọc `warnings` trước khi dựa vào một snapshot.

## Bắt đầu nhanh

Bạn cần:

- Google Chrome đã đăng nhập monday.com
- [Node.js](https://nodejs.org) 22.12 trở lên, và [Git](https://git-scm.com)
- Ít nhất một agent CLI: Claude Code, Codex hoặc agy

### 1. Chạy trình cài đặt

Mở terminal và chạy một lệnh.

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.sh | bash
```

Trình cài đặt (installer) sẽ:

- tải mã nguồn về và build,
- đăng ký MCP server với mọi agent CLI mà nó tìm thấy (Claude Code, Codex, agy); bạn không cần tự chạy lệnh `mcp add` nào,
- cho các CLI đó đọc monday mà không hỏi bạn mỗi lần ([chế độ duyệt (approval mode)](#chế-độ-duyệt-auto-hoặc-manual) `auto`),
- khởi động bridge,
- mở `chrome://extensions` và chờ bạn tải extension rồi pair nó (bước 2 và 3).

Giữ terminal mở cho đến khi nó báo **Done**.

### 2. Tải extension vào Chrome

Làm bước này trong profile Chrome đã đăng nhập monday.com.

1. Mở `chrome://extensions` (trình cài đặt đã mở sẵn trang này cho bạn).
2. Bật **Chế độ dành cho nhà phát triển** (Developer mode) ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked) và chọn thư mục extension. Trình cài đặt đã chép đường dẫn của thư mục này vào clipboard (trên Windows và macOS):

   | Hệ điều hành | Thư mục extension |
   | --- | --- |
   | Windows | `%LOCALAPPDATA%\Programs\monday-task-bridge\dist\extension` |
   | macOS / Linux | `~/.monday-task-bridge/dist/extension` |

4. Ghim **Monday Task Bridge** lên thanh công cụ để mở popup chỉ bằng một cú bấm.

### 3. Pair extension với bridge

1. Mở popup của extension và bấm **power button** (nút nguồn). Popup hiện một mã 6 chữ số.
2. Nhập mã đó vào terminal của trình cài đặt và nhấn Enter.
3. Popup báo **Connected**. Trình cài đặt kết thúc với **Done**.

Mã hết hạn sau hai phút. Nếu mã hết hạn, bấm lại power button để lấy mã mới.

### 4. Khởi động lại agent và dùng thử

Khởi động lại mọi phiên Claude Code, Codex hoặc agy đang mở, để chúng nhận các tool mới. Kiểm tra xem server đã có chưa:

```powershell
claude mcp list    # hoặc: codex mcp list / agy mcp list
```

`monday-task-bridge` phải có trong danh sách (Claude Code hiện `✔ Connected`). Sau đó hãy nhờ agent, ví dụ:

> Đọc task monday này: https://your-team.monday.com/boards/123/pulses/456

> Liệt kê các task monday được giao cho tôi.

Mỗi khi agent đọc monday, Chrome phải đang chạy và power button của extension phải đang bật.

## Cập nhật, pair lại, gỡ cài đặt

**Cập nhật:** chạy lại lệnh cài đặt. Sau đó bấm **Tải lại** (Reload) trên thẻ Monday Task Bridge trong `chrome://extensions`.

**Pair lại** (sau khi bấm **Unpair**, khi dùng profile Chrome mới, hoặc khi mã đã hết hạn): chạy lại lệnh cài đặt; lệnh này hỏi mã mới mỗi khi extension chưa kết nối. Để pair mà không cài lại, chạy công cụ pair (pair helper) với mã lấy từ popup:

```powershell
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\pair-cli.js" 123456
```

```sh
node ~/.monday-task-bridge/dist/bridge/pair-cli.js 123456
```

Popup cũng hiện lệnh `npm run pair -- <code>`. Lệnh này chỉ chạy được bên trong thư mục cài đặt.

**Profile Claude Code khác:** Claude Code lưu cấu hình riêng cho từng profile. Trỏ `CLAUDE_CONFIG_DIR` tới profile kia rồi chạy lại trình cài đặt:

```powershell
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-profiles\other-profile"
irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
```

**Gỡ cài đặt:**

1. Gỡ các quy tắc duyệt, rồi gỡ MCP server, khỏi từng agent CLI:

   ```powershell
   node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" manual
   claude mcp remove -s user monday-task-bridge
   codex mcp remove monday-task-bridge
   agy mcp remove monday-task-bridge
   ```

   Trên macOS/Linux, dòng đầu tiên là `node ~/.monday-task-bridge/dist/bridge/approval-cli.js manual`.

2. Bấm **Xóa** (Remove) trên thẻ extension trong `chrome://extensions`.
3. Xóa thư mục cài đặt: `%LOCALAPPDATA%\Programs\monday-task-bridge` trên Windows, `~/.monday-task-bridge` trên macOS/Linux.
4. Xóa thư mục dữ liệu (xem [Dữ liệu cục bộ và quyền riêng tư](#dữ-liệu-cục-bộ-và-quyền-riêng-tư)).
5. Khởi động lại máy tính để dừng bridge nếu nó vẫn đang chạy.

### Tùy chọn của trình cài đặt

Đặt các biến môi trường sau trước khi chạy trình cài đặt:

| Biến | Tác dụng |
| --- | --- |
| `MONDAY_BRIDGE_HOME` | Cài vào một thư mục khác. |
| `MONDAY_BRIDGE_CLIENTS` | Các agent CLI cần đăng ký, phân tách bằng dấu phẩy. Mặc định là `claude,codex,agy`; `none` thì không đăng ký CLI nào. |
| `MONDAY_BRIDGE_APPROVAL` | `auto` (mặc định) hoặc `manual`; xem [Chế độ duyệt](#chế-độ-duyệt-auto-hoặc-manual). |
| `CLAUDE_CONFIG_DIR` | Profile Claude Code để đăng ký vào. |

## Chế độ duyệt: auto hoặc manual

Mặc định, agent CLI yêu cầu bạn duyệt từng lần gọi MCP tool, nên mỗi lần đọc monday đều dừng lại ở một câu hỏi yes/no. Chế độ duyệt quyết định việc này cho các tool của bridge trong Claude Code, Codex và agy cùng lúc:

- **`auto`**: agent đọc task, board và ảnh mà không hỏi. Trình cài đặt đặt chế độ này.
- **`manual`**: agent hỏi trước mỗi lần đọc, giống hành vi mặc định của các CLI.

Bạn có thể chuyển chế độ bất cứ lúc nào, sau đó khởi động lại các phiên agent đang mở:

```powershell
# Trên Windows
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" auto
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" manual
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" status
```

```sh
# Trên macOS / Linux
node ~/.monday-task-bridge/dist/bridge/approval-cli.js auto
```

Trong bản checkout mã nguồn, `npm run approval -- auto` làm việc tương tự.

`auto` chỉ áp dụng cho các tool đọc. `monday_write_back` luôn hỏi. Lệnh này ghi các quy tắc dưới đây, và `manual` gỡ chúng đi:

| CLI | Tệp | Quy tắc cho mỗi tool đọc |
| --- | --- | --- |
| Claude Code | `settings.json` trong thư mục profile (`~/.claude`, hoặc `CLAUDE_CONFIG_DIR`) | `permissions.allow`: `mcp__monday-task-bridge__monday_read_task` |
| Codex | `config.toml` trong `~/.codex` (hoặc `CODEX_HOME`) | `[mcp_servers.monday-task-bridge.tools.monday_read_task]` với `approval_mode = "approve"` |
| agy | `~/.gemini/antigravity-cli/settings.json` | `permissions.allow`: `mcp(monday-task-bridge/monday_read_task)` |

`MONDAY_BRIDGE_CLIENTS` giới hạn các CLI mà lệnh này thay đổi. Với một profile Claude Code khác, hãy đặt `CLAUDE_CONFIG_DIR` trước, giống như với trình cài đặt.

## Agent của bạn làm được gì

| MCP tool | Kết quả |
| --- | --- |
| `monday_read_task` | Đọc mới bất kỳ task nào, theo `url` hoặc theo `boardId` + `itemId` (`accountHost` là tùy chọn). Bạn không cần mở task đó. |
| `monday_read_open_task` | Đọc mới task đang mở trong tab Chrome đang hoạt động, hoặc trong tab task đầu tiên đang mở. |
| `monday_list_assigned_tasks` | Danh sách trực tiếp (live) các task được giao cho bạn (ở bất kỳ cột người nào), kèm board, link và các cột. Tham số tùy chọn `boardIds` giới hạn việc đọc ở những board đó. Tool kiểm tra tối đa 100 board đang hoạt động và 5000 task (item và subitem) trong vòng 160 giây. Khi một giới hạn hoặc một board không đọc được làm danh sách bị cắt bớt, `complete` là false và `warnings` cho biết lý do. Kết quả không được cache. |
| `monday_list_boards` | Các board đang hoạt động mà bạn có thể được giao task, kèm workspace của chúng, để dùng làm `boardIds` ở trên. |
| `monday_get_image` | Các byte gốc PNG, JPEG, GIF hoặc WebP của một tệp đính kèm có trạng thái `ready`. |
| `monday_get_task` | Snapshot mới nhất trong cache, có thể lọc theo `boardId` và/hoặc `itemId`. |
| `monday_list_tasks` | Tóm tắt các snapshot trong cache. |
| `monday_bridge_status` | Tình trạng hoạt động của bridge, trạng thái pairing và trạng thái kết nối của extension. |

Một luồng làm việc điển hình của agent: gọi `monday_read_task` với link task, đọc `complete` và `warnings`, rồi gọi `monday_get_image` cho từng tệp đính kèm cần xem.

Các tool chỉ đọc. Ngoại lệ duy nhất là `monday_write_back`: tool này thêm một update vào item và có thể đặt cột Status của item. Agent không bao giờ thấy tool này, trừ khi MCP client của nó khởi động server với `MONDAY_BRIDGE_ALLOW_WRITE=1`. Trình cài đặt không đặt biến này.

## Popup của extension

Bấm **power button** để bật hoặc tắt kết nối. Khi kết nối tắt, mọi lần đọc đều lỗi với `BROWSER_OFFLINE`. Biểu tượng trên thanh công cụ có màu khi đã kết nối, và màu xám trong các trường hợp còn lại. Một huy hiệu (badge) báo những gì cần chú ý:

| Huy hiệu | Ý nghĩa |
| --- | --- |
| `…` (tím) | Đang đọc một task, hoặc đang chờ duyệt pairing. |
| `!` (đỏ) | Kết nối đang bật, nhưng bridge đang offline hoặc chưa kết nối. |
| `!` (hổ phách) | Lần đọc gần nhất chưa đầy đủ. Mở popup để đọc các cảnh báo. |
| `+` (hổ phách) | Một host chứa ảnh cần được cấp quyền. |
| không có | Đã kết nối (biểu tượng màu), hoặc đã tắt hay chưa pair (biểu tượng xám). |

## Cách hoạt động

1. Agent gọi một MCP tool. MCP server (do agent CLI khởi động) chuyển request tới bridge, và khởi động bridge ở chế độ nền nếu bridge chưa chạy.
2. Bridge gửi request tới extension đã pair qua một WebSocket cục bộ.
3. Extension gọi **web API của chính monday** (`https://<account>.monday.com/v2`, GraphQL): cùng endpoint mà web app của monday dùng, với phiên đăng nhập trình duyệt của bạn và CSRF token của app. Một request trả về tên task, mọi cột dưới dạng văn bản, các update kèm phản hồi và tác giả, cùng các tệp đính kèm. Không có tab nào được mở.
4. Ảnh gốc được tải về từ kho lưu trữ tệp của monday và được kiểm tra từng byte. Các tệp không phải ảnh được liệt kê trong trường `Other files`.
5. Snapshot được gửi về bridge; bridge lưu snapshot vào cache và trả về cho agent.

Extension không bao giờ crawl board, không đọc hay xuất giá trị cookie, và không thay ảnh gốc bằng ảnh chụp màn hình. Extension chỉ thấy được những task mà tài khoản monday của bạn thấy được.

## Dữ liệu cục bộ và quyền riêng tư

Bridge chỉ lắng nghe trên loopback và từ chối các trang web. Pairing cần mã 6 chữ số được duyệt trên máy tính của bạn. Sau đó, extension phải gửi một bearer token từ chính origin của extension, còn MCP server dùng một admin token cục bộ riêng. **Unpair** trong popup sẽ thu hồi token của extension. Mỗi lần pairing mới cấp một token mới, nên token cũ không còn dùng được.

CSRF token mà monday đặt trong trang app của mình chỉ nằm trong bộ nhớ của extension và không bao giờ được gửi tới bridge. Extension có quyền truy cập host `*.monday.com` và kho lưu trữ tệp của monday (`files-monday-com.s3.amazonaws.com`) để lấy ảnh gốc.

Snapshot, ảnh và token được lưu **không mã hóa** trong thư mục người dùng của bạn:

| Hệ điều hành | Thư mục dữ liệu |
| --- | --- |
| Windows | `%LOCALAPPDATA%\monday-task-bridge` |
| macOS | `~/Library/Application Support/monday-task-bridge` |
| Linux | `$XDG_DATA_HOME/monday-task-bridge`, hoặc `~/.local/share/monday-task-bridge` |

Log của bridge là tệp `bridge.log` trong thư mục đó. `MONDAY_BRIDGE_DATA_DIR` đổi vị trí thư mục này; khi đó bridge, công cụ pair và MCP server đều phải dùng cùng một giá trị. Mỗi snapshot mới sẽ dọn bớt cache về mức **200 snapshot / 7 ngày** và xóa những ảnh không còn snapshot nào được giữ lại sử dụng. Không bao giờ commit hoặc chia sẻ thư mục này.

## Khắc phục sự cố

### Cài đặt và kết nối agent

- **`claude mcp list` báo `monday-task-bridge` ở trạng thái failed, hoặc agent báo `Cannot find module '...\dist\bridge\mcp.js'`:** Đường dẫn đã đăng ký bị sai, hoặc mã nguồn chưa được build ở đó. Lỗi này thường do cài đặt thủ công với đường dẫn tương đối, dùng biến PowerShell trong một shell khác, hoặc gõ dấu gạch chéo ngược (backslash) trong Git Bash. Chạy lại lệnh cài đặt; lệnh này build mã nguồn và đăng ký đường dẫn đầy đủ. Nếu mục cũ vẫn còn, gỡ nó bằng `claude mcp remove monday-task-bridge` từ thư mục nơi bạn đã thêm nó, rồi chạy lại trình cài đặt.
- **`Cannot find package '@modelcontextprotocol/sdk'` (hoặc `ws`, `zod`):** Thiếu dependency, ví dụ vì chỉ thư mục `dist` được chép sang máy này. Chạy lại lệnh cài đặt.
- **`irm` lỗi với "Could not create SSL/TLS secure channel" (không tạo được kênh bảo mật SSL/TLS, trên Windows 10 bản cũ):** Chạy `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` trong cùng cửa sổ đó, rồi chạy lại lệnh cài đặt.
- **`npm.ps1 cannot be loaded because running scripts is disabled`:** PowerShell chặn script shim của npm. Dùng `npm.cmd` thay cho `npm`. Trình cài đặt đã làm sẵn việc này.
- **"is not empty and is not a git checkout":** Thư mục cài đặt đang chứa tệp khác. Xóa thư mục đó, hoặc đặt `MONDAY_BRIDGE_HOME` thành một thư mục khác.
- **Agent không liệt kê các tool monday:** Khởi động lại phiên agent sau khi cài đặt.
- **Agent vẫn hỏi trước mỗi lần đọc monday:** Chạy lệnh chế độ duyệt với `status`; kết quả phải là `auto` cho CLI đó. Sau đó khởi động lại phiên agent. Trong Codex, việc đăng ký lại server bằng `codex mcp remove` và `codex mcp add` làm mất các quy tắc; hãy chạy lại `auto`.

### Đọc task

- **`BROWSER_OFFLINE` hoặc `extensionConnected: false`:** Chrome phải đang chạy, và power button trong popup phải đang bật. Dùng **Retry connection** trong popup nếu cần.
- **"Not signed in to `<account>`.monday.com":** Bạn chưa đăng nhập. Hãy đăng nhập monday trong profile Chrome có extension, rồi thử lại.
- **"monday API: …":** monday đã từ chối request; thông báo lỗi là của monday. Với một task bạn không xem được trong monday, kết quả là "monday has no task … that this account can see" (monday không có task … nào mà tài khoản này xem được).
- **`CAPTURE_TIMEOUT`:** Một lần đọc không xong trong vòng 180 giây. Xem lỗi trong popup rồi thử lại.
- **`NO_SNAPSHOT`:** Không có task nào trong cache khớp với các ID, hoặc lần đọc đã thất bại. Gọi `monday_bridge_status` trước.
- **`INVALID_TARGET`:** URL không phải link task dạng `https://<account>.monday.com/boards/<id>/pulses/<id>`, hoặc chưa biết account nào ứng với ID board và item đã cho. Truyền `accountHost`, hoặc mở monday trong Chrome.
- **Không tìm thấy tab task nào:** Dùng `monday_read_task` với link task thay cho `monday_read_open_task`.
- **Ảnh không khả dụng:** Chỉ ảnh gốc PNG, JPEG, GIF và WebP được trả về; các tệp khác được liệt kê trong `Other files`. Ảnh vượt **25 MB mỗi ảnh** hoặc **75 MB mỗi lần đọc** sẽ bị bỏ qua. Nếu ảnh được lưu ngoài kho lưu trữ tệp thông thường của monday, popup sẽ hỏi một lần để cho phép host đó. Chỉ cho phép khi bạn nhận ra host đó.
- **Hơn 100 update:** Chỉ 100 update mới nhất được đọc, và `warnings` sẽ ghi rõ điều đó.
- **Pairing thất bại hoặc hết hạn:** Bấm lại power button và nhập mã mới trong vòng hai phút. Pair một extension khác (trong profile Chrome khác, hoặc được tải từ thư mục khác) sẽ thay thế pairing trước đó.
- **Popup báo "The bridge no longer accepts this browser" (bridge không còn chấp nhận trình duyệt này):** Một pairing khác đã thay thế pairing này, hoặc bridge đang dùng thư mục dữ liệu khác. Hãy pair lại.

Để kiểm tra bridge mà không làm lộ token, chạy `Invoke-RestMethod http://127.0.0.1:3457/health` (macOS/Linux: `curl http://127.0.0.1:3457/health`). `paired: true` nghĩa là đã có extension được pair; `extensionConnected: true` nghĩa là extension đang kết nối. Muốn đọc trực tiếp thì cần cả hai.

Khi báo lỗi, hãy kèm dạng URL của task, lỗi hiện trong popup và các cảnh báo của snapshot. Không đăng cookie phiên đăng nhập, token của bridge hay nội dung task riêng tư trong một issue công khai.

## Cài đặt thủ công (từ mã nguồn)

Dùng cách này khi phát triển, hoặc khi bạn không chạy được trình cài đặt.

```powershell
git clone https://github.com/nathanpixodeo/monday-task-bridge.git
cd monday-task-bridge
npm ci
npm run build
node dist/bridge/start-cli.js
```

`start-cli.js` khởi động bridge ở chế độ nền (còn `npm run bridge` chạy bridge ở chế độ tiền cảnh). Tải `dist/extension` vào Chrome như ở bước 2 của phần Bắt đầu nhanh. Sau đó bấm power button và duyệt mã từ thư mục này bằng `npm run pair -- 123456`.

Đăng ký MCP server với **đường dẫn đầy đủ** của `dist/bridge/mcp.js`. Đường dẫn này phải tồn tại, nên hãy build trước. Thay `C:\path\to\monday-task-bridge` bằng thư mục của bạn:

```powershell
claude mcp add -s user monday-task-bridge -- node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
codex mcp add monday-task-bridge -- node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
agy mcp add monday-task-bridge node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
```

- Giữ `-s user` cho Claude Code. Thiếu tham số này, server chỉ được đăng ký cho thư mục hiện tại.
- Trong Git Bash, viết đường dẫn bằng dấu gạch chéo xuôi (`C:/path/to/...`). Bash xóa các dấu gạch chéo ngược không nằm trong dấu nháy.
- Với các MCP client khác, dùng một stdio server với `command` là `node` và `args` là đường dẫn đầy đủ:

  ```json
  {
    "mcpServers": {
      "monday-task-bridge": {
        "command": "node",
        "args": ["C:/path/to/monday-task-bridge/dist/bridge/mcp.js"]
      }
    }
  }
  ```

Không có token nào nằm trong cấu hình của client: MCP server đọc admin token của nó từ thư mục dữ liệu.

Để đọc mà không gặp câu hỏi yes/no mỗi lần, chạy `npm run approval -- auto` từ thư mục này sau khi đăng ký (xem [Chế độ duyệt](#chế-độ-duyệt-auto-hoặc-manual)).

## Phát triển

```powershell
npm run typecheck
npm test
npm run build
```

Chrome extension nằm trong `extension/` (phần ánh xạ API nằm trong `extension/helpers/monday-api.ts`), bridge, MCP server và các CLI (`pair-cli`, `start-cli`, `approval-cli`) nằm trong `bridge/`, các kiểu payload dùng chung nằm trong `shared/`, còn các trình cài đặt nằm trong `scripts/`. `npm run mcp` chạy MCP server từ mã nguồn. CI chạy install, typecheck, test và build trên Node.js 24. Kết quả build trong `dist/` không được commit.

Extension luôn dùng port `3457`; đừng để chương trình khác chiếm port này. Extension không dùng giá trị `MONDAY_BRIDGE_PORT` tùy chỉnh.
