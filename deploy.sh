#!/bin/bash
set -e

echo "========================================"
echo " Abel123 Orbital Sentinel Setup Script"
echo "========================================"

# Definieer de huidige map (waar alle bestanden staan)
REPO_DIR=$(pwd)
USER_NAME=$(whoami)

echo ">>> 1. Setting up Python Microservice..."
# We blijven in de huidige map
cd $REPO_DIR
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate

echo ">>> 2. Building Java Backend..."
# pom.xml staat ook in deze map
mvn clean package

echo ">>> 3. Creating systemd service for Python (Port 5091)..."
sudo bash -c "cat > /etc/systemd/system/sattracker-python.service <<EOF
[Unit]
Description=SatTracker Python TLE Microservice
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/venv/bin/python app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF"

echo ">>> 4. Creating systemd service for Java (Port 5090)..."
sudo bash -c "cat > /etc/systemd/system/sattracker-java.service <<EOF
[Unit]
Description=SatTracker Java Backend
After=network.target sattracker-python.service

[Service]
User=$USER_NAME
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/java -jar target/sattracker.jar
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF"

echo ">>> 5. Reloading systemd and enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable --now sattracker-python
sudo systemctl enable --now sattracker-java

echo "========================================"
echo " Services are running! Check status with:"
echo " sudo systemctl status sattracker-python"
echo " sudo systemctl status sattracker-java"
echo "========================================"
