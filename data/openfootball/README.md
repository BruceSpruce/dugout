# openfootball data

Season 2024/25 for 8 European leagues (en.1, en.2, es.1, de.1, it.1, fr.1, nl.1, pt.1).

- Source: https://github.com/openfootball/football.json (directory `2024-25`)
- License: CC0 1.0 Universal (public domain dedication)
- Downloaded: 2026-11-17
- Files are verbatim copies; Biome ignores `data/` so they stay unchanged.

Refresh:

```sh
for c in en.1 en.2 es.1 de.1 it.1 fr.1 nl.1 pt.1; do
  curl -fsSL "https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/$c.json" \
    -o "data/openfootball/2024-25/$c.json"
done
```
