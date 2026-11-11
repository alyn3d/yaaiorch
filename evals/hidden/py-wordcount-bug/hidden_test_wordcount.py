import unittest

from textstats.words import word_count


class WordCountTest(unittest.TestCase):
    def test_spacing(self):
        self.assertEqual(word_count("hello   world"), 2)
        self.assertEqual(word_count("  a\tb\nc  "), 3)
        self.assertEqual(word_count(""), 0)
        self.assertEqual(word_count("   \n\t "), 0)

    def test_apostrophes_and_punctuation(self):
        self.assertEqual(word_count("it's fine"), 2)
        self.assertEqual(word_count("well-known fact"), 3)
        self.assertEqual(word_count("wait -- what ..."), 2)
        self.assertEqual(word_count("Hello, world!"), 2)
        self.assertEqual(word_count("route 66"), 2)


if __name__ == "__main__":
    unittest.main()
