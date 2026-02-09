#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# WordBlitz Setup Script
# Run as root on a fresh Ubuntu 22.04+ server
# =============================================================================

INSTALL_DIR="/opt/wordblitz"
LOG_DIR="/var/log/wordblitz"
CERTBOT_WEBROOT="/var/www/certbot"

# --- Load config ---
if [ ! -f "config.env" ]; then
    echo "ERROR: config.env not found. Copy config.env.example to config.env and edit it."
    exit 1
fi
source config.env

if [ "$WORDBLITZ_HOSTNAME" = "wordblitz.example.com" ]; then
    echo "ERROR: Please set WORDBLITZ_HOSTNAME in config.env to your actual domain."
    exit 1
fi

echo "=== WordBlitz Setup ==="
echo "Hostname: $WORDBLITZ_HOSTNAME"
echo ""

# --- System packages ---
echo ">>> Installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip postgresql postgresql-contrib nginx certbot python3-certbot-nginx

# --- PostgreSQL setup ---
echo ">>> Setting up PostgreSQL..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "PostgreSQL database '${DB_NAME}' ready."

# --- Application directory ---
echo ">>> Setting up application directory..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$CERTBOT_WEBROOT"

# Copy application files
cp -r app db wsgi.py requirements.txt "$INSTALL_DIR/"
cp config.env "$INSTALL_DIR/.env"

# --- Python virtual environment ---
echo ">>> Setting up Python environment..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

# --- Initialize database and seed words ---
echo ">>> Initializing database schema and seeding words..."
cd "$INSTALL_DIR"
"$INSTALL_DIR/venv/bin/python" -c "from app.db import init_db; init_db()"
"$INSTALL_DIR/venv/bin/python" -m app.seed

# --- Set permissions ---
chown -R www-data:www-data "$INSTALL_DIR"
chown -R www-data:www-data "$LOG_DIR"

# --- Nginx configuration ---
echo ">>> Configuring Nginx..."
sed "s/WORDBLITZ_HOSTNAME/${WORDBLITZ_HOSTNAME}/g" \
    deploy/nginx-wordblitz.conf > /etc/nginx/sites-available/wordblitz

# Remove default site if present
rm -f /etc/nginx/sites-enabled/default

ln -sf /etc/nginx/sites-available/wordblitz /etc/nginx/sites-enabled/wordblitz

# Test Nginx config (will fail on SSL certs that don't exist yet)
# We'll start without SSL first, get the cert, then enable SSL
echo ">>> Getting SSL certificate..."

# Create a temporary HTTP-only config for certificate issuance
cat > /etc/nginx/sites-available/wordblitz-temp <<EOF
server {
    listen 80;
    server_name ${WORDBLITZ_HOSTNAME};

    location /.well-known/acme-challenge/ {
        root ${CERTBOT_WEBROOT};
    }

    location / {
        return 200 'Setting up...';
        add_header Content-Type text/plain;
    }
}
EOF

ln -sf /etc/nginx/sites-available/wordblitz-temp /etc/nginx/sites-enabled/wordblitz
nginx -t && systemctl restart nginx

# Get Let's Encrypt certificate
certbot certonly --webroot \
    -w "$CERTBOT_WEBROOT" \
    -d "$WORDBLITZ_HOSTNAME" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos \
    --non-interactive

# Switch to full config with SSL
ln -sf /etc/nginx/sites-available/wordblitz /etc/nginx/sites-enabled/wordblitz
rm -f /etc/nginx/sites-available/wordblitz-temp
nginx -t && systemctl reload nginx

# --- Auto-renew certificates ---
echo ">>> Setting up certificate auto-renewal..."
systemctl enable certbot.timer 2>/dev/null || \
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -

# --- Systemd service ---
echo ">>> Setting up Gunicorn service..."
cp deploy/wordblitz.service /etc/systemd/system/wordblitz.service
systemctl daemon-reload
systemctl enable wordblitz
systemctl start wordblitz

echo ""
echo "=== Setup Complete ==="
echo "WordBlitz is running at https://${WORDBLITZ_HOSTNAME}"
echo ""
echo "Useful commands:"
echo "  systemctl status wordblitz     - Check app status"
echo "  systemctl restart wordblitz    - Restart app"
echo "  journalctl -u wordblitz -f     - View app logs"
echo "  tail -f ${LOG_DIR}/error.log   - View Gunicorn error log"
