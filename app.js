/* =====================================================
   ABEL123 :: ORBITAL SENTINEL - Frontend Logic
   =====================================================
   Praat uitsluitend met de Java hoofd-backend (poort 8080).
   Java handelt zelf de orbit-berekeningen af en proxy't
   live satelliet-tracking naar de interne Python-service.
   ===================================================== */

const API_BASE = ""; // zelfde origin als de Java server

// ---------------------------------------------------
// STATUS CHECK
// ---------------------------------------------------
async function checkHealth() {
  const dotJava = document.getElementById("dot-java");
  const dotPython = document.getElementById("dot-python");
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();
    dotJava.classList.add("online");
    dotPython.classList.toggle("online", data.python_service === "ok");
    dotPython.classList.toggle("offline", data.python_service !== "ok");
  } catch (e) {
    dotJava.classList.add("offline");
    dotPython.classList.add("offline");
  }
}

// ---------------------------------------------------
// WERELDKAART (equirectangular projectie)
// ---------------------------------------------------
const mapCanvas = document.getElementById("worldmap");
const mapCtx = mapCanvas.getContext("2d");
let currentGroup = "stations";
let currentSats = [];

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  canvas.getContext("2d").scale(devicePixelRatio, devicePixelRatio);
}

function drawWorldMap() {
  const w = mapCanvas.clientWidth;
  const h = mapCanvas.clientHeight;
  mapCtx.clearRect(0, 0, w, h);

  // achtergrondgrid (lat/lon lijnen)
  mapCtx.strokeStyle = "rgba(77,232,224,0.08)";
  mapCtx.lineWidth = 1;
  for (let i = 0; i <= 12; i++) {
    const x = (w / 12) * i;
    mapCtx.beginPath();
    mapCtx.moveTo(x, 0);
    mapCtx.lineTo(x, h);
    mapCtx.stroke();
  }
  for (let i = 0; i <= 6; i++) {
    const y = (h / 6) * i;
    mapCtx.beginPath();
    mapCtx.moveTo(0, y);
    mapCtx.lineTo(w, y);
    mapCtx.stroke();
  }

  // equator + prime meridian iets sterker
  mapCtx.strokeStyle = "rgba(157,124,255,0.25)";
  mapCtx.beginPath();
  mapCtx.moveTo(0, h / 2);
  mapCtx.lineTo(w, h / 2);
  mapCtx.moveTo(w / 2, 0);
  mapCtx.lineTo(w / 2, h);
  mapCtx.stroke();

  // satellieten plotten
  currentSats.forEach(sat => {
    const x = ((sat.lon + 180) / 360) * w;
    const y = ((90 - sat.lat) / 180) * h;

    mapCtx.fillStyle = "#4DE8E0";
    mapCtx.shadowColor = "#4DE8E0";
    mapCtx.shadowBlur = 8;
    mapCtx.beginPath();
    mapCtx.arc(x, y, 3, 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.shadowBlur = 0;
  });
}

async function loadSatellites(group) {
  const errBox = document.getElementById("tracking-error");
  const listEl = document.getElementById("sat-list");
  const countEl = document.getElementById("sat-count");
  errBox.style.display = "none";

  try {
    const res = await fetch(`${API_BASE}/api/satellites/${group}?limit=60`);
    if (!res.ok) throw new Error(`Server gaf status ${res.status}`);
    const data = await res.json();

    currentSats = data.satellites || [];
    countEl.textContent = `${currentSats.length} objects`;
    drawWorldMap();

    listEl.innerHTML = currentSats.map(s => `
      <div class="sat-row">
        <span class="name">${s.name}</span>
        <span class="cyan-val">${s.alt_km.toFixed(0)} km</span>
        <span>${s.speed_km_s.toFixed(2)} km/s</span>
      </div>
    `).join("");
  } catch (e) {
    errBox.textContent = `TRACKING LINK ERROR :: ${e.message} -- controleer of de Python-service draait`;
    errBox.style.display = "block";
    countEl.textContent = "-- objects";
  }
}

document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    currentGroup = chip.dataset.group;
    loadSatellites(currentGroup);
  });
});

// ---------------------------------------------------
// ORBIT SIMULATOR (3D-achtige projectie op canvas)
// ---------------------------------------------------
const orbitCanvas = document.getElementById("orbitcanvas");
const orbitCtx = orbitCanvas.getContext("2d");

const altSlider = document.getElementById("alt-slider");
const incSlider = document.getElementById("inc-slider");
const eccSlider = document.getElementById("ecc-slider");

