"""Connect to the Deadlock API public data lake (read-only, free, updated hourly).

The lake moved in 2026 from s3-cache.deadlock-api.com to data.deadlock-api.com
(manifest: https://data.deadlock-api.com/v1/manifest.json). If ATTACH fails,
copy the current snippet from https://deadlock-api.com/data-dumps (DuckDB tab).

OVERRIDE_DATA_PATH is needed because the catalog stores its build machine's
local path (/tmp/...). Without it DuckDB looks for the Parquet files on disk.
"""
import duckdb

DATA_ROOT = "https://data.deadlock-api.com/"
CATALOG_URL = f"ducklake:{DATA_ROOT}v1/catalog.ducklake"


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake; INSTALL httpfs; LOAD httpfs;")
    con.execute(f"""
        ATTACH '{CATALOG_URL}' AS dl
        (READ_ONLY, DATA_PATH '{DATA_ROOT}', OVERRIDE_DATA_PATH true)
    """)
    return con
