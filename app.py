"""
Abel123 Sat-Tracker :: Python Microservice
============================================
Interne service, alleen bereikbaar vanaf de Java hoofd-backend.
Haalt actuele TLE-data op van CelesTrak en berekent live lat/lon/alt/
snelheid/heading van satellieten met sgp4.

NIET direct door de browser aan te spreken -- Java (poort 5090)
proxy't alle requests hiernaartoe. Deze service draait alleen
lokaal op 127.0.0.1:5091 en hoeft niet publiek open te staan.

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
# TLE bronnen (Space-Track.org) -- vereist login, geen publieke API-key.
# Space-Track gebruikt session-cookies na een login-POST; we bewaren de
# sessie en loggen opnieuw in zodra die verlopen is.
# -------------------------------------------------------------------
SPACETRACK_BASE_URL = "https://www.space-track.org"
SPACETRACK_USERNAME = "abelsoftware123@hotmail.com"
SPACETRACK_PASSWORD = "Welkomzwolle2027!"

# GROUP-namen zoals CelesTrak ze gebruikte, omgezet naar Space-Track
# GP-queries. Space-Track kent geen kant-en-klare "groep"-namen zoals
# CelesTrak; in plaats daarvan filteren we op OBJECT_NAME (Starlink) of
# op een vaste lijst NORAD-ID's (stations, science, weather).
TLE_QUERIES = {
    "stations": (
        "/basicspacedata/query/class/gp/NORAD_CAT_ID/"
        "25544,48274,49044/orderby/NORAD_CAT_ID/format/tle"
    ),
    "starlink": (
        "/basicspacedata/query/class/gp/OBJECT_NAME/~~STARLINK/"
        "orderby/NORAD_CAT_ID/limit/200/format/tle"
    ),
    "science": (
        "/basicspacedata/query/class/gp/OBJECT_NAME/~~HUBBLE,~~JWST,~~SWIFT/"
        "orderby/NORAD_CAT_ID/format/tle"
    ),
    "weather": (
        "/basicspacedata/query/class/gp/OBJECT_NAME/~~NOAA,~~METOP,~~GOES/"
        "orderby/NORAD_CAT_ID/format/tle"
    ),
}

# NORAD ID van het ISS (ZARYA) -- vast, verandert niet
ISS_NORAD_ID = 25544

# cache: {groep: {"ts": epoch, "data": [...]}}
_cache = {}
CACHE_TTL_SECONDS = 60 * 30  # 30 min, TLE's veranderen niet snel

EARTH_RADIUS_KM = 6371.0
EARTH_MU = 398600.4418  # km^3/s^2

# Aparte requests-sessie die de Space-Track login-cookie vasthoudt,
# zodat we niet bij elke aanvraag opnieuw hoeven in te loggen.
_st_session = requests.Session()
_st_logged_in = False


def spacetrack_login():
    """
    Logt in bij Space-Track en bewaart de sessie-cookie in _st_session.
    Wordt automatisch (opnieuw) aangeroepen als een query faalt met een
    auth-gerelateerde fout. Space-Track's rate-limit: max 30 requests/min
    en 300/uur -- ruim voldoende met onze 30-min cache.
    """
    global _st_logged_in
    resp = _st_session.post(
        f"{SPACETRACK_BASE_URL}/ajaxauth/login",
        data={"identity": SPACETRACK_USERNAME, "password": SPACETRACK_PASSWORD},
        timeout=15,
    )
    resp.raise_for_status()
    # Bij een mislukte login stuurt Space-Track gewoon HTTP 200 terug met
    # {"Login": "Failed"} in de body, geen foutcode -- dus expliciet checken.
    try:
        data = resp.json()
        if isinstance(data, dict) and data.get("Login") == "Failed":
            _st_logged_in = False
            raise RuntimeError("Space-Track login mislukt: controleer gebruikersnaam/wachtwoord")
    except ValueError:
        pass  # geen JSON-body betekent meestal een geslaagde login
    _st_logged_in = True


def spacetrack_query(path: str) -> str:
    """
    Voert een GET-query uit tegen Space-Track, logt automatisch in
    (of opnieuw in) als dat nog niet is gebeurd of de sessie is verlopen.
    Geeft de ruwe TLE-tekst terug.
    """
    global _st_logged_in
    if not _st_logged_in:
        spacetrack_login()

    resp = _st_session.get(f"{SPACETRACK_BASE_URL}{path}", timeout=20)

    if resp.status_code in (401, 403):
        # Sessie verlopen -- eenmalig opnieuw inloggen en herhalen.
        spacetrack_login()
        resp = _st_session.get(f"{SPACETRACK_BASE_URL}{path}", timeout=20)

    resp.raise_for_status()
    return resp.text


def fetch_tle_group(group: str):
    """Haalt en parsed TLE-sets van Space-Track, met caching."""
    now = time.time()
    cached = _cache.get(group)
    if cached and (now - cached["ts"]) < CACHE_TTL_SECONDS:
        return cached["data"]

    path = TLE_QUERIES.get(group)
    if not path:
        raise ValueError(f"Onbekende TLE-groep: {group}")

    text = spacetrack_query(path)
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    sats = []
    i = 0
    n = len(lines)
    while i < n:
        # Space-Track's TLE-formaat levert geen naamregel mee zoals CelesTrak
        # dat doet -- alleen regel 1 en regel 2. We herkennen een record aan
        # "1 " / "2 "-prefixen en gebruiken het NORAD-ID uit regel 1 als naam
        # bij gebrek aan een aparte naamregel.
        if lines[i].startswith("1 ") and i + 1 < n and lines[i + 1].startswith("2 "):
            norad_id = lines[i][2:7].strip()
            sats.append({"name": f"NORAD {norad_id}", "line1": lines[i], "line2": lines[i + 1]})
            i += 2
        elif i + 2 < n and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
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
    Space-Track-query op NORAD-ID als het ISS daar niet in staat.
    """
    try:
        sats = fetch_tle_group("stations")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    entry = next((s for s in sats if str(ISS_NORAD_ID) in s["line1"][:20]), None)

    if entry is None:
        try:
            text = spacetrack_query(
                f"/basicspacedata/query/class/gp/NORAD_CAT_ID/{ISS_NORAD_ID}/format/tle"
            )
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            if len(lines) >= 2 and lines[0].startswith("1 ") and lines[1].startswith("2 "):
                entry = {"name": f"NORAD {ISS_NORAD_ID}", "line1": lines[0], "line2": lines[1]}
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
