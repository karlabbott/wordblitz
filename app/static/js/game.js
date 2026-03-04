(function () {
  'use strict';

  // --- State ---
  let currentRow = 0;
  let currentCol = 0;
  let gameOver = false;
  let currentGameId = null;
  let currentMode = 'race';
  let playerRegistered = false;
  let isAnimating = false;
  const keyboardState = {};

  // Race timer state
  let roundEndsAt = null;
  let timerInterval = null;
  let raceStatusInterval = null;
  let roundSeconds = 300;

  // --- DOM refs ---
  const board = document.getElementById('game-board');
  const keyboard = document.getElementById('keyboard');
  const modal = document.getElementById('registration-modal');
  const nameInput = document.getElementById('player-name-input');
  const registerBtn = document.getElementById('register-btn');
  const newWordBtn = document.getElementById('new-word-btn');
  const playRandomBtn = document.getElementById('play-random-btn');
  const nextRoundMsg = document.getElementById('next-round-msg');
  const playerNameEl = document.getElementById('player-name');
  const toastContainer = document.getElementById('toast-container');
  const raceBar = document.getElementById('race-bar');
  const raceLabel = document.getElementById('race-label');
  const raceTimer = document.getElementById('race-timer');
  const raceProgress = document.getElementById('race-progress');
  const confettiCanvas = document.getElementById('confetti-canvas');

  // --- Init ---
  async function init() {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = await res.json();
        playerRegistered = true;
        playerNameEl.textContent = data.name || '';
        await loadRaceStatus();
      } else if (res.status === 404) {
        showModal();
      }
    } catch (e) {
      showModal();
    }
  }

  // --- Modal ---
  function showModal() {
    modal.style.display = 'flex';
    setTimeout(function () { nameInput.focus(); }, 100);
  }

  function hideModal() {
    modal.style.display = 'none';
  }

  registerBtn.addEventListener('click', handleRegister);
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleRegister();
  });

  async function handleRegister() {
    var name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    try {
      var res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      if (res.ok || res.status === 409) {
        var data = await res.json();
        playerRegistered = true;
        playerNameEl.textContent = data.name || name;
        hideModal();
        await loadRaceStatus();
      } else {
        var err = await res.json().catch(function () { return {}; });
        showToast(err.error || 'Registration failed', 3000);
      }
    } catch (e) {
      showToast('Connection error', 3000);
    }
  }

  // --- Race status ---
  async function loadRaceStatus() {
    try {
      var res = await fetch('/api/race/status');
      if (!res.ok) return;
      var data = await res.json();
      roundSeconds = data.round_seconds || 300;
      roundEndsAt = new Date(data.round_ends_at).getTime();

      if (data.played && data.player_result !== 'active') {
        // Already completed this round
        showRaceBar();
        startTimer();
        showWaitingState();
      } else {
        // Start or resume race game
        await startRaceGame();
      }

      // Poll for new rounds
      clearInterval(raceStatusInterval);
      raceStatusInterval = setInterval(checkForNewRound, 5000);
    } catch (e) {
      await startRandomGame();
    }
  }

  async function checkForNewRound() {
    if (!playerRegistered) return;
    try {
      var res = await fetch('/api/race/status');
      if (!res.ok) return;
      var data = await res.json();
      var newEndsAt = new Date(data.round_ends_at).getTime();

      // New round detected
      if (newEndsAt !== roundEndsAt && !data.played) {
        roundEndsAt = newEndsAt;
        roundSeconds = data.round_seconds || 300;
        hideWaitingState();
        await startRaceGame();
      }
    } catch (e) { /* ignore */ }
  }

  // --- Timer ---
  function showRaceBar() {
    raceBar.style.display = '';
  }

  function startTimer() {
    clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 250);
  }

  function updateTimerDisplay() {
    if (!roundEndsAt) return;
    var now = Date.now();
    var remaining = Math.max(0, Math.ceil((roundEndsAt - now) / 1000));
    var minutes = Math.floor(remaining / 60);
    var seconds = remaining % 60;
    raceTimer.textContent = minutes + ':' + (seconds < 10 ? '0' : '') + seconds;

    // Progress bar
    var fraction = Math.max(0, Math.min(1, remaining / roundSeconds));
    raceProgress.style.width = (fraction * 100) + '%';

    // Color changes
    if (remaining <= 30) {
      raceTimer.classList.add('timer-urgent');
      raceProgress.classList.add('progress-urgent');
    } else if (remaining <= 60) {
      raceTimer.classList.remove('timer-urgent');
      raceTimer.classList.add('timer-warning');
      raceProgress.classList.remove('progress-urgent');
      raceProgress.classList.add('progress-warning');
    } else {
      raceTimer.classList.remove('timer-urgent', 'timer-warning');
      raceProgress.classList.remove('progress-urgent', 'progress-warning');
    }

    // Time's up — force end
    if (remaining <= 0 && !gameOver && currentMode === 'race') {
      forceEndRace();
    }
  }

  async function forceEndRace() {
    gameOver = true;
    clearInterval(timerInterval);
    raceLabel.textContent = '⏰ Time\'s up!';

    // Try to get the answer from the server
    try {
      var res = await fetch('/api/game/guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guess: 'zzzzz' })
      });
      if (res.status === 410) {
        var data = await res.json();
        if (data.answer) showToast('The word was: ' + data.answer, 5000);
      }
    } catch (e) { /* ignore */ }

    showWaitingState();
  }

  // --- Waiting state (between rounds) ---
  function showWaitingState() {
    newWordBtn.style.display = 'none';
    playRandomBtn.style.display = 'inline-block';
    nextRoundMsg.style.display = 'block';
    updateNextRoundCountdown();

    clearInterval(timerInterval);
    timerInterval = setInterval(function () {
      updateTimerDisplay();
      updateNextRoundCountdown();
    }, 250);
  }

  function hideWaitingState() {
    playRandomBtn.style.display = 'none';
    nextRoundMsg.style.display = 'none';
    raceLabel.textContent = '⏱️ Race Round';
    raceTimer.classList.remove('timer-urgent', 'timer-warning');
    raceProgress.classList.remove('progress-urgent', 'progress-warning');
  }

  function updateNextRoundCountdown() {
    if (!roundEndsAt) return;
    var remaining = Math.max(0, Math.ceil((roundEndsAt - Date.now()) / 1000));
    if (remaining > 0) {
      var m = Math.floor(remaining / 60);
      var s = remaining % 60;
      nextRoundMsg.textContent = 'Next race word in ' + m + ':' + (s < 10 ? '0' : '') + s;
    } else {
      nextRoundMsg.textContent = 'New round starting...';
    }
  }

  // --- Game loading ---
  async function startRaceGame() {
    try {
      var res = await fetch('/api/game/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'race' })
      });
      if (res.ok || res.status === 201) {
        var data = await res.json();
        currentGameId = data.game_id;
        currentMode = 'race';
        if (data.round_ends_at) {
          roundEndsAt = new Date(data.round_ends_at).getTime();
        }
        showRaceBar();
        startTimer();
        if (data.guesses && data.guesses.length > 0) {
          restoreBoard(data);
        } else {
          resetBoard();
        }
      } else if (res.status === 409) {
        // Already played this round
        showRaceBar();
        startTimer();
        showWaitingState();
      }
    } catch (e) {
      showToast('Failed to start race game', 3000);
    }
  }

  async function startRandomGame() {
    try {
      var res = await fetch('/api/game/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'random' })
      });
      if (res.ok || res.status === 201) {
        var data = await res.json();
        currentGameId = data.game_id;
        currentMode = 'random';
        raceBar.style.display = 'none';
        resetBoard();
      }
    } catch (e) {
      showToast('Failed to start game', 3000);
    }
  }

  function restoreBoard(data) {
    resetBoard();
    var guesses = data.guesses || [];
    for (var r = 0; r < guesses.length; r++) {
      var g = guesses[r];
      var word = g.word || g.guess || '';
      var result = g.result || g.letters || [];
      for (var c = 0; c < 5; c++) {
        var tile = getTile(r, c);
        tile.textContent = word[c] ? word[c].toUpperCase() : '';
        if (result[c]) {
          var state = result[c].status || result[c].state || result[c];
          tile.setAttribute('data-state', state);
          updateKeyboardKey(word[c].toUpperCase(), state);
        }
      }
      currentRow = r + 1;
    }
    currentCol = 0;

    if (data.status === 'won') {
      gameOver = true;
      if (currentMode === 'race') showWaitingState();
      else newWordBtn.style.display = 'inline-block';
    } else if (data.status === 'lost') {
      gameOver = true;
      if (currentMode === 'race') showWaitingState();
      else newWordBtn.style.display = 'inline-block';
      if (data.answer) showToast('The word was: ' + data.answer.toUpperCase(), 5000);
    }
  }

  // --- Board helpers ---
  function getTile(row, col) {
    return board.querySelector('.tile[data-row="' + row + '"][data-col="' + col + '"]');
  }

  function getRow(row) {
    return board.querySelector('.board-row[data-row="' + row + '"]');
  }

  function resetBoard() {
    currentRow = 0;
    currentCol = 0;
    gameOver = false;
    isAnimating = false;
    newWordBtn.style.display = 'none';

    for (var r = 0; r < 6; r++) {
      for (var c = 0; c < 5; c++) {
        var tile = getTile(r, c);
        tile.textContent = '';
        tile.removeAttribute('data-state');
        tile.classList.remove('flip', 'bounce');
      }
      var rowEl = getRow(r);
      if (rowEl) rowEl.classList.remove('shake');
    }

    Object.keys(keyboardState).forEach(function (k) { delete keyboardState[k]; });
    keyboard.querySelectorAll('.key').forEach(function (key) {
      key.removeAttribute('data-state');
    });
  }

  // --- Input handling ---
  function handleKey(key) {
    if (gameOver || isAnimating) return;
    if (modal.style.display === 'flex') return;

    if (key === 'ENTER') submitGuess();
    else if (key === 'BACKSPACE') deleteLetter();
    else if (/^[A-Z]$/.test(key)) addLetter(key);
  }

  function addLetter(letter) {
    if (currentCol >= 5) return;
    var tile = getTile(currentRow, currentCol);
    tile.textContent = letter;
    tile.setAttribute('data-state', 'tbd');
    currentCol++;
  }

  function deleteLetter() {
    if (currentCol <= 0) return;
    currentCol--;
    var tile = getTile(currentRow, currentCol);
    tile.textContent = '';
    tile.removeAttribute('data-state');
  }

  async function submitGuess() {
    if (currentCol < 5) {
      shakeRow(currentRow);
      showToast('Not enough letters');
      return;
    }

    var word = '';
    for (var c = 0; c < 5; c++) {
      word += getTile(currentRow, c).textContent;
    }
    word = word.toLowerCase();

    isAnimating = true;
    try {
      var res = await fetch('/api/game/guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guess: word })
      });

      // Race round expired
      if (res.status === 410) {
        var expData = await res.json();
        isAnimating = false;
        gameOver = true;
        if (expData.answer) showToast('Time\'s up! The word was: ' + expData.answer, 5000);
        showWaitingState();
        return;
      }

      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        isAnimating = false;
        shakeRow(currentRow);
        showToast(err.error || 'Not in word list');
        return;
      }

      var data = await res.json();
      var guessData = data.guess || {};
      var result = guessData.result || [];

      await revealRow(currentRow, word.toUpperCase(), result);

      if (data.status === 'won') {
        gameOver = true;
        await bounceRow(currentRow);
        var messages = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
        showToast(messages[currentRow] || 'You won!', 3000);
        currentRow++;
        launchConfetti();
        if (currentMode === 'race') showWaitingState();
        else newWordBtn.style.display = 'inline-block';
      } else if (data.status === 'lost') {
        gameOver = true;
        currentRow++;
        var answer = (data.answer || '').toUpperCase();
        showToast('The word was: ' + answer, 5000);
        if (currentMode === 'race') showWaitingState();
        else newWordBtn.style.display = 'inline-block';
      } else {
        currentRow++;
        currentCol = 0;
      }
      isAnimating = false;
    } catch (e) {
      isAnimating = false;
      showToast('Connection error', 3000);
    }
  }

  // --- Animations ---
  function revealRow(row, word, result) {
    return new Promise(function (resolve) {
      var tiles = [];
      for (var c = 0; c < 5; c++) tiles.push(getTile(row, c));

      var revealed = 0;
      tiles.forEach(function (tile, i) {
        setTimeout(function () {
          tile.classList.add('flip');
          setTimeout(function () {
            var state = result[i].status || result[i].state || result[i];
            tile.removeAttribute('data-state');
            tile.setAttribute('data-state', state);
            updateKeyboardKey(word[i], state);
          }, 250);

          tile.addEventListener('animationend', function handler() {
            tile.classList.remove('flip');
            tile.removeEventListener('animationend', handler);
            revealed++;
            if (revealed === 5) resolve();
          });
        }, i * 300);
      });
    });
  }

  function bounceRow(row) {
    return new Promise(function (resolve) {
      var tiles = [];
      for (var c = 0; c < 5; c++) tiles.push(getTile(row, c));

      var bounced = 0;
      tiles.forEach(function (tile, i) {
        setTimeout(function () {
          tile.classList.add('bounce');
          tile.addEventListener('animationend', function handler() {
            tile.classList.remove('bounce');
            tile.removeEventListener('animationend', handler);
            bounced++;
            if (bounced === 5) resolve();
          });
        }, i * 100);
      });
    });
  }

  function shakeRow(row) {
    var rowEl = getRow(row);
    if (!rowEl) return;
    rowEl.classList.remove('shake');
    void rowEl.offsetWidth;
    rowEl.classList.add('shake');
    rowEl.addEventListener('animationend', function handler() {
      rowEl.classList.remove('shake');
      rowEl.removeEventListener('animationend', handler);
    });
  }

  // --- Confetti ---
  function launchConfetti() {
    var canvas = confettiCanvas;
    var ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display = 'block';

    var particles = [];
    var colors = ['#538d4e', '#b59f3b', '#ff6b6b', '#4ecdc4', '#ffe66d', '#ff8a5c', '#a78bfa', '#f472b6'];
    var gravity = 0.12;
    var drag = 0.98;

    for (var i = 0; i < 150; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 4 + Math.random() * 8;
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 200,
        y: canvas.height / 2 - 100,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 4 + Math.random() * 6,
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 10,
        life: 1,
        decay: 0.003 + Math.random() * 0.005,
        shape: Math.random() > 0.5 ? 'rect' : 'circle',
      });
    }

    var startTime = Date.now();
    var maxDuration = 3000;

    function animate() {
      var elapsed = Date.now() - startTime;
      if (elapsed > maxDuration || particles.every(function (p) { return p.life <= 0; })) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach(function (p) {
        if (p.life <= 0) return;
        p.vy += gravity;
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
        p.life -= p.decay;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;

        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });

      requestAnimationFrame(animate);
    }

    animate();
  }

  // --- Keyboard color tracking ---
  var stateRank = { absent: 1, present: 2, correct: 3 };

  function updateKeyboardKey(letter, state) {
    letter = letter.toUpperCase();
    var current = keyboardState[letter];
    var currentRank = current ? stateRank[current] || 0 : 0;
    var newRank = stateRank[state] || 0;

    if (newRank > currentRank) {
      keyboardState[letter] = state;
      var keyEl = keyboard.querySelector('.key[data-key="' + letter + '"]');
      if (keyEl) keyEl.setAttribute('data-state', state);
    }
  }

  // --- Toast ---
  function showToast(message, duration) {
    duration = duration || 2000;
    var toast = document.createElement('div');
    toast.classList.add('toast');
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', function () { toast.remove(); });
    }, duration);
  }

  // --- Button handlers ---
  newWordBtn.addEventListener('click', async function () {
    newWordBtn.style.display = 'none';
    await startRandomGame();
  });

  playRandomBtn.addEventListener('click', async function () {
    playRandomBtn.style.display = 'none';
    nextRoundMsg.style.display = 'none';
    await startRandomGame();
  });

  // --- Physical keyboard ---
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (modal.style.display === 'flex') return;

    if (e.key === 'Enter') { e.preventDefault(); handleKey('ENTER'); }
    else if (e.key === 'Backspace') { e.preventDefault(); handleKey('BACKSPACE'); }
    else if (/^[a-zA-Z]$/.test(e.key)) { handleKey(e.key.toUpperCase()); }
  });

  // --- On-screen keyboard ---
  keyboard.addEventListener('click', function (e) {
    var keyEl = e.target.closest('.key');
    if (!keyEl) return;
    handleKey(keyEl.dataset.key);
  });

  keyboard.addEventListener('touchend', function (e) {
    e.preventDefault();
    var keyEl = e.target.closest('.key');
    if (!keyEl) return;
    handleKey(keyEl.dataset.key);
  });

  // --- Start ---
  init();
})();
