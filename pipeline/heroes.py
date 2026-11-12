"""Hero names and images from the Deadlock assets API."""
import json
import urllib.request

HEROES_URL = "https://api.deadlock-api.com/v1/assets/heroes"   # old host assets.deadlock-api.com is gone
UA = {"User-Agent": "deadlock-power-curves/0.1"}                # the API returns 403 to urllib's default UA


def fetch_heroes() -> dict[int, dict]:
    """{hero_id: {id, name, image, card}}; empty dict if the API is unreachable."""
    try:
        req = urllib.request.Request(HEROES_URL, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"warning: hero assets unavailable ({e}); using 'Hero <id>'")
        return {}
    out = {}
    for h in data:
        img = h.get("images") or {}
        out[int(h["id"])] = {
            "id": int(h["id"]),
            "name": h.get("name") or f"Hero {h['id']}",
            "image": img.get("icon_image_small_webp") or img.get("icon_image_small"),
            "card": img.get("icon_hero_card_webp") or img.get("icon_hero_card"),
        }
    return out


def hero_table(ids, assets: dict[int, dict]) -> list[dict]:
    return [assets.get(int(i), {"id": int(i), "name": f"Hero {i}", "image": None, "card": None})
            for i in sorted(int(i) for i in ids)]