function project3D(x, y, z, w, h) {
  // simpele isometrische projectie
  const scale = Math.min(w, h) / 60000; // km -> px schaal
  const angleX = 0.5;
  const px = x * Math.cos(angleX) - z * Math.sin(angleX);
  const py = y;
  return {
    x: w / 2 + px * scale,
    y: h / 2 - py * scale,
  };
}

function drawOrbit(pathPoints) {
  const w = orbitCanvas.clientWidth;
  const h = orbitCanvas.clientHeight;
  orbitCtx.clearRect(0, 0, w, h);

  const earthRadiusPx = (6371 / 60000) * Math.min(w, h);

  // aarde
  orbitCtx.fillStyle = "rgba(77,232,224,0.12)";
  orbitCtx.strokeStyle = "rgba(77,232,224,0.5)";
  orbitCtx.lineWidth = 1.5;
  orbitCtx.beginPath();
  orbitCtx.arc(w / 2, h / 2, earthRadiusPx, 0, Math.PI * 2);
  orbitCtx.fill();
  orbitCtx.stroke();

  // baan
  if (pathPoints && pathPoints.length > 0) {
    orbitCtx.strokeStyle = "#9D7CFF";
    orbitCtx.lineWidth = 2;
    orbitCtx.shadowColor = "#9D7CFF";
    orbitCtx.shadowBlur = 6;
    orbitCtx.beginPath();
    pathPoints.forEach((p, i) => {
      const proj = project3D(p[0], p[1], p[2], w, h);
      if (i === 0) orbitCtx.moveTo(proj.x, proj.y);
      else orbitCtx.lineTo(proj.x, proj.y);
    });
    orbitCtx.closePath();
    orbitCtx.stroke();
    orbitCtx.shadowBlur = 0;

    // satelliet-marker op eerste punt (perigee)
    const first = project3D(pathPoints[0][0], pathPoints[0][1], pathPoints[0][2], w, h);
    orbitCtx.fillStyle = "#FF4D6D";
    orbitCtx.shadowColor = "#FF4D6D";
    orbitCtx.shadowBlur = 10;
    orbitCtx.beginPath();
    orbitCtx.arc(first.x, first.y, 4, 0, Math.PI * 2);
    orbitCtx.fill();
    orbitCtx.shadowBlur = 0;
  }
}

let orbitDebounce = null;

async function updateOrbit() {
  const altitude = parseFloat(altSlider.value);
  const inclination = parseFloat(incSlider.value);
  const eccentricity = parseFloat(eccSlider.value);

  document.getElementById("alt-val").textContent = `${altitude.toFixed(0)} km`;
  document.getElementById("inc-val").textContent = `${inclination.toFixed(1)}°`;
  document.getElementById("ecc-val").textContent = eccentricity.toFixed(3);

  const errBox = document.getElementById("orbit-error");
  errBox.style.display = "none";

  try {
    const params = new URLSearchParams({
      altitude, inclination, eccentricity, points: 180
    });
    const res = await fetch(`${API_BASE}/api/orbit?${params}`);
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || `Status ${res.status}`);
    }
    const data = await res.json();

    document.getElementById("tm-period").textContent = `${data.periodMinutes.toFixed(1)} min`;
    document.getElementById("tm-velocity").textContent = `${data.velocityKmS.toFixed(2)} km/s`;
    document.getElementById("tm-apogee").textContent = `${data.apogeeAltKm.toFixed(0)} km`;
    document.getElementById("tm-sma").textContent = `${data.semiMajorAxisKm.toFixed(0)} km`;

    drawOrbit(data.pathPoints);
  } catch (e) {
    errBox.textContent = `ORBIT CALC ERROR :: ${e.message}`;
    errBox.style.display = "block";
  }
}

function debouncedUpdateOrbit() {
  clearTimeout(orbitDebounce);
  orbitDebounce = setTimeout(updateOrbit, 120);
}

[altSlider, incSlider, eccSlider].forEach(el => {
  el.addEventListener("input", debouncedUpdateOrbit);
});

// ---------------------------------------------------
// INIT
// ---------------------------------------------------
function initCanvases() {
  resizeCanvas(mapCanvas);
  resizeCanvas(orbitCanvas);
  drawWorldMap();
}

window.addEventListener("resize", () => {
  initCanvases();
  updateOrbit();
});

window.addEventListener("load", () => {
  initCanvases();
  checkHealth();
  loadSatellites(currentGroup);
  updateOrbit();

  // live refresh
  setInterval(() => loadSatellites(currentGroup), 15000);
  setInterval(checkHealth, 20000);
});
