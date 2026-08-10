#!/bin/bash
set -e

echo "========================================"
echo " Abel123 Orbital Sentinel Setup Script"
echo "========================================"

# Define paths
REPO_DIR=$(pwd)
PYTHON_DIR="$REPO_DIR/python-service"
JAVA_DIR="$REPO_DIR/java-service"
USER_NAME=$(whoami)

echo ">>> 1. Setting up Python Microservice..."
cd $PYTHON_DIR
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate

echo ">>> 2. Building Java Backend..."
cd $JAVA_DIR
mvn clean package

echo ">>> 3. Creating systemd service for Python..."
sudo bash -c "cat > /etc/systemd/system/sattracker-python.service <<EOF
[Unit]
Description=SatTracker Python TLE Microservice
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$PYTHON_DIR
ExecStart=$PYTHON_DIR/venv/bin/python app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF"

echo ">>> 4. Creating systemd service for Java..."
sudo bash -c "cat > /etc/systemd/system/sattracker-java.service <<EOF
[Unit]
Description=SatTracker Java Backend
After=network.target sattracker-python.service

[Service]
User=$USER_NAME
WorkingDirectory=$JAVA_DIR
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
