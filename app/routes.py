import hashlib
import json

from flask import Blueprint, jsonify, render_template, request

from .db import execute_db, query_db

bp = Blueprint('main', __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_fingerprint() -> str:
    """SHA-256 hash of IP + User-Agent + Accept-Language."""
    ip = request.headers.get('X-Forwarded-For', request.remote_addr or '')
    if ',' in ip:
        ip = ip.split(',')[0].strip()
    raw = (
        ip
        + (request.headers.get('User-Agent', ''))
        + (request.headers.get('Accept-Language', ''))
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _player_by_fingerprint(fp: str):
    return query_db(
        'SELECT id, name, fingerprint, created_at FROM players WHERE fingerprint = %s',
        (fp,),
        one=True,
    )


def _serialize_player(p: dict) -> dict:
    return {
        'id': p['id'],
        'name': p['name'],
        'fingerprint': p['fingerprint'],
        'created_at': p['created_at'].isoformat(),
    }


def _evaluate_guess(guess: str, target: str):
    """Return a list of {letter, status} dicts for each position.

    Algorithm:
      1. First pass  – mark exact matches as 'correct'.
      2. Second pass – for remaining letters, mark as 'present' (consuming
         one occurrence in the target) or 'absent'.
    """
    result = [None] * 5
    target_remaining = list(target)

    # First pass: correct
    for i in range(5):
        if guess[i] == target[i]:
            result[i] = {'letter': guess[i], 'status': 'correct'}
            target_remaining[i] = None  # consumed

    # Second pass: present / absent
    for i in range(5):
        if result[i] is not None:
            continue
        letter = guess[i]
        if letter in target_remaining:
            result[i] = {'letter': letter, 'status': 'present'}
            target_remaining[target_remaining.index(letter)] = None
        else:
            result[i] = {'letter': letter, 'status': 'absent'}

    return result


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@bp.route('/')
def index():
    return render_template('index.html')


@bp.route('/leaderboard')
def leaderboard_page():
    return render_template('leaderboard.html')


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@bp.route('/api/register', methods=['POST'])
def register():
    data = request.get_json(silent=True) or {}
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400

    fp = get_fingerprint()

    existing = _player_by_fingerprint(fp)
    if existing:
        return jsonify({'error': 'Player already registered from this browser'}), 409

    player = execute_db(
        'INSERT INTO players (name, fingerprint) VALUES (%s, %s) '
        'RETURNING id, name, fingerprint, created_at',
        (name, fp),
    )
    return jsonify(_serialize_player(player)), 201


@bp.route('/api/me')
def me():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not found'}), 404
    return jsonify(_serialize_player(player))


@bp.route('/api/game/new', methods=['POST'])
def new_game():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not registered'}), 401

    pid = player['id']

    # Check for an existing active game
    active = query_db(
        'SELECT id, status, num_guesses, created_at FROM games '
        'WHERE player_id = %s AND status = %s',
        (pid, 'active'),
        one=True,
    )
    if active:
        guesses = query_db(
            'SELECT guess_word, guess_number, result FROM guesses '
            'WHERE game_id = %s ORDER BY guess_number',
            (active['id'],),
        )
        return jsonify({
            'game_id': active['id'],
            'guesses': [
                {
                    'guess': g['guess_word'],
                    'guess_number': g['guess_number'],
                    'result': g['result'],
                }
                for g in guesses
            ],
        })

    # Pick a word the player hasn't seen yet
    word = query_db(
        'SELECT id, word FROM words '
        'WHERE id NOT IN (SELECT word_id FROM games WHERE player_id = %s) '
        'ORDER BY RANDOM() LIMIT 1',
        (pid,),
        one=True,
    )

    # Fallback: player has played every word – pick any random word
    if not word:
        word = query_db(
            'SELECT id, word FROM words ORDER BY RANDOM() LIMIT 1',
            one=True,
        )

    if not word:
        return jsonify({'error': 'No words available'}), 500

    game = execute_db(
        'INSERT INTO games (player_id, word_id) VALUES (%s, %s) '
        'RETURNING id, status, num_guesses, created_at',
        (pid, word['id']),
    )

    return jsonify({'game_id': game['id'], 'guesses': []}), 201


@bp.route('/api/game/current')
def current_game():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not registered'}), 401

    game = query_db(
        'SELECT g.id, g.status, g.num_guesses, g.created_at '
        'FROM games g WHERE g.player_id = %s AND g.status = %s',
        (player['id'], 'active'),
        one=True,
    )
    if not game:
        return jsonify({'error': 'No active game'}), 404

    guesses = query_db(
        'SELECT guess_word, guess_number, result FROM guesses '
        'WHERE game_id = %s ORDER BY guess_number',
        (game['id'],),
    )

    return jsonify({
        'game_id': game['id'],
        'status': game['status'],
        'num_guesses': game['num_guesses'],
        'guesses': [
            {
                'guess': g['guess_word'],
                'guess_number': g['guess_number'],
                'result': g['result'],
            }
            for g in guesses
        ],
    })


@bp.route('/api/game/guess', methods=['POST'])
def guess():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not registered'}), 401

    game = query_db(
        'SELECT g.id, g.status, g.num_guesses, w.word '
        'FROM games g JOIN words w ON w.id = g.word_id '
        'WHERE g.player_id = %s AND g.status = %s',
        (player['id'], 'active'),
        one=True,
    )
    if not game:
        return jsonify({'error': 'No active game'}), 404

    data = request.get_json(silent=True) or {}
    guess_word = data.get('guess', '').strip().lower()

    if len(guess_word) != 5 or not guess_word.isalpha():
        return jsonify({'error': 'Guess must be exactly 5 letters'}), 400

    # Validate against dictionary
    valid = query_db(
        'SELECT 1 FROM words WHERE word = %s',
        (guess_word,),
        one=True,
    )
    if not valid:
        return jsonify({'error': 'Not a valid word'}), 400

    target = game['word']
    guess_number = game['num_guesses'] + 1
    result = _evaluate_guess(guess_word, target)

    won = guess_word == target
    lost = guess_number == 6 and not won

    if won:
        new_status = 'won'
    elif lost:
        new_status = 'lost'
    else:
        new_status = 'active'

    # Insert guess row
    execute_db(
        'INSERT INTO guesses (game_id, guess_word, guess_number, result) '
        'VALUES (%s, %s, %s, %s)',
        (game['id'], guess_word, guess_number, json.dumps(result)),
    )

    # Update game
    if new_status in ('won', 'lost'):
        execute_db(
            'UPDATE games SET num_guesses = %s, status = %s, completed_at = NOW() '
            'WHERE id = %s RETURNING id',
            (guess_number, new_status, game['id']),
        )
    else:
        execute_db(
            'UPDATE games SET num_guesses = %s WHERE id = %s RETURNING id',
            (guess_number, game['id']),
        )

    # Build response
    all_guesses = query_db(
        'SELECT guess_word, guess_number, result FROM guesses '
        'WHERE game_id = %s ORDER BY guess_number',
        (game['id'],),
    )

    resp = {
        'game_id': game['id'],
        'status': new_status,
        'num_guesses': guess_number,
        'guess': {
            'guess': guess_word,
            'guess_number': guess_number,
            'result': result,
        },
        'guesses': [
            {
                'guess': g['guess_word'],
                'guess_number': g['guess_number'],
                'result': g['result'],
            }
            for g in all_guesses
        ],
    }

    if lost:
        resp['answer'] = target

    return jsonify(resp)


@bp.route('/api/leaderboard')
def leaderboard():
    champions = query_db(
        'SELECT name, games_won, games_played, avg_guesses_per_win, '
        '       current_streak, best_streak '
        'FROM leaderboard_stats '
        'WHERE games_won >= 5 '
        'ORDER BY avg_guesses_per_win ASC '
        'LIMIT 20',
    )
    prolific = query_db(
        'SELECT name, games_won, games_played, avg_guesses_per_win, '
        '       current_streak, best_streak '
        'FROM leaderboard_stats '
        'ORDER BY games_won DESC '
        'LIMIT 20',
    )

    def _serialize(rows):
        return [
            {
                'name': r['name'],
                'games_won': r['games_won'],
                'games_played': r['games_played'],
                'avg_guesses_per_win': float(r['avg_guesses_per_win'])
                if r['avg_guesses_per_win'] is not None
                else None,
                'current_streak': r['current_streak'],
                'best_streak': r['best_streak'],
            }
            for r in rows
        ]

    return jsonify({
        'champions': _serialize(champions),
        'prolific': _serialize(prolific),
    })


@bp.route('/api/stats')
def stats():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not found'}), 404

    row = query_db(
        'SELECT games_won, games_played, avg_guesses_per_win, '
        '       current_streak, best_streak '
        'FROM leaderboard_stats '
        'WHERE player_id = %s',
        (player['id'],),
        one=True,
    )

    if not row:
        return jsonify({
            'games_won': 0,
            'games_lost': 0,
            'avg_guesses': None,
            'current_streak': 0,
            'best_streak': 0,
        })

    return jsonify({
        'games_won': row['games_won'],
        'games_lost': row['games_played'] - row['games_won'],
        'avg_guesses': float(row['avg_guesses_per_win'])
        if row['avg_guesses_per_win'] is not None
        else None,
        'current_streak': row['current_streak'],
        'best_streak': row['best_streak'],
    })
