"""FastAPI app serving the precomputed tables in ./data.

Dev:   uvicorn api.main:app --reload --port 8000   (Vite proxies /api here)
Prod:  build the frontend (cd web && npm run build); this app also serves web/dist.

Each analysis section is its own router under /api.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.routers import model_eval, power_curves, win_factors, win_probability

app = FastAPI(title="Deadlock analytics API", version="0.1.0")
app.include_router(power_curves.router, prefix="/api")
app.include_router(win_factors.router, prefix="/api")
app.include_router(model_eval.router, prefix="/api")
app.include_router(win_probability.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"ok": True}


DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
