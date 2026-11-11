import unittest

from textstats.roman import from_roman, to_roman


class RomanTest(unittest.TestCase):
    def test_to_roman(self):
        cases = {1: "I", 4: "IV", 9: "IX", 14: "XIV", 40: "XL", 90: "XC", 400: "CD",
                 1994: "MCMXCIV", 2024: "MMXXIV", 3999: "MMMCMXCIX"}
        for n, s in cases.items():
            self.assertEqual(to_roman(n), s)

    def test_round_trip(self):
        for n in range(1, 4000):
            self.assertEqual(from_roman(to_roman(n)), n)

    def test_to_roman_rejects(self):
        for bad in (0, -1, 4000, 1.0, True, "5", None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                to_roman(bad)

    def test_from_roman_rejects(self):
        for bad in ("", "IIII", "IC", "VV", "mcm", "MMMM", "ABC", " X", None, 5):
            with self.assertRaises(ValueError, msg=repr(bad)):
                from_roman(bad)


if __name__ == "__main__":
    unittest.main()
