"""Loads the precomputed tables from ./data and reloads them when the files change."""
import json
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class Store:
    FILES = ("power_curves.parquet", "scaling_index.parquet", "heroes.json", "meta.json")

    def __init__(self, data_dir: Path = DATA_DIR):
        self.dir = data_dir
        self._stamp = None

    def _mtimes(self):
        return tuple((self.dir / f).stat().st_mtime for f in self.FILES)

    def _load(self):
        stamp = self._mtimes()
        if stamp == self._stamp:
            return
        self.curves = pd.read_parquet(self.dir / "power_curves.parquet")
        self.index = pd.read_parquet(self.dir / "scaling_index.parquet")
        self.heroes = json.loads((self.dir / "heroes.json").read_text(encoding="utf-8"))
        self.meta = json.loads((self.dir / "meta.json").read_text(encoding="utf-8"))
        self._stamp = stamp

    def fresh(self) -> "Store":
        self._load()
        return self


store = Store()
