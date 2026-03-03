#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# WordBlitz Setup Script
# Run as root on a fresh Ubuntu 22.04+ or RHEL 9/10 server
# =============================================================================

INSTALL_DIR="/opt/wordblitz"
LOG_DIR="/var/log/wordblitz"
CERTBOT_WEBROOT="/var/www/certbot"

# --- Detect OS family ---
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID}"
    OS_FAMILY="${ID_LIKE:-$ID}"
else
    echo "ERROR: Cannot detect OS (missing /etc/os-release)."
    exit 1
fi

case "$OS_ID" in
    ubuntu|debian)  DISTRO_FAMILY="debian" ;;
    rhel|centos|fedora|rocky|alma)  DISTRO_FAMILY="rhel" ;;
    *)
        # Fall back to ID_LIKE
        case "$OS_FAMILY" in
            *rhel*|*fedora*|*centos*)  DISTRO_FAMILY="rhel" ;;
            *debian*|*ubuntu*)         DISTRO_FAMILY="debian" ;;
            *)  echo "ERROR: Unsupported OS: $OS_ID ($OS_FAMILY)"; exit 1 ;;
        esac
        ;;
esac

echo "Detected OS: $OS_ID (family: $DISTRO_FAMILY)"

# --- Set OS-specific defaults ---
if [ "$DISTRO_FAMILY" = "debian" ]; then
    SVC_USER="www-data"
    SVC_GROUP="www-data"
    NGINX_CONF_DIR="/etc/nginx/sites-available"
    NGINX_ENABLED_DIR="/etc/nginx/sites-enabled"
    CERTBOT_CMD="certbot"
else
    SVC_USER="nobody"
    SVC_GROUP="nobody"
    NGINX_CONF_DIR="/etc/nginx/conf.d"
    NGINX_ENABLED_DIR=""  # RHEL uses conf.d directly
    CERTBOT_CMD="/usr/local/bin/certbot"
fi

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
if [ "$DISTRO_FAMILY" = "debian" ]; then
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip postgresql postgresql-contrib \
        nginx certbot python3-certbot-nginx
else
    dnf install -y python3 python3-pip python3-devel postgresql-server postgresql-contrib \
        nginx git gcc libpq-devel
    pip3 install certbot certbot-nginx
fi

# --- PostgreSQL setup ---
echo ">>> Setting up PostgreSQL..."
if [ "$DISTRO_FAMILY" = "rhel" ]; then
    # RHEL requires explicit initdb
    if [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then
        postgresql-setup --initdb
    fi
    systemctl enable --now postgresql
fi

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
cp -r app db deploy wsgi.py requirements.txt "$INSTALL_DIR/"
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
chown -R "$SVC_USER:$SVC_GROUP" "$INSTALL_DIR"
chown -R "$SVC_USER:$SVC_GROUP" "$LOG_DIR"

# --- Nginx configuration ---
echo ">>> Configuring Nginx..."
if [ "$DISTRO_FAMILY" = "debian" ]; then
    sed "s/WORDBLITZ_HOSTNAME/${WORDBLITZ_HOSTNAME}/g" \
        deploy/nginx-wordblitz.conf > "$NGINX_CONF_DIR/wordblitz"
    rm -f "$NGINX_ENABLED_DIR/default"
    ln -sf "$NGINX_CONF_DIR/wordblitz" "$NGINX_ENABLED_DIR/wordblitz"
else
    sed "s/WORDBLITZ_HOSTNAME/${WORDBLITZ_HOSTNAME}/g" \
        deploy/nginx-wordblitz.conf > "$NGINX_CONF_DIR/wordblitz.conf"
fi

# --- SELinux and firewall (RHEL) ---
if [ "$DISTRO_FAMILY" = "rhel" ]; then
    echo ">>> Configuring SELinux and firewall..."
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
    chcon -R -t httpd_sys_content_t "$INSTALL_DIR/app/static/" 2>/dev/null || true
    chcon -R -t httpd_sys_content_t "$CERTBOT_WEBROOT" 2>/dev/null || true
    firewall-cmd --add-service=http --permanent 2>/dev/null || true
    firewall-cmd --add-service=https --permanent 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
fi

# --- SSL certificate ---
echo ">>> Getting SSL certificate..."

# Create a temporary HTTP-only config for certificate issuance
if [ "$DISTRO_FAMILY" = "debian" ]; then
    TEMP_CONF="$NGINX_CONF_DIR/wordblitz-temp"
    cat > "$TEMP_CONF" <<EOF
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
    ln -sf "$TEMP_CONF" "$NGINX_ENABLED_DIR/wordblitz"
else
    TEMP_CONF="$NGINX_CONF_DIR/wordblitz-temp.conf"
    cat > "$TEMP_CONF" <<EOF
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
    # Temporarily disable the full config
    mv "$NGINX_CONF_DIR/wordblitz.conf" "$NGINX_CONF_DIR/wordblitz.conf.bak"
fi

nginx -t && systemctl restart nginx

# Get Let's Encrypt certificate
$CERTBOT_CMD certonly --webroot \
    -w "$CERTBOT_WEBROOT" \
    -d "$WORDBLITZ_HOSTNAME" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos \
    --non-interactive

# Switch to full config with SSL
if [ "$DISTRO_FAMILY" = "debian" ]; then
    ln -sf "$NGINX_CONF_DIR/wordblitz" "$NGINX_ENABLED_DIR/wordblitz"
    rm -f "$TEMP_CONF"
else
    mv "$NGINX_CONF_DIR/wordblitz.conf.bak" "$NGINX_CONF_DIR/wordblitz.conf"
    rm -f "$TEMP_CONF"
fi
nginx -t && systemctl reload nginx

# --- Auto-renew certificates ---
echo ">>> Setting up certificate auto-renewal..."
systemctl enable certbot.timer 2>/dev/null || \
    (crontab -l 2>/dev/null; echo "0 3 * * * $CERTBOT_CMD renew --quiet --post-hook 'systemctl reload nginx'") | crontab -

# --- Chaos testing script (install on DB VM where psql and postgres user exist) ---
echo ">>> Installing chaos testing script on DB VM..."
if [ -n "${DB_VM_HOST:-}" ] && [ "$DB_VM_HOST" != "localhost" ] && [ "$DB_VM_HOST" != "127.0.0.1" ]; then
    scp deploy/chaos.sh "${SSH_USER:-azureuser}@${DB_VM_HOST}:/tmp/chaos.sh"
    ssh "${SSH_USER:-azureuser}@${DB_VM_HOST}" "sudo install -m 755 /tmp/chaos.sh /usr/local/bin/chaos.sh && rm /tmp/chaos.sh"
else
    install -m 755 deploy/chaos.sh /usr/local/bin/chaos.sh
fi

# --- Systemd service ---
echo ">>> Setting up Gunicorn service..."
sed "s/User=www-data/User=$SVC_USER/;s/Group=www-data/Group=$SVC_GROUP/" \
    deploy/wordblitz.service > /etc/systemd/system/wordblitz.service
# Replace shell-style defaults that systemd doesn't support
sed -i 's/${GUNICORN_WORKERS:-3}/3/g;s/${GUNICORN_BIND:-127.0.0.1:5000}/127.0.0.1:5000/g' \
    /etc/systemd/system/wordblitz.service
if [ "$DISTRO_FAMILY" = "rhel" ]; then
    # Remove local PostgreSQL dependency when DB may be on a separate host
    sed -i '/Wants=postgresql.service/d;s/After=network.target postgresql.service/After=network.target/' \
        /etc/systemd/system/wordblitz.service
fi
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
