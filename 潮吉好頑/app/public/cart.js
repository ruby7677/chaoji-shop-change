// 購物車：品項與取貨方式、現貨／預購分組、本機保存與會員雲端同步、加入購物車回饋與前往結帳。
import { escapeHtml, isPreorderItem, money } from "./product-format.js";
import { auth, showToast, syncPageScrollLock } from "./app-core.js";
import { products } from "./storefront-catalog.js";
import { activeCheckoutItems, activeCheckoutScope, openCheckout } from "./checkout-flow.js";
import { beginLineLogin, profileIsComplete, showProfileDialog } from "./member-profile.js";
import { requireLineFriendshipForCheckout } from "./member-benefits.js";

export const cart = [];

let cartDeliveryMethod = "store_pickup";

const cartGroupDeliveryMethods = { in_stock: "store_pickup", preorder: "store_pickup" };
const MEMBER_CART_SYNC_DEBOUNCE_MS = 750;
let cartSyncTimer = null;
let cartSyncRevision = 0;
export let cartSyncUserId = null;
let lastSyncedCartHash = null;
let pendingCartSnapshot = null;
let pendingCartHash = null;
let cartSyncInFlight = null;
let cartSyncGeneration = 0;

// 登出或切換會員時清除購物車同步對象（登入模組不能直接重新指定這個 let）
export function forgetCartSyncUser() {
  cartSyncUserId = null;
}

export function resetMemberCartSyncState() {
  if (cartSyncTimer) window.clearTimeout(cartSyncTimer);
  cartSyncTimer = null;
  cartSyncRevision += 1;
  cartSyncGeneration += 1;
  lastSyncedCartHash = null;
  pendingCartSnapshot = null;
  pendingCartHash = null;
  // A pending fetch cannot be cancelled reliably across browsers. Drop the
  // guard and use cartSyncGeneration so its completion cannot update a new
  // member session.
  cartSyncInFlight = null;
  cartSyncUserId = null;
}

try {
  const savedDeliveryMethod = sessionStorage.getItem("cj-cart-delivery-method");
  if (["store_pickup", "seller_delivery", "home_delivery"].includes(savedDeliveryMethod)) cartDeliveryMethod = savedDeliveryMethod;
  for (const scope of Object.keys(cartGroupDeliveryMethods)) {
    const savedGroupMethod = sessionStorage.getItem(`cj-cart-delivery-method-${scope}`);
    if (["store_pickup", "seller_delivery", "home_delivery"].includes(savedGroupMethod)) cartGroupDeliveryMethods[scope] = savedGroupMethod;
    else cartGroupDeliveryMethods[scope] = cartDeliveryMethod;
  }
} catch { /* sessionStorage may be unavailable in restricted previews. */ }

export function selectedDeliveryMethod() { return document.querySelector("input[name='delivery_method']:checked")?.value || "store_pickup"; }
export function selectedPaymentMethod() { return document.querySelector("input[name='payment_method']:checked")?.value || "bank_transfer"; }

function cartItemMarkup(item) {
  return `<div class="cart-item"><div><h3>${escapeHtml(item.name)}</h3><small>${money(item.price)} · ${escapeHtml(item.category)} · ${isPreorderItem(item) ? "預購" : "現貨"}</small><div class="quantity"><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="-1" aria-label="減少「${escapeHtml(item.name)}」數量">−</button><b>${item.quantity}</b><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="1" aria-label="增加「${escapeHtml(item.name)}」數量">＋</button></div></div><div><strong>${money(item.price * item.quantity)}</strong><button class="remove" type="button" data-remove="${escapeHtml(item.id)}">移除</button></div></div>`;
}

