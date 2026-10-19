import re


def read_args(s, i):
    """s[i] == '('. Return (args, end_index) with top-level comma split, handling C++ strings/raw strings."""
    assert s[i] == '('
    depth = 0
    args = []
    cur = []
    n = len(s)
    while i < n:
        c = s[i]
        if c == 'R' and s.startswith('R"', i) and (i == 0 or not (s[i - 1].isalnum() or s[i - 1] == '_')):
            j = s.index('(', i + 2)
            delim = s[i + 2 : j]
            end = s.index(')' + delim + '"', j)
            cur.append(s[i : end + len(delim) + 2])
            i = end + len(delim) + 2
            continue
        if c == '"':
            j = i + 1
            while s[j] != '"':
                j += 2 if s[j] == '\\' else 1
            cur.append(s[i : j + 1])
            i = j + 1
            continue
        if c == "'" and i > 0 and s[i - 1].isalnum() and i + 1 < n and s[i + 1].isalnum():
            cur.append(c)
            i += 1
            continue  # C++14 digit separator, e.g. 1'000
        if c == "'":
            j = i + 1
            while s[j] != "'":
                j += 2 if s[j] == '\\' else 1
            cur.append(s[i : j + 1])
            i = j + 1
            continue
        if c == '/' and s.startswith('//', i):
            i = s.index('\n', i)
            continue
        if c == '/' and s.startswith('/*', i):
            i = s.index('*/', i) + 2
            continue
        if c in '({[':
            depth += 1
            if depth == 1:
                i += 1
                continue
        elif c in ')}]':
            depth -= 1
            if depth == 0:
                args.append(''.join(cur).strip())
                return args, i + 1
        elif c == ',' and depth == 1:
            args.append(''.join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    raise ValueError('unbalanced')


def cstr(tok):
    """Decode a C++ string token sequence (possibly concatenated) to python str."""
    out = []
    for m in re.finditer(r'R"([^(]*)\((.*?)\)\1"|"((?:[^"\\]|\\.)*)"', tok, re.S):
        if m.group(2) is not None:
            out.append(m.group(2))
        else:
            out.append(
                bytes(m.group(3), 'utf-8').decode('unicode_escape', errors='ignore')
                if '\\' in m.group(3)
                else m.group(3)
            )
    return ''.join(out) if out else tok


def find_calls(s, names):
    pat = re.compile(r'(?<![A-Za-z0-9_])(' + '|'.join(map(re.escape, names)) + r')\s*\(')
    pos = 0
    while True:
        m = pat.search(s, pos)
        if not m:
            return
        start = m.end() - 1
        # skip #define lines
        line_start = s.rfind('\n', 0, m.start()) + 1
        if s[line_start : m.start()].lstrip().startswith('#define'):
            pos = m.end()
            continue
        try:
            args, end = read_args(s, start)
        except Exception:
            pos = m.end()
            continue
        yield m.group(1), args
        pos = end
