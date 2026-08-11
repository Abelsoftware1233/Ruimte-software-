package com.abelsoftware123.sattracker;

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
 * Publiek bereikbaar op poort 5090.
 * Vereist dat de Python-service draait op http://127.0.0.1:5091
 * (zie python-service/app.py) -- die poort is alleen intern en
 * hoeft niet publiek open te staan.
 */
public class Main {

    private static final String PYTHON_SERVICE_URL = "http://127.0.0.1:5091";
    private static final int PUBLIC_PORT = 5090;

    public static void main(String[] args) {
        PythonServiceClient pythonClient = new PythonServiceClient(PYTHON_SERVICE_URL);

        Javalin app = Javalin.create(config -> {
            config.staticFiles.add(staticFiles -> {
                staticFiles.hostedPath = "/";
                staticFiles.directory = "/public";
                staticFiles.location = Location.CLASSPATH;
            });
            config.bundledPlugins.enableCors(cors -> cors.addRule(it -> it.anyHost()));
        }).start(PUBLIC_PORT);

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
                double altitude = parseDoubleParam(ctx, "altitude", 400.0);
                double inclination = parseDoubleParam(ctx, "inclination", 51.6);
                double eccentricity = parseDoubleParam(ctx, "eccentricity", 0.0);
                int points = (int) parseDoubleParam(ctx, "points", 180);

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
                if (points < 8 || points > 2000) {
                    ctx.status(400).json(Map.of("error", "points moet tussen 8 en 2000 liggen"));
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
            int limit;
            try {
                limit = (int) parseDoubleParam(ctx, "limit", 60);
            } catch (NumberFormatException e) {
                ctx.status(400).json(Map.of("error", "limit moet een geheel getal zijn"));
                return;
            }
            if (limit < 1 || limit > 400) {
                ctx.status(400).json(Map.of("error", "limit moet tussen 1 en 400 liggen"));
                return;
            }

            try {
                String pythonResponse = pythonClient.getPositions(group, limit);
                ctx.contentType("application/json").result(pythonResponse);
            } catch (Exception e) {
                ctx.status(502).json(Map.of(
                        "error", "Kon geen verbinding maken met de Python tracking-service",
                        "detail", String.valueOf(e.getMessage())
                ));
            }
        });

        // -------------------------------------------------------
        // ISS: apart, altijd-vers endpoint (geen limit nodig, 1 object)
        // -------------------------------------------------------
        app.get("/api/iss", ctx -> {
            try {
                String pythonResponse = pythonClient.getIss();
                ctx.contentType("application/json").result(pythonResponse);
            } catch (Exception e) {
                ctx.status(502).json(Map.of(
                        "error", "Kon geen verbinding maken met de Python tracking-service",
                        "detail", String.valueOf(e.getMessage())
                ));
            }
        });

        System.out.println("=================================================");
        System.out.println(" Abel123 Sat-Tracker :: Java hoofd-backend actief");
        System.out.println(" -> http://127.0.0.1:" + PUBLIC_PORT);
        System.out.println(" Python-service verwacht op " + PYTHON_SERVICE_URL);
        System.out.println("=================================================");
    }

    /**
     * Parsed een double query-param met default-waarde, en gooit een
     * nette NumberFormatException (afgevangen door de caller) bij
     * ongeldige invoer i.p.v. een ongevangen 500-fout.
     */
    private static double parseDoubleParam(io.javalin.http.Context ctx, String name, double defaultVal) {
        String raw = ctx.queryParam(name);
        if (raw == null || raw.isBlank()) {
            return defaultVal;
        }
        return Double.parseDouble(raw);
    }
}
