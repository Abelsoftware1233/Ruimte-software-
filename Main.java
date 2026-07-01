package com.abelsoftware123.sattracker;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.staticfiles.Location;

import java.util.HashMap;
import java.util.Map;

/**
 * Abel123 Sat-Tracker :: Java Main
 * ====================================
 * Hoofd-backend. Serveert de frontend, doet orbit-simulator
 * berekeningen zelf (Kepler-mechanica), en proxy't live
 * satelliet-tracking requests naar de interne Python-service.
 *
 * Build & run:
 *   mvn clean package
 *   java -jar target/sattracker.jar
 *
 * Vereist dat de Python-service draait op http://127.0.0.1:5000
 * (zie python-service/app.py)
 */
public class Main {

    private static final String PYTHON_SERVICE_URL = "http://127.0.0.1:5000";
    private static final ObjectMapper mapper = new ObjectMapper();

    public static void main(String[] args) {
        PythonServiceClient pythonClient = new PythonServiceClient(PYTHON_SERVICE_URL);

        Javalin app = Javalin.create(config -> {
            config.staticFiles.add(staticFiles -> {
                staticFiles.hostedPath = "/";
                staticFiles.directory = "/public";
                staticFiles.location = Location.CLASSPATH;
            });
            config.bundledPlugins.enableCors(cors -> cors.addRule(it -> it.anyHost()));
        }).start(8080);

        // -------------------------------------------------------
        // Health check
        // -------------------------------------------------------
        app.get("/api/health", ctx -> {
            boolean pyHealthy = pythonClient.isHealthy();
            Map<String, Object> status = new HashMap<>();
            status.put("java_service", "ok");
            status.put("python_service", pyHealthy ? "ok" : "unreachable");
            ctx.json(status);
        });

        // -------------------------------------------------------
        // Orbit-simulator: Java berekent zelf, geen Python nodig
        // -------------------------------------------------------
        app.get("/api/orbit", ctx -> {
            try {
                double altitude = Double.parseDouble(ctx.queryParamAsClass("altitude", String.class).getOrDefault("400"));
                double inclination = Double.parseDouble(ctx.queryParamAsClass("inclination", String.class).getOrDefault("51.6"));
                double eccentricity = Double.parseDouble(ctx.queryParamAsClass("eccentricity", String.class).getOrDefault("0.0"));
                int points = Integer.parseInt(ctx.queryParamAsClass("points", String.class).getOrDefault("180"));

                if (altitude < 100 || altitude > 50000) {
                    ctx.status(400).json(Map.of("error", "Hoogte moet tussen 100 en 50000 km liggen"));
                    return;
                }
                if (inclination < 0 || inclination > 180) {
                    ctx.status(400).json(Map.of("error", "Inclinatie moet tussen 0 en 180 graden liggen"));
                    return;
                }
                if (eccentricity < 0 || eccentricity >= 1) {
                    ctx.status(400).json(Map.of("error", "Excentriciteit moet tussen 0 en 1 liggen (exclusief 1)"));
                    return;
                }

                OrbitCalculator.OrbitResult result = OrbitCalculator.calculate(
                        altitude, inclination, eccentricity, points
                );
                ctx.json(result);
            } catch (NumberFormatException e) {
                ctx.status(400).json(Map.of("error", "Ongeldige numerieke invoer"));
            }
        });

        // -------------------------------------------------------
        // Live satelliet-tracking: proxy naar Python-service
        // -------------------------------------------------------
        app.get("/api/satellites/{group}", ctx -> {
            String group = ctx.pathParam("group");
            int limit = Integer.parseInt(ctx.queryParamAsClass("limit", String.class).getOrDefault("50"));

            try {
                String pythonResponse = pythonClient.getPositions(group, limit);
                ctx.contentType("application/json").result(pythonResponse);
            } catch (Exception e) {
                ctx.status(502).json(Map.of(
                        "error", "Kon geen verbinding maken met de Python tracking-service",
                        "detail", e.getMessage()
                ));
            }
        });

        System.out.println("=================================================");
        System.out.println(" Abel123 Sat-Tracker :: Java hoofd-backend actief");
        System.out.println(" -> http://127.0.0.1:8080");
        System.out.println(" Python-service verwacht op " + PYTHON_SERVICE_URL);
        System.out.println("=================================================");
    }
}
