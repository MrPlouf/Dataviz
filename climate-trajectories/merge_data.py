import zipfile
from pathlib import Path
import pandas as pd

PROJECT = Path(".")
DATA_DIR = PROJECT / "public" / "data"
OUT_FILE = DATA_DIR / "core_merged.csv"
GLOBAL_TEMP_OUT = DATA_DIR / "global_temp_monthly.csv"

START_YEAR = 2000
END_YEAR = 2023


def find_first_existing(*candidates: str) -> Path | None:
    for name in candidates:
        p = DATA_DIR / name
        if p.exists():
            return p
    return None


def read_owid_csv(path: Path, value_name: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    # OWID-like columns
    # Entity, Code, Year, <value column>
    if "Entity" not in df.columns or "Year" not in df.columns:
        raise ValueError(f"{path.name}: not an OWID-like file (missing Entity/Year)")
    if "Code" not in df.columns:
        # sometimes global series doesn't have code
        df["Code"] = None

    # detect value column = last column typically
    value_col = None
    for c in df.columns[::-1]:
        if c not in ("Entity", "Code", "Year"):
            value_col = c
            break
    if value_col is None:
        raise ValueError(f"{path.name}: cannot find value column")

    df = df.rename(columns={"Entity": "country", "Code": "iso3", "Year": "year", value_col: value_name})
    df["year"] = pd.to_numeric(df["year"], errors="coerce")
    df = df[df["year"].between(START_YEAR, END_YEAR)]
    # keep real countries with ISO3
    df["iso3"] = df["iso3"].astype("string")
    df = df[df["iso3"].str.match(r"^[A-Z]{3}$", na=False)]
    df[value_name] = pd.to_numeric(df[value_name], errors="coerce")
    return df[["iso3", "country", "year", value_name]]


def read_zip_csv(zip_path: Path, csv_name: str) -> pd.DataFrame:
    with zipfile.ZipFile(zip_path) as z:
        with z.open(csv_name) as f:
            return pd.read_csv(f)


def load_country_temp_anom(zip_path: Path) -> pd.DataFrame:
    # monthly-temperature-anomalies.zip -> monthly-temperature-anomalies.csv
    df = read_zip_csv(zip_path, "monthly-temperature-anomalies.csv")
    # columns: Entity, Code, Day, Temperature anomaly
    needed = {"Entity", "Code", "Day", "Temperature anomaly"}
    if not needed.issubset(df.columns):
        raise ValueError(f"{zip_path.name}: unexpected columns: {list(df.columns)}")

    df = df.rename(columns={
        "Entity": "country",
        "Code": "iso3",
        "Temperature anomaly": "temp_anom",
        "Day": "day",
    })
    df["day"] = pd.to_datetime(df["day"], errors="coerce")
    df["year"] = df["day"].dt.year
    df = df[df["year"].between(START_YEAR, END_YEAR)]
    df["iso3"] = df["iso3"].astype("string")
    df = df[df["iso3"].str.match(r"^[A-Z]{3}$", na=False)]
    df["temp_anom"] = pd.to_numeric(df["temp_anom"], errors="coerce")

    # annual mean per country
    out = (
        df.groupby(["iso3", "country", "year"], as_index=False)["temp_anom"]
        .mean()
    )
    return out


def export_global_temp_monthly(zip_path: Path) -> None:
    # global-temperature-anomalies-by-month.zip -> global-temperature-anomalies-by-month.csv
    df = read_zip_csv(zip_path, "global-temperature-anomalies-by-month.csv")
    # columns: Entity (month name), Year, Temperature anomaly
    needed = {"Entity", "Year", "Temperature anomaly"}
    if not needed.issubset(df.columns):
        raise ValueError(f"{zip_path.name}: unexpected columns: {list(df.columns)}")

    df = df.rename(columns={"Entity": "month", "Year": "year", "Temperature anomaly": "temp_anom"})
    df["year"] = pd.to_numeric(df["year"], errors="coerce")
    df = df[df["year"].between(START_YEAR, END_YEAR)]
    df["temp_anom"] = pd.to_numeric(df["temp_anom"], errors="coerce")

    # order months
    month_order = ["January","February","March","April","May","June","July","August","September","October","November","December"]
    order_map = {m:i+1 for i,m in enumerate(month_order)}
    df["month_idx"] = df["month"].map(order_map)
    df = df.dropna(subset=["month_idx"]).sort_values(["year","month_idx"])
    df.to_csv(GLOBAL_TEMP_OUT, index=False)
    print(f"✅ Wrote {GLOBAL_TEMP_OUT} ({len(df):,} rows)")


def main():
    # Your OWID-style metrics (adjusted to your filenames)
    co2_path = find_first_existing("co-emissions-per-capita.csv", "co2-emissions-per-capita.csv")
    energy_path = find_first_existing("per-capita-energy-use.csv")
    water_path = find_first_existing("population-using-at-least-basic-drinking-water.csv")
    sanit_path = find_first_existing(
        "share-of-population-with-improved-sanitation-facilities.csv",
        "share-of-population-with-improved-sanitation-faciltities.csv",  # keep your old typo just in case
    )
    gdp_path = find_first_existing("gdp-per-capita-maddison-project-database.csv")

    if not (co2_path and energy_path and water_path and sanit_path and gdp_path):
        missing = [("co2", co2_path), ("energy", energy_path), ("water", water_path), ("sanit", sanit_path), ("gdp", gdp_path)]
        raise FileNotFoundError("Missing required file(s): " + ", ".join(k for k,p in missing if p is None))

    co2 = read_owid_csv(co2_path, "co2_pc")
    energy = read_owid_csv(energy_path, "energy_pc")
    water = read_owid_csv(water_path, "water_basic_pct")
    sanit = read_owid_csv(sanit_path, "sanitation_pct")
    gdp = read_owid_csv(gdp_path, "gdp_pc")

    # temperature (country annual)
    temp_zip = DATA_DIR / "monthly-temperature-anomalies.zip"
    temp = None
    if temp_zip.exists():
        try:
            temp = load_country_temp_anom(temp_zip)
        except Exception as e:
            print(f"⚠️ Temp load failed, skipping. Reason: {e}")

    # global monthly export (optional, for immersion)
    global_temp_zip = DATA_DIR / "global-temperature-anomalies-by-month.zip"
    if global_temp_zip.exists():
        try:
            export_global_temp_monthly(global_temp_zip)
        except Exception as e:
            print(f"⚠️ Global temp export failed: {e}")

    # merge (outer -> keep more, then you can filter later)
    df = co2.merge(energy, on=["iso3","country","year"], how="outer")
    df = df.merge(water, on=["iso3","country","year"], how="outer")
    df = df.merge(sanit, on=["iso3","country","year"], how="outer")
    df = df.merge(gdp, on=["iso3","country","year"], how="outer")

    if temp is not None:
        df = df.merge(temp, on=["iso3","country","year"], how="left")

    df = df.sort_values(["iso3","year"])
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT_FILE, index=False)

    print(f"✅ Wrote {OUT_FILE} with {len(df):,} rows and {df['iso3'].nunique()} countries.")
    print("Columns:", list(df.columns))


if __name__ == "__main__":
    main()
