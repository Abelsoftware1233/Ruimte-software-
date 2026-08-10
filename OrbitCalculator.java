package com.abelsoftware123.sattracker;

import java.util.ArrayList;
import java.util.List;

/**
 * Abel123 Sat-Tracker :: Orbit Calculator
 * ==========================================
 * Berekent Kepleriaanse baanparameters uit gebruikersinvoer
 * (hoogte, inclinatie, excentriciteit) voor de orbit-simulator.
 *
 * Alle berekeningen gaan uit van een sferische aarde-benadering,
 * voldoende nauwkeurig voor visualisatie.
 */
public class OrbitCalculator {

    private static final double EARTH_RADIUS_KM = 6371.0;
    private static final double MU_EARTH = 398600.4418; // km^3/s^2, standaard zwaartekrachtsparameter

    public static class OrbitResult {
        public double semiMajorAxisKm;
        public double perigeeAltKm;
        public double apogeeAltKm;
        public double periodMinutes;
        public double velocityKmS;
        public double inclinationDeg;
        public double eccentricity;
        public List<double[]> pathPoints; // [x, y, z] in km, ECI-achtig frame voor visualisatie

        public OrbitResult() {
            this.pathPoints = new ArrayList<>();
        }
    }

    /**
     * Berekent volledige baanparameters.
     *
     * @param altitudeKm    gewenste hoogte boven aardoppervlak bij perigee (km)
     * @param inclinationDeg baaninclinatie in graden (0-180)
     * @param eccentricity  excentriciteit (0 = cirkel, 0-1 = ellips)
     * @param numPoints     aantal punten voor de baan-visualisatie
     */
    public static OrbitResult calculate(double altitudeKm, double inclinationDeg,
                                          double eccentricity, int numPoints) {
        OrbitResult result = new OrbitResult();

        double perigeeRadiusKm = EARTH_RADIUS_KM + altitudeKm;
        double semiMajorAxisKm = perigeeRadiusKm / (1 - eccentricity);
        double apogeeRadiusKm = semiMajorAxisKm * (1 + eccentricity);

        double periodSeconds = 2 * Math.PI * Math.sqrt(
                Math.pow(semiMajorAxisKm, 3) / MU_EARTH
        );

        // Snelheid bij perigee (vis-viva vergelijking)
        double velocityAtPerigee = Math.sqrt(
                MU_EARTH * (2.0 / perigeeRadiusKm - 1.0 / semiMajorAxisKm)
        );

        result.semiMajorAxisKm = round2(semiMajorAxisKm);
        result.perigeeAltKm = round2(perigeeRadiusKm - EARTH_RADIUS_KM);
        result.apogeeAltKm = round2(apogeeRadiusKm - EARTH_RADIUS_KM);
        result.periodMinutes = round2(periodSeconds / 60.0);
        result.velocityKmS = round2(velocityAtPerigee);
        result.inclinationDeg = inclinationDeg;
        result.eccentricity = eccentricity;

        double incRad = Math.toRadians(inclinationDeg);

        for (int i = 0; i < numPoints; i++) {
            double theta = 2 * Math.PI * i / numPoints; // ware anomalie
            double r = semiMajorAxisKm * (1 - eccentricity * eccentricity)
                    / (1 + eccentricity * Math.cos(theta));

            // Positie in het baanvlak
            double xOrbit = r * Math.cos(theta);
            double yOrbit = r * Math.sin(theta);

            // Roteer om inclinatie toe te passen (rotatie om de x-as)
            double x = xOrbit;
            double y = yOrbit * Math.cos(incRad);
            double z = yOrbit * Math.sin(incRad);

            result.pathPoints.add(new double[]{round2(x), round2(y), round2(z)});
        }

        return result;
    }

    private static double round2(double val) {
        return Math.round(val * 100.0) / 100.0;
    }
}
