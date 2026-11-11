import re

_WORD = re.compile(r"[A-Za-z0-9']+")


def word_count(text):
    """Return the number of words: runs of letters, digits and apostrophes."""
    return len(_WORD.findall(text))


def longest_word(text):
    """Return the longest word, or an empty string."""
    words = text.split()
    return max(words, key=len) if words else ""
