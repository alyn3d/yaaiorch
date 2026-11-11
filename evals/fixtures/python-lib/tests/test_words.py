import unittest

from textstats.words import longest_word, word_count


class WordsTest(unittest.TestCase):
    def test_word_count_simple(self):
        self.assertEqual(word_count("hello world"), 2)

    def test_longest_word(self):
        self.assertEqual(longest_word("a bb ccc"), "ccc")
        self.assertEqual(longest_word(""), "")


if __name__ == "__main__":
    unittest.main()
