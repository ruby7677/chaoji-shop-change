const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";
const LIFF_SDK_TIMEOUT_MS = 5000;

let sdkPromise = null;
let liffInitPromise = null;
let liffInitId = null;

export const liffState = {
  initialized: false,
  available: false,
  isInClient: false,
  loggedIn: false,
  idToken: null,
  accessToken: null
};

function loadLiffSdk() {
  if (globalThis.liff?.init) return Promise.resolve(globalThis.liff);
  if (typeof document === "undefined") return Promise.resolve(null);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${LIFF_SDK_URL}"]`);
    const script = existing || document.createElement("script");
    const timeoutId = globalThis.setTimeout(() => reject(new Error("LIFF SDK 載入逾時")), LIFF_SDK_TIMEOUT_MS);
    script.addEventListener("load", () => {
      globalThis.clearTimeout(timeoutId);
      resolve(globalThis.liff || null);
    }, { once: true });
    script.addEventListener("error", () => {
      globalThis.clearTimeout(timeoutId);
      reject(new Error("LIFF SDK 載入失敗"));
    }, { once: true });
    if (!existing) {
      script.src = LIFF_SDK_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    }
  });
  return sdkPromise;
}

// Start downloading the SDK while /api/config is still in flight. Failures are
// cleared so initializeLiffClient() can report them with its normal handling.
export function preloadLiffSdk() {
  loadLiffSdk().catch(() => { sdkPromise = null; });
}

export async function initializeLiffClient(liffId) {
  if (!liffId) return liffState;
  if (liffState.initialized && liffInitId === liffId) return liffState;
  if (liffInitPromise && liffInitId === liffId) return liffInitPromise;

  liffInitId = liffId;
  liffInitPromise = (async () => {
    const liff = await loadLiffSdk();
    if (!liff?.init) return liffState;
    await liff.init({ liffId });
    liffState.initialized = true;
    liffState.available = true;
    liffState.isInClient = Boolean(liff.isInClient?.());
    liffState.loggedIn = Boolean(liff.isLoggedIn?.());
    liffState.idToken = liffState.loggedIn ? liff.getIDToken?.() || null : null;
    liffState.accessToken = liffState.loggedIn ? liff.getAccessToken?.() || null : null;
    return liffState;
  })().catch((error) => {
    // A failed init may be retried, but never let concurrent callers create
    // multiple liff.init() calls during the same page lifecycle.
    liffInitPromise = null;
    liffInitId = null;
    liffState.initialized = false;
    liffState.available = false;
    liffState.isInClient = false;
    liffState.loggedIn = false;
    liffState.idToken = null;
    liffState.accessToken = null;
    throw error;
  });
  return liffInitPromise;
}

export function canRequestLineFriendship() {
  return Boolean(
    liffState.initialized
    && liffState.isInClient
    && liffState.loggedIn
    && typeof globalThis.liff?.requestFriendship === "function"
  );
}

export async function requestLineFriendship() {
  if (!canRequestLineFriendship()) return false;
  const liff = globalThis.liff;
  if (typeof liff.getFriendship === "function") {
    const current = await liff.getFriendship();
    if (current?.friendFlag === true) return true;
  }
  if (typeof liff.requestFriendship !== "function") return false;
  await liff.requestFriendship();
  if (typeof liff.getFriendship !== "function") return true;
  const updated = await liff.getFriendship();
  return updated?.friendFlag === true;
}
