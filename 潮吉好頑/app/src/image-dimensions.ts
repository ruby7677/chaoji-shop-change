// 從圖片檔頭讀出原始寬高（PNG、JPEG、WebP），不解碼像素；無法辨識時回 null。
// 只需要檔案開頭：PNG／WebP 在前 30 bytes 內，JPEG 的 SOF 區段通常在前 64KB（EXIF 之後）。
export type ImageDimensions = { width: number; height: number };

const MAX_SIDE = 20000;

function valid(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE ? { width, height } : null;
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function readPng(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return valid(view.getUint32(16), view.getUint32(20));
}

function readWebp(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return valid(width, height);
  }
  return null;
}

// APP1 Exif 的 Orientation（0x0112）；讀不到或格式不對時回 1（不旋轉）
function exifOrientation(bytes: Uint8Array, view: DataView, start: number, end: number) {
  if (end - start < 14 || ascii(bytes, start, 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const little = ascii(bytes, tiff, 2) === "II";
  if (!little && ascii(bytes, tiff, 2) !== "MM") return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return 1;
}

// SOF0–SOF15（排除 DHT C4、JPG C8、DAC CC）記錄編碼的高與寬；EXIF 方向 5–8 會轉 90 度顯示，寬高互換
function readJpeg(bytes: Uint8Array, view: DataView) {
  let offset = 2;
  let orientation = 1;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1) orientation = exifOrientation(bytes, view, offset + 4, Math.min(offset + 2 + length, bytes.length));
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const width = view.getUint16(offset + 7);
      const height = view.getUint16(offset + 5);
      return orientation >= 5 && orientation <= 8 ? valid(height, width) : valid(width, height);
    }
    if (marker === 0xda || marker === 0xd9) return null;
    offset += 2 + length;
  }
  return null;
}

export function readImageDimensions(input: ArrayBuffer | Uint8Array): ImageDimensions | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return readPng(bytes, view);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return readWebp(bytes, view);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes, view);
  return null;
}
