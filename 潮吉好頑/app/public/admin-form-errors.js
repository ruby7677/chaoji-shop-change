// 後台表單的就地錯誤：送出失敗時把訊息放在送出按鈕上方（role="alert"），並把焦點帶到出錯欄位。
// toast 會消失、也可能離表單很遠；就地訊息留到下一次輸入或送出才清除。
// 錯誤物件可帶 field（欄位 name）指定出錯欄位；沒有時改找瀏覽器判定為 :invalid 的第一個欄位。
const ERROR_CLASS = "admin-form-error";

function submitAnchor(form) {
  const button = form.querySelector("button[type='submit']:not([hidden])");
  if (!button) return null;
  // 面板內的送出列（.form-actions）是 sticky；訊息放在整列之前才不會被蓋住
  return button.closest(".form-actions") || button;
}

function invalidField(form, error) {
  const named = error?.field ? form.elements.namedItem(error.field) : null;
  if (named instanceof HTMLElement) return named;
  return form.querySelector(":invalid:not(fieldset)");
}

export function clearAdminFormError(form) {
  if (!(form instanceof HTMLFormElement)) return;
  form.querySelectorAll(`:scope .${ERROR_CLASS}`).forEach((node) => node.remove());
  form.querySelectorAll("[aria-invalid='true']").forEach((field) => field.removeAttribute("aria-invalid"));
}

export function showAdminFormError(form, error) {
  if (!(form instanceof HTMLFormElement) || !form.isConnected) return;
  clearAdminFormError(form);
  const message = document.createElement("p");
  message.className = ERROR_CLASS;
  message.setAttribute("role", "alert");
  message.textContent = error?.message || "儲存失敗，請稍後再試";
  const anchor = submitAnchor(form);
  if (anchor?.parentElement) anchor.parentElement.insertBefore(message, anchor);
  else form.append(message);
  const field = invalidField(form, error);
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.focus({ preventScroll: false });
  } else {
    // 置中而非 nearest：面板底部的送出鈕是 sticky（帶白色陰影），nearest 會讓訊息停在按鈕底下
    message.scrollIntoView({ block: "center" });
  }
  form.addEventListener("input", () => clearAdminFormError(form), { once: true });
}
