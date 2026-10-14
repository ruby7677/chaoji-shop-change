"""fetch_711_stores.py 的路名抽取與整理（不連線）。執行：python -m unittest discover tests/scripts"""
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
