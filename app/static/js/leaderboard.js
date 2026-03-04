(function () {
  'use strict';

  var championsBody = document.getElementById('champions-body');
  var prolificBody = document.getElementById('prolific-body');
  var playerNameEl = document.getElementById('player-name');
  var raceRoundsContainer = document.getElementById('race-rounds-container');

  var statPlayed = document.getElementById('stat-played');
  var statWon = document.getElementById('stat-won');
  var statWinRate = document.getElementById('stat-win-rate');
  var statAvgGuesses = document.getElementById('stat-avg-guesses');
  var statStreak = document.getElementById('stat-streak');

  async function loadPlayerInfo() {
    try {
      var res = await fetch('/api/me');
      if (res.ok) {
        var data = await res.json();
        playerNameEl.textContent = data.name || '';
      }
    } catch (e) { /* ignore */ }
  }

  async function loadRaceRounds() {
    try {
      var res = await fetch('/api/race/leaderboard?rounds=10');
      if (!res.ok) return;
      var data = await res.json();
      var rounds = data.rounds || [];

      if (rounds.length === 0) {
        raceRoundsContainer.innerHTML = '<p class="empty-message">No race rounds yet. Start playing!</p>';
        return;
      }

      var html = '';
      rounds.forEach(function (round) {
        var time = new Date(round.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += '<div class="race-round-card">';
        html += '<div class="race-round-header">';
        html += '<span class="race-round-time">' + time + '</span>';
        html += '<span class="race-round-word">' + escapeHtml(round.word).toUpperCase() + '</span>';
        html += '</div>';

        if (round.players.length === 0) {
          html += '<p class="empty-message">No players</p>';
        } else {
          html += '<table class="leaderboard-table race-table"><thead><tr>';
          html += '<th>#</th><th>Player</th><th>Result</th><th>Guesses</th><th>Time</th>';
          html += '</tr></thead><tbody>';
          round.players.forEach(function (p, i) {
            var statusIcon = p.status === 'won' ? '🟩' : '🟥';
            var timeStr = p.solve_seconds != null ? Math.round(p.solve_seconds) + 's' : '-';
            html += '<tr>';
            html += '<td>' + (i + 1) + '</td>';
            html += '<td>' + escapeHtml(p.name) + '</td>';
            html += '<td>' + statusIcon + '</td>';
            html += '<td>' + (p.status === 'won' ? p.num_guesses : '-') + '</td>';
            html += '<td>' + (p.status === 'won' ? timeStr : '-') + '</td>';
            html += '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';
      });

      raceRoundsContainer.innerHTML = html;
    } catch (e) {
      raceRoundsContainer.innerHTML = '<p class="empty-message">Failed to load race results</p>';
    }
  }

  async function loadLeaderboard() {
    try {
      var res = await fetch('/api/leaderboard');
      if (!res.ok) return;
      var data = await res.json();

      var champions = data.champions || data.best_average || [];
      if (champions.length === 0) {
        championsBody.innerHTML = '<tr><td colspan="4" class="empty-message">No champions yet. Play at least 5 games!</td></tr>';
      } else {
        championsBody.innerHTML = champions.map(function (p, i) {
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(p.name) + '</td>' +
            '<td>' + (p.avg_guesses_per_win != null ? Number(p.avg_guesses_per_win).toFixed(2) : (p.avg_guesses != null ? Number(p.avg_guesses).toFixed(2) : '-')) + '</td>' +
            '<td>' + (p.games_won != null ? p.games_won : '-') + '</td>' +
            '</tr>';
        }).join('');
      }

      var prolific = data.prolific || data.most_prolific || [];
      if (prolific.length === 0) {
        prolificBody.innerHTML = '<tr><td colspan="4" class="empty-message">No data yet. Start playing!</td></tr>';
      } else {
        prolificBody.innerHTML = prolific.map(function (p, i) {
          var winRate = '-';
          if (p.games_won != null && p.games_played != null && p.games_played > 0) {
            winRate = Math.round((p.games_won / p.games_played) * 100) + '%';
          }
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(p.name) + '</td>' +
            '<td>' + (p.games_won != null ? p.games_won : '-') + '</td>' +
            '<td>' + winRate + '</td>' +
            '</tr>';
        }).join('');
      }
    } catch (e) { /* ignore */ }
  }

  async function loadPersonalStats() {
    try {
      var res = await fetch('/api/stats');
      if (!res.ok) { setStatsEmpty(); return; }
      var data = await res.json();

      var gamesPlayed = (data.games_won || 0) + (data.games_lost || 0);
      statPlayed.textContent = gamesPlayed;
      statWon.textContent = data.games_won != null ? data.games_won : 0;

      if (gamesPlayed > 0) {
        statWinRate.textContent = Math.round(((data.games_won || 0) / gamesPlayed) * 100) + '%';
      } else {
        statWinRate.textContent = '-';
      }

      statAvgGuesses.textContent = data.avg_guesses != null ? Number(data.avg_guesses).toFixed(1) : '-';
      statStreak.textContent = data.current_streak != null ? data.current_streak : (data.streak != null ? data.streak : '-');
    } catch (e) { setStatsEmpty(); }
  }

  function setStatsEmpty() {
    statPlayed.textContent = '-';
    statWon.textContent = '-';
    statWinRate.textContent = '-';
    statAvgGuesses.textContent = '-';
    statStreak.textContent = '-';
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function refreshAll() {
    await Promise.all([loadRaceRounds(), loadLeaderboard(), loadPersonalStats()]);
  }

  loadPlayerInfo();
  refreshAll();
  setInterval(refreshAll, 30000);
})();
