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


def diff_npcs(pa, pb):
    """NPC roster diff (HEAVY: scans every character). Reports per-field changes in
    HP / Max HP / disposition, plus NPCs present in only one save. Emitted as normal
    rows (one per changed field) so the standard renderer handles them."""
    a = {n["id"]: n for n in g1r.list_npcs(pa)}
    b = {n["id"]: n for n in g1r.list_npcs(pb)}

    def disp(n):
        bits = [n.get("name") or n["id"]]
        if n.get("area"):
            bits.append(f"[{n['area']}]")
        return " ".join(bits)

    added = [{"key": k, "name": disp(b[k]), "b": b[k].get("hp")} for k in b if k not in a]
    removed = [{"key": k, "name": disp(a[k]), "a": a[k].get("hp")} for k in a if k not in b]
    changed = []
    FIELDS = [("hp", "HP"), ("maxhp", "Max HP"), ("attitude", "Disposition")]
    for k in a:
        if k not in b:
            continue
        for f, flabel in FIELDS:
            if a[k].get(f) != b[k].get(f):
                changed.append({"key": f"{k}#{f}", "name": f"{disp(a[k])} · {flabel}",
                                "a": a[k].get(f), "b": b[k].get(f)})
    for lst in (added, removed, changed):
        lst.sort(key=lambda x: str(x["name"]).lower())
    return {"added": added, "removed": removed, "changed": changed,
            "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)}}


CATEGORIES = [
    ("flags", "Story flags", diff_flags),
    ("quests", "Quests", diff_quests),
    ("attributes", "Attributes", diff_attributes),
    ("skills", "Skills", diff_skills),
    ("inventory", "Inventory", diff_inventory),
]
# categories whose B-values the Compare page can edit + export (skills/npcs are read-only)
EDITABLE = {"flags", "quests", "attributes", "inventory"}


def diff_payloads(pa, pb, include_npcs=False):
    """Full structured diff of two decompressed payloads. NPCs are opt-in (heavy)."""
    cats = list(CATEGORIES)
    if include_npcs:
        cats.append(("npcs", "NPCs", diff_npcs))
    out = {}
    for key, label, fn in cats:
        try:
            d = fn(pa, pb)
        except Exception as e:
            d = {"error": str(e), "counts": {"added": 0, "removed": 0, "changed": 0}}
        d["label"] = label
        d["editable"] = key in EDITABLE
        out[key] = d
    total = sum(d["counts"]["added"] + d["counts"]["removed"] + d["counts"]["changed"]
                for d in out.values())
    return {"categories": out, "total": total}


def apply_diff_edits(payload, edits):
    """Apply Compare-page edits to save B and return the patched payload.
    edits: [{cat, key, value}]. In-place edits first, then length-changing ones;
    unknown/read-only categories are ignored. Re-validated.
      flags      -> set existing (apply_passage_edits) or add new (add_passage)
      attributes -> apply_attribute_edits (float, in place)
      inventory  -> set existing count, or add the item (clone) if absent
      quests     -> apply_edits (EQuestState)
    """
    by = {}
    for e in edits:
        by.setdefault(e.get("cat"), []).append(e)

    flag_adds, inv_adds = [], []

    if by.get("attributes"):
        amap = {a["name"]: a for a in g1r.list_player_attributes(payload)}
        ae = [{"base_off": amap[e["key"]]["base_off"], "value": float(e["value"])}
              for e in by["attributes"] if e["key"] in amap]
        if ae:
            payload = g1r.apply_attribute_edits(payload, ae)

    if by.get("inventory"):
        imap = {s["item"]: s for s in g1r.find_player_inventory(payload)}
        ie = []
        for e in by["inventory"]:
            if e["key"] in imap:
                ie.append({"id": imap[e["key"]]["id"], "value": int(e["value"])})
            else:
                inv_adds.append((e["key"], int(e["value"])))
        if ie:
            payload = g1r.apply_inventory_edits(payload, ie)

    if by.get("flags"):
        present = {f["name"] for f in g1r.list_passages(payload)}
        sets = [{"name": e["key"], "value": int(e["value"])}
                for e in by["flags"] if e["key"] in present]
        flag_adds = [(e["key"], int(e["value"])) for e in by["flags"] if e["key"] not in present]
        if sets:
            payload = g1r.apply_passage_edits(payload, sets)

    if by.get("quests"):
        qmap = {q["key"]: q for q in g1r.list_quests(payload)}
        qe = [{"val_off": qmap[e["key"]]["val_off"], "new_state": e["value"]}
              for e in by["quests"] if e["key"] in qmap and e["value"] in g1r.EQUEST_STATES]
        if qe:
            payload = g1r.apply_edits(payload, qe)

    for name, val in flag_adds:
        payload = g1r.add_passage(payload, name, val)
    for item, cnt in inv_adds:
        payload = g1r.add_item(payload, item, cnt)

    if not g1r.validate(payload):
        raise ValueError("edited save failed structural validation; refused")
    return payload
