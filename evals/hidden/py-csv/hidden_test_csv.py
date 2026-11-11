import pathlib
import unittest

from textstats.csvparse import parse_csv


class CsvTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(parse_csv(""), [])
        self.assertEqual(parse_csv("a,b,c"), [["a", "b", "c"]])
        self.assertEqual(parse_csv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]])
        self.assertEqual(parse_csv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]])
        self.assertEqual(parse_csv("a\r\nb"), [["a"], ["b"]])

    def test_empty_fields_and_lines(self):
        self.assertEqual(parse_csv("a,,c"), [["a", "", "c"]])
        self.assertEqual(parse_csv("a,"), [["a", ""]])
        self.assertEqual(parse_csv('a,""'), [["a", ""]])
        self.assertEqual(parse_csv("a\n\nb"), [["a"], [""], ["b"]])
        self.assertEqual(parse_csv(" a , b "), [[" a ", " b "]])

    def test_quotes(self):
        self.assertEqual(parse_csv('"x, y",z'), [["x, y", "z"]])
        self.assertEqual(parse_csv('"he said ""hi""",ok'), [['he said "hi"', "ok"]])
        self.assertEqual(parse_csv('"line1\nline2",b\n'), [["line1\nline2", "b"]])
        self.assertEqual(parse_csv('"a\r\nb",c\r\nd,e'), [["a\r\nb", "c"], ["d", "e"]])
        self.assertEqual(parse_csv('"a"'), [["a"]])
        self.assertEqual(parse_csv('""""'), [['"']])

    def test_errors(self):
        for bad in ('"abc', 'a"b,c', '"a"b,c', '"a" ,b', 'x,"unterminated\n'):
            with self.assertRaises(ValueError, msg=repr(bad)):
                parse_csv(bad)

    def test_no_csv_module(self):
        source = pathlib.Path("textstats/csvparse.py").read_text(encoding="utf-8")
        self.assertNotRegex(source, r"(?m)^\s*(import\s+csv\b|from\s+csv\s+import)")


if __name__ == "__main__":
    unittest.main()
