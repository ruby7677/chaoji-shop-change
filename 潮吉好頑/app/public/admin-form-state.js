// 編輯面板分頁化後，商品／規格／展示設定各自獨立成分頁；重新整理清單（送出成功後）會整段換新 HTML，
// 若使用者正在別的分頁輸入到一半，原本的內容會被直接蓋掉。這裡只放「表單欄位快照與還原」的純資料邏輯，
// 不碰 DOM，方便單元測試；實際讀寫表單元素留在 admin-products-table.js。
//
// 欄位以 { name, type, value, checked } 表示；輸入來源可以是真的表單元素（name/type/value/checked 為
// getter），也可以是測試用的一般物件，只要結構相同即可。

// 從一組「表單元素」建立快照：忽略沒有 name 的欄位；file 類型無法（也不該）還原，直接跳過。
export function snapshotFields(elements) {
  const fields = [];
  for (const element of elements || []) {
    if (!element || !element.name || element.type === "file") continue;
    if (element.type === "checkbox" || element.type === "radio") {
      fields.push({ name: element.name, type: element.type, value: element.value, checked: Boolean(element.checked) });
    } else {
      fields.push({ name: element.name, type: element.type, value: element.value });
    }
  }
  return fields;
}

// 在快照裡找出對應某個表單元素的欄位。checkbox／radio 同名可能有多個選項，需連 value 一起比對，
// 避免把 A 選項的勾選狀態誤套到同名的 B 選項上；一般欄位只比對 name。
export function matchField(fields, element) {
  if (!element || !element.name || !Array.isArray(fields)) return null;
  if (element.type === "checkbox" || element.type === "radio") {
    return fields.find((field) => field.name === element.name && field.type === element.type && field.value === element.value) || null;
  }
  return fields.find((field) => field.name === element.name && field.type !== "checkbox" && field.type !== "radio") || null;
}

// 以表單 key（例如 product:<id>、variant:<id>、showcase:<id>）保存/取出快照。
// take() 對未保存過的 key 一律回傳 null，呼叫端據此判斷「沒有要還原的資料」而略過，不丟例外。
export function createFormStateStore() {
  const store = new Map();
  return {
    save(key, fields) { store.set(key, fields); },
    take(key) {
      if (!store.has(key)) return null;
      const fields = store.get(key);
      store.delete(key);
      return fields;
    },
    has(key) { return store.has(key); },
    clear() { store.clear(); }
  };
}
