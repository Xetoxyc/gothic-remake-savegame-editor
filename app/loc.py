"""Localized (EN/DE) names for everything the editor shows.

Names come from `localization.json` (a trimmed slice of the game's
AlkimiaLocalization_*.lcache, built by ../../build_loc_bundle.py). Each lookup
returns a `{"en": str, "de": str}` dict — the frontend's language toggle picks
one, always falling back to the English/raw label so nothing ever renders blank.

Key transforms (how a save's identifier maps to an lcache key):
    item   id           -> id.lower()                         (+ '_description')
    quest  /…Quest_X_Y  -> 'quest-' + 'x_y' + '-name'
    skill  base         -> 'skill_' + base.lower()  (+ overrides)
    npc    Id-Suffix     -> id.split('-')[0].lower()
Attributes aren't game-localized text, so they use a hand-written DE map.
"""
import json
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "localization.json")
_BUNDLE = None


def _bundle():
    global _BUNDLE
    if _BUNDLE is None:
        try:
            with open(_PATH, encoding="utf-8") as f:
                _BUNDLE = json.load(f)
        except (OSError, ValueError):
            _BUNDLE = {}
    return _BUNDLE


def _pair(key, fallback):
    """{'en','de'} for an lcache key; missing langs fall back to `fallback`."""
    d = _bundle().get(key)
    if not d:
        return {"en": fallback, "de": fallback}
    return {"en": d.get("en") or fallback, "de": d.get("de") or d.get("en") or fallback}


# ---- per-category lookups ---------------------------------------------------
def item(item_id, fallback=None):
    return _pair(item_id.lower(), fallback or item_id)


def item_description(item_id):
    d = _bundle().get(item_id.lower() + "_description")
    return {"en": d.get("en"), "de": d.get("de") or d.get("en")} if d else None


def quest(save_key, fallback=None):
    s = save_key.split(".")[-1].lower()
    if s.startswith("quest_"):
        s = "quest-" + s[6:]
    return _pair(s + "-name", fallback or save_key)


def npc(npc_id, fallback=None):
    return _pair(npc_id.split("-")[0].lower(), fallback or npc_id)


_SKILL_KEY = {"Picklock": "skill_lockpicking", "Pickpocket": "skill_pickpocketing"}
# bases with no single lcache name key (tiered/absent) -> hand DE
_SKILL_DE = {"Mage_Circle": "Magiekreis"}


def skill(base, fallback):
    key = _SKILL_KEY.get(base, "skill_" + base.lower())
    p = _pair(key, fallback)
    if base in _SKILL_DE and (p["de"] == fallback):
        p["de"] = _SKILL_DE[base]
    return p


# Attributes are stat internals, not game-localized text -> hand-written German.
_ATTR_DE = {
    "Health": "Gesundheit", "MaxHealth": "Max. Gesundheit",
    "Mana": "Mana", "MaxMana": "Max. Mana",
    "Strength": "Stärke", "Dexterity": "Geschicklichkeit",
    "Level": "Stufe", "Experience": "Erfahrung",
    "SkillPoints": "Lernpunkte", "Learning Points": "Lernpunkte",
    "DamageMultiplier": "Schadensmultiplikator", "SpeedModifier": "Geschwindigkeit",
    "SuperArmor": "Standfestigkeit", "MaxSuperArmor": "Max. Standfestigkeit",
    "Toughness": "Zähigkeit", "ToughnessA": "Zähigkeit A",
    "ToughnessB": "Zähigkeit B", "ToughnessC": "Zähigkeit C",
    "RecoveryRatePerHourOfSleep": "Erholung pro Schlafstunde",
    "MaxOxygen": "Max. Sauerstoff", "MaxStamina": "Max. Ausdauer",
    "XPExecutedBounty": "EP (Hinrichtung)", "XPKillOrDefeatBounty": "EP (Kopfgeld)",
    "Critical_OneHand": "Krit. (Einhand)", "Critical_TwoHand": "Krit. (Zweihand)",
    "Critical_Fists": "Krit. (Fäuste)", "Critical_Orc": "Krit. (Ork)",
    "PickPocketing": "Taschendiebstahl",
    # armor defense layers (resistances) — match the in-game armor screen
    "Resistance_Edge": "Klinge", "Resistance_Blunt": "Stumpf", "Resistance_Fire": "Feuer",
    "Resistance_Wind": "Wind", "Resistance_Ice": "Eis", "Resistance_Energy": "Energie",
    "Edge resist": "Klinge", "Blunt resist": "Stumpf", "Fire resist": "Feuer",
    "Wind resist": "Wind", "Ice resist": "Eis", "Energy resist": "Energie",
}


def attribute(name, label_en):
    """name is the raw attribute id, label_en the editor's English label."""
    de = _ATTR_DE.get(name) or _ATTR_DE.get(label_en) or label_en
    return {"en": label_en, "de": de}
