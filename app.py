"""
Abel123 Sat-Tracker :: Python Microservice
============================================
Interne service, alleen bereikbaar vanaf de Java hoofd-backend.
Haalt actuele TLE-data op van CelesTrak en berekent live lat/lon/alt
posities van satellieten met sgp4.

NIET direct door de browser aan te spreken -- Java (poort 8080)
proxy't alle requests hiernaartoe.

Run:
    pip install flask sgp4 requests
    python app.py
    -> luistert op http://127.0.0.1:5000
"""

from flask import Flask, jsonify, request
from sgp4.api import Satrec, WGS72
from sgp4.conveniences import jday
import requests
import time
import math

app = Flask(__name__)

# -------------------------------------------------------------------
# TLE bronnen (CelesTrak) -- publiek beschikbare, actuele baandata
# -------------------------------------------------------------------
TLE_SOURCES = {
    "stations": "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
    "starlink": "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle",
    "science": "https://celestrak.org/NORAD/elements/gp.php?GROUP=science&FORMAT=tle",
    "weather": "https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle",
}

# cache: {groep: {"ts": epoch, "data": [...]}}
_cache = {}
CACHE_TTL_SECONDS = 60 * 30  # 30 min, TLE's veranderen niet snel


def fetch_tle_group(group: str):
    """Haalt en parsed TLE-sets van CelesTrak, met caching."""
    now = time.time()
    cached = _cache.get(group)
    if cached and (now - cached["ts"]) < CACHE_TTL_SECONDS:
        return cached["data"]

    url = TLE_SOURCES.get(group)
    if not url:
        raise ValueError(f"Onbekende TLE-groep: {group}")

    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    lines = [l.strip() for l in resp.text.splitlines() if l.strip()]

    sats = []
    i = 0
    while i < len(lines) - 2:
        name = lines[i]
        line1 = lines[i + 1]
        line2 = lines[i + 2]
        if line1.startswith("1 ") and line2.startswith("2 "):
            sats.append({"name": name, "line1": line1, "line2": line2})
            i += 3
        else:
            i += 1

    _cache[group] = {"ts": now, "data": sats}
    return sats


def eci_to_geodetic(x, y, z, gmst):
    """
    Zet ECI-coördinaten (km) om naar geodetische lat/lon/alt.
    Simpele sferische aarde-benadering (voldoende voor visualisatie).
    """
    r = math.sqrt(x * x + y * y + z * z)
    lon = math.degrees(math.atan2(y, x) - gmst)
    lon = ((lon + 180) % 360) - 180
    lat = math.degrees(math.asin(z / r)) if r > 0 else 0.0
    alt = r - 6371.0  # aarde-radius gemiddeld, km
    return lat, lon, alt


def gmst_from_jd(jd, fr):
    """Greenwich Mean Sidereal Time in radialen, benadering."""
    d = (jd - 2451545.0) + fr
    gmst_deg = (280.46061837 + 360.98564736629 * d) % 360.0
    return math.radians(gmst_deg)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "python-tle-service"})


@app.route("/tle/<group>", methods=["GET"])
def get_positions(group):
    """
    Retourneert live posities voor alle satellieten in een TLE-groep.
    Query param: limit (default 50, max 200) om payload klein te houden.
    """
    limit = min(int(request.args.get("limit", 50)), 200)

    try:
        sats = fetch_tle_group(group)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    now = time.time()
    jd, fr = jday(*time.gmtime(now)[:6])
    gmst = gmst_from_jd(jd, fr)

    results = []
    for entry in sats[:limit]:
        try:
            sat = Satrec.twoline2rv(entry["line1"], entry["line2"], WGS72)
            e, r, v = sat.sgp4(jd, fr)
            if e != 0:
                continue
            lat, lon, alt = eci_to_geodetic(r[0], r[1], r[2], gmst)
            speed = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)  # km/s
            results.append({
                "name": entry["name"],
                "norad_id": sat.satnum,
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "alt_km": round(alt, 2),
                "speed_km_s": round(speed, 3),
            })
        except Exception:
            continue

    return jsonify({
        "group": group,
        "count": len(results),
        "timestamp": now,
        "satellites": results,
    })


@app.route("/tle/groups", methods=["GET"])
def list_groups():
    return jsonify({"groups": list(TLE_SOURCES.keys())})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