function renderCartSplitGroups() {
  const itemsNode = document.querySelector("#cart-items");
  const groups = cartGroups();
  const mixed = groups.in_stock.length > 0 && groups.preorder.length > 0;
  itemsNode?.classList.toggle("is-mixed", mixed);
  itemsNode?.querySelector("#cart-split-groups")?.remove();
  const globalChoice = document.querySelector(".cart-delivery-choice");
  const globalNote = document.querySelector(".cart-delivery-note");
  globalChoice?.classList.toggle("hidden", mixed);
  globalNote?.classList.toggle("hidden", mixed);
  if (!itemsNode || !mixed) return;
  const wrapper = document.createElement("div");
  wrapper.id = "cart-split-groups";
  wrapper.className = "cart-split-groups";
  wrapper.innerHTML = `<p class="cart-split-note">購物車含現貨與預購，系統會分開建立 2 筆訂單；付款期限、庫存確認與 LINE 通知也會分開計算。</p>` + ["in_stock", "preorder"].map((scope) => {
    const group = groups[scope];
    const title = scope === "in_stock" ? "現貨商品" : "預購商品";
    const subtotal = group.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const method = selectedCartDeliveryMethod(scope);
    const sellerNote = scope === "preorder"
      ? "本站先建立預購訂單；到貨後客服通知，再由客服開賣貨便。運費由 7-11 取貨時收取。"
      : "先建立本站待確認訂單，再前往賣貨便完成結帳；運費由 7-11 取貨時收取。";
    const options = [
      ["store_pickup", "到店取貨", "台南市中西區民生路二段 93 號", ""],
      ["seller_delivery", "賣貨便", sellerNote, scope === "in_stock" ? "現貨／賣貨便 無法使用優惠券、點數折抵" : ""],
      ["home_delivery", "宅配", "現貨備貨完成或預購商品到貨後，由客服通知實際運費。", ""]
    ];
    return `<section class="cart-group" data-cart-group="${scope}"><header><div><span class="eyebrow">${scope === "in_stock" ? "READY" : "PREORDER"}</span><h3>${title}</h3></div><strong>${money(subtotal)}</strong></header><div class="cart-group-items">${group.map(cartItemMarkup).join("")}</div><fieldset class="cart-group-delivery"><legend>此組商品取貨方式</legend>${options.map(([value, label, note, warning]) => `<label class="cart-delivery-option"><input type="radio" name="cart_group_delivery_method_${scope}" value="${value}" data-group-delivery="${scope}" ${method === value ? "checked" : ""} /> <span><strong>${label}</strong><small>${note}</small>${warning ? `<em class="cart-seller-benefit-warning">${warning}</em>` : ""}</span></label>`).join("")}</fieldset><p class="cart-delivery-feedback hidden" data-group-feedback="${scope}" role="status" aria-live="polite"></p><button class="primary-button cart-group-checkout" type="button" data-checkout-scope="${scope}">${scope === "in_stock" ? "結帳現貨商品" : "結帳預購商品"}</button></section>`;
  }).join("");
  itemsNode.appendChild(wrapper);
}

function syncGlobalCartDeliveryCopy() {
  const allPreorder = cart.length > 0 && cart.every(isPreorderItem);
  const hasInStock = cart.some((item) => !isPreorderItem(item));
  const sellerOption = document.querySelector("input[name='cart_delivery_method'][value='seller_delivery']")?.closest("label");
  const sellerNote = sellerOption?.querySelector("small");
  const sellerWarning = sellerOption?.querySelector(".cart-seller-benefit-warning");
  if (sellerNote) sellerNote.textContent = allPreorder
    ? "本站先建立預購訂單；到貨後客服通知並開立賣貨便，運費由 7-11 取貨時收取。"
    : "前往賣貨便完成結帳，運費由 7-11 取貨時收取。";
  sellerWarning?.classList.toggle("hidden", !hasInStock);
  const note = document.querySelector(".cart-delivery-note");
  if (note) note.textContent = allPreorder
    ? "預購賣貨便流程：先建立本站訂金訂單 → 到貨後客服通知 → 客服開立賣貨便供尾款取貨。"
    : "現貨賣貨便流程：加入購物車 → 選賣貨便 → 建立本站待確認訂單 → 前往賣貨便 → 管理員人工核對。";
}

