"""Roman numerals for 1..3999."""

_VALUES = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
    (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]


def to_roman(n):
    if type(n) is not int or not 1 <= n <= 3999:
        raise ValueError(f"expected an int from 1 to 3999, got {n!r}")
    out = []
    for value, numeral in _VALUES:
        count, n = divmod(n, value)
        out.append(numeral * count)
    return "".join(out)


_FROM = {to_roman(n): n for n in range(1, 4000)}


def from_roman(s):
    if not isinstance(s, str) or s not in _FROM:
        raise ValueError(f"not a canonical Roman numeral: {s!r}")
    return _FROM[s]
