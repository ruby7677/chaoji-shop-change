// 商品頁多圖：原生 scroll-snap 滑動、計數器、上一張／下一張、縮圖列，點圖開全螢幕大圖。
// 滑動交給瀏覽器原生捲動（手勢最順、無額外套件）；JS 只同步計數與按鈕狀態。
import { escapeHtml } from "./product-format.js";

function slideIndex(track) {
  const slides = [...track.children];
  let nearest = 0;
  let distance = Infinity;
  slides.forEach((slide, index) => {
    const gap = Math.abs(slide.offsetLeft - track.scrollLeft - track.firstElementChild.offsetLeft);
    if (gap < distance) { distance = gap; nearest = index; }
  });
  return nearest;
}

function scrollToSlide(track, index) {
  const slide = track.children[index];
  if (!slide) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  track.scrollTo({ left: slide.offsetLeft - track.firstElementChild.offsetLeft, behavior: smooth ? "smooth" : "auto" });
}

function trackMarkup(images, name, { zoomable }) {
  return images.map((image, index) => {
    const alt = `${image.alt || name} 第 ${index + 1} 張`;
    const loading = index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
    const size = image.width && image.height ? ` width="${image.width}" height="${image.height}"` : "";
    const img = `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(alt)}"${size} decoding="async" ${loading} />`;
    return `<figure class="pp-gallery-slide">${zoomable ? `<button type="button" class="pp-gallery-zoom" data-gallery-zoom="${index}" aria-label="放大檢視第 ${index + 1} 張">${img}</button>` : img}</figure>`;
  }).join("");
}

function barMarkup(total) {
  if (total < 2) return "";
  return `<div class="pp-gallery-bar"><button type="button" class="pp-gallery-nav" data-gallery-step="-1" aria-label="上一張">‹</button><span class="pp-gallery-counter" aria-live="polite"><b data-gallery-current>1</b> / ${total}</span><button type="button" class="pp-gallery-nav" data-gallery-step="1" aria-label="下一張">›</button></div>`;
}

export function productGalleryMarkup(images, name) {
  if (!images.length) return `<div class="pp-gallery pp-gallery--empty"><div class="product-placeholder"><span>${escapeHtml(String(name).slice(0, 2))}</span><small>潮吉好頑選物</small></div></div>`;
  const thumbs = images.length > 1
    ? `<div class="pp-gallery-thumbs" role="group" aria-label="選擇照片">${images.map((image, index) => `<button type="button" data-gallery-thumb="${index}" aria-label="第 ${index + 1} 張" ${index === 0 ? 'aria-current="true"' : ""}><img src="${escapeHtml(image.url)}" alt="" loading="lazy" decoding="async" /></button>`).join("")}</div>`
    : "";
  return `<div class="pp-gallery" role="region" aria-roledescription="carousel" aria-label="商品照片"><div class="pp-gallery-track" tabindex="0" data-gallery-track>${trackMarkup(images, name, { zoomable: true })}</div>${barMarkup(images.length)}${thumbs}</div>`;
}

// 同一組控制行為給商品頁與大圖共用。
function bindTrack(container, signal, onIndex) {
  const track = container.querySelector("[data-gallery-track]");
  if (!track) return null;
  let frame = 0;
  const update = () => {
    const index = slideIndex(track);
    const current = container.querySelector("[data-gallery-current]");
    if (current) current.textContent = String(index + 1);
    container.querySelector('[data-gallery-step="-1"]')?.toggleAttribute("disabled", index === 0);
    container.querySelector('[data-gallery-step="1"]')?.toggleAttribute("disabled", index === track.children.length - 1);
    container.querySelectorAll("[data-gallery-thumb]").forEach((thumb) => thumb.setAttribute("aria-current", String(Number(thumb.dataset.galleryThumb) === index)));
    onIndex?.(index);
  };
  track.addEventListener("scroll", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); }, { passive: true, signal });
  container.addEventListener("click", (event) => {
    const step = event.target.closest("[data-gallery-step]");
    const thumb = event.target.closest("[data-gallery-thumb]");
    if (step) scrollToSlide(track, slideIndex(track) + Number(step.dataset.galleryStep));
    if (thumb) scrollToSlide(track, Number(thumb.dataset.galleryThumb));
  }, { signal });
  update();
  return { track, update };
}

export function bindProductGallery(root, { images, name, showDialog, closeDialog }) {
  const abort = new AbortController();
  const { signal } = abort;
  bindTrack(root, signal);
  const lightbox = document.querySelector("#product-lightbox");
  let lightboxAbort = null;

  function openLightbox(index) {
    if (!lightbox) return;
    lightboxAbort?.abort();
    lightboxAbort = new AbortController();
    const body = lightbox.querySelector("[data-lightbox-body]");
    body.innerHTML = `<button class="dialog-close pp-lightbox-close" type="button" data-lightbox-close aria-label="關閉大圖">×</button><div class="pp-gallery pp-gallery--lightbox" role="region" aria-roledescription="carousel" aria-label="${escapeHtml(name)} 大圖"><div class="pp-gallery-track" tabindex="0" data-gallery-track>${trackMarkup(images, name, { zoomable: false })}</div>${barMarkup(images.length)}</div>`;
    const bound = bindTrack(body, lightboxAbort.signal);
    body.querySelector("[data-lightbox-close]").addEventListener("click", () => closeDialog(lightbox), { signal: lightboxAbort.signal });
    showDialog(lightbox);
    // 開啟後才有版面尺寸，此時才能定位到被點的那一張。
    requestAnimationFrame(() => {
      bound.track.scrollLeft = bound.track.children[index]?.offsetLeft - bound.track.firstElementChild.offsetLeft || 0;
      bound.update();
      bound.track.focus({ preventScroll: true });
    });
  }

  root.addEventListener("click", (event) => {
    const zoom = event.target.closest("[data-gallery-zoom]");
    if (zoom) openLightbox(Number(zoom.dataset.galleryZoom));
  }, { signal });

  return {
    destroy() {
      abort.abort();
      lightboxAbort?.abort();
      if (lightbox?.open) closeDialog(lightbox);
    }
  };
}
