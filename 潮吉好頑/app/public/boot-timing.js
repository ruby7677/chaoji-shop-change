// 開機各階段計時（只在除錯時開啟）：網址帶 ?cj_timing=1 開啟一次後，同分頁（含 LINE 登入轉址回來）都會記錄，
// 開機與會員載入完成後跳出各階段距離頁面開始載入的毫秒數，方便在 LINE 手機上直接看時間花在哪裡。
const TIMING_PARAM = "cj_timing";
const TIMING_KEY = "cj-boot-timing";

const enabled = (() => {
  try {
    if (new URL(location.href).searchParams.has(TIMING_PARAM)) sessionStorage.setItem(TIMING_KEY, "1");
    return sessionStorage.getItem(TIMING_KEY) === "1";
  } catch {
    return false;
  }
})();

const marks = [];

export function markBoot(label) {
  if (enabled) marks.push(`${label}：${Math.round(performance.now())}ms`);
}

export function reportBootTiming() {
  if (!enabled || !marks.length) return;
  const text = `開機計時（從頁面開始載入算起）\n${marks.join("\n")}`;
  console.info(text);
  window.alert(text);
}
