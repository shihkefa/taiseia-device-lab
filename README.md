# TaiSEIA Lab：設備端串口模擬器

**線上使用：**以桌面版 Chrome 或 Edge 開啟 [TaiSEIA Lab](https://shihkefa.github.io/taiseia-device-lab/)，按「連接串口」並選取控制器所接的 COM port。請勿在檔案總管雙擊 `dist/index.html`；`file://` 無法載入頁面所需的 JavaScript 模組。

網頁扮演家電，控制器透過電腦的 USB 串口介面向網頁讀寫。本專案使用純 HTML/CSS/JavaScript，不需要 npm 安裝或後端資料庫。封包與設備狀態只存在瀏覽器工作階段，不會上傳。

## 本機啟動

安裝 Node.js 20 以上後，在此資料夾執行：

```sh
node server.mjs
```

以桌面版 Chrome 或 Edge 開啟 http://127.0.0.1:4173 。也可直接將 `dist/` 的內容部署至 GitHub Pages 或其他 HTTPS 靜態空間。不要直接以 `file://` 開啟 ES module 網頁。

1. 預設使用「自動辨識／自動偵測」，選定 TaiSEIA 共通查詢時要宣告的設備。另可選 Daikin 空調（S21）或固定協議／手動串口參數。
2. 自動模式會輪流以 9600 8N1 與 2400 8E2 被動接收，每組約 4 秒、最多 60 秒；完整有效命令才鎖定協議。
3. 按「連接串口」，由使用者選擇控制器的 COM port。
4. 開啟「自動回覆」，控制器的讀寫會反映於設備狀態與封包紀錄。
5. 在左側編輯感測值、狀態；TaiSEIA 可設定 `FFFF` 無資料，控制器下次讀取即會取得修改值。
6. 點選紀錄檢視 byte 欄位、XOR／S21 SUM 與功能解碼；匯出 JSON 或 CSV 保存。

使用符合控制器電氣介面的串口轉接器。TX/RX 交叉並共地；TTL 5V、3.3V 與 RS-232 不可視為相同介面。此頁不能反轉硬體訊號電位。

## 設備與可信度

| SA | 設備 | 依據 |
|---|---|---|
| 01 | 空調 | taixia 控制/感測映射與公開實機封包 |
| 03 | 洗衣機 | taixia 部分未開放元件；研究設定檔 |
| 04 | 除濕機 | taixia 控制/感測映射與公開註冊/服務樣本 |
| 08 | 空氣清淨機 | taixia 部分未開放元件；研究設定檔 |
| 0E | 全熱交換器 | taixia 功能表；模式保留原始值，換氣另有獨立 enum |
| 0F | 電風扇 | taixia 功能表與可配置檔位 |
| S21 | Daikin 空調 | S21 v2 子集；asund、RevK 公開實作與模擬樣本 |

所有設備均可執行識別、服務讀取、支援功能的寫入、全狀態回覆。洗衣機電源 0/1 為明示模擬約定；沒有證據的模式預設不啟用，可在協定設定中自行建立目標機型的行為。沒有正式 TaiSEIA 全文或每一機型實測，不能視為協定認證或真機完整重建。

已整理 151 項研究記錄；特殊 0xFF 室外濕度常數不當作一般 7-bit service，實際設定庫提供其餘 150 項。預設只啟用精簡子集，保持註冊封包較短。各功能的來源、能力原始值與限制均可檢視。`docs/device-catalog-research.json` 保存逐項研究依據，`prepare-catalog.mjs` 產生瀏覽器的 `catalog.js`。

## 設備端行為

- 一般請求：`06 SA SERVICE HI LO XOR`。bit7=1 為寫入，bit7=0 且資料 `FFFF` 為讀取。
- XOR 為前面所有 bytes 的 XOR；資料為 big-endian。溫度通常為 int16；电流與耗電量按個別定義縮放。
- 共通 SA=00：支援註冊00、Class ID 01、版本02、SA Type 04、品牌05、型號06、服務07、全狀態08。03 保留不回覆。
- 註冊：`LEN 00 CLASS MAJOR MINOR 03 SA_HI SA_LO BRAND 00 MODEL 00 [CAP_ID HI LO]… XOR`。byte5 原始值預設03，可調，語意未當成官方定義。
- 服务清單：`LEN 00 07 [ID|WRITE_BIT CAP_HI CAP_LO]… XOR`。能力值單獨保存，不能全部解成最大值、範圍或 bitmask；未確認處預設0000並明確標示。另提供省略 `00 07` 的相容變體，至少須兩項服務。
- 全狀態：`LEN 00 08 [ID VALUE_HI VALUE_LO]… XOR`，不包含 write bit，只列已啟用功能。
- 成功寫入先改狀態，再原樣回覆。錯誤 XOR、其他 SA 或非6-byte請求不執行。
- 不支援／唯讀／不合法寫入預設回 `06 SA FF HI LO XOR`，參考公開 Hitachi 錯誤封包；也可選資料FFFF或靜默。這是可配置相容策略，不宣稱所有機型一致。
- 耗電/時數重設和 ERV 濾網通知等明確區分「只寫0」與一般可設定值，手動編輯感測值不受控制器唯讀權限制。
- 各設備狀態互相獨立；不模擬物理冷卻、乾衣進程或計時器自動倒數。需要情境變化時手動修改狀態。

## 擷取與串口限制

累積接收 buffer 可处理任意拆包/黏包、XOR 驗證及250ms殘包重新同步。同一連線共用單一 writer 與有序佇列；中斷連線會取消待送回覆，舊連線不能寫入新連線。

JSON 保存每個 RX 原始區塊、完整收發frame、異常/手動變更、wall time、monotonic time、回覆關聯及設定快照。重复封包逐筆保存。最多5000記錄（含原始區塊），超出顯示移除數；畫面只顯示篩選後最新600筆，匯出包含全部保留記錄。暫停只凍結畫面。

TX 時間表示 Web Serial writer.write 完成，不是對端收到或ACK。此工具捕捉本頁與這個COM port的互動，不是第三方總線雙向嗅探器。瀏覽器不是硬即時系統，背景節流及 USB 延遲可能影響控制器短逾時；請以目標控制器實測。Daikin S21 使用獨立解析器、加總校驗與狀態引擎，詳見 [S21 與自動辨識說明](docs/s21.md)。

## 自動辨識與握手

- 按「連接串口」並選取 COM 後，才開始收發。瀏覽器不能代替使用者授予 COM 權限；靜默控制器也不會憑空產生可辨識封包。
- TaiSEIA 共通 SA=00 只識別協議，並不含控制器想查詢的家電類型。此時使用選定的模擬設備；在尚未宣告身份前收到目標 SA，可自動選擇六類設備。身份一旦宣告，本輪不會跟隨其他 SA 改型。
- TaiSEIA 先回覆註冊／SA Type，再觀察 10 秒內的相同 SA 定址查詢，才標「握手流程完成（定址）」。這是流程證據，不是獨立 ACK。
- S21 查詢先回 ACK，再回 G/S frame；只有 1000ms 內收到對應控制器 ACK 才標「握手已確認（ACK）」。NAK、逾時、未配對 ACK 分別顯示。省略 ACK 而開始下一查詢的控制器仍可繼續通訊。
- S21 v2 提供 D1/F1、D5/F5、D6/F6、D7/F7、F8、F9、FC、FM、RH、RI、Ra、RL、Rd、Re。未知命令 NAK；FY00 不宣告 v3。M/V/VS000M 可拆包辨識但未實作回覆資料。P1P2、X50A 與 S21 v3 未支援。
- 每組自動 UART 偵測約 4 秒，總計最多 60 秒；收到有效控制器命令即停止切換。只送一次開機查詢的控制器，可能需要固定協議後重啟。此工具不會量測任意 baud，也不能從 S21 查詢知道真實型號。
- 「重新偵測」清除本輪辨識證據，保留設備狀態和封包紀錄；已連線時重新開啟同一個已授權 COM。15 秒沒有有效命令會顯示最近無活動。
- 離線示範的協議與握手卡片明確標示「離線示範」，不代表真實控制器測試。
- JSON v2 與 CSV 均帶協議欄位；JSON 另保存辨識狀態、來源和設備設定快照。S21 的 ACK/NAK 逐筆保留。

## 封包轉譯（v1.2）

點上方「封包轉譯」，貼入 HEX 後按「轉譯封包」。不需要連線，可在實體串口擷取期間使用；不會變更虛擬設備或發送資料。

- 支援單包、連續資料、跨行拆包及混合協議。可加 RX:／TX: 前綴；此工具 RX 為控制器→設備、TX 為設備→控制器。
- 支援 0x、空白、冒號、逗號、換行、行尾 # 註解及帶方向的時間戳，例如 [12:30:01.200] RX: 06 01 03 FF FF 04。
- 可載入本工具匯出的擷取 JSON，略過原始區塊避免重複，保留重複完整封包、收發方向及逐包設定快照。亦可載入 TXT／LOG。
- 「載入目前擷取」分析現有完整 RX/TX 封包。監看區選一筆記錄，按「送到封包轉譯」，可轉入該筆及配對請求；RAW／錯誤資料可單獨轉入。
- 中文摘要之外，逐欄位顯示 byte 位置、原始 HEX、功能／模式／狀態、縮放物理量與 XOR／SUM。提供搜尋、只看待確認及每頁 20 筆分頁。
- 可複製完整報告或下載 TXT／JSON；搜尋與分頁不會刪除報告內容。
- TaiSEIA 的寫入與 echo 回覆相同，FFFF 也可能代表讀取請求或無資料回覆；缺少方向時保留歧義。SA00 回覆若沒有可信設備上下文，請選擇設備類型。能力值獨立保存，不套通用最大值／min-max 公式。
- 精簡服務清單可手動選格式；註冊與狀態結構有歧義時，優先按標準清單解讀並提示，可指定「註冊回覆」或提供前一筆註冊查詢。校驗損壞不更新設備／配對上下文。
- S21 已知狀態、倒序感測值與 ACK/NAK 分開解讀。G9 的 FF 為無資料，SH/Sa 的 -0.1°C 可正常轉譯；未收錄命令及未知機型旗標保留 raw。
- 單次最多 64KB 位元組、2000 完整或部分封包、1MB 文字／檔案。若超出，請分批或選取單包。

## 驗證

```sh
node --test tests/*.test.mjs
```

包含六類設備讀寫、完整中介資料一致性、逐byte拆包/黏包、壞XOR與殘包復原、負溫/FFFF、唯讀/錯SA拒絕、重設限制、公開Hitachi註冊及Panasonic服務清單逐byte比對、模擬Web Serial佇列/關閉/重連競態等測試。新增 S21 公開映射向量、ACK/NAK、checksum 特殊值、控制原子性、負溫、協議／SA 辨識、握手證據、UART 重開與取消競態測試。另已透過瀏覽器操作六類 TaiSEIA 與 S21 離線流程及自動選型。未連接真實控制器作硬體驗證。

## 來源

- [tsunglung/taixia commit 581bd57](https://github.com/tsunglung/taixia/tree/581bd578407a166f1d15a9058ae114d5a5a7458f)
- [twseia 公開測試封包](https://github.com/slee124565/twseia/blob/main/tests/sample_pdus.py)
- [成功寫入 echo：Issue 1](https://github.com/tsunglung/taixia/issues/1)
- [不支援寫入 FF：Issue 3](https://github.com/tsunglung/taixia/issues/3)
- [全狀態抓包：Issue 5](https://github.com/tsunglung/taixia/issues/5)
- [原參考工具](https://shihkefa.github.io/taiseia_packet_tool_v2_serial/)
- [asund/esphome-daikin-s21](https://github.com/asund/esphome-daikin-s21/tree/30239f5)
- [RevK/Faikout S21 simulator](https://codeberg.org/RevK/ESP32-Faikout/src/commit/202b9efeb52859fdee98a02fad6c08c20402c1cf/Tools/Simulators/faikin-s21.c)
- [Web Serial 官方文件](https://developer.chrome.com/docs/capabilities/serial)

本專案是獨立的JavaScript設備端實作，未複製 taixia 的C++控制器程式。研究資產記載事實性的功能映射與參考位置；原專案各自保有其授權。
