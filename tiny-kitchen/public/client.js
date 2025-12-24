(() => {
  const socket = io();

  const lobbyScreen = document.getElementById("lobbyScreen");
  const roomScreen = document.getElementById("roomScreen");
  const gameScreen = document.getElementById("gameScreen");

  const connPill = document.getElementById("connPill");
  const nameInput = document.getElementById("nameInput");
  const codeInput = document.getElementById("codeInput");
  const btnCreate = document.getElementById("btnCreate");
  const btnJoin = document.getElementById("btnJoin");
  const errorBox = document.getElementById("errorBox");

  const roomCodePill = document.getElementById("roomCodePill");
  const roomConnPill = document.getElementById("roomConnPill");
  const youName = document.getElementById("youName");
  const playerList = document.getElementById("playerList");
  const btnStart = document.getElementById("btnStart");
  const btnLeave = document.getElementById("btnLeave");
  const errorBoxRoom = document.getElementById("errorBoxRoom");

  const hudTimer = document.getElementById("hudTimer");
  const hudScore = document.getElementById("hudScore");
  const hudInfo = document.getElementById("hudInfo");
  const hudLock = document.getElementById("hudLock");
  const errorBoxGame = document.getElementById("errorBoxGame");

  const gameFrame = document.getElementById("gameFrame");
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const toast = document.getElementById("toast");
  const endOverlay = document.getElementById("endOverlay");
  const endTitle = document.getElementById("endTitle");
  const endMeta = document.getElementById("endMeta");
  const btnPlayAgain = document.getElementById("btnPlayAgain");
  const btnBackRoom = document.getElementById("btnBackRoom");
  const btnPause = document.getElementById("btnPause");
  const pauseOverlay = document.getElementById("pauseOverlay");

  const btnAction = document.getElementById("btnAction");
  const joystick = document.getElementById("joystick");
  const joyKnob = document.getElementById("joyKnob");


  let myId = null;
  let myName = null;
  let roomCode = null;
  let gameState = null;
  let pendingRoomUpdate = null;
  let myIsHost = false;

  const MAP_W = 900, MAP_H = 520;
  // Keep in sync with server.js
  const OVEN_BAKE_TIME = 9.0;
  const OVEN_BURN_EXTRA = 8.0;
  const SINK_WASH_TIME = 5.0;
  const FOOD_WAIT_BASE = 60.0;

  function isCookedPizzaType(t) {
    return t === "PIZZA_PHOMAI" || t === "PIZZA_XUCXICH" || t === "PIZZA_XUCXICH_PHOMAI";
  }
  const keys = { up:false, down:false, left:false, right:false };
  let useJoystick = false;
  let joyActive = false;
  let joy = { x: 0, y: 0 };
  let joyCenter = { x: 0, y: 0 };
  let joyRadius = 34;

  function showScreen(which) {
    lobbyScreen.classList.add("hidden");
    roomScreen.classList.add("hidden");
    gameScreen.classList.add("hidden");
    if (which === "lobby") lobbyScreen.classList.remove("hidden");
    if (which === "room") roomScreen.classList.remove("hidden");
    if (which === "game") gameScreen.classList.remove("hidden");
  }

  function showError(box, msg) {
    box.style.display = "block";
    box.textContent = msg;
    setTimeout(() => {
      if (box.textContent === msg) box.style.display = "none";
    }, 3000);
  }

  function addToast(msg) {
    const el = document.createElement("div");
    el.className = "msg";
    el.textContent = msg;
    toast.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .25s ease"; }, 1600);
    setTimeout(() => el.remove(), 1900);
  }

  function emitAction() { socket.emit("action"); }

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function fitGameFrame() {
    if (gameScreen.classList.contains("hidden")) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 10;
    const availW = vw - margin * 2;
    const availH = vh - margin * 2;
    const scale = Math.min(availW / MAP_W, availH / MAP_H);

    const cssW = Math.floor(MAP_W * scale);
    const cssH = Math.floor(MAP_H * scale);

    gameFrame.style.width = cssW + "px";
    gameFrame.style.height = cssH + "px";
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }
  window.addEventListener("resize", fitGameFrame);
  window.addEventListener("orientationchange", () => setTimeout(fitGameFrame, 60));

  function pathRoundRect(x, y, w, h, r) {
    r = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }


  function drawRing(cx, cy, radius, progress, color, bg = "rgba(0,0,0,0.35)", thickness = 3) {
    const p = Math.max(0, Math.min(1, Number(progress || 0)));
    ctx.save();
    ctx.lineWidth = thickness;
    ctx.lineCap = "round";

    ctx.strokeStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = color;
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * p;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end);
    ctx.stroke();

    ctx.restore();
  }

  function drawItemIcon(type, x, y, size, meta=null) {
    const t = String(type || "").toUpperCase();
    ctx.save();
    ctx.translate(x, y);
    // make toppings easier to see (especially in customer order bubbles)
    const dot = Math.max(3.4, size * 0.30);
    const burnDot = Math.max(6, size * 0.42);

    if (t === "PIZZA_BASE") {
      ctx.fillStyle = "rgba(255, 224, 170, 0.92)";
      ctx.beginPath();
      ctx.moveTo(-size*0.7, size*0.55);
      ctx.lineTo(size*0.7, size*0.55);
      ctx.lineTo(0, -size*0.8);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,211,107,0.9)";
      ctx.lineWidth = Math.max(2, size*0.20);
      ctx.beginPath();
      ctx.moveTo(-size*0.7, size*0.55);
      ctx.lineTo(size*0.7, size*0.55);
      ctx.stroke();
    } else if (t === "RAW_PIZZA") {
      drawItemIcon("PIZZA_BASE", 0, 0, size);
      const cheese = !!meta?.cheese;
      const sausage = !!meta?.sausage;
      if (cheese) {
        ctx.fillStyle = "rgba(255,211,107,0.95)";
        ctx.beginPath(); ctx.arc(-size*0.12, -size*0.05, dot, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(size*0.15, size*0.12, dot, 0, Math.PI*2); ctx.fill();
      }
      if (sausage) {
        ctx.fillStyle = "rgba(255,160,180,0.95)";
        ctx.beginPath(); ctx.arc(size*0.14, -size*0.12, dot, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(-size*0.04, size*0.16, dot, 0, Math.PI*2); ctx.fill();
      }
    } else if (t === "CHEESE") {
      ctx.fillStyle = "rgba(255, 211, 107, 0.92)";
      ctx.beginPath();
      ctx.moveTo(-size*0.65, size*0.45);
      ctx.lineTo(size*0.55, size*0.45);
      ctx.lineTo(size*0.20, -size*0.55);
      ctx.closePath();
      ctx.fill();
    } else if (t === "SAUSAGE") {
      ctx.fillStyle = "rgba(255,160,180,0.92)";
      pathRoundRect(-size*0.7, -size*0.35, size*1.4, size*0.7, size*0.35);
      ctx.fill();
    } else if (t === "PLATE") {
      ctx.strokeStyle = "rgba(232,236,255,0.78)";
      ctx.lineWidth = Math.max(2, size*0.16);
      ctx.beginPath(); ctx.arc(0, 0, size*0.78, 0, Math.PI*2); ctx.stroke();
      ctx.strokeStyle = "rgba(232,236,255,0.35)";
      ctx.beginPath(); ctx.arc(0, 0, size*0.46, 0, Math.PI*2); ctx.stroke();
    } else if (t === "BURNT_PIZZA") {
      ctx.fillStyle = "rgba(120,80,60,0.92)";
      ctx.beginPath();
      ctx.moveTo(-size*0.7, size*0.55);
      ctx.lineTo(size*0.7, size*0.55);
      ctx.lineTo(0, -size*0.8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath(); ctx.arc(0, 0, burnDot, 0, Math.PI*2); ctx.fill();
      // big X mark
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = Math.max(2, size * 0.18);
      ctx.beginPath();
      ctx.moveTo(-size*0.38, -size*0.18);
      ctx.lineTo(size*0.38, size*0.22);
      ctx.moveTo(-size*0.38, size*0.22);
      ctx.lineTo(size*0.38, -size*0.18);
      ctx.stroke();
    } else if (t.startsWith("PIZZA_")) {
      drawItemIcon("PIZZA_BASE", 0, 0, size);
      if (t.includes("PHOMAI")) {
        ctx.fillStyle = "rgba(255,211,107,0.95)";
        ctx.beginPath(); ctx.arc(-size*0.12, -size*0.05, dot, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(size*0.15, size*0.12, dot, 0, Math.PI*2); ctx.fill();
      }
      if (t.includes("XUCXICH")) {
        ctx.fillStyle = "rgba(255,160,180,0.95)";
        ctx.beginPath(); ctx.arc(size*0.14, -size*0.12, dot, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(-size*0.04, size*0.16, dot, 0, Math.PI*2); ctx.fill();
      }
    } else {
      ctx.fillStyle = "rgba(232,236,255,0.9)";
      ctx.font = "9px system-ui";
      const s = t.slice(0, 4);
      ctx.fillText(s, -ctx.measureText(s).width/2, 3);
    }

    ctx.restore();
  }

  function sendInput() {
    if (!roomCode) return;
    if (!gameState || gameState.phase !== "playing") return;
    const payload = {
      up: keys.up,
      down: keys.down,
      left: keys.left,
      right: keys.right
    };

    // If joystick has been used, send analog axes.
    // (We still include booleans as a fallback for older servers.)
    if (useJoystick) {
      payload.ax = joy.x;
      payload.ay = joy.y;
      const th = 0.34;
      payload.up = payload.up || (joy.y < -th);
      payload.down = payload.down || (joy.y > th);
      payload.left = payload.left || (joy.x < -th);
      payload.right = payload.right || (joy.x > th);
    }

    socket.emit("input", payload);
  }
  setInterval(sendInput, 50);

  btnCreate.addEventListener("click", () => {
    const name = (nameInput.value || "").trim();
    if (!name) return showError(errorBox, "Nhập tên trước.");
    myName = name;
    socket.emit("createRoom", { name });
  });
  btnJoin.addEventListener("click", () => {
    const name = (nameInput.value || "").trim();
    if (!name) return showError(errorBox, "Nhập tên trước.");
    const code = (codeInput.value || "").trim();
    if (!code) return showError(errorBox, "Nhập roomCode.");
    myName = name;
    socket.emit("joinRoom", { name, code });
  });

  btnStart.addEventListener("click", () => socket.emit("startGame"));
  btnLeave.addEventListener("click", () => {
    socket.emit("leaveRoom");
    roomCode = null;
    gameState = null;
    pendingRoomUpdate = null;
    endOverlay.classList.add("hidden");
    showScreen("lobby");
  });

  btnPlayAgain.addEventListener("click", () => {
    socket.emit("restart", { mode: "again" });
    endOverlay.classList.add("hidden");
  });
  btnBackRoom.addEventListener("click", () => {
    socket.emit("restart", { mode: "lobby" });
    endOverlay.classList.add("hidden");
  });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === "w" || e.key === "ArrowUp") keys.up = true;
    if (k === "s" || e.key === "ArrowDown") keys.down = true;
    if (k === "a" || e.key === "ArrowLeft") keys.left = true;
    if (k === "d" || e.key === "ArrowRight") keys.right = true;

    if (k === "e" || e.key === " ") { emitAction(); e.preventDefault(); }
    if (k === "p" || e.key === "Escape") { socket.emit("togglePause"); }
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (k === "w" || e.key === "ArrowUp") keys.up = false;
    if (k === "s" || e.key === "ArrowDown") keys.down = false;
    if (k === "a" || e.key === "ArrowLeft") keys.left = false;
    if (k === "d" || e.key === "ArrowRight") keys.right = false;
  });

  function setupTap(el, onFire) {
    if (!el) return;
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); onFire(); });
    el.addEventListener("click", (e) => { e.preventDefault(); onFire(); });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  setupTap(btnAction, emitAction);
  // Pause toggling must not double-fire on pointerdown+click.
  let lastPauseTapAt = 0;
  setupTap(btnPause, () => {
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (now - lastPauseTapAt < 250) return;
    lastPauseTapAt = now;
    socket.emit("togglePause");
  });

  // --- Mobile joystick (virtual stick) ---
  function setJoyFromPointer(clientX, clientY) {
    const dx0 = clientX - joyCenter.x;
    const dy0 = clientY - joyCenter.y;
    const mag = Math.hypot(dx0, dy0);
    const r = Math.max(18, joyRadius);
    const clamped = mag > r ? r / mag : 1;
    const dx = dx0 * clamped;
    const dy = dy0 * clamped;

    joy.x = Math.max(-1, Math.min(1, dx / r));
    joy.y = Math.max(-1, Math.min(1, dy / r));

    if (joyKnob) joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function resetJoy() {
    joyActive = false;
    joy.x = 0; joy.y = 0;
    if (joyKnob) joyKnob.style.transform = "translate(0px, 0px)";
  }

  if (joystick) {
    joystick.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      useJoystick = true;
      joyActive = true;
      joystick.setPointerCapture(e.pointerId);
      const r = joystick.getBoundingClientRect();
      joyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      joyRadius = Math.min(r.width, r.height) * 0.34;
      setJoyFromPointer(e.clientX, e.clientY);
    });

    joystick.addEventListener("pointermove", (e) => {
      if (!joyActive) return;
      e.preventDefault();
      setJoyFromPointer(e.clientX, e.clientY);
    });

    joystick.addEventListener("pointerup", (e) => { e.preventDefault(); resetJoy(); });
    joystick.addEventListener("pointercancel", () => resetJoy());
    joystick.addEventListener("pointerleave", () => { if (joyActive) resetJoy(); });
  }

  socket.on("connect", () => {
    myId = socket.id;
    connPill.textContent = "Online";
    connPill.style.color = "var(--accent)";
    roomConnPill.textContent = "Online";
    roomConnPill.style.color = "var(--accent)";
  });
  socket.on("disconnect", () => {
    connPill.textContent = "Offline";
    connPill.style.color = "var(--danger)";
    roomConnPill.textContent = "Offline";
    roomConnPill.style.color = "var(--danger)";
  });

  socket.on("errorMsg", (msg) => {
    if (!roomCode) showError(errorBox, msg);
    else if (!gameScreen.classList.contains("hidden")) showError(errorBoxGame, msg);
    else showError(errorBoxRoom, msg);
  });

  function applyRoomUpdate(payload) {
    roomCodePill.textContent = payload.code;
    youName.textContent = myName || "—";

    myIsHost = payload.hostId === myId;
    btnStart.disabled = !myIsHost;
    btnStart.textContent = myIsHost ? "Start (Host)" : "Start (Host only)";
    // Only host can see End buttons + pause
    btnPlayAgain.classList.toggle("hidden", !myIsHost);
    btnBackRoom.classList.toggle("hidden", !myIsHost);
    if (btnPause) btnPause.classList.toggle("hidden", !myIsHost);

    playerList.innerHTML = "";
    for (const p of payload.players) {
      const row = document.createElement("div");
      row.className = "player";

      const left = document.createElement("div");
      left.textContent = p.name + (p.id === myId ? " (You)" : "");

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";
      right.style.alignItems = "center";

      if (!p.connected) {
        const b = document.createElement("span");
        b.className = "badge off";
        b.textContent = "OFF";
        right.appendChild(b);
      }

      const b2 = document.createElement("span");
      if (p.id === payload.hostId) { b2.className = "badge host"; b2.textContent = "HOST"; }
      else { b2.className = "badge"; b2.textContent = "PLAYER"; }
      right.appendChild(b2);

      row.appendChild(left);
      row.appendChild(right);
      playerList.appendChild(row);
    }

    if (payload.phase === "lobby") showScreen("room");
    else {
      showScreen("game");
      hudInfo.textContent = `Room ${payload.code}`;
      hudLock.textContent = payload.lockedCount ? `Lock: ${payload.lockedCount}` : "Lock: —";
      fitGameFrame();
    }
  }

  socket.on("joined", ({ code }) => {
    roomCode = code;
    roomCodePill.textContent = code;
    youName.textContent = myName || "—";
    showScreen("room");
    if (pendingRoomUpdate && pendingRoomUpdate.code === roomCode) {
      applyRoomUpdate(pendingRoomUpdate);
      pendingRoomUpdate = null;
    }
  });

  socket.on("roomUpdate", (payload) => {
    if (!roomCode) { pendingRoomUpdate = payload; return; }
    if (payload.code !== roomCode) return;
    applyRoomUpdate(payload);
  });

  socket.on("note", ({ text }) => addToast(text));

  socket.on("ended", (info) => {
    const win = !!info.win;
    endTitle.textContent = win ? "🎉 WIN!" : "💀 LOSE!";
    endMeta.textContent = `Gold: ${info.score} / ${info.target}` + (info.reason ? ` • ${info.reason}` : "");
    btnPlayAgain.classList.toggle("hidden", !myIsHost);
    btnBackRoom.classList.toggle("hidden", !myIsHost);
    endOverlay.classList.remove("hidden");
  });

  socket.on("state", (snap) => {
    gameState = snap;
    const paused = !!gameState?.game?.paused;
    if (pauseOverlay) pauseOverlay.classList.toggle("hidden", !paused);
    if (btnPause) btnPause.textContent = paused ? "▶️" : "⏸";
    if (!gameScreen.classList.contains("hidden")) fitGameFrame();
  });

  function drawCenterSlots(s) {
    // match server-ish spacing
    const cols = 3, rows = 2;
    const marginX = 6, marginY = 6;
    const cellW = (s.w - marginX * 2) / cols;
    const cellH = (s.h - marginY * 2) / rows;

    ctx.strokeStyle = "rgba(232,236,255,0.18)";
    ctx.lineWidth = 2;

    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = s.x + marginX + cellW * (c + 0.5);
        const cy = s.y + marginY + cellH * (r + 0.5);
        pathRoundRect(cx - 15, cy - 15, 30, 30, 7);
        ctx.stroke();

        // slot index tiny
        ctx.fillStyle = "rgba(232,236,255,0.20)";
        ctx.font = "10px system-ui";
        ctx.fillText(String(idx + 1), cx - 3, cy + 4);
        idx++;
      }
    }
  }

  function drawPlateStackSlots(s) {
    const cols = Math.max(1, Number(s.slotCount || 3));
    const rows = 1;
    const marginX = 8, marginY = 16;
    const cellW = (s.w - marginX * 2) / cols;
    const cellH = (s.h - marginY * 2) / rows;

    ctx.strokeStyle = "rgba(232,236,255,0.18)";
    ctx.lineWidth = 2;

    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = s.x + marginX + cellW * (c + 0.5);
        const cy = s.y + marginY + cellH * (r + 0.5);
        pathRoundRect(cx - 15, cy - 15, 30, 30, 7);
        ctx.stroke();

        ctx.fillStyle = "rgba(232,236,255,0.20)";
        ctx.font = "10px system-ui";
        ctx.fillText(String(idx + 1), cx - 3, cy + 4);
        idx++;
      }
    }
  }

  function twoSlotCenters(s) {
    // match server computeTwoSlotCenters()
    const cols = 2;
    const marginX = 6;
    const cellW = (s.w - marginX * 2) / cols;
    const cy = s.y + s.h / 2;
    const pts = [];
    for (let c = 0; c < cols; c++) {
      pts.push({
        x: s.x + marginX + cellW * (c + 0.5),
        y: cy
      });
    }
    return pts;
  }

  function drawTwoSlots(s) {
    const pts = twoSlotCenters(s);
    ctx.strokeStyle = "rgba(232,236,255,0.18)";
    ctx.lineWidth = 2;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      pathRoundRect(p.x - 15, p.y - 15, 30, 30, 7);
      ctx.stroke();
      ctx.fillStyle = "rgba(232,236,255,0.20)";
      ctx.font = "10px system-ui";
      ctx.fillText(String(i + 1), p.x - 3, p.y + 4);
    }
    return pts;
  }

  function draw() {
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!gameState) return;

    if (gameState.game) {
      hudTimer.textContent = "⏱ " + fmtTime(gameState.game.timeLeft || 0);
      hudScore.textContent = `🪙 ${gameState.game.score || 0} / ${gameState.game.target || 0}`;
    }

    if (gameState.map?.walls) {
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      for (const w of gameState.map.walls) ctx.fillRect(w.x, w.y, w.w, w.h);
    }

    if (gameState.entrance) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(gameState.entrance.x - 26, gameState.entrance.y - 18, 52, 36);
      ctx.fillStyle = "rgba(232,236,255,0.8)";
      ctx.font = "11px system-ui";
      ctx.fillText("DOOR", gameState.entrance.x - 16, gameState.entrance.y + 4);
    }

    for (const tb of (gameState.tables || [])) {
      // Round table with 3 chairs (server provides cx/cy/r + seats[])
      if (typeof tb.cx === "number" && typeof tb.cy === "number" && typeof tb.r === "number") {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.beginPath();
        ctx.arc(tb.cx, tb.cy, tb.r, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(tb.cx, tb.cy, tb.r, 0, Math.PI * 2);
        ctx.stroke();

        // Chairs
        const seats = tb.seats || [];
        for (const s of seats) {
          if (typeof s.chairX !== "number" || typeof s.chairY !== "number") continue;
          ctx.fillStyle = "rgba(255,255,255,0.05)";
          ctx.beginPath();
          ctx.arc(s.chairX, s.chairY, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.10)";
          ctx.beginPath();
          ctx.arc(s.chairX, s.chairY, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        // fallback rectangle
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(tb.x, tb.y, tb.w, tb.h);
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.strokeRect(tb.x, tb.y, tb.w, tb.h);
      }
    }

    for (const s of (gameState.stations || [])) {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      // Keep UI clean: only show TRASH label
      if (s.id === "TRASH") {
        ctx.fillStyle = "rgba(232,236,255,0.82)";
        ctx.font = "12px system-ui";
        ctx.fillText("TRASH", s.x + 8, s.y + 18);
      }

      if (s.type === "BIN" && s.gives) {
        drawItemIcon(s.gives, s.x + s.w - 18, s.y + 20, 12);
      }

      let slotPts = null;
      if (s.id === "CENTER") drawCenterSlots(s);
      if (s.type === "PLATE") drawPlateStackSlots(s);
      if (s.id === "OVEN") slotPts = drawTwoSlots(s);
      if (s.id === "SINK") slotPts = drawTwoSlots(s);

      // OVEN bars: GREEN for baking -> cooked, RED for cooked -> burnt
      if (s.type === "OVEN" && Array.isArray(s.slotTs)) {
        const pts = slotPts || twoSlotCenters(s);
        for (let i = 0; i < pts.length; i++) {
          if (!s.slots || !s.slots[i]) continue;
          const t = Number(s.slotTs[i] || 0);
          let p = 0;
          let fill = "rgba(90,220,130,0.75)"; // green
          if (t < OVEN_BAKE_TIME) {
            p = Math.min(1, Math.max(0, t / OVEN_BAKE_TIME));
          } else {
            fill = "rgba(255,110,110,0.75)"; // red
            p = Math.min(1, Math.max(0, (t - OVEN_BAKE_TIME) / OVEN_BURN_EXTRA));
          }
          const cx = pts[i].x;
          const cy = pts[i].y + 23;
          drawRing(cx, cy, 9, p, fill, "rgba(0,0,0,0.35)", 3);
        }
      }

      // SINK bars: per-slot wash progress
      if (s.type === "SINK" && Array.isArray(s.slotTs) && Array.isArray(s.slotActives)) {
        const pts = slotPts || twoSlotCenters(s);
        for (let i = 0; i < pts.length; i++) {
          if (!s.slotActives[i]) continue;
          const p = Math.min(1, Math.max(0, (s.slotTs[i] || 0) / SINK_WASH_TIME));
          const cx = pts[i].x;
          const cy = pts[i].y + 23;
          drawRing(cx, cy, 9, p, "rgba(120,180,255,0.75)", "rgba(0,0,0,0.35)", 3);
        }
      }
    }

    // customers + bubble order
    for (const c of (gameState.customers || [])) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.globalAlpha = c.state === "leaving" ? 0.7 : 1;

      ctx.fillStyle = "rgba(255,255,255,0.10)";
      pathRoundRect(-10, -2, 20, 18, 6);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.beginPath(); ctx.arc(0, -12, 9, 0, Math.PI * 2); ctx.fill();

      const showGreet = (c.state === "await_order") && (typeof c.greetLeft === "number") && (typeof c.greetTotal === "number");
      const showWait = (c.state === "waiting_food") && !!c.dishType && (typeof c.patienceLeft === "number") && (typeof c.patienceTotal === "number");

      if (showGreet || showWait) {
        ctx.save();
        ctx.translate(0, -48);

        // Order bubble (smaller)
        ctx.fillStyle = "rgba(0,0,0,0.50)";
        pathRoundRect(-32, -22, 64, 44, 11);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.stroke();

        if (showWait) {
          drawItemIcon(c.dishType, 0, -3, 18);

          // label under icon (C / S / CS)
          const dt = String(c.dishType || "").toUpperCase();
          let lbl = "";
          const hasC = dt.includes("PHOMAI") || dt.includes("CHEESE");
          const hasS = dt.includes("XUCXICH") || dt.includes("SAUSAGE");
          if (hasC && hasS) lbl = "CS";
          else if (hasC) lbl = "C";
          else if (hasS) lbl = "S";
          ctx.fillStyle = "rgba(232,236,255,0.80)";
          ctx.font = "10px system-ui";
          ctx.fillText(lbl, -ctx.measureText(lbl).width / 2, 14);

          // patience countdown (circular)
// Fill amount is scaled against FOOD_WAIT_BASE (60s) so shorter waits start with a smaller ring.
const total = Math.max(1, Number(c.patienceTotal || 1));
const left = Math.max(0, Number(c.patienceLeft || 0));
const q = Math.max(0, Math.min(1, left / total));           // for green->red threshold
const p = Math.max(0, Math.min(1, left / FOOD_WAIT_BASE));  // for ring fill amount
const fillWait = (q < 0.5) ? "rgba(255,110,110,0.85)" : "rgba(90,220,130,0.85)";
drawRing(0, 20, 10, p, fillWait, "rgba(0,0,0,0.40)", 3);

// seconds number inside the waiting ring (numbers only)
const sec = String(Math.ceil(left));
ctx.fillStyle = "rgba(255,255,255,0.90)";
ctx.font = "10px system-ui";
ctx.fillText(sec, -ctx.measureText(sec).width / 2, 24);
        } else {
          // awaiting order: show dish if already taken, otherwise "?"
          if (c.dishType) {
            drawItemIcon(c.dishType, 0, -3, 18);

            const dt = String(c.dishType || "").toUpperCase();
            let lbl = "";
            const hasC = dt.includes("PHOMAI") || dt.includes("CHEESE");
            const hasS = dt.includes("XUCXICH") || dt.includes("SAUSAGE");
            if (hasC && hasS) lbl = "CS";
            else if (hasC) lbl = "C";
            else if (hasS) lbl = "S";
            ctx.fillStyle = "rgba(232,236,255,0.80)";
            ctx.font = "10px system-ui";
            ctx.fillText(lbl, -ctx.measureText(lbl).width / 2, 14);
          } else {
            ctx.fillStyle = "rgba(232,236,255,0.85)";
            ctx.font = "16px system-ui";
            ctx.fillText("?", -ctx.measureText("?").width / 2, 6);
          }

          const total = Math.max(1, Number(c.greetTotal || 1));
          const left = Math.max(0, Number(c.greetLeft || 0));
          const p = Math.max(0, Math.min(1, left / total));
          drawRing(0, 20, 10, p, "rgba(120,180,255,0.80)", "rgba(0,0,0,0.40)", 3);
        }

        ctx.restore();
      }

      // Waiting for order (needs greeting at door)
      if (c.state === "waiting_order") {
        ctx.save();
        ctx.translate(0, -50);

        ctx.fillStyle = "rgba(0,0,0,0.50)";
        pathRoundRect(-30, -22, 60, 44, 11);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.stroke();

        ctx.fillStyle = "rgba(255,230,160,0.95)";
        ctx.font = "10px system-ui";
        const txt = "ORDER";
        ctx.fillText(txt, -ctx.measureText(txt).width / 2, -8);

        const total = Math.max(1, Number(c.greetTotal || 20));
        const left = Math.max(0, Number(c.greetLeft || 0));
        const p = Math.max(0, Math.min(1, left / total));
        drawRing(0, 12, 10, p, "rgba(255,210,120,0.85)", "rgba(0,0,0,0.40)", 3);

        ctx.fillStyle = "rgba(232,236,255,0.78)";
        ctx.font = "10px system-ui";
        const sec = Math.ceil(left);
        ctx.fillText(sec + "s", -10, 30);

        ctx.restore();
      }

      ctx.restore();
    }

    // items
    for (const it of (gameState.items || [])) {
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.stroke();

      if (it.type === "PLATE") {
        drawItemIcon("PLATE", 0, 0, 14);

        if (it.tray && it.tray.stage) {
          const st = it.tray.stage;
          const meta = it.tray.meta || null;
          if (st === "RAW_PIZZA") drawItemIcon("RAW_PIZZA", 0, 0, 14, meta);
          else drawItemIcon("PIZZA_BASE", 0, 0, 14, meta);
        }

        if (it.completed && it.dishType) drawItemIcon(it.dishType, 0, 0, 14);


        if (it.dirty) {
          ctx.fillStyle = "rgba(255,160,160,0.92)";
          ctx.font = "10px system-ui";
          ctx.fillText("DIRTY", -18, 26);
        }
      } else if (it.type === "RAW_PIZZA") {
        drawItemIcon("RAW_PIZZA", 0, 0, 15, it.meta || null);
      } else {
        drawItemIcon(it.type, 0, 0, 15, it.meta || null);
      }

      ctx.restore();
    }

    // players
    for (const p of (gameState.players || [])) {
      ctx.save();
      ctx.translate(p.x, p.y);

      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.fillStyle = p.connected ? "rgba(124,243,200,0.22)" : "rgba(255,255,255,0.08)";
      ctx.fill();
      ctx.strokeStyle = p.id === myId ? "rgba(124,243,200,0.85)" : "rgba(255,255,255,0.18)";
      ctx.stroke();

      ctx.fillStyle = "rgba(232,236,255,0.9)";
      ctx.font = "12px system-ui";
      const nm = p.name + (p.connected ? "" : " (OFF)");
      ctx.fillText(nm, -ctx.measureText(nm).width/2, -28);

      if (p.heldType) {
        ctx.save();
        ctx.translate(0, -46);
        ctx.fillStyle = "rgba(0,0,0,0.30)";
        ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI*2); ctx.fill();

        if (p.heldType === "PLATE" && p.heldPlate) {
          drawItemIcon("PLATE", 0, 0, 16);

          if (p.heldPlate.tray && p.heldPlate.tray.stage) {
            const st = p.heldPlate.tray.stage;
            const meta = p.heldPlate.tray.meta || null;
            if (st === "RAW_PIZZA") drawItemIcon("RAW_PIZZA", 0, 0, 14, meta);
            else drawItemIcon("PIZZA_BASE", 0, 0, 14, meta);
          }
          if (p.heldPlate.completed && p.heldPlate.dishType) drawItemIcon(p.heldPlate.dishType, 0, 0, 14);


          if (p.heldPlate.dirty) {
            ctx.fillStyle = "rgba(255,160,160,0.92)";
            ctx.font = "10px system-ui";
            ctx.fillText("DIRTY", -18, 26);
          }
        } else if (p.heldType === "RAW_PIZZA") {
          drawItemIcon("RAW_PIZZA", 0, 0, 16, p.heldMeta || null);
        } else {
          drawItemIcon(p.heldType, 0, 0, 16, p.heldMeta || null);
        }
        ctx.restore();
      }

      ctx.restore();
    }
  }

  requestAnimationFrame(draw);
  showScreen("lobby");
})();
