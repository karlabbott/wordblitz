# WordBlitz 🎯

A Wordle-style word guessing game with unlimited plays, a leaderboard, and persistent player tracking.

![Game Screenshot](https://img.shields.io/badge/game-WordBlitz-538d4e?style=for-the-badge)

## Features

- **Classic Wordle gameplay** — Guess a 5-letter word in 6 tries with green/yellow/gray feedback
- **Unlimited plays** — Once you guess a word, immediately start another
- **Player recognition** — Identified by IP + browser fingerprint, so you can leave and come back
- **Leaderboard** — See who has the best average guesses and who has solved the most words
- **Mobile-friendly** — Responsive design with on-screen keyboard
- **SSL/HTTPS** — Production deployment with Let's Encrypt certificates
- **5,000 word dictionary** — Curated list of common 5-letter English words

## Architecture

```
Browser → Nginx (SSL/443) → Gunicorn (Flask :5000) → PostgreSQL (:5432)
```

## Project Structure

```
wordblitz/
├── app/
│   ├── __init__.py          # Flask app factory
│   ├── config.py            # Configuration from environment
│   ├── db.py                # Database connection pool & helpers
│   ├── routes.py            # API endpoints & page routes
│   ├── seed.py              # Word seeding script
│   ├── static/
│   │   ├── css/style.css    # Full responsive stylesheet
│   │   └── js/
│   │       ├── game.js      # Game logic & UI
│   │       └── leaderboard.js
│   └── templates/
│       ├── index.html       # Game page
│       └── leaderboard.html # Leaderboard page
├── db/
│   ├── schema.sql           # PostgreSQL schema (tables + views)
│   └── words.py             # 5,000 five-letter words
├── deploy/
│   ├── nginx-wordblitz.conf # Nginx site config
│   └── wordblitz.service    # Systemd service file
├── config.env.example       # Environment config template
├── setup.sh                 # Automated setup script
├── wsgi.py                  # WSGI entry point
└── requirements.txt         # Python dependencies
```

## Quick Start (Development)

### Prerequisites
- Python 3.10+
- PostgreSQL 14+

### 1. Set up PostgreSQL

```bash
sudo -u postgres psql -c "CREATE ROLE wordblitz WITH LOGIN PASSWORD 'wordblitz';"
sudo -u postgres psql -c "CREATE DATABASE wordblitz OWNER wordblitz;"
```

### 2. Set up Python environment

```bash
git clone https://github.com/karlabbott/wordblitz.git
cd wordblitz
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Initialize database and seed words

```bash
python -c "from app.db import init_db; init_db()"
python -m app.seed
```

### 4. Run the development server

```bash
flask --app wsgi:app run --debug
```

Open http://localhost:5000 in your browser.

## Production Deployment

### Prerequisites
- Ubuntu 22.04+ server
- Domain name pointing to your server's IP
- Root access

### 1. Clone the repository

```bash
git clone https://github.com/karlabbott/wordblitz.git
cd wordblitz
```

### 2. Configure

```bash
cp config.env.example config.env
nano config.env
```

Edit these values:
- `WORDBLITZ_HOSTNAME` — Your domain name (e.g., `wordblitz.yourdomain.com`)
- `SECRET_KEY` — A random secret key (generate with `python3 -c "import secrets; print(secrets.token_hex(32))"`)
- `DB_PASSWORD` — A strong database password
- `LETSENCRYPT_EMAIL` — Your email for certificate expiry notifications

### 3. Run setup

```bash
sudo bash setup.sh
```

This will:
1. Install system packages (Python, PostgreSQL, Nginx, Certbot)
2. Create the database and user
3. Set up Python virtual environment and install dependencies
4. Initialize the database schema and seed 5,000 words
5. Configure Nginx with SSL (Let's Encrypt)
6. Set up and start the Gunicorn systemd service

### 4. Verify

Visit `https://your-hostname` — you should see the WordBlitz game.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Game page |
| GET | `/leaderboard` | Leaderboard page |
| POST | `/api/register` | Register player name |
| GET | `/api/me` | Get current player info |
| POST | `/api/game/new` | Start a new game |
| GET | `/api/game/current` | Get current game state |
| POST | `/api/game/guess` | Submit a guess |
| GET | `/api/leaderboard` | Get leaderboard data |
| GET | `/api/stats` | Get personal stats |

## Game Rules

1. You have 6 attempts to guess the 5-letter word
2. After each guess, letters are color-coded:
   - 🟩 **Green** — Correct letter in the correct position
   - 🟨 **Yellow** — Correct letter in the wrong position
   - ⬛ **Gray** — Letter is not in the word
3. Duplicate letters are handled correctly (excess duplicates show as gray)
4. After winning or losing, click "New Word" to play again
5. Your progress is saved — leave and come back anytime

## Management

```bash
# Check service status
systemctl status wordblitz

# Restart the application
systemctl restart wordblitz

# View application logs
journalctl -u wordblitz -f

# View Gunicorn access/error logs
tail -f /var/log/wordblitz/error.log

# Renew SSL certificate manually
certbot renew
```

## License

MIT
