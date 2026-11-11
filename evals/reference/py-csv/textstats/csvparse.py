"""RFC 4180 CSV parsing without the csv module."""


def parse_csv(text):
    rows, row, field = [], [], []
    i, n = 0, len(text)
    quoted = False  # the current field started with a quote
    after_quote = False  # the closing quote of the current field was just read
    started = False  # anything has been read for the current row

    def end_field():
        nonlocal field, quoted, after_quote
        row.append("".join(field))
        field, quoted, after_quote = [], False, False

    def end_row():
        nonlocal row, started
        end_field()
        rows.append(row)
        row, started = [], False

    while i < n:
        c = text[i]
        if quoted and not after_quote:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 1
                else:
                    after_quote = True
            else:
                field.append(c)
        elif c == ",":
            end_field()
            started = True
        elif c == "\n" or (c == "\r" and i + 1 < n and text[i + 1] == "\n"):
            if c == "\r":
                i += 1
            end_row()
        elif after_quote:
            raise ValueError(f"unexpected character after closing quote at {i}")
        elif c == '"':
            if field:
                raise ValueError(f"quote inside an unquoted field at {i}")
            quoted = True
            started = True
        else:
            field.append(c)
            started = True
        i += 1

    if quoted and not after_quote:
        raise ValueError("unterminated quoted field")
    if started or field or row:
        end_row()
    return rows
