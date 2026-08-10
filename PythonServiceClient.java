package com.abelsoftware123.sattracker;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Abel123 Sat-Tracker :: Python Service Client
 * ================================================
 * Java (hoofd-backend) roept hiermee de interne Python-microservice
 * aan, die de live TLE-data en sgp4-berekeningen levert.
 *
 * De browser praat NOOIT direct met Python; alles loopt via Java.
 * Python luistert alleen op 127.0.0.1 en hoeft niet publiek
 * bereikbaar te zijn.
 */
public class PythonServiceClient {

    private final String baseUrl;
    private final HttpClient client;

    public PythonServiceClient(String baseUrl) {
        this.baseUrl = baseUrl;
        this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    /**
     * Haalt live satellietposities op voor een TLE-groep (bv. "stations", "starlink").
     * Retourneert de ruwe JSON-string van de Python-service (wordt door Javalin doorgestuurd).
     */
    public String getPositions(String group, int limit) throws Exception {
        String url = String.format("%s/tle/%s?limit=%d", baseUrl, group, limit);
        return doGet(url);
    }

    /**
     * Haalt de live ISS-positie op (apart endpoint, altijd vers).
     */
    public String getIss() throws Exception {
        return doGet(baseUrl + "/tle/iss");
    }

    private String doGet(String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(15))
                .GET()
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new RuntimeException("Python service gaf status " + response.statusCode() + ": " + response.body());
        }
        return response.body();
    }

    /**
     * Controleert of de Python-service bereikbaar is.
     */
    public boolean isHealthy() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/health"))
                    .timeout(Duration.ofSeconds(3))
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }
}
