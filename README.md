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
- **最佳著法開關**：面板勾選框、彈出視窗，或快捷鍵 `Alt+B`；可在棋盤上畫箭頭，並說明為什麼這步比較好（殺棋、贏子、捉雙、牽制／串擊、閃擊、避開殺棋、保護被攻擊的子、出子、王車易位、控制中心、通路兵、國王活躍、升變）
- **賽後總結頁**（以「你」的角度；自動判斷你執白或執黑，也可以手動切換）
  - **本局最重要的課**：只挑你勝率掉最多的 3 步，用白話說明為什麼錯，例如「你的騎士 e5 沒有保護」「對手可以走 Qg5 捉雙」「這步讓對手可以直接將死你」
  - **錯失良機**：對手剛下錯、你卻沒有抓住，會另外標出來
  - **自己找找看**：在棋盤上自己走走看，答錯會告訴你勝率會掉多少，並給分段提示（主題 → 該動哪個子 → 答案）；跟引擎首選只差一點點的走法也算對
  - **對手的失誤**：列出對手的大錯，標示你有沒有抓住，沒抓住的可以直接練習
  - **這盤棋的故事**：開局名稱，以及局勢在哪幾步轉變、你有沒有錯失良機、最好時的勝率
  - **開局・中局・殘局**：分階段的準確率，標出最需要加強的階段
  - **你下得好的地方**：唯一好棋、抓住對手失誤、漂亮的棄子
  - **錯誤統計**：你犯的錯分類（送子、被捉雙、讓對手殺棋…）與漏看的戰術機會
  - **下一步練什麼**：依這盤的弱點連到 Lichess 免費主題謎題
  - 雙方準確率、勝率走勢圖（標出三個階段）、棋盤重播（← → 鍵）
  - 匯出含評分與白話註解的 PGN、複製文字摘要（方便貼給朋友討論）
- 即時面板在你下錯時也會顯示一句原因

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
  explain.js                 規則式白話解釋：為什麼錯、為什麼更好的著法比較好、練習提示
  insights.js                開局辨識、三階段表現、好棋、錯誤統計、對局故事、練習建議
  report.html / .js / .css   賽後總結頁
  popup.html / .js           設定（深度、開關）
pieces/                      棋子圖（Lichess cburnett，GPLv2+）
tools/build-openings.mjs     由 lichess-org/chess-openings 產生 vendor/openings.json
vendor/
  stockfish.js / .wasm       Stockfish 17.1 lite single-thread（GPLv3）
  chess.js                   chess.js 1.4.0（BSD-2）
  openings.json              開局表（lichess-org/chess-openings，CC0）
```

## 已知限制

- chess.com 的 DOM 結構沒有公開文件，著法列表和「對局是否結束」的判斷是根據目前已知的 class 名稱（`wc-simple-move-list`、`.node.main-line-ply`、`.resign-button-component`、`.game-result` 等）。如果 chess.com 改版導致面板沒反應，需要調整 `src/content.js` 裡的選擇器。
- 判斷不出對局是否結束時，一律當作進行中，不會分析。
- 白話解釋是規則判斷，能抓到沒保護的子、捉雙、殺棋、子力得失；比較抽象的局面型錯誤（例如兵型、王的安全）只會說「局面會變差」。
- 準確率使用 Lichess 的公式，數字會跟 chess.com 官方的 CAPS 有些差距。

## 授權

本專案包含 Stockfish（GPLv3），因此整體以 GPLv3 散布。見 `vendor/STOCKFISH-LICENSE.txt`。
棋子圖為 Colin M.L. Burnett 的 cburnett 棋子（取自 Lichess，GPLv2 或更新版本）。
