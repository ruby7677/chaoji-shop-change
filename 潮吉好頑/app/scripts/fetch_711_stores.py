"""抓取 7-ELEVEN 門市並整理成 build-cvs-stores.mjs 要的 6 欄 CSV。

流程：7-11 門市地圖 API（emap.pcsc.com.tw）→ 5 欄原始檔 → 抽出路名插入第 4 欄並排序 → 6 欄最終檔。
最終檔欄位：縣市, 鄉鎮區, 店號, 路名, 店名, 地址（無標題列）。

用法（在 app/ 執行）：
  python scripts/fetch_711_stores.py                       # 重新抓取（22 縣市，約十幾分鐘）
  python scripts/fetch_711_stores.py --raw-in 711_stores_raw.csv   # 不連線，只用既有原始檔重新整理
  node scripts/build-cvs-stores.mjs scripts/711-data/711_stores_sorted.csv   # 再產生網站用 JSON

抓取失敗、筆數明顯變少時不會覆蓋既有檔案（見 --force／--allow-missing）。
"""
import argparse
import csv
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

API_URL = "https://emap.pcsc.com.tw/EMapSDK.aspx"
BASE_URL = "https://emap.pcsc.com.tw/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://emap.pcsc.com.tw",
    "Referer": "https://emap.pcsc.com.tw/default.aspx",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
}
# (cityid, 縣市)；六都排前面，其餘照官方順序。排序用 CITY_ORDER。
CITIES = [
    ("01", "台北市"), ("02", "基隆市"), ("03", "新北市"), ("04", "桃園市"), ("05", "新竹市"), ("06", "新竹縣"),
    ("07", "苗栗縣"), ("08", "台中市"), ("10", "彰化縣"), ("11", "南投縣"), ("12", "雲林縣"), ("13", "嘉義市"),
    ("14", "嘉義縣"), ("15", "台南市"), ("17", "高雄市"), ("19", "屏東縣"), ("20", "宜蘭縣"), ("21", "花蓮縣"),
    ("22", "台東縣"), ("23", "澎湖縣"), ("24", "金門縣"), ("25", "連江縣"),
]
CITY_ORDER = {name: index for index, name in enumerate(
    ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市", "基隆市", "新竹市", "新竹縣", "苗栗縣", "彰化縣",
     "南投縣", "雲林縣", "嘉義市", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣"], start=1)}
RETRIES = 3
REQUEST_DELAY = 2.0
MIN_RATIO = 0.95  # 新筆數低於舊檔的這個比例就視為異常

CITY_PATTERN = re.compile(r"^(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)")
DISTRICT_PATTERN = re.compile(r"^(中正區|大同區|中山區|松山區|大安區|萬華區|信義區|士林區|北投區|內湖區|南港區|文山區|板橋區|三重區|中和區|永和區|新莊區|新店區|樹林區|鶯歌區|三峽區|淡水區|汐止區|瑞芳區|土城區|蘆洲區|五股區|泰山區|林口區|深坑區|石碇區|坪林區|三芝區|石門區|八里區|平溪區|雙溪區|貢寮區|金山區|萬里區|烏來區|中壢區|平鎮區|龍潭區|楊梅區|新屋區|觀音區|桃園區|龜山區|八德區|大溪區|復興區|大園區|蘆竹區|中區|東區|南區|西區|北區|北屯區|西屯區|南屯區|太平區|大里區|霧峰區|烏日區|豐原區|后里區|石岡區|東勢區|和平區|新社區|潭子區|大雅區|神岡區|大肚區|沙鹿區|龍井區|梧棲區|清水區|大甲區|外埔區|大安區|[一-龥]{1,3}[區鄉鎮市])")
NEIGHBOR_PATTERN = re.compile(r"[\d一二三四五六七八九十百零壹貳參肆伍陸柒捌玖拾]+鄰")
ROAD_MARKERS = ["路", "街", "大道", "巷"]
VILLAGE_MARKERS = ["村", "里"]


def road_name(address: str) -> str:
    """從地址抽出路、街、大道、巷；沒有時依序取村／里、號碼前的地名，都沒有回空字串。"""
    cleaned = NEIGHBOR_PATTERN.sub("", DISTRICT_PATTERN.sub("", CITY_PATTERN.sub("", address)))
    for marker in ROAD_MARKERS:
        # 從第 2 個字開始找：路名至少要有一個字在標記前，否則「路竹區路科十路」會只剩「路」
        position = cleaned.find(marker, 1)
        if position != -1:
            name = cleaned[:position + len(marker)]
            # 去掉路名前的里／村；剩下不到 2 字（如「大里路」）就不截斷
            for admin in ("里", "村"):
                if admin in name and len(name[name.rfind(admin) + 1:]) >= 2:
                    name = name[name.rfind(admin) + 1:]
            return name.strip()
    for marker in VILLAGE_MARKERS:
        if marker in cleaned:
            end = cleaned.find(marker)
            start = 0
            for i in range(end - 1, -1, -1):
                if cleaned[i].isdigit() or not "一" <= cleaned[i] <= "鿿":
                    start = i + 1
                    break
            return cleaned[start:end + 1].strip()
    match = re.match(r"^([一-龥]+)\d", cleaned)
    return match.group(1) if match else ""


def is_store_row(row: list[str]) -> bool:
    return len(row) >= 5 and row[2].strip().isdigit() and len(row[2].strip()) == 6


def to_final_rows(raw_rows: list[list[str]]) -> list[list[str]]:
    """5 欄原始列 → 6 欄（縣市, 區, 店號, 路名, 店名, 地址），依縣市順序、區、店號排序；標題列與重複店號會略過。"""
    seen = {}
    for row in raw_rows:
        if not is_store_row(row):
            continue
        city, district, code, name, address = (cell.strip() for cell in row[:5])
        seen[code] = [city, district, code, road_name(address), name, address]
    return sorted(seen.values(), key=lambda r: (CITY_ORDER.get(r[0], 99), r[1], r[2]))


def text_of(node: ET.Element, tag: str) -> str:
    child = node.find(tag)
    return (child.text or "").strip() if child is not None else ""


def post_with_retry(session, data: dict[str, str]) -> ET.Element | None:
    """每次重試都重新送出請求（只重複解析同一個回應不會恢復失敗）；全部失敗回 None。"""
    for attempt in range(1, RETRIES + 1):
        try:
            response = session.post(API_URL, data=data, headers=HEADERS, timeout=30)
            if response.status_code == 200:
                return ET.fromstring(response.text)
            print(f"  請求失敗 {response.status_code}（第 {attempt} 次）", file=sys.stderr)
        except Exception as error:  # 網路錯誤與 XML 解析錯誤都重試
            print(f"  發生錯誤：{error}（第 {attempt} 次）", file=sys.stderr)
        time.sleep(REQUEST_DELAY)
    return None


def fetch_city_rows(post, city_id: str, city: str, delay: float) -> tuple[list[list[str]], list[str]]:
    """抓一個縣市；回傳（門市列, 失敗項目）。官方回應可解析但沒有鄉鎮、或整個縣市沒有任何門市，都視為失敗而不是「沒有資料」。"""
    towns = post({"commandid": "GetTown", "cityid": city_id, "cityname": city})
    town_nodes = towns.findall(".//GeoPosition") if towns is not None else []
    if not town_nodes:
        return [], [city]
    rows, failed = [], []
    for town in town_nodes:
        town_name = text_of(town, "TownName")
        stores = post({"commandid": "SearchStore", "city": city, "town": town_name, "roadname": "", "ID": "", "StoreName": ""})
        if stores is None:
            failed.append(f"{city}{town_name}")
        else:
            rows += [[city, town_name, text_of(s, "POIID"), text_of(s, "POIName"), text_of(s, "Address")] for s in stores.findall(".//GeoPosition")]
        time.sleep(delay)
    if not rows and not failed:
        failed.append(city)
    return rows, failed


def fetch_raw_rows(delay: float) -> tuple[list[list[str]], list[str]]:
    import requests
    session = requests.Session()
    session.get(BASE_URL, timeout=30)
    rows, failed = [], []
    for city_id, city in CITIES:
        print(f"處理 {city}…")
        city_rows, city_failed = fetch_city_rows(lambda data: post_with_retry(session, data), city_id, city, delay)
        rows += city_rows
        failed += city_failed
    return rows, failed


def read_csv(path: Path) -> list[list[str]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as file:
        return list(csv.reader(file))


def write_csv(path: Path, rows: list[list[str]]) -> None:
    with open(path, "w", encoding="utf-8-sig" if path.name.endswith("_raw.csv") else "utf-8", newline="") as file:
        csv.writer(file).writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw-in", type=Path, help="不連線，改讀 5 欄原始檔")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).parent / "711-data")
    parser.add_argument("--delay", type=float, default=REQUEST_DELAY, help="每個鄉鎮區之間的間隔秒數")
    parser.add_argument("--allow-missing", action="store_true", help="有鄉鎮區抓取失敗時仍寫入")
    parser.add_argument("--force", action="store_true", help="筆數明顯變少時仍覆蓋")
    args = parser.parse_args()

    failed = []
    if args.raw_in:
        raw_rows = [row for row in read_csv(args.raw_in) if is_store_row(row)]
    else:
        raw_rows, failed = fetch_raw_rows(args.delay)
    final_rows = to_final_rows(raw_rows)
    print(f"共 {len(final_rows)} 間門市")

    if failed and not args.allow_missing:
        sys.exit(f"以下縣市／鄉鎮區抓取失敗，未寫入任何檔案：{', '.join(failed)}（確認後可加 --allow-missing）")
    final_path = args.out_dir / "711_stores_sorted.csv"
    if final_path.exists() and not args.force:
        previous = len(read_csv(final_path))
        if len(final_rows) < previous * MIN_RATIO:
            sys.exit(f"筆數由 {previous} 降到 {len(final_rows)}，低於 {int(MIN_RATIO * 100)}%，未寫入（確認資料正確後可加 --force）")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if not args.raw_in:
        write_csv(args.out_dir / "711_stores_raw.csv", [["縣市", "地區", "門市編號", "門市名稱", "門市地址"], *raw_rows])
    write_csv(final_path, final_rows)
    print(f"已寫入 {final_path}")


if __name__ == "__main__":
    main()
