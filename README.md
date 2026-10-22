# Chess Review Buddy

Chrome 擴充功能（Manifest V3）：在 chess.com 上顯示**每一步的勝率變化**、可開關的**最佳著法**，以及**賽後總結**頁。引擎是 Stockfish 17.1（WASM 精簡版），完全在本機瀏覽器執行，不需要伺服器。

## 什麼時候會啟用

| 頁面 | 狀態 |
|---|---|
| 分析棋盤（`/analysis`）、對電腦（`/play/computer`） | 即時分析 |
| 真人對局**結束後**的對局頁 | 即時分析 + 賽後總結 |
| 真人對局**進行中**（包含友誼賽、Daily） | 自動停用 |

chess.com 的 Fair Play 規則禁止在任何真人對局中使用引擎輔助（友誼賽也一樣），被偵測到可能會被封號，所以進行中的對局一律不分析。跟朋友下完以後，可以一起打開賽後總結或分析棋盤討論。

## 功能

- **浮動面板**（可拖曳、可收合）：勝率條、白／黑勝率、上一步的評價（最佳／優秀／良好／不精確／失誤／大失誤），以及走子方勝率從多少變成多少
- **最佳著法開關**：面板勾選框、彈出視窗，或快捷鍵 `Alt+B`；可在棋盤上畫箭頭
- **賽後總結頁**
  - 雙方準確率與各類著法數量
  - 勝率走勢圖（滑鼠移上去看數值，點一下跳到該步）
  - 棋盤重播（← → 鍵），失誤時用綠色箭頭標出更好的著法與變化
  - 關鍵時刻：勝率掉最多的 5 步
  - 匯出含評分與註解的 PGN、複製文字摘要（方便貼給朋友討論）

## 安裝（開發者模式）

1. 下載這個 repo
2. Chrome 打開 `chrome://extensions`，開啟右上角的「開發人員模式」
3. 點「載入未封裝項目」，選這個資料夾
4. 打開 chess.com 的分析棋盤試試看

## 架構

```
manifest.json
src/
  content.js / content.css   讀取 chess.com 著法列表、判斷頁面狀態、顯示面板與箭頭
  background.js              建立 offscreen 文件、轉送訊息、開啟總結頁、快捷鍵
  offscreen.html / .js       常駐 Stockfish worker，負責即時分析（含快取）
  engine.js                  Stockfish UCI 包裝
  analysis.js                勝率換算、準確率、著法分類（Lichess 公式）
  report.html / .js / .css   賽後總結頁
  popup.html / .js           設定（深度、開關）
vendor/
  stockfish.js / .wasm       Stockfish 17.1 lite single-thread（GPLv3）
  chess.js                   chess.js 1.4.0（BSD-2）
```

## 已知限制

- chess.com 的 DOM 結構沒有公開文件，著法列表和「對局是否結束」的判斷是根據目前已知的 class 名稱（`wc-simple-move-list`、`.node.main-line-ply`、`.resign-button-component`、`.game-result` 等）。如果 chess.com 改版導致面板沒反應，需要調整 `src/content.js` 裡的選擇器。
- 判斷不出對局是否結束時，一律當作進行中，不會分析。
- 準確率使用 Lichess 的公式，數字會跟 chess.com 官方的 CAPS 有些差距。

## 授權

本專案包含 Stockfish（GPLv3），因此整體以 GPLv3 散布。見 `vendor/STOCKFISH-LICENSE.txt`。
