"""Shared settings for the pipeline (and read by the API via meta.json)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"            # precomputed tables the API serves

# Game-length buckets (minutes). Labels/mids line up with the edges.
BIN_EDGES_MIN = [0, 20, 25, 30, 35, 40, 45, 50, 1e9]
BIN_LABELS = ["<20", "20–25", "25–30", "30–35", "35–40", "40–45", "45–50", "50+"]
BIN_MIDS = [17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5, 55.0]

MIN_GAMES_PER_BIN = 300             # buckets below this are hidden in the UI
MIN_BINS_FOR_INDEX = 3              # scaling index needs at least this many shown buckets

MIN_HEROES_FOR_ADJUST = 8           # heroes needed in a bucket to estimate the stomp effect

# Rank brackets from average_badge (tier*10 + subtier). Ranked matches only.
# Tiers: 1 Initiate, 2 Seeker, 3 Alchemist, 4 Arcanist, 5 Ritualist, 6 Emissary,
#        7 Archon, 8 Oracle, 9 Phantom, 10 Ascendant, 11 Eternus.
RANK_BRACKETS = [
    # (id, label, min_badge inclusive, max_badge exclusive)
    ("low", "Initiate–Arcanist", 0, 50),
    ("mid", "Ritualist–Archon", 50, 80),
    ("high", "Oracle–Eternus", 80, 1000),
]

# Patches by start date (UTC): ("label", "YYYY-MM-DD"). The lake has no patch
# column, so the dates come from data/patches.json (python -m pipeline.patches,
# from the API's patch-notes list). Matches before the first date are "earlier".
def _patches(keep: int = 6) -> list[tuple[str, str]]:
    import json
    f = DATA_DIR / "patches.json"
    if not f.exists():
        return []
    return [(d, d) for d in json.loads(f.read_text(encoding="utf-8"))["patches"][-keep:]]


PATCHES: list[tuple[str, str]] = _patches()

QUEUES = ["Ranked", "Unranked"]
