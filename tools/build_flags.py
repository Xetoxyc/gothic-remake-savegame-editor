"""
Regenerate app/passages.json — the catalog of Gothic 1 Remake story flags
(a.k.a. "passages": the global StoryPropertyValues map of Name -> Int that gates
dialogue/quest conditions).

Source of truth: the shipped precompiled AngelScript module
  <Gothic 1 Remake>/G1R/Script/PrecompiledScript_Shipping.Cache

Two tables in that file are used:
  1. Global declaration table -- flag NAMES. Each global is
       [i32 namelen][name (no NUL)][\\0][8-byte type descriptor][i32 slot]
     Story-flag int globals have the 4-byte type-family prefix 84 5B 00 08.
  2. Schema table -- flag TYPE. Each flag name is followed (after NUL padding) by a
     one-byte type code: 'D' = boolean / small integer, 'F' = game-time/day value.
     Validated against real saves: every 'F' flag holds a large day-timestamp; every
     'D' flag holds 0/1 (or a small counter).

Output schema per flag: {name, label, category, type, values, note, [examples]}
  type   : "bool" | "time" | "counter" | "enum"
  values : [0,1] for bool, explicit list for enum, null for time/counter (free int)
  examples (optional): values actually seen in real saves (from observed_values.json)

To never regress the curated data, the output is the UNION of script-derived flags,
the existing passages.json, and observed_values.json; existing label/category kept.

Usage:
  python tools/build_flags.py "<...>/G1R/Script/PrecompiledScript_Shipping.Cache"
"""
import os
import re
import sys
import json
import struct

TYPE_PREFIX = b"\x84\x5b\x00\x08"        # story-flag int family (4-byte prefix)
NAMEOK = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(os.path.dirname(TOOLS_DIR), "app")
if not os.path.isdir(APP_DIR):
    APP_DIR = TOOLS_DIR

DAYISH = re.compile(r"(Day|Timer|Delivery|Collect|Ration|PayDay)$")
ENUMS = {"Chapter": list(range(1, 7))}    # known small enumerations (value sets)
_CAT_RULES = [
    (re.compile(r"(Day|Timer|Delivery|Collect|Ration|PayDay)$"), "Timer / Day"),
    (re.compile(r"Permission|Passage|Access|CanEnter|Allowed"), "Permission / Passage"),
    (re.compile(r"^(XP_|Location_|Area)"), "Location / World"),
    (re.compile(r"Guild|Faction|Rank|Convoy|Camp|Guru|Templar|Novice"), "Faction / Progression"),
    (re.compile(r"Quest|Chapter|OBJ_|CHAPTER"), "Quest Log"),
]


def _i32(b, o):
    return struct.unpack_from("<i", b, o)[0]


def scan_names(data):
    """Every global whose type descriptor begins with the story-flag prefix."""
    names = set()
    o, n = 0, len(data)
    while o + 4 < n:
        ln = _i32(data, o)
        if 2 <= ln <= 80 and o + 4 + ln + 13 <= n:
            body = data[o + 4:o + 4 + ln]
            if (all(c in NAMEOK for c in body) and data[o + 4 + ln] == 0
                    and data[o + 4 + ln + 1:o + 4 + ln + 5] == TYPE_PREFIX):
                names.add(body.decode("ascii"))
                o += 4 + ln + 13
                continue
        o += 1
    return names


def type_code(data, name, lo=58_000_000, hi=60_500_000):
    """One-byte type code from the schema table: 'D' (bool/int) or 'F' (time)."""
    m = data.find(name.encode(), lo, hi)
    if m < 0:
        return None
    o, end = m + len(name), min(m + 70, len(data))
    while o < end:
        if data[o] != 0:
            return chr(data[o]) if 32 <= data[o] <= 126 else None
        o += 1
    return None


def classify(name, code, examples):
    """Decide (type, values, note). Priority: known enum > observed values > schema
    code > name heuristic."""
    if name in ENUMS:
        return "enum", ENUMS[name], "chapter/enum value"
    mx = max(examples) if examples else None
    if mx is not None and mx > 100:
        return "time", None, "game-time/day value (large int)"
    if mx is not None and mx > 1:
        return "counter", None, "small integer counter"
    if code == "F" or DAYISH.search(name):
        return "time", None, "game-time/day value (large int)"
    # default: boolean (schema 'D' or unknown)
    return "bool", [0, 1], "0 = unset, 1 = set"


def _label(name):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ")
    return re.sub(r"\s+", " ", s).strip()


def _category(name):
    for rx, cat in _CAT_RULES:
        if rx.search(name):
            return cat
    return "NPC / Dialogue"


def _load_json(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return default


def main(argv):
    if len(argv) < 2 or not os.path.exists(argv[1]):
        sys.exit("usage: build_flags.py <path to PrecompiledScript_Shipping.Cache>")
    data = open(argv[1], "rb").read()
    found = scan_names(data)

    pj = os.path.join(APP_DIR, "passages.json")
    existing = {x["name"]: x for x in _load_json(pj, [])}
    observed = _load_json(os.path.join(TOOLS_DIR, "observed_values.json"), {})

    allnames = found | set(existing) | set(observed)
    n_typed_from_code = 0
    out = []
    for name in sorted(allnames, key=str.lower):
        code = type_code(data, name)
        if code in ("D", "F"):
            n_typed_from_code += 1
        examples = observed.get(name) or []
        typ, values, note = classify(name, code, examples)
        base = dict(existing.get(name, {}))
        entry = {
            "name": name,
            "label": base.get("label") or _label(name),
            "category": base.get("category") or _category(name),
            "type": typ,
            "values": values,
            "note": note,
        }
        if examples:
            entry["examples"] = examples
        out.append(entry)

    json.dump(out, open(pj, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    from collections import Counter
    tc = Counter(e["type"] for e in out)
    print(f"wrote {pj}: {len(out)} flags  types={dict(tc)}")
    print(f"  names: script={len(found)} existing={len(existing)} observed={len(observed)}")
    print(f"  typed from schema code (D/F): {n_typed_from_code}")


if __name__ == "__main__":
    main(sys.argv)
