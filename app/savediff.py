"""
Savegame diff engine for the Gothic 1 Remake editor.

Decodes two saves (reusing g1r) and reports what changed between them, category by
category, using the same readers the editor already exposes:
  - story flags ("passages")   name -> int
  - quests                     key  -> EQuestState
  - player attributes          name -> value
  - player skills (learned)    base -> tier
  - player inventory           item -> count
Each category returns {added, removed, changed}, where 'A' is the first save (base)
and 'B' is the second (compare). Meant to power a read-only "Compare" tab.
"""
import g1r


def _diff_map(a, b, va=lambda x: x, vb=lambda x: x):
    """Generic added/removed/changed over two {key: item} dicts."""
    added = [{"key": k, "b": vb(b[k])} for k in b if k not in a]
    removed = [{"key": k, "a": va(a[k])} for k in a if k not in b]
    changed = [{"key": k, "a": va(a[k]), "b": vb(b[k])}
               for k in a if k in b and va(a[k]) != vb(b[k])]
    added.sort(key=lambda x: str(x["key"]).lower())
    removed.sort(key=lambda x: str(x["key"]).lower())
    changed.sort(key=lambda x: str(x["key"]).lower())
    return {"added": added, "removed": removed, "changed": changed,
            "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)}}


def diff_flags(pa, pb):
    a = {f["name"]: f["value"] for f in g1r.list_passages(pa)}
    b = {f["name"]: f["value"] for f in g1r.list_passages(pb)}
    return _diff_map(a, b)


def diff_quests(pa, pb):
    a = {q["key"]: q for q in g1r.list_quests(pa)}
    b = {q["key"]: q for q in g1r.list_quests(pb)}
    d = _diff_map(a, b, va=lambda q: q["state"], vb=lambda q: q["state"])
    # attach a friendly name to every entry
    names = {k: v.get("name") for k, v in {**a, **b}.items()}
    for grp in ("added", "removed", "changed"):
        for e in d[grp]:
            e["name"] = names.get(e["key"]) or e["key"]
    return d


def diff_attributes(pa, pb):
    a = {x["name"]: x for x in g1r.list_player_attributes(pa)}
    b = {x["name"]: x for x in g1r.list_player_attributes(pb)}
    d = _diff_map(a, b, va=lambda x: x["value"], vb=lambda x: x["value"])
    labels = {k: v.get("label", k) for k, v in {**a, **b}.items()}
    for grp in ("added", "removed", "changed"):
        for e in d[grp]:
            e["name"] = labels.get(e["key"], e["key"])
    return d


def diff_skills(pa, pb):
    a = {s["base"]: s for s in g1r.list_player_skills(pa) if s.get("learned")}
    b = {s["base"]: s for s in g1r.list_player_skills(pb) if s.get("learned")}
    d = _diff_map(a, b, va=lambda s: s["tier"], vb=lambda s: s["tier"])
    labels = {k: v.get("label", k) for k, v in {**a, **b}.items()}
    for grp in ("added", "removed", "changed"):
        for e in d[grp]:
            e["name"] = labels.get(e["key"], e["key"])
    return d


def diff_inventory(pa, pb):
    def inv(p):
        out = {}
        for it in g1r.find_player_inventory(p):
            out[it["item"]] = {"count": it["count"], "label": it.get("label", it["item"])}
        return out
    a, b = inv(pa), inv(pb)
    d = _diff_map(a, b, va=lambda x: x["count"], vb=lambda x: x["count"])
    labels = {k: v["label"] for k, v in {**a, **b}.items()}
    for grp in ("added", "removed", "changed"):
        for e in d[grp]:
            e["name"] = labels.get(e["key"], e["key"])
    return d


CATEGORIES = [
    ("flags", "Story flags", diff_flags),
    ("quests", "Quests", diff_quests),
    ("attributes", "Attributes", diff_attributes),
    ("skills", "Skills", diff_skills),
    ("inventory", "Inventory", diff_inventory),
]


def diff_payloads(pa, pb):
    """Full structured diff of two decompressed payloads."""
    out = {}
    for key, label, fn in CATEGORIES:
        try:
            d = fn(pa, pb)
        except Exception as e:
            d = {"error": str(e), "counts": {"added": 0, "removed": 0, "changed": 0}}
        d["label"] = label
        out[key] = d
    total = sum(d["counts"]["added"] + d["counts"]["removed"] + d["counts"]["changed"]
                for d in out.values())
    return {"categories": out, "total": total}
