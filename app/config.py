import os


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'change-me-in-production')
    DATABASE_URL = os.environ.get(
        'DATABASE_URL',
        'postgresql://wordblitz:wordblitz@localhost:5432/wordblitz',
    )
    HOSTNAME = os.environ.get('HOSTNAME', 'localhost')