export function renderCart() {
  const items = document.querySelector("#cart-items");
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll("[data-cart-count]").forEach((node) => node.textContent = count);
  document.querySelector("[data-tray-count]")?.replaceChildren(document.createTextNode(`${count} 件`));
  document.querySelector("[data-tray-total]")?.replaceChildren(document.createTextNode(money(total)));
  document.querySelector("#selection-tray")?.classList.toggle("has-items", count > 0);
  const currentGroups = cartGroups();
  const remainingScope = currentGroups.in_stock.length && !currentGroups.preorder.length ? "in_stock" : currentGroups.preorder.length && !currentGroups.in_stock.length ? "preorder" : null;
  if (remainingScope && cartGroupDeliveryMethods[remainingScope]) cartDeliveryMethod = cartGroupDeliveryMethods[remainingScope];
  document.querySelectorAll("input[name='cart_delivery_method']").forEach((input) => { input.checked = input.value === cartDeliveryMethod; });
  document.querySelector("#cart-total").textContent = money(total);
  document.querySelector("#cart-empty").classList.toggle("hidden", cart.length > 0);
  items.innerHTML = cart.map(cartItemMarkup).join("");
  items.querySelectorAll(".cart-item small").forEach((meta) => {
    const [price, ...labels] = meta.textContent.split(" · ");
    if (!labels.length) return;
    meta.classList.add("cart-item-meta");
    meta.innerHTML = `<span>${escapeHtml(price)}</span><span>${escapeHtml(labels.join(" · "))}</span>`;
  });
  renderCartSplitGroups();
  syncGlobalCartDeliveryCopy();
  updateCartCheckoutAction();
}
function cartPayload(items = cart) { return items.map((item) => ({ variant_id: item.id, quantity: item.quantity })); }
function persistCartLocally() {
  try { sessionStorage.setItem("cj-cart", JSON.stringify(cart)); } catch { /* ignore restricted storage */ }
}
function stableCartHash(items = cart) {
  const entries = (Array.isArray(items) ? items : []).map((item) => {
    const variantId = item?.variant_id ?? item?.id;
    const quantity = Number(item?.quantity);
    if (variantId === undefined || variantId === null || !Number.isFinite(quantity)) return null;
    return { variant_id: String(variantId), quantity };
  }).filter(Boolean);
  entries.sort((left, right) => left.variant_id.localeCompare(right.variant_id) || left.quantity - right.quantity);
  return JSON.stringify(entries);
}
function snapshotCart(items = cart) {
  return (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
}
function queueMemberCartSnapshot(items = cart) {
  pendingCartSnapshot = snapshotCart(items);
  pendingCartHash = stableCartHash(pendingCartSnapshot);
  return pendingCartHash;
}
function scheduleMemberCartSync() {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return;
  cartSyncRevision += 1;
  const hash = queueMemberCartSnapshot(cart);
  if (!cartSyncInFlight && hash === lastSyncedCartHash) {
    pendingCartSnapshot = null;
    pendingCartHash = null;
    if (cartSyncTimer) window.clearTimeout(cartSyncTimer);
    cartSyncTimer = null;
    return;
  }
  if (cartSyncTimer) window.clearTimeout(cartSyncTimer);
  const revision = cartSyncRevision;
  cartSyncTimer = window.setTimeout(() => {
    cartSyncTimer = null;
    syncMemberCartToServer(revision).catch(() => {});
  }, MEMBER_CART_SYNC_DEBOUNCE_MS);
}
async function replaceMemberCartOnServer(items = cart) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return;
  const response = await fetch("/api/cart", {
    method: "PUT",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: cartPayload(items) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "會員購物車同步失敗");
}
function runMemberCartSync({ silent = false } = {}) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return Promise.resolve();
  const userId = auth.user.id;
  const generation = cartSyncGeneration;
  if (cartSyncInFlight) return cartSyncInFlight;
  let pump;
  pump = (async () => {
    while (cartSyncGeneration === generation && auth.accessToken && auth.user?.id === userId && auth.config?.authEnabled && pendingCartSnapshot) {
      const snapshot = pendingCartSnapshot;
      const hash = pendingCartHash ?? stableCartHash(snapshot);
      pendingCartSnapshot = null;
      pendingCartHash = null;
      if (hash === lastSyncedCartHash) continue;
      try {
        await replaceMemberCartOnServer(snapshot);
      } catch (error) {
        if (!silent && cartSyncGeneration === generation && auth.user?.id === userId) showToast(error.message || "會員購物車同步失敗，稍後會再試", "warning");
        return;
      }
      if (cartSyncGeneration === generation && auth.user?.id === userId) lastSyncedCartHash = hash;
    }
  })();
  const guardedPump = pump.finally(() => {
    if (cartSyncInFlight === guardedPump) cartSyncInFlight = null;
  });
  cartSyncInFlight = guardedPump;
  return guardedPump;
}
async function syncMemberCartToServer(revision = cartSyncRevision) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled || revision !== cartSyncRevision) return;
  // Keep only the newest state at flush time; any snapshot already in flight
  // is completed before runMemberCartSync drains this replacement.
  queueMemberCartSnapshot(cart);
  try { await runMemberCartSync(); }
  catch (error) { showToast(error.message || "會員購物車同步失敗，稍後會再試", "warning"); }
}
export async function syncMemberCartNow({ silent = false } = {}) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return;
  if (cartSyncTimer) { window.clearTimeout(cartSyncTimer); cartSyncTimer = null; }
  cartSyncRevision += 1;
  queueMemberCartSnapshot(cart);
  if (!cartSyncInFlight && pendingCartHash === lastSyncedCartHash) {
    pendingCartSnapshot = null;
    pendingCartHash = null;
    return;
  }
  try { await runMemberCartSync({ silent }); }
  catch (error) { if (!silent) showToast(error.message || "會員購物車同步失敗", "warning"); }
}
export function saveCart(options = {}) {
  persistCartLocally();
  if (options.sync !== false) scheduleMemberCartSync();
}
export function loadLocalCart() {
  try {
    const savedCart = JSON.parse(sessionStorage.getItem("cj-cart") || "[]");
    if (Array.isArray(savedCart)) {
      cart.push(...savedCart.slice(0, 50).map((item) => {
        const product = products.find((entry) => entry.id === item.id);
        const quantity = Number(item.quantity);
        const stock = Number(product?.stock || 0);
        return product && stock > 0 && Number.isInteger(quantity) && quantity > 0 ? { ...product, quantity: Math.min(quantity, stock, 100) } : null;
      }).filter(Boolean));
    }
  } catch { try { sessionStorage.removeItem("cj-cart"); } catch { /* ignore restricted storage */ } }
}
export async function loadMemberCart() {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled || cartSyncUserId === auth.user.id) return;
  try {
    const response = await fetch("/api/cart", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "會員購物車載入失敗");
    const remoteItems = Array.isArray(result.items) ? result.items : [];
    const remoteHashItems = remoteItems.map((remote) => {
      const product = products.find((entry) => String(entry.id).toLowerCase() === String(remote?.variant_id).toLowerCase());
      return { variant_id: product?.id ?? remote?.variant_id, quantity: remote?.quantity };
    });
    const remoteCartHash = stableCartHash(remoteHashItems);
    const localItems = cart.slice();
    const merged = new Map();
    for (const item of localItems) {
      const product = products.find((entry) => String(entry.id).toLowerCase() === String(item.id).toLowerCase());
      const quantity = Number(item.quantity);
      if (product && Number.isInteger(quantity) && quantity > 0 && Number(product.stock || 0) > 0) merged.set(item.id, { ...product, quantity: Math.min(quantity, Number(product.stock || 0), 100) });
    }
    for (const remote of remoteItems) {
      const product = products.find((entry) => String(entry.id).toLowerCase() === String(remote.variant_id).toLowerCase());
      const quantity = Number(remote.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || Number(product.stock || 0) <= 0) continue;
      const existing = merged.get(product.id);
      merged.set(product.id, { ...product, quantity: Math.min((existing?.quantity || 0) + quantity, Number(product.stock || 0), 100) });
    }
    cart.splice(0, cart.length, ...[...merged.values()].slice(0, 50));
    cartSyncUserId = auth.user.id;
    lastSyncedCartHash = remoteCartHash;
    saveCart({ sync: false });
    if (stableCartHash(cart) !== remoteCartHash) await syncMemberCartNow({ silent: true });
    if (document.body.classList.contains("auth-boot-ready")) renderCart();
  } catch (error) {
    showToast(error.message || "會員購物車同步失敗，仍保留本機購物車", "warning");
  }
}
function addToCart(id) { const product = products.find((item) => item.id === id); const existing = cart.find((item) => item.id === id); if (existing) { if (existing.quantity >= product.stock) return showToast("已達可選購庫存上限"); existing.quantity += 1; } else cart.push({ ...product, quantity: 1 }); saveCart(); renderCart(); showToast(`${product.name} 已加入購物車`); }
export function toggleCart() { const drawer = document.querySelector("#cart-drawer"); const open = drawer.classList.toggle("open"); document.querySelector(".overlay").classList.toggle("visible", open); drawer.setAttribute("aria-hidden", String(!open)); syncPageScrollLock(); }
export function cartGroups() {
  return {
    in_stock: cart.filter((item) => !isPreorderItem(item)),
    preorder: cart.filter((item) => isPreorderItem(item))
  };
}
export function cartItemsForScope(scope) {
  if (scope === "in_stock") return cart.filter((item) => !isPreorderItem(item));
  if (scope === "preorder") return cart.filter((item) => isPreorderItem(item));
  return cart;
}
export function checkoutCartItems() { return activeCheckoutItems || cartItemsForScope(activeCheckoutScope); }
export function selectedCartDeliveryMethod(scope = null) {
  if (!scope || !cartGroups().in_stock.length || !cartGroups().preorder.length) return cartDeliveryMethod;
  return cartGroupDeliveryMethods[scope] || cartDeliveryMethod;
}
function flashAddedButton(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add("is-added");
  button.textContent = "已加入 ✓";
  window.setTimeout(() => {
    if (!button.isConnected) return;
    button.disabled = false;
    button.classList.remove("is-added");
    button.textContent = originalLabel;
  }, 1100);
}
export function addToCartWithFeedback(id, button) {
  const beforeCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  addToCart(id);
  const afterCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  if (afterCount > beforeCount) flashAddedButton(button);
}
export function setCartDeliveryMethod(method) {
  if (!["store_pickup", "seller_delivery", "home_delivery"].includes(method)) return;
  cartDeliveryMethod = method;
  const groups = cartGroups();
  const scope = groups.in_stock.length && !groups.preorder.length ? "in_stock" : groups.preorder.length && !groups.in_stock.length ? "preorder" : null;
  if (scope) cartGroupDeliveryMethods[scope] = method;
  try { sessionStorage.setItem("cj-cart-delivery-method", method); } catch { /* ignore restricted storage */ }
  if (scope) try { sessionStorage.setItem(`cj-cart-delivery-method-${scope}`, method); } catch { /* ignore restricted storage */ }
  document.querySelectorAll("input[name='cart_delivery_method']").forEach((input) => { input.checked = input.value === cartDeliveryMethod; });
  updateCartCheckoutAction();
}
export function setCartGroupDeliveryMethod(scope, method) {
  if (!Object.prototype.hasOwnProperty.call(cartGroupDeliveryMethods, scope) || !["store_pickup", "seller_delivery", "home_delivery"].includes(method)) return;
  cartGroupDeliveryMethods[scope] = method;
  try { sessionStorage.setItem(`cj-cart-delivery-method-${scope}`, method); } catch { /* ignore restricted storage */ }
  updateCartCheckoutAction();
}
function cartSellerDeliveryState(scope = null) {
  const method = selectedCartDeliveryMethod(scope);
  const groupItems = cartItemsForScope(scope);
  if (method !== "seller_delivery" || !groupItems.length) return { invalid: false, message: "" };
  if (scope === "preorder" || groupItems.every(isPreorderItem)) return { invalid: false, message: "預購會先建立本站訂單並收取訂金；商品到貨後由客服通知，再開立賣貨便供尾款取貨。" };
  const links = [...new Set(groupItems.map((item) => item.link || item.seller_link).filter(Boolean))];
  if (groupItems.some(isPreorderItem)) return { invalid: true, message: "現貨與預購已分組，請分開選擇取貨方式。" };
  if (!links.length) return { invalid: true, message: "這組現貨商品尚未設定賣貨便連結，請改選到店取貨或宅配。" };
  if (links.length > 1) return { invalid: true, message: "這組商品有不同賣場連結，請拆成不同批次結帳。" };
  return { invalid: false, message: "下一步會先建立本站「待確認」訂單，再開啟賣貨便；完成賣貨便結帳後，請等待管理員人工核對。" };
}
function syncCartDeliveryFeedback(scope = null) {
  const feedback = scope ? document.querySelector(`[data-group-feedback='${scope}']`) : document.querySelector("#cart-delivery-feedback");
  const state = cartSellerDeliveryState(scope);
  if (!feedback) return state;
  feedback.textContent = state.message;
  feedback.classList.toggle("hidden", !state.message);
  feedback.classList.toggle("is-error", state.invalid);
  feedback.classList.toggle("is-ready", Boolean(state.message) && !state.invalid);
  feedback.setAttribute("role", state.invalid ? "alert" : "status");
  return state;
}
function updateCartCheckoutAction() {
  const button = document.querySelector("#cart-drawer [data-checkout]");
  const groups = cartGroups();
  const mixed = groups.in_stock.length > 0 && groups.preorder.length > 0;
  if (button) {
    button.classList.toggle("hidden", mixed);
    if (!mixed) {
      const scope = groups.preorder.length ? "preorder" : "in_stock";
      const method = selectedCartDeliveryMethod(scope);
      const sellerCheckout = method === "seller_delivery" && scope === "in_stock";
      const sellerState = syncCartDeliveryFeedback();
      button.textContent = sellerCheckout ? "前往賣貨便結帳" : "前往 結帳";
      button.setAttribute("aria-label", sellerCheckout ? "前往賣貨便結帳" : "前往本站結帳");
      button.classList.toggle("seller-checkout-button", sellerCheckout);
      button.disabled = sellerCheckout && sellerState.invalid;
      button.setAttribute("aria-disabled", String(button.disabled));
      if (sellerState.message) button.setAttribute("aria-describedby", "cart-delivery-feedback");
      else button.removeAttribute("aria-describedby");
    }
  }
  ["in_stock", "preorder"].forEach((scope) => {
    const groupButton = document.querySelector(`[data-checkout-scope='${scope}']`);
    if (!groupButton || !groups[scope].length) return;
    const method = selectedCartDeliveryMethod(scope);
    const sellerCheckout = method === "seller_delivery" && scope === "in_stock";
    const state = syncCartDeliveryFeedback(scope);
    groupButton.textContent = sellerCheckout ? "前往賣貨便結帳" : `結帳${scope === "in_stock" ? "現貨" : "預購"}商品`;
    groupButton.classList.toggle("seller-checkout-button", sellerCheckout);
    groupButton.disabled = sellerCheckout && state.invalid;
    groupButton.setAttribute("aria-disabled", String(groupButton.disabled));
  });
  if (!mixed) syncCartDeliveryFeedback();
}
async function openSellerDeliveryCheckout(scope = "in_stock") {
  const groupItems = cartItemsForScope(scope);
  if (!groupItems.length) return showToast("請先加入商品", "warning");
  const links = [...new Set(groupItems.map((item) => item.link || item.seller_link).filter(Boolean))];
  if (!links.length) return showToast("購物車商品尚未設定賣貨便連結，請改選其他取貨方式", "warning");
  if (links.length > 1) return showToast("購物車內商品屬於不同賣場，請分開前往賣貨便結帳", "warning");
  if (groupItems.some(isPreorderItem)) return showToast("預購賣貨便請使用本站結帳，商品到貨後再由客服開立賣貨便", "warning");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const button = document.querySelector(`[data-checkout-scope='${scope}']`) || document.querySelector("#cart-drawer [data-checkout]");
  if (button instanceof HTMLButtonElement) { button.disabled = true; button.textContent = "建立待確認紀錄…"; }
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: groupItems.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: "together", delivery_method: "seller_delivery", payment_method: "store_payment" })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || "賣貨便待確認訂單建立失敗");
    cart.splice(0, cart.length, ...cart.filter((item) => !groupItems.includes(item)));
    saveCart();
    await syncMemberCartNow({ silent: true });
    renderCart();
    window.location.assign(links[0]);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button instanceof HTMLButtonElement) { button.disabled = false; updateCartCheckoutAction(); }
  }
}
export function handleCartCheckout(scope = null) {
  const groups = cartGroups();
  if (!scope && groups.in_stock.length && groups.preorder.length) return showToast("購物車含現貨與預購，請分別點選各組的結帳按鈕", "warning");
  const checkoutScope = scope || (groups.preorder.length ? "preorder" : "in_stock");
  const method = selectedCartDeliveryMethod(checkoutScope);
  if (method === "seller_delivery" && checkoutScope === "in_stock") return openSellerDeliveryCheckout(checkoutScope);
  openCheckout(checkoutScope);
}
// 商品頁加入購物車：依庫存與限購檢查後加入指定數量。伺服器建單時仍會重新驗證。
export function addVariantQuantityToCart(variantId, quantity) {
  const variant = products.find((item) => item.id === variantId);
  if (!variant) return { ok: false, message: "找不到這個規格，請重新整理頁面" };
  const purchaseLimit = Number.isInteger(Number(variant.purchase_limit)) && Number(variant.purchase_limit) > 0 ? Number(variant.purchase_limit) : null;
  const maxQuantity = purchaseLimit ? Math.min(variant.stock, purchaseLimit) : variant.stock;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) return { ok: false, message: `數量需介於 1 至 ${Math.max(maxQuantity, 1)} 件` };
  const existing = cart.find((item) => item.id === variant.id);
  if (existing && existing.quantity + quantity > maxQuantity) return { ok: false, message: "已達可選購庫存或限購上限" };
  if (existing) existing.quantity += quantity;
  else cart.push({ ...variant, quantity });
  saveCart();
  renderCart();
  return { ok: true, message: `${variant.name} 已加入購物車` };
}

// 商品卡「直接購買」：尚未在購物車才加入 1 件（避免連點變 2 件），再打開購物車抽屜；
// 取貨方式、預購與現貨分開結帳、登入都在購物車內處理，不直接跳過到結帳頁。
export function buyNowFromCard(variantId) {
  if (!cart.some((item) => item.id === variantId)) {
    const result = addVariantQuantityToCart(variantId, 1);
    if (!result.ok) return showToast(result.message, "warning");
  }
  if (!document.querySelector("#cart-drawer")?.classList.contains("open")) toggleCart();
}
