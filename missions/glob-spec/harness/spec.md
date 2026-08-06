# Path-glob matching specification

PROTECTED and readable. This is the contract your matcher must implement.

**Note this is NOT `fnmatch`.** The key difference is that `*` does not cross `/`. Reaching
for `fnmatch` or `pathlib.PurePath.match` will get some cases right and a lot wrong.

`match(pattern, path) -> bool` returns whether the whole path matches the whole pattern.

## Tokens

| Token | Meaning |
|---|---|
| `*` | zero or more characters, **not including `/`** |
| `**` | zero or more characters, **including `/`** |
| `?` | exactly one character, **not `/`** |
| `[abc]` | one character from the set |
| `[a-z]` | one character from the range |
| `[!abc]` | one character *not* in the set |
| anything else | matches itself literally |

## Rules

- The match is anchored at both ends. `*.py` matches `main.py` but not `src/main.py`.
- An unterminated `[` — one with no closing `]` anywhere after it — is a literal `[`.
- `**` alone matches everything, including the empty string.
- The empty pattern matches only the empty path.

## Worked examples

| pattern | path | result |
|---|---|---|
| `*.py` | `main.py` | true |
| `*.py` | `src/main.py` | false — `*` cannot cross `/` |
| `src/**/*.py` | `src/util/helpers.py` | true |
| `**/test_*.py` | `test_x.py` | true — `**` matches empty |
| `?.txt` | `a.txt` | true |
| `?.txt` | `ab.txt` | false |
| `[!x]*.log` | `debug.log` | true |
| `[!x]*.log` | `x.log` | false |
| `a/*/c` | `a/b/c` | true |
| `a/*/c` | `a/b/d/c` | false |
| `a/**/c` | `a/b/d/c` | true |
| `a/**/c` | `a/c` | true |

The reference implementation used to generate the test data is deliberately **not** in
this repository. Protected paths are unwritable, not unreadable — shipping the answer here
would make the mission a copying exercise.
