"""
Abel123 Sat-Tracker :: Python Microservice
============================================
Interne service, alleen bereikbaar vanaf de Java hoofd-backend.
Haalt actuele TLE-data op van CelesTrak en berekent live lat/lon/alt/
snelheid/heading van satellieten met sgp4.

NIET direct door de browser aan te spreken -- Java (poort 5090)
proxy't alle requests hiernaartoe. Deze service draait alleen
lokaal op 127.0.0.1:5000 en hoeft niet publiek open te staan.

Run:
    pip install -r requirements.txt
    python app.py
    -> luistert op http://127.0.0.1:5091
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

# NORAD ID van het ISS (ZARYA) -- vast, verandert niet
ISS_NORAD_ID = 25544

# cache: {groep: {"ts": epoch, "data": [...]}}
_cache = {}
CACHE_TTL_SECONDS = 60 * 30  # 30 min, TLE's veranderen niet snel

EARTH_RADIUS_KM = 6371.0
EARTH_MU = 398600.4418  # km^3/s^2


def fetch_tle_group(group: str):
    """Haalt en parsed TLE-sets van CelesTrak, met caching."""
    now = time.time()
    cached = _cache.get(group)
    if cached and (now - cached["ts"]) < CACHE_TTL_SECONDS:
        return cached["data"]

    url = TLE_SOURCES.get(group)
    if not url:
        raise ValueError(f"Onbekende TLE-groep: {group}")

    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    lines = [l.strip() for l in resp.text.splitlines() if l.strip()]

    sats = []
    i = 0
    n = len(lines)
    while i < n:
        # Robuuste TLE-parsing: een geldig record is 3 regels waarbij
        # regel i+1 en i+2 beginnen met "1 " resp. "2 " (checksum-regels).
        # Dit voorkomt foute matches als een satelliet-naam toevallig
        # met "1 " of "2 " begint.
        if i + 2 < n and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
            sats.append({"name": lines[i], "line1": lines[i + 1], "line2": lines[i + 2]})
            i += 3
        else:
            i += 1

    _cache[group] = {"ts": now, "data": sats}
    return sats


def eci_to_geodetic(x, y, z, gmst):
    """
    Zet ECI-coördinaten (km) om naar geodetische lat/lon/alt.
    Sferische aarde-benadering (voldoende nauwkeurig voor visualisatie,
    afwijking t.o.v. WGS84-ellipsoide is < 0.2% op LEO-hoogtes).
    """
    r = math.sqrt(x * x + y * y + z * z)
    lon = math.degrees(math.atan2(y, x) - gmst)
    lon = ((lon + 180) % 360) - 180
    lat = math.degrees(math.asin(z / r)) if r > 0 else 0.0
    alt = r - EARTH_RADIUS_KM
    return lat, lon, alt


def gmst_from_jd(jd, fr):
    """Greenwich Mean Sidereal Time in radialen, benadering (IAU 1982)."""
    d = (jd - 2451545.0) + fr
    gmst_deg = (280.46061837 + 360.98564736629 * d) % 360.0
    return math.radians(gmst_deg)


def heading_from_velocity(x, y, z, vx, vy, vz, gmst):
    """
    Benadert de grondspoor-richting (heading, 0-360 graden, 0=noord)
    door de snelheidsvector te projecteren op het lokale horizontale vlak.
    """
    r = math.sqrt(x * x + y * y + z * z)
    if r == 0:
        return 0.0
    # radiale eenheidsvector
    rx, ry, rz = x / r, y / r, z / r
    # snelheidscomponent loodrecht op radiaal (horizontaal)
    vdotr = vx * rx + vy * ry + vz * rz
    hx, hy, hz = vx - vdotr * rx, vy - vdotr * ry, vz - vdotr * rz

    # lokale "noord" en "oost" eenheidsvectoren in ECI, afgeleid van lat/lon
    lat, lon, _ = eci_to_geodetic(x, y, z, gmst)
    lat_r, lon_r = math.radians(lat), math.radians(lon) + gmst
    east = (-math.sin(lon_r), math.cos(lon_r), 0.0)
    north = (
        -math.sin(lat_r) * math.cos(lon_r),
        -math.sin(lat_r) * math.sin(lon_r),
        math.cos(lat_r),
    )
    e_comp = hx * east[0] + hy * east[1] + hz * east[2]
    n_comp = hx * north[0] + hy * north[1] + hz * north[2]
    heading = math.degrees(math.atan2(e_comp, n_comp))
    return (heading + 360.0) % 360.0


def propagate(entry, jd, fr, gmst):
    """Propageert een enkele TLE-entry naar het huidige tijdstip."""
    sat = Satrec.twoline2rv(entry["line1"], entry["line2"], WGS72)
    e, r, v = sat.sgp4(jd, fr)
    if e != 0:
        return None
    lat, lon, alt = eci_to_geodetic(r[0], r[1], r[2], gmst)
    speed = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)  # km/s
    heading = heading_from_velocity(r[0], r[1], r[2], v[0], v[1], v[2], gmst)
    period_min = None
    try:
        # baanperiode via 3e Kepler-wet op basis van gemiddelde beweging (rev/dag)
        if sat.no_kozai and sat.no_kozai > 0:
            n_rad_per_min = sat.no_kozai  # sat.no_kozai is al rad/min in sgp4-api
            period_min = (2 * math.pi) / n_rad_per_min
    except Exception:
        period_min = None

    return {
        "name": entry["name"].strip(),
        "norad_id": sat.satnum,
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "alt_km": round(alt, 2),
        "speed_km_s": round(speed, 3),
        "heading_deg": round(heading, 1),
        "period_min": round(period_min, 2) if period_min else None,
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "python-tle-service"})


@app.route("/tle/groups", methods=["GET"])
def list_groups():
    return jsonify({"groups": list(TLE_SOURCES.keys())})


@app.route("/tle/<group>", methods=["GET"])
def get_positions(group):
    """
    Retourneert live posities voor alle satellieten in een TLE-groep.
    Query param: limit (default 60, max 400) om payload behapbaar te houden.
    """
    try:
        limit = min(max(int(request.args.get("limit", 60)), 1), 400)
    except ValueError:
        return jsonify({"error": "limit moet een geheel getal zijn"}), 400

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
            pos = propagate(entry, jd, fr, gmst)
            if pos:
                results.append(pos)
        except Exception:
            continue

    return jsonify({
        "group": group,
        "count": len(results),
        "total_in_group": len(sats),
        "timestamp": now,
        "satellites": results,
    })


@app.route("/tle/iss", methods=["GET"])
def get_iss():
    """
    Specifiek endpoint voor het ISS (ZARYA, NORAD 25544).
    Zoekt eerst in de 'stations'-groep cache; valt terug op een directe
    CelesTrak-query op NORAD-ID als het ISS daar niet in staat.
    """
    try:
        sats = fetch_tle_group("stations")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    entry = next((s for s in sats if str(ISS_NORAD_ID) in s["line1"][:20]), None)

    if entry is None:
        try:
            url = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={ISS_NORAD_ID}&FORMAT=tle"
            resp = requests.get(url, timeout=15)
            resp.raise_for_status()
            lines = [l.strip() for l in resp.text.splitlines() if l.strip()]
            if len(lines) >= 3:
                entry = {"name": lines[0], "line1": lines[1], "line2": lines[2]}
        except Exception as exc:
            return jsonify({"error": f"ISS TLE niet gevonden: {exc}"}), 502

    if entry is None:
        return jsonify({"error": "ISS TLE niet gevonden"}), 502

    now = time.time()
    jd, fr = jday(*time.gmtime(now)[:6])
    gmst = gmst_from_jd(jd, fr)

    pos = propagate(entry, jd, fr, gmst)
    if pos is None:
        return jsonify({"error": "SGP4-propagatie mislukt voor ISS"}), 502

    return jsonify({"timestamp": now, "satellite": pos})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5091, debug=False)
