# 首頁輪播活動橫幅（暫緩，需要時再做）

紀錄日期：2026-11-03。素材：`E:\desktop\superfun-banner\`（`superfun-banner@2x.png` 2880×1216、`superfun-banner-mobile@2x.png` 1440×1800；原始 `banner.html`／`banner-mobile.html`）。

## 目標

把開幕活動橫幅放在首頁 Hero 輪播第一張，後面接原本依商品設定輪播的 slide。

## 現況限制

- `public/hero-slides.js` 的 `selectHeroSlides` 只從型錄挑商品（有輪播排序、有圖、有可售量）；不要建假商品塞圖（會出現在商品格、搜尋、購物車）。
- 電腦版商品 slide 是左 2/3 照片＋右 1/3 文字（`hero-desktop.css`）；橫幅自帶文字，需整張滿版、不分欄。

## 做法

- 新增「活動 slide」型別，`heroCarouselMarkup` 先輸出活動 slide 再接商品 slide；沒有輪播商品時仍顯示活動 slide。
- `<picture>` 依寬度切換電腦版（約 2.37:1）與手機版（4:5）；第一張 `loading="eager" fetchpriority="high"`。
- 點擊導向加入會員／LINE 登入（或提示優惠碼），按鈕文字改「立即加入會員」。
- 設定活動起訖時間（台灣時間），過期自動不顯示。
- 沿用 `hero-carousel.js` 的圓點、切換、自動播放、暫停；活動 slide 高度與商品 slide 一致，避免切換時版面跳動。

## 方案

- A. 程式內設定：圖片放 `public/`（新檔名），一個小設定檔記圖片、連結、起訖。工作量小，換圖要部署。
- B. 後台設定：新增「首頁活動橫幅」（R2 上傳兩張圖、連結、期間、開關），需 migration、後台 UI、首頁內嵌資料與測試。適合常換活動。

## 上線前必做

- PNG 轉 WebP（各約 300KB 內），用新檔名（JS／CSS 無雜湊、圖片快取 7 天）。
- 確認優惠碼：圖上大字 `SUPERFUN`，條碼旁小字 `SUPERFUN100`，不一致；確認後台已建立、是否限新會員、折抵 $100（未確認）。
- 圖片文字寫入 alt（例：「全新官網開幕：加入新會員，結帳輸入優惠碼 SUPERFUN 折抵 $100」）。
- 手機版圖下方約 15% 只有裝飾，可考慮裁短。
- 檢查手機／平板／桌機三種尺寸與 CSP（`img-src` 同源或 R2 網域）。
