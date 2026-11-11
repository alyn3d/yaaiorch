def word_count(text):
    """Return the number of words in text."""
    return len(text.split(" "))


def longest_word(text):
    """Return the longest word, or an empty string."""
    words = text.split()
    return max(words, key=len) if words else ""
