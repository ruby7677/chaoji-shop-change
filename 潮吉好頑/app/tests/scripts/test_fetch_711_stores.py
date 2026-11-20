"""fetch_711_stores.py 的路名抽取與整理（不連線）。執行：python -m unittest discover tests/scripts"""
import importlib.util
import xml.etree.ElementTree as ET
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("fetch_711_stores", Path(__file__).parents[2] / "scripts" / "fetch_711_stores.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RoadName(unittest.TestCase):
    def test_strips_city_district_and_neighbor(self):
        self.assertEqual(module.road_name("台北市中山區民權東路二段96號98號1樓"), "民權東路")
        self.assertEqual(module.road_name("新北市板橋區21鄰復興路3號"), "復興路")

    def test_district_name_starting_with_a_road_marker(self):
        self.assertEqual(module.road_name("高雄市路竹區路科十路11號1樓"), "路科十路")

    def test_first_road_wins_when_the_address_names_two(self):
        self.assertEqual(module.road_name("台北市中山區中原街37號.吉林路168巷22號"), "中原街")
        self.assertEqual(module.road_name("桃園市八德區中興街42號興仁路46號48號"), "中興街")

    def test_admin_unit_before_the_road_is_dropped_but_road_names_containing_it_are_kept(self):
        self.assertEqual(module.road_name("新北市三峽區鳶山里21鄰復興路447號"), "復興路")
        self.assertEqual(module.road_name("南投縣仁愛鄉大同村定遠新村路18-1號"), "定遠新村路")
        self.assertEqual(module.road_name("台中市豐原區南村里豐東路412號"), "豐東路")
        self.assertEqual(module.road_name("屏東縣車城鄉新街村保新路25之2號"), "保新路")
        self.assertEqual(module.road_name("台中市大里區大里路97號1樓"), "大里路")
        self.assertEqual(module.road_name("台中市南區美村路二段188號"), "美村路")

    def test_village_and_place_name_fallbacks(self):
        self.assertEqual(module.road_name("南投縣仁愛鄉定遠新村26之1號"), "定遠新村")
        self.assertEqual(module.road_name("苗栗縣大湖鄉下員坑39之1號"), "下員坑")
        self.assertEqual(module.road_name("台北市中山區"), "")


class FinalRows(unittest.TestCase):
    RAW = [
        ["縣市", "地區", "門市編號", "門市名稱", "門市地址"],
        ["高雄市", "苓雅區", "000002   ", "乙", "高雄市苓雅區四維路1號"],
        ["台北市", "中山區", "000001   ", "甲", "台北市中山區民權東路二段96號"],
        ["台北市", "中山區", "000001   ", "甲", "台北市中山區民權東路二段96號"],
    ]

    def test_six_columns_sorted_without_header_or_duplicates(self):
        self.assertEqual(module.to_final_rows(self.RAW), [
            ["台北市", "中山區", "000001", "民權東路", "甲", "台北市中山區民權東路二段96號"],
            ["高雄市", "苓雅區", "000002", "四維路", "乙", "高雄市苓雅區四維路1號"],
        ])


def xml(*items):
    root = ET.Element("root")
    for fields in items:
        node = ET.SubElement(root, "GeoPosition")
        for tag, value in fields.items():
            ET.SubElement(node, tag).text = value
    return root


class FetchCity(unittest.TestCase):
    def run_city(self, responses):
        calls = iter(responses)
        return module.fetch_city_rows(lambda _data: next(calls), "01", "台北市", 0)

    def test_collects_stores(self):
        rows, failed = self.run_city([xml({"TownName": "中山區"}), xml({"POIID": "000001", "POIName": "甲", "Address": "台北市中山區民權東路1號"})])
        self.assertEqual((rows, failed), ([["台北市", "中山區", "000001", "甲", "台北市中山區民權東路1號"]], []))

    def test_empty_town_list_is_a_failure(self):
        self.assertEqual(self.run_city([xml()]), ([], ["台北市"]))
        self.assertEqual(self.run_city([None]), ([], ["台北市"]))

    def test_failed_town_request_is_reported(self):
        rows, failed = self.run_city([xml({"TownName": "中山區"}, {"TownName": "大安區"}), None, xml({"POIID": "000002", "POIName": "乙", "Address": "x"})])
        self.assertEqual(failed, ["台北市中山區"])
        self.assertEqual(len(rows), 1)

    def test_city_with_no_stores_at_all_is_a_failure(self):
        self.assertEqual(self.run_city([xml({"TownName": "中山區"}), xml()]), ([], ["台北市"]))


if __name__ == "__main__":
    unittest.main()
