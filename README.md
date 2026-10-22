# Chess Review Buddy

Chrome 擴充功能（Manifest V3）：在 chess.com 上顯示**每一步的勝率變化**、可開關的**最佳著法**，以及**賽後總結**頁。引擎是 Stockfish 17.1（WASM 精簡版），完全在本機瀏覽器執行，不需要伺服器。

## 什麼時候會啟用

| 頁面 | 狀態 |
|---|---|
| 分析棋盤（`/analysis`）、對電腦（`/play/computer`） | 即時分析 |
| 真人對局**結束後**的對局頁 | 即時分析 + 賽後復盤（結束當下面板自動出現，並在背景先跑完整盤分析） |
| 真人對局**進行中**（包含友誼賽、Daily） | 自動停用 |

chess.com 的 Fair Play 規則禁止在任何真人對局中使用引擎輔助（友誼賽也一樣），被偵測到可能會被封號，所以進行中的對局一律不分析。跟朋友下完以後，可以一起打開賽後總結或分析棋盤討論。

## 功能

- **浮動面板**（可拖曳、可收合）：勝率條、白／黑勝率、上一步的評價（最佳／優秀／良好／不精確／失誤／大失誤），以及走子方勝率從多少變成多少
- **Best Move 開關**：面板勾選框、彈出視窗，或快捷鍵 `Alt+B`；可在棋盤上畫箭頭，並說明為什麼這步比較好（殺棋、贏子、捉雙、牽制／串擊、閃擊、避開殺棋、保護被攻擊的子、出子、王車易位、控制中心、通路兵、國王活躍、升變）
- **賽後復盤頁**（chess.com 式版面：大棋盤＋直立勝率條＋雙方資訊列，右側分頁面板，不用一直往下捲）
  - **復盤**：教練框說明每一步（評價、勝率變化、為什麼錯、更好的著法與理由）、勝率走勢圖、著法列表
  - **總結**：準確率、這盤棋的故事、開局／中局／殘局表現、你下得好的地方、本局最重要的課（可練習）
  - **開局**：開局名稱與中文說明、主線（可一步步看）、在哪一步離開常見下法與當時的常見下法、你開局的失誤該怎麼走、雙方計畫、初學者常犯的錯、開局原則；可「練習這個開局」，對手照主線／開局庫回應
  - **統計**：錯誤分類、漏看的戰術、下一步練什麼（Lichess 主題謎題）、對手的失誤
  - **Best Move 常設開關**（教練框右上角，會記住）；Opening 練習時會自動顯示 Best Move，直到離開 Book（顯示「此 Opening 已結束」）
  - 棋子移動有滑動動畫，並有走子／吃子／王車易位／將軍／升變音效（chess.com 音效，直接從 chess.com 載入、不包含在本專案中；載不到時改用合成音效，可在設定關閉）
  - **Show Moves**：每個 Best Move 旁的按鈕，把之後的連續手法（到最後一次吃子／將軍後再一步）在棋盤上走一遍，結束後停留 5 秒再回到原局面
  - **播放**：自動一步步重播，遇到你的關鍵錯誤（勝率掉超過 8%）或錯失對手失誤（Miss）就停下來說明，按播放再繼續（空白鍵也可以）
  - **從這裡重新下**：從任一步開始自己重下，對手先照實戰走，你一偏離就由電腦接手（簡單／普通／困難），勝率條與教練框即時更新
  - **試走**：直接拖曳棋子試其他下法，每一步都會評分與說明，用 ◀ ▶ 撤回或重走
  - 匯出含評分與白話註解的 PGN、複製文字摘要
  - 棋子：自動使用你在 chess.com 用的棋子樣式（打開 chess.com 任一盤棋時從頁面讀取圖檔網址並下載存在本機，不包含在本專案中）；取得前暫時用 papercut
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
  opening-guides.js          常見開局的中文說明、主線、雙方計畫與常見錯誤
  report.html / .js / .css   賽後總結頁
  popup.html / .js           設定（深度、開關）
pieces/                      棋子圖（papercut、spatial、cburnett，授權見 pieces/LICENSES.md）
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
棋子圖取自 Lichess：papercut（Nikolay Anzarov，CC BY 4.0）、spatial（Maurizio Monge，MIT）、cburnett（Colin M.L. Burnett，GPLv2+），詳見 `pieces/LICENSES.md`。
