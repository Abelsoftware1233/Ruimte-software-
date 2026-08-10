# ABEL123 :: ORBITAL SENTINEL

Satelliet-trackingtool + orbit-simulator met een echte interactieve
3D-aarde. Java (hoofd-backend) roept een interne Python-microservice
aan voor live TLE-data en SGP4-baanpropagatie (incl. ISS en alle
Starlink-satellieten).

## Architectuur

```
Browser
   |
   v
Java (Javalin, poort 5090)  <-- serveert frontend + orbit-berekeningen
   |
   v  (interne HTTP call, alleen op localhost)
Python (Flask, poort 5000)  <-- haalt TLE's op van CelesTrak, SGP4-propagatie
```

De browser praat alleen met Java op poort **5090**. Python draait
alleen op `127.0.0.1:5000` (localhost-only) en is niet publiek
bereikbaar — dat hoeft ook niet, want Java proxy't alles.

## Mapstructuur

```
Ruimte-software/
├── README.md
├── java-service/
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/abelsoftware123/sattracker/
│       │   ├── Main.java
│       │   ├── OrbitCalculator.java
│       │   └── PythonServiceClient.java
│       └── resources/public/       <-- frontend, wordt in de jar gebundeld
│           ├── index.html
│           └── app.js
└── python-service/
    ├── app.py
    └── requirements.txt
```

## Vereisten

- Java 17+
- Maven 3.8+
- Python 3.10+
- Internetverbinding (voor CelesTrak TLE-data en Google Fonts/Three.js CDN)

## Setup

### 1. Python-service starten (eerst!)

```bash
cd python-service
python -m venv venv
source venv/bin/activate    # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Draait op `http://127.0.0.1:5000` (alleen intern, niet publiek). Test met:
```bash
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:5000/tle/iss
```

### 2. Java-service bouwen en starten

In een nieuwe terminal:

```bash
cd java-service
mvn clean package
java -jar target/sattracker.jar
```

Draait op **`http://127.0.0.1:5090`**.

### 3. Openen

Ga naar **http://127.0.0.1:5090** in je browser.

Je ziet een draaibare, zoombare 3D-aarde met continenten, wolken en
een atmosfeer-glow. Standaard staat de ISS geselecteerd — die
knippert met een rode ring op zijn actuele positie en de kaart
ernaast toont live snelheid, hoogte, lat/lon en omlooptijd. Klik op
"STARLINK" om alle actieve Starlink-satellieten (tot 200 tegelijk)
als cyaan puntjes op de bol te zien; sleep om te roteren, scroll om
te zoomen, hover over een satelliet voor details.

## Endpoints (Java, publiek op poort 5090)

| Endpoint | Beschrijving |
|---|---|
| `GET /api/health` | Status van Java + Python-koppeling |
| `GET /api/orbit?altitude=400&inclination=51.6&eccentricity=0&points=180` | Kepler-baanberekening |
| `GET /api/satellites/{group}?limit=80` | Live posities (proxy naar Python), `limit` 1-400 |
| `GET /api/iss` | Live ISS-positie + snelheid + omlooptijd (apart, altijd vers) |

TLE-groepen voor `/api/satellites/{group}`: `stations`, `starlink`, `science`, `weather`

## Wat is er live te zien

- **ISS**: real-time lat/lon, hoogte (km), snelheid (km/s), heading en
  omlooptijd, geplot op de 3D-globe met een korte grondspoor-boog die
  de bewegingsrichting toont. Ververst elke 5 seconden.
- **Starlink**: tot 200 satellieten tegelijk als live punten op de
  bol, elk met hoogte/snelheid/heading in de lijst ernaast. Ververst
  elke 15 seconden.
- **Stations / Science / Weather**: overige CelesTrak-groepen, zelfde
  weergave.
- **Orbit simulator**: los van de live tracking — een Kepler-baan die
  je zelf kunt instellen (hoogte, inclinatie, excentriciteit) om te
  zien hoe een baan er geometrisch uitziet.

## Troubleshooting

- **PYTHON TLE-LINK toont offline**: check of `python app.py` nog draait op poort 5000
- **CelesTrak errors / 502**: CelesTrak kan rate-limiten; TLE's worden 30 min gecached in Python om dit te beperken
- **Lege globe / geen satellieten**: wacht de eerste fetch af (kan enkele seconden duren bij een koude cache), of check de foutmelding onderin het paneel
- **Aarde/Three.js laadt niet**: de pagina laadt Three.js via een CDN (`cdnjs.cloudflare.com`) — vereist internetverbinding in de browser, ook als de backend lokaal draait

## Beveiligingsopmerkingen als je dit publiek online zet

Dit project is gebouwd en getest voor **localhost**. Zet je het toch
op een publiek toegankelijke server, houd dan rekening met:

- **CORS staat nu open voor alle hosts** (`cors.anyHost()` in
  `Main.java`). Voor lokaal gebruik onschuldig; publiek is dit een
  risico omdat elke website vanuit de browser van een bezoeker jouw
  API kan aanroepen. Vervang dit door een expliciete lijst toegestane
  origins voordat je live gaat.
- **Geen rate-limiting** op de Java-kant. De Python-cache (30 min)
  beschermt CelesTrak tegen overbelasting, maar niet je eigen server
  tegen misbruik/spam van `/api/satellites/starlink?limit=400`. Zet
  een reverse proxy (nginx/Caddy) met rate-limiting ervoor, of voeg
  een simpele token-bucket toe in Javalin.
- **Python-poort 5000 moet alleen lokaal bereikbaar blijven** — bind
  'm nooit aan `0.0.0.0` op een publieke server, alleen aan
  `127.0.0.1`, zoals nu al in `app.py` staat.
- Draai beide processen met een procesmanager (systemd, supervisor,
  of docker-compose) zodat ze automatisch herstarten bij een crash.

## Uitbreidingsideeën

- WebSocket i.p.v. polling voor nog vloeiendere live-tracking
- Meer TLE-groepen toevoegen (zie CelesTrak groepen-lijst)
- Ground station visibility / pass predictions (wanneer is de ISS
  vanaf jouw locatie zichtbaar)
- Historische baan-decay grafieken
- Klik-op-satelliet detail-panel met volledige TLE-gegevens
