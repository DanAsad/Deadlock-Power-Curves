"""Patch dates from the Deadlock API (the lake has no patch column).

  python -m pipeline.patches        # refresh data/patches.json

The API lists the official patch-notes posts. A post's title holds the patch
date ("09-29-2026 Update"); its pub_date is when the post was last edited, so
the title is used. Everything else reads the cached data/patches.json, so the
pipeline works offline once it has been fetched.
"""
import json
import re
import urllib.request
from datetime import date, datetime, timedelta

from pipeline.config import DATA_DIR
from pipeline.heroes import UA

PATCHES_URL = "https://api.deadlock-api.com/v1/patches"
FILE = DATA_DIR / "patches.json"
MIN_DAYS_ON_PATCH = 7       # use only same-patch history once it covers this many days


def parse(posts: list[dict]) -> list[str]:
    """Sorted, unique patch dates (YYYY-MM-DD) from the posts' titles."""
    out = set()
    for p in posts:
        m = re.match(r"\s*(\d{2})-(\d{2})-(\d{4})", p.get("title") or "")
        if m:
            try:
                out.add(date(int(m[3]), int(m[1]), int(m[2])).isoformat())
            except ValueError:
                pass
    return sorted(out)


def fetch() -> list[str]:
    req = urllib.request.Request(PATCHES_URL, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        dates = parse(json.loads(r.read().decode("utf-8")))
    FILE.parent.mkdir(exist_ok=True)
    FILE.write_text(json.dumps({"fetched_at": datetime.now().isoformat(timespec="seconds"), "patches": dates}, indent=1),
                    encoding="utf-8")
    return dates


def load(refresh: bool = False) -> list[str]:
    """Patch dates, from the cache unless refresh; [] if neither is available."""
    if refresh or not FILE.exists():
        try:
            return fetch()
        except Exception as e:
            print(f"warning: patch list unavailable ({e})")
    if FILE.exists():
        return json.loads(FILE.read_text(encoding="utf-8"))["patches"]
    return []


def patch_of(day: date, patches: list[str]) -> str | None:
    """Start date of the patch a day belongs to."""
    before = [p for p in patches if p <= str(day)]
    return before[-1] if before else None


def history_start(day: date, window_days: int, patches: list[str]) -> date:
    """First day of the look-back window for stats used on `day`.

    Normally `window_days` back. If a patch landed inside the window and at
    least MIN_DAYS_ON_PATCH days have passed since, only days on the current
    patch are used, so hero and draft stats are not mixed across balance changes.
    """
    start = day - timedelta(days=window_days)
    p = patch_of(day - timedelta(days=1), patches)
    if p and date.fromisoformat(p) > start and (day - date.fromisoformat(p)).days >= MIN_DAYS_ON_PATCH:
        return date.fromisoformat(p)
    return start


if __name__ == "__main__":
    d = load(refresh=True)
    print(f"{len(d)} patches, latest {d[-1] if d else None}; wrote {FILE}")
