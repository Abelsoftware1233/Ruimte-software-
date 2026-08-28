/* ==========================================================
   ABEL123 :: ORBITAL SENTINEL — Frontend
   ==========================================================
   Praat alleen met de Java-backend (zelfde origin, relatieve
   paden), die op zijn beurt de Python-service proxy't.
   Endpoints die gebruikt worden:
     GET /api/health
     GET /api/orbit?altitude=&inclination=&eccentricity=&points=
     GET /api/satellites/{group}?limit=
     GET /api/iss
   ========================================================== */

(() => {
  "use strict";

  // Relatief pad: werkt zowel op http://127.0.0.1:5090 als achter
  // een reverse proxy op een eigen domein. GEEN hardcoded host hier.
  const API_BASE = "";

  const ISS_POLL_MS = 5000;
  const SAT_POLL_MS = 15000;
  const HEALTH_POLL_MS = 10000;

  const EARTH_RADIUS = 2.0; // "wereld"-eenheden in de 3D-scene

  // ------------------------------------------------------------
  // Kleine DOM-helpers
  // ------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const dotJava = $("dot-java");
  const dotPython = $("dot-python");
  const clockEl = $("clock-utc");
  const satCountEl = $("sat-count");
  const globeLoading = $("globe-loading");
  const issCard = $("iss-card");
  const issSpeed = $("iss-speed");
  const issAlt = $("iss-alt");
  const issLatLon = $("iss-latlon");
  const issPeriod = $("iss-period");
  const satListEl = $("sat-list");
  const trackingError = $("tracking-error");

  const altSlider = $("alt-slider");
  const incSlider = $("inc-slider");
  const eccSlider = $("ecc-slider");
  const altVal = $("alt-val");
  const incVal = $("inc-val");
  const eccVal = $("ecc-val");
  const tmPeriod = $("tm-period");
  const tmVelocity = $("tm-velocity");
  const tmApogee = $("tm-apogee");
  const tmSma = $("tm-sma");
  const orbitError = $("orbit-error");

  function showError(box, msg) {
    if (!box) return;
    box.textContent = msg;
    box.style.display = msg ? "block" : "none";
  }

  function setStatusDot(el, online) {
    if (!el) return;
    el.classList.toggle("online", !!online);
    el.classList.toggle("offline", !online);
  }

  // Live UTC clock in de header
  function tickClock() {
    if (clockEl) {
      clockEl.textContent = new Date().toISOString().substr(11, 8) + " UTC";
    }
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ------------------------------------------------------------
  // fetch-helper met timeout + nette foutafhandeling
  // ------------------------------------------------------------
  async function apiGet(path, { timeoutMs = 12000 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API_BASE + path, { signal: controller.signal });
      if (!res.ok) {
        let detail = "";
        try {
          const j = await res.json();
          detail = j.error || j.detail || "";
        } catch (_) {
          /* geen JSON body */
        }
        throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ==============================================================
  // 3D GLOBE (Three.js)
  // ==============================================================
  let scene, camera, renderer, globeGroup, earthMesh, cloudsMesh, atmosphereMesh;
  let issMarker, issTrailLine;
  let starlinkPoints = null;
  let globeReady = false;

  let rotateVelocity = { x: 0, y: 0.0009 }; // idle auto-rotate
  let dragging = false;
  let lastPointer = { x: 0, y: 0 };

  function initGlobe() {
    const wrapper = $("globe-wrapper");
    const canvas = $("globe-canvas");
    if (!wrapper || !canvas || typeof THREE === "undefined") {
      // Three.js CDN kon niet laden (geen internet in browser) of
      // canvas ontbreekt — laat de spinner staan met uitleg i.p.v.
      // eeuwig te blijven hangen zonder feedback.
      showError(
        trackingError,
        "3D-engine (Three.js) kon niet geladen worden. Check je internetverbinding (CDN vereist)."
      );
      return;
    }

    const width = wrapper.clientWidth;
    const height = wrapper.clientHeight;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 0, 5.5);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);

    // Licht: één "zon" + zwak ambient zodat de nachtzijde niet zwart-zwart is
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 2, 5);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x445566, 0.55));

    globeGroup = new THREE.Group();
    scene.add(globeGroup);

    // --- Aarde: procedureel materiaal (geen externe textures nodig,
    //     zodat dit ook werkt zonder extra CDN-afhankelijkheden) ---
    const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);
    const earthMat = new THREE.MeshPhongMaterial({
      color: 0x1b3a5c,
      emissive: 0x03101f,
      shininess: 6,
      specular: 0x224466,
    });
    earthMesh = new THREE.Mesh(earthGeo, earthMat);
    globeGroup.add(earthMesh);

    // Simpele "continenten" look: fijne wireframe overlay in cyaan
    const gridGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.001, 36, 24);
    const gridMat = new THREE.MeshBasicMaterial({
      color: 0x4de8e0,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
    });
    globeGroup.add(new THREE.Mesh(gridGeo, gridMat));

    // Wolken-achtige buitenlaag
    const cloudGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.012, 48, 48);
    const cloudMat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    });
    cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);
    globeGroup.add(cloudsMesh);

    // Atmosfeer-glow (backside shell)
    const atmGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.08, 48, 48);
    const atmMat = new THREE.MeshBasicMaterial({
      color: 0x4de8e0,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
    });
    atmosphereMesh = new THREE.Mesh(atmGeo, atmMat);
    globeGroup.add(atmosphereMesh);

    // Sterren-achtergrond
    const starGeo = new THREE.BufferGeometry();
    const starCount = 900;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
      starPos[i] = (Math.random() - 0.5) * 80;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.03, transparent: true, opacity: 0.7 });
    scene.add(new THREE.Points(starGeo, starMat));

    // ISS marker (rode knipperende bol)
    const issGeo = new THREE.SphereGeometry(0.035, 12, 12);
    const issMat = new THREE.MeshBasicMaterial({ color: 0xff4d6d });
    issMarker = new THREE.Mesh(issGeo, issMat);
    issMarker.visible = false;
    globeGroup.add(issMarker);

    // Interactie: slepen om te roteren, scrollen om te zoomen
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", () => (dragging = false));
    canvas.addEventListener("pointerleave", () => (dragging = false));
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      lastPointer = { x: e.clientX, y: e.clientY };
      rotateVelocity.y = dx * 0.004;
      rotateVelocity.x = dy * 0.004;
      globeGroup.rotation.y += dx * 0.006;
      globeGroup.rotation.x += dy * 0.006;
      globeGroup.rotation.x = Math.max(-1.2, Math.min(1.2, globeGroup.rotation.x));
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        camera.position.z = Math.max(3.0, Math.min(12, camera.position.z + e.deltaY * 0.003));
      },
      { passive: false }
    );

    window.addEventListener("resize", onGlobeResize);

    globeReady = true;
    if (globeLoading) {
      globeLoading.style.opacity = "0";
      setTimeout(() => (globeLoading.style.display = "none"), 400);
    }

    animateGlobe();
  }

  function onGlobeResize() {
    const wrapper = $("globe-wrapper");
    if (!wrapper || !renderer || !camera) return;
    const width = wrapper.clientWidth;
    const height = wrapper.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function animateGlobe() {
    requestAnimationFrame(animateGlobe);
    if (!globeReady) return;

    if (!dragging) {
      // damping terug naar rustige auto-rotatie
      rotateVelocity.x *= 0.94;
      rotateVelocity.y += (0.0009 - rotateVelocity.y) * 0.02;
      globeGroup.rotation.y += rotateVelocity.y;
      globeGroup.rotation.x += rotateVelocity.x * 0.05;
    }
    cloudsMesh.rotation.y += 0.0004;

    if (issMarker && issMarker.visible) {
      const pulse = 1 + 0.25 * Math.sin(Date.now() * 0.006);
      issMarker.scale.setScalar(pulse);
    }

    renderer.render(scene, camera);
  }

  // lat/lon (graden) -> positie op de globe-bol
  function latLonToVector3(lat, lon, radius) {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon + 180);
    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    return new THREE.Vector3(x, y, z);
  }

  function updateIssMarker(lat, lon) {
    if (!globeReady || !issMarker) return;
    const pos = latLonToVector3(lat, lon, EARTH_RADIUS * 1.02);
    issMarker.position.copy(pos);
    issMarker.visible = true;
  }

  function clearSatPoints() {
    if (starlinkPoints) {
      globeGroup.remove(starlinkPoints);
      starlinkPoints.geometry.dispose();
      starlinkPoints.material.dispose();
      starlinkPoints = null;
    }
  }

  function renderSatPoints(satellites, color) {
    if (!globeReady) return;
    clearSatPoints();
    const positions = new Float32Array(satellites.length * 3);
    satellites.forEach((s, i) => {
      const v = latLonToVector3(s.lat, s.lon, EARTH_RADIUS * 1.02);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: color || 0x4de8e0, size: 0.05, transparent: true, opacity: 0.9 });
    starlinkPoints = new THREE.Points(geo, mat);
    globeGroup.add(starlinkPoints);
  }

  // ==============================================================
  // LIVE TRACKING (ISS + satellietgroepen)
  // ==============================================================
  let currentGroup = "iss";
  let issTimer = null;
  let satTimer = null;

  function fmtLatLon(lat, lon) {
    const ns = lat >= 0 ? "N" : "S";
    const ew = lon >= 0 ? "E" : "W";
    return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
  }

  async function refreshIss() {
    try {
      const data = await apiGet("/api/iss");
      const sat = data.satellite;
      if (!sat) return;

      issCard.style.display = "grid";
      satListEl.style.display = "none";
      issSpeed.textContent = (sat.speed_km_s != null) ? `${sat.speed_km_s.toFixed(2)} km/s` : "--";
      issAlt.textContent = `${sat.alt_km.toFixed(0)} km`;
      issLatLon.textContent = fmtLatLon(sat.lat, sat.lon);
      issPeriod.textContent = sat.period_min ? `${sat.period_min.toFixed(1)} min` : "--";
      satCountEl.textContent = "1 object";

      updateIssMarker(sat.lat, sat.lon);
      clearSatPoints();
      showError(trackingError, "");
      setStatusDot(dotPython, true);
    } catch (err) {
      showError(trackingError, `Kon ISS-positie niet ophalen: ${err.message}`);
      setStatusDot(dotPython, false);
    }
  }

  async function refreshSatGroup(group) {
    try {
      const data = await apiGet(`/api/satellites/${encodeURIComponent(group)}?limit=200`);
      const sats = data.satellites || [];

      issCard.style.display = "none";
      satListEl.style.display = "block";
      satCountEl.textContent = `${data.count} / ${data.total_in_group} objects`;

      satListEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      sats.forEach((s) => {
        const row = document.createElement("div");
        row.className = "sat-row";
        row.innerHTML = `
          <span class="name">${s.name}</span>
          <span class="cyan-val">${s.alt_km.toFixed(0)} km</span>
          <span class="violet-val">${s.speed_km_s.toFixed(2)} km/s</span>
          <span>${s.heading_deg.toFixed(0)}°</span>
        `;
        frag.appendChild(row);
      });
      satListEl.appendChild(frag);

      renderSatPoints(sats, groupColor(group));
      if (issMarker) issMarker.visible = false;
      showError(trackingError, "");
      setStatusDot(dotPython, true);
    } catch (err) {
      showError(trackingError, `Kon ${group} niet ophalen: ${err.message}`);
      setStatusDot(dotPython, false);
    }
  }

  function groupColor(group) {
    switch (group) {
      case "starlink":
        return 0x4de8e0;
      case "stations":
        return 0xffb84d;
      case "science":
        return 0x9d7cff;
      case "weather":
        return 0x6bd0ff;
      default:
        return 0x4de8e0;
    }
  }

  function stopTimers() {
    if (issTimer) clearInterval(issTimer);
    if (satTimer) clearInterval(satTimer);
    issTimer = null;
    satTimer = null;
  }

  function switchGroup(group) {
    currentGroup = group;
    stopTimers();
    document.querySelectorAll(".chip[data-group]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.group === group);
    });

    if (group === "iss") {
      refreshIss();
      issTimer = setInterval(refreshIss, ISS_POLL_MS);
    } else {
      refreshSatGroup(group);
      satTimer = setInterval(() => refreshSatGroup(group), SAT_POLL_MS);
    }
  }

  document.querySelectorAll(".chip[data-group]").forEach((chip) => {
    chip.addEventListener("click", () => switchGroup(chip.dataset.group));
  });

  // ==============================================================
  // ORBIT SIMULATOR (Kepler-baan, 2D-canvas)
  // ==============================================================
  const orbitCanvas = $("orbitcanvas");
  const orbitCtx = orbitCanvas ? orbitCanvas.getContext("2d") : null;
  let orbitDebounce = null;

  function resizeOrbitCanvas() {
    if (!orbitCanvas) return;
    const wrapper = orbitCanvas.parentElement;
    const size = Math.min(wrapper.clientWidth, wrapper.clientHeight) || wrapper.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    orbitCanvas.width = wrapper.clientWidth * dpr;
    orbitCanvas.height = wrapper.clientHeight * dpr;
    orbitCanvas.style.width = wrapper.clientWidth + "px";
    orbitCanvas.style.height = wrapper.clientHeight + "px";
    orbitCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resizeOrbitCanvas);

  function drawOrbit(pathPoints) {
    if (!orbitCtx) return;
    const w = orbitCanvas.clientWidth;
    const h = orbitCanvas.clientHeight;
    orbitCtx.clearRect(0, 0, w, h);

    // schaal: vind max radius in de baan (x/y in km) om alles te laten passen
    let maxR = 6371 * 1.2; // minstens aarde + marge
    pathPoints.forEach(([x, y]) => {
      maxR = Math.max(maxR, Math.abs(x), Math.abs(y));
    });
    const cx = w / 2;
    const cy = h / 2;
    const scale = (Math.min(w, h) / 2 - 12) / (maxR * 1.15);

    // aarde
    orbitCtx.beginPath();
    orbitCtx.arc(cx, cy, 6371 * scale, 0, Math.PI * 2);
    orbitCtx.fillStyle = "rgba(77,232,224,0.18)";
    orbitCtx.fill();
    orbitCtx.strokeStyle = "#4DE8E0";
    orbitCtx.lineWidth = 1;
    orbitCtx.stroke();

    // baan
    orbitCtx.beginPath();
    pathPoints.forEach(([x, y], i) => {
      const px = cx + x * scale;
      const py = cy - y * scale;
      if (i === 0) orbitCtx.moveTo(px, py);
      else orbitCtx.lineTo(px, py);
    });
    orbitCtx.closePath();
    orbitCtx.strokeStyle = "#9D7CFF";
    orbitCtx.lineWidth = 1.5;
    orbitCtx.stroke();

    // satelliet-stip op perigee (eerste punt)
    if (pathPoints.length) {
      const [x0, y0] = pathPoints[0];
      orbitCtx.beginPath();
      orbitCtx.arc(cx + x0 * scale, cy - y0 * scale, 3.5, 0, Math.PI * 2);
      orbitCtx.fillStyle = "#FF4D6D";
      orbitCtx.fill();
    }
  }

  async function refreshOrbit() {
    const altitude = parseFloat(altSlider.value);
    const inclination = parseFloat(incSlider.value);
    const eccentricity = parseFloat(eccSlider.value);

    altVal.textContent = `${altitude.toFixed(0)} km`;
    incVal.textContent = `${inclination.toFixed(1)}°`;
    eccVal.textContent = eccentricity.toFixed(3);

    try {
      const data = await apiGet(
        `/api/orbit?altitude=${altitude}&inclination=${inclination}&eccentricity=${eccentricity}&points=180`
      );
      tmPeriod.textContent = `${data.periodMinutes.toFixed(1)} min`;
      tmVelocity.textContent = `${data.velocityKmS.toFixed(2)} km/s`;
      tmApogee.textContent = `${data.apogeeAltKm.toFixed(0)} km`;
      tmSma.textContent = `${data.semiMajorAxisKm.toFixed(0)} km`;
      drawOrbit(data.pathPoints);
      showError(orbitError, "");
      setStatusDot(dotJava, true);
    } catch (err) {
      showError(orbitError, `Kon baan niet berekenen: ${err.message}`);
      setStatusDot(dotJava, false);
    }
  }

  function debouncedOrbitRefresh() {
    if (orbitDebounce) clearTimeout(orbitDebounce);
    orbitDebounce = setTimeout(refreshOrbit, 120);
  }

  [altSlider, incSlider, eccSlider].forEach((slider) => {
    if (slider) slider.addEventListener("input", debouncedOrbitRefresh);
  });

  // ==============================================================
  // HEALTH POLLING (status-dots in de header)
  // ==============================================================
  async function refreshHealth() {
    try {
      const data = await apiGet("/api/health", { timeoutMs: 6000 });
      setStatusDot(dotJava, data.java_service === "ok");
      setStatusDot(dotPython, data.python_service === "ok");
    } catch (err) {
      setStatusDot(dotJava, false);
      setStatusDot(dotPython, false);
    }
  }

  // ==============================================================
  // INIT
  // ==============================================================
  function init() {
    resizeOrbitCanvas();
    initGlobe();

    refreshHealth();
    setInterval(refreshHealth, HEALTH_POLL_MS);

    switchGroup("iss");
    refreshOrbit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
