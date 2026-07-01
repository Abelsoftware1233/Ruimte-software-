# ABEL123 :: ORBITAL SENTINEL

Satelliet-trackingtool + orbit-simulator. Java (hoofd-backend) roept
een interne Python-microservice aan voor live TLE-data.

## Architectuur

```
Browser
   |
   v
Java (Javalin, poort 8080)  <-- serveert frontend + orbit-berekeningen
   |
   v  (interne HTTP call)
Python (Flask, poort 5000)  <-- haalt TLE's op van CelesTrak, sgp4-propagatie
```

De browser praat alleen met Java. Python is niet publiek bereikbaar
en hoeft dat ook niet te zijn.

## Vereisten

- Java 17+
- Maven 3.8+
- Python 3.10+
- Internetverbinding (voor CelesTrak TLE-data)

## Setup

### 1. Python-service starten (eerst!)

```bash
cd python-service
python -m venv venv
source venv/bin/activate    # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Draait op `http://127.0.0.1:5000`. Test met:
```bash
curl http://127.0.0.1:5000/health
```

### 2. Java-service bouwen en starten

In een nieuwe terminal:

```bash
cd java-service
mvn clean package
java -jar target/sattracker.jar
```

Draait op `http://127.0.0.1:8080`.

### 3. Openen

Ga naar **http://127.0.0.1:8080** in je browser.

## Endpoints (Java, publiek)

| Endpoint | Beschrijving |
|---|---|
| `GET /api/health` | Status van Java + Python-koppeling |
| `GET /api/orbit?altitude=400&inclination=51.6&eccentricity=0` | Kepler-baanberekening |
| `GET /api/satellites/{group}?limit=50` | Live posities (proxy naar Python) |

TLE-groepen: `stations`, `starlink`, `science`, `weather`

## Troubleshooting

- **PYTHON TLE-LINK toont offline**: check of `python app.py` nog draait op poort 5000
- **CelesTrak errors / 502**: CelesTrak kan rate-limiten; TLE's worden 30 min gecached in Python om dit te beperken
- **Lege wereldkaart**: wacht de eerste fetch af (kan enkele seconden duren bij een koude cache)

## Uitbreidingsideeën

- WebSocket i.p.v. polling voor smoothere live-tracking
- Meer TLE-groepen toevoegen (zie CelesTrak groepen-lijst)
- Ground station visibility / pass predictions
- Historische baan-decay grafieken
