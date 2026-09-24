// 開機遮罩：登入／LIFF 初始化期間顯示的準備畫面，含逾時保護與失敗訊息。


const AUTH_BOOT_FAILSAFE_MS = 30000;
const AUTH_BOOT_STABLE_MESSAGE = "正在準備潮吉好頑…";

let authBootFailsafe = null;
let authBootFailed = false;

function setAuthBootMessage(message, { force = false } = {}) {
  const node = document.querySelector("[data-auth-boot-message]");
  if (node && message && (force || authBootFailed)) node.textContent = message;
}

export function startAuthBoot() {
  authBootFailed = false;
  const retry = document.querySelector("[data-auth-boot-retry]");
  if (retry && retry.dataset.bound !== "true") {
    retry.dataset.bound = "true";
    retry.addEventListener("click", () => location.reload());
  }
  document.body.classList.add("auth-booting");
  document.body.classList.remove("auth-boot-ready");
  setAuthBootMessage(AUTH_BOOT_STABLE_MESSAGE, { force: true });
  document.querySelector("#auth-boot-screen i")?.classList.remove("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.add("hidden");
  if (authBootFailsafe) clearTimeout(authBootFailsafe);
  authBootFailsafe = setTimeout(() => failAuthBoot("登入服務回應逾時，請點擊重試"), AUTH_BOOT_FAILSAFE_MS);
}

export function failAuthBoot(message) {
  if (authBootFailed) return;
  authBootFailed = true;
  if (authBootFailsafe) {
    clearTimeout(authBootFailsafe);
    authBootFailsafe = null;
  }
  setAuthBootMessage(message);
  document.querySelector("#auth-boot-screen i")?.classList.add("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.remove("hidden");
}

export function finishAuthBoot() {
  // A late but successful resource response may arrive after the failsafe.
  // Successful completion must be allowed to clear the retry state.
  authBootFailed = false;
  if (authBootFailsafe) {
    clearTimeout(authBootFailsafe);
    authBootFailsafe = null;
  }
  document.querySelector("#auth-boot-screen i")?.classList.remove("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.add("hidden");
  document.body.classList.remove("auth-booting");
  document.body.classList.add("auth-boot-ready");
  document.querySelector("#auth-boot-screen")?.setAttribute("aria-hidden", "true");
}
