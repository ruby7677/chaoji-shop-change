let products = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", icon: "🌀" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", icon: "⚔️" }
];

const cart = [];
const grid = document.querySelector("#product-grid");
const search = document.querySelector("#product-search");
const auth = { config: null, accessToken: null, refreshToken: null, user: null };
let activeCategory = "all";

function money(value) { return `NT$${value.toLocaleString("zh-TW")}`; }
function showToast(message) { const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show"); window.setTimeout(() => toast.classList.remove("show"), 2400); }
function renderProducts() {
  const keyword = search.value.trim().toLowerCase();
  const visible = products.filter((product) => (activeCategory === "all" || product.category === activeCategory || product.type === activeCategory) && `${product.category}${product.name}`.toLowerCase().includes(keyword));
  grid.innerHTML = visible.length ? visible.map((product) => `<article class="product-card"><div class="product-image"><span>${product.icon ?? "🎁"}</span></div><div class="product-info"><span class="product-category">${product.category} · ${product.type}</span><h3>${product.name}</h3><p class="stock">${product.type === "現貨" ? `現貨 ${product.stock} 件` : `預購${product.preorder_arrival ? ` · ${product.preorder_arrival}` : " · 訂金 50%"}`}</p><div class="price">${money(product.price)}</div><div class="card-actions"><button type="button" data-add="${product.id}">加入購物車</button></div></div></article>`).join("") : "<p>目前沒有符合的商品。</p>";
}
function renderCart() {
  const items = document.querySelector("#cart-items");
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  document.querySelectorAll("[data-cart-count]").forEach((node) => node.textContent = cart.reduce((sum, item) => sum + item.quantity, 0));
  document.querySelector("#cart-total").textContent = money(total);
  document.querySelector("#cart-empty").classList.toggle("hidden", cart.length > 0);
  items.innerHTML = cart.map((item) => `<div class="cart-item"><div><h3>${item.name}</h3><small>${money(item.price)} · ${item.category}</small><div class="quantity"><button type="button" data-quantity="${item.id}" data-delta="-1">−</button><b>${item.quantity}</b><button type="button" data-quantity="${item.id}" data-delta="1">＋</button></div></div><div><strong>${money(item.price * item.quantity)}</strong><button class="remove" type="button" data-remove="${item.id}">移除</button></div></div>`).join("");
}
function saveCart() { sessionStorage.setItem("cj-cart", JSON.stringify(cart)); }
function addToCart(id) { const product = products.find((item) => item.id === id); const existing = cart.find((item) => item.id === id); if (existing) { if (existing.quantity >= product.stock) return showToast("已達可選購庫存上限"); existing.quantity += 1; } else cart.push({ ...product, quantity: 1 }); saveCart(); renderCart(); showToast(`${product.name} 已加入購物車`); }
function toggleCart() { const drawer = document.querySelector("#cart-drawer"); const open = drawer.classList.toggle("open"); document.querySelector(".overlay").classList.toggle("visible", open); drawer.setAttribute("aria-hidden", String(!open)); }

function captureAuthSession() {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (fragment.get("access_token")) {
    auth.accessToken = fragment.get("access_token");
    auth.refreshToken = fragment.get("refresh_token");
    sessionStorage.setItem("cj-auth", JSON.stringify({ accessToken: auth.accessToken, refreshToken: auth.refreshToken }));
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem("cj-auth") || "null");
    auth.accessToken = saved?.accessToken ?? null;
    auth.refreshToken = saved?.refreshToken ?? null;
  } catch { sessionStorage.removeItem("cj-auth"); }
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) auth.config = await response.json();
  } catch { auth.config = null; }
}

async function loadMember() {
  if (!auth.accessToken || !auth.config?.authEnabled) return;
  try {
    const response = await fetch(`${auth.config.supabaseUrl}/auth/v1/user`, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
    if (!response.ok) throw new Error("expired");
    auth.user = await response.json();
    const displayName = auth.user.user_metadata?.name || auth.user.user_metadata?.full_name || "會員";
    document.querySelector("[data-demo='login']").textContent = displayName;
  } catch {
    auth.accessToken = null; auth.refreshToken = null; auth.user = null; sessionStorage.removeItem("cj-auth");
  }
}

function beginLineLogin() {
  if (!auth.config?.authEnabled) return showToast("LINE Login 尚未在 Supabase 啟用");
  saveCart();
  const redirectTo = location.origin + location.pathname;
  const url = new URL(`${auth.config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", auth.config.lineProvider);
  url.searchParams.set("redirect_to", redirectTo);
  location.assign(url.toString());
}

async function saveProfile(fullName, phone) {
  const response = await fetch(`${auth.config.supabaseUrl}/rest/v1/profiles?id=eq.${auth.user.id}`, {
    method: "PATCH",
    headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ full_name: fullName, phone })
  });
  if (!response.ok) throw new Error("會員資料儲存失敗");
}

async function submitOrder() {
  if (!auth.config?.authEnabled) return showToast("目前為靜態預覽，尚未連接訂單資料庫");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const fullName = document.querySelector("#checkout-name").value.trim();
  const phone = document.querySelector("#checkout-phone").value.trim();
  const lastFive = document.querySelector("#checkout-last-five").value.trim();
  const pickupPlan = document.querySelector("input[name='pickup']:checked").value;
  await saveProfile(fullName, phone);
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: pickupPlan, payment_last_five: lastFive || null })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "訂單建立失敗");
  cart.splice(0); saveCart(); renderCart(); document.querySelector("#checkout-dialog").close();
  showToast("訂單已建立，請等待管理員確認款項");
}

document.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add]"); if (add) addToCart(add.dataset.add);
  const change = event.target.closest("[data-quantity]"); if (change) { const item = cart.find((entry) => entry.id === change.dataset.quantity); const delta = Number(change.dataset.delta); const max = products.find((product) => product.id === item.id).stock; item.quantity = Math.min(max, item.quantity + delta); if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const remove = event.target.closest("[data-remove]"); if (remove) { const item = cart.find((entry) => entry.id === remove.dataset.remove); cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  if (event.target.closest("[data-cart-toggle]")) toggleCart();
  if (event.target.closest("[data-checkout]")) { if (!cart.length) return showToast("請先加入商品"); document.querySelector("#checkout-dialog").showModal(); }
  if (event.target.closest("[data-admin-open]")) document.querySelector("#admin-dialog").showModal();
  if (event.target.closest("[data-admin-close]")) document.querySelector("#admin-dialog").close();
  if (event.target.closest("#checkout-dialog .dialog-close")) { event.preventDefault(); document.querySelector("#checkout-dialog").close(); }
  if (event.target.closest("[data-demo='login']")) beginLineLogin();
});
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { activeCategory = button.dataset.category; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button)); renderProducts(); }));
search.addEventListener("input", renderProducts);
document.querySelector("#checkout-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await submitOrder(); } catch (error) { showToast(error.message); } });
async function loadProducts() {
  try {
    const response = await fetch("/api/catalog");
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.products) && payload.products.length) products = payload.products.map((product) => ({ ...product, icon: product.category?.startsWith("BX") ? "🌀" : "⚔️" }));
  } catch {
    // 在純靜態預覽時保留示範資料。
  }
}

captureAuthSession();
await Promise.all([loadRuntimeConfig(), loadProducts()]);
await loadMember();
try { const savedCart = JSON.parse(sessionStorage.getItem("cj-cart") || "[]"); if (Array.isArray(savedCart)) cart.push(...savedCart.filter((item) => products.some((product) => product.id === item.id))); } catch { sessionStorage.removeItem("cj-cart"); }
renderProducts(); renderCart();
