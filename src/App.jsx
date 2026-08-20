import { useState, useEffect, useRef, useCallback } from "react";

// ── API CONFIG ─────────────────────────────────────────────────────────────
// Questions now come from the CricketIQ API instead of being bundled here.
// Point this at wherever the API is running (see cricketiq-api/README.md).
const API_BASE_URL = "https://api.cricketiq.club";

// ── FIREBASE CONFIG (Google Sign-In) ────────────────────────────────────────
// Replace every value below with your own project's config, from:
// Firebase Console → Project Settings → General → Your apps → SDK setup and
// configuration. These values are safe to be public in client code — Firebase
// security relies on Security Rules, not on hiding this config.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, runTransaction, serverTimestamp, deleteField } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC2yyapAkZmri4JXHiLU2kFWsMYB8dUHoM",
  authDomain: "cricketiq-2bca5.firebaseapp.com",
  projectId: "cricketiq-2bca5",
  storageBucket: "cricketiq-2bca5.firebasestorage.app",
  messagingSenderId: "806707387268",
  appId: "1:806707387268:web:689b4f3f13b187e7789bd1",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
const db = getFirestore(firebaseApp);

// ── MULTIPLAYER ROOMS ────────────────────────────────────────────────────────
// Room state lives in Firestore, one document per room at rooms/{code}.
// MAX_ROOM_PLAYERS includes the host — a 5-player room is the host + 4 joiners.
const MAX_ROOM_PLAYERS = 5;
const ROOM_QUESTION_COUNT = 25;

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, always
}

function getOrCreateLocalPlayerId() {
  // A stable per-device identity for room participation, independent of
  // Google sign-in — lets anonymous players join rooms without a sign-in
  // gate, while still being distinguishable from other players in the room.
  try {
    let id = localStorage.getItem("cricketiq_player_id");
    if (!id) {
      id = "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem("cricketiq_player_id", id);
    }
    return id;
  } catch {
    return "p_" + Math.random().toString(36).slice(2, 10); // private browsing fallback, non-persistent
  }
}

// Creates a new room, retrying on the astronomically rare chance of a code
// collision. Returns the created room's code.
async function createRoom({ playerId, playerName }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode();
    const roomRef = doc(db, "rooms", code);
    const existing = await getDoc(roomRef);
    if (existing.exists()) continue; // extremely unlikely, but retry with a new code
    await setDoc(roomRef, {
      code,
      hostId: playerId,
      status: "waiting",
      createdAt: serverTimestamp(),
      questionIds: [],
      currentQuestionIndex: 0,
      players: {
        [playerId]: { name: playerName, isHost: true, score: 0, joinedAt: serverTimestamp() },
      },
    });
    return code;
  }
  throw new Error("Couldn't create a room right now — try again.");
}

// Joins an existing room by code. Uses a transaction so two people racing to
// take the last open slot can't both succeed and overfill the room.
async function joinRoom({ code, playerId, playerName }) {
  const roomRef = doc(db, "rooms", code);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("That room code doesn't exist. Check it and try again.");
    const room = snap.data();
    if (room.status !== "waiting") throw new Error("That room's match has already started.");
    const players = room.players || {};
    if (players[playerId]) return room; // already in this room (e.g., reconnecting) — fine
    if (Object.keys(players).length >= MAX_ROOM_PLAYERS) {
      throw new Error("That room is full (5 players max).");
    }
    tx.update(roomRef, {
      [`players.${playerId}`]: { name: playerName, isHost: false, score: 0, joinedAt: serverTimestamp() },
    });
    return { ...room, players: { ...players, [playerId]: { name: playerName, isHost: false, score: 0 } } };
  });
}

function leaveRoom({ code, playerId }) {
  const roomRef = doc(db, "rooms", code);
  return updateDoc(roomRef, { [`players.${playerId}`]: deleteField() }).catch(() => {});
  // Failure here (e.g., room already deleted) is fine to ignore — leaving is best-effort.
}

const ROOM_TIMER_SECONDS = 20; // matches solo mode's per-question timer

// Fetches the shared question set (once, from the host's device) and writes
// it into the room so every player reads the exact same 25 questions in the
// exact same order — clients never fetch their own independent set.
async function startRoomGame({ code }) {
  const res = await fetch(`${API_BASE_URL}/api/questions/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: ROOM_QUESTION_COUNT }),
  });
  if (!res.ok) throw new Error("Couldn't load questions for the room.");
  const data = await res.json();
  const questions = (data.questions || []).slice(0, ROOM_QUESTION_COUNT);
  if (questions.length === 0) throw new Error("Couldn't load questions for the room.");

  const roomRef = doc(db, "rooms", code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) throw new Error("This room no longer exists.");
  const room = snap.data();

  const resetFields = {
    status: "playing",
    questions,
    currentQuestionIndex: 0,
    questionStartedAt: Date.now(),
  };
  Object.keys(room.players || {}).forEach((pid) => {
    resetFields[`players.${pid}.score`] = 0;
    resetFields[`players.${pid}.wrongCount`] = 0;
    resetFields[`players.${pid}.lastAnsweredIndex`] = -1;
  });
  await updateDoc(roomRef, resetFields);
}

// Host-only: advances the room to the next question, or marks it finished if
// that was the last one. Uses a transaction guarded on the expected current
// index, so if two triggers fire close together (everyone-answered AND the
// timer expiring, say), only the first one actually does anything — the
// second sees the index no longer matches and safely no-ops.
async function advanceRoomQuestion({ code, expectedIndex, totalQuestions }) {
  const roomRef = doc(db, "rooms", code);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) return;
    const room = snap.data();
    if (room.currentQuestionIndex !== expectedIndex) return; // someone else already advanced it
    const nextIndex = expectedIndex + 1;
    if (nextIndex >= totalQuestions) {
      tx.update(roomRef, { status: "finished" });
    } else {
      tx.update(roomRef, { currentQuestionIndex: nextIndex, questionStartedAt: Date.now() });
    }
  });
}

// ── ADSENSE CONFIG ───────────────────────────────────────────────────────────
// Replace with your real publisher ID once AdSense approves your site
// (AdSense dashboard → Account → Account information). Create ad units there
// too, and replace the two slot IDs below with the real ones for each unit.
// Everything ad-related stays completely inactive — no ad calls, no empty ad
// boxes — until you replace this placeholder, so this is safe to ship now.
const ADSENSE_CLIENT_ID = "ca-pub-XXXXXXXXXXXXXXXX";
const ADSENSE_ENABLED = ADSENSE_CLIENT_ID !== "ca-pub-XXXXXXXXXXXXXXXX";
const AD_SLOT_HOME = "XXXXXXXXXX";   // ad unit slot ID for the home screen strip
const AD_SLOT_RESULT = "XXXXXXXXXX"; // ad unit slot ID for the results screen strip

// Reusable display-ad "strip" — renders nothing at all until ADSENSE_ENABLED
// is true, so there's no empty/broken-looking ad box before you're approved.
function AdStrip({ slot }) {
  const pushedRef = useRef(false);
  useEffect(() => {
    if (!ADSENSE_ENABLED || pushedRef.current) return;
    try {
      pushedRef.current = true;
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.error("AdSense push failed:", e);
    }
  }, []);

  if (!ADSENSE_ENABLED) return null;

  return (
    <ins className="adsbygoogle"
      style={{ display: "block", width: "100%", minHeight: 90 }}
      data-ad-client={ADSENSE_CLIENT_ID}
      data-ad-slot={slot}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
}

// Shuffle options PER question at runtime so correct answer is random position
function prepareQuestion(q) {
  const shuffled = [...q.opts].sort(() => Math.random() - 0.5);
  return { ...q, shuffledOpts: shuffled, correctIdx: shuffled.indexOf(q.ans) };
}

const CAT_META = {
  "Rules & Format":        { color:"#60a5fa", icon:"🏏" },
  "Records & Stats":       { color:"#ef4444", icon:"📊" },
  "World Cup - ODI":       { color:"#34d399", icon:"🏆" },
  "World Cup - T20":       { color:"#a78bfa", icon:"🚀" },
  "IPL":                   { color:"#ec4899", icon:"💎" },
  "Teams & History":       { color:"#fbbf24", icon:"📜" },
  "Grounds & Trivia":      { color:"#38bdf8", icon:"🏟" },
  "Legends & Players":     { color:"#f59e0b", icon:"👑" },
  "Women's Cricket":       { color:"#fb7185", icon:"⭐" },
  "Domestic Cricket":      { color:"#22d3ee", icon:"🏛" },
  "Captains & Leadership": { color:"#facc15", icon:"🎖" },
  "Bowling Styles":        { color:"#c084fc", icon:"🎯" },
  "Rivalries & Trophies":  { color:"#f97316", icon:"🔥" },
  "Cricket Terminology":   { color:"#60a5fa", icon:"📖" },
};

const shuffle = a => [...a].sort(() => Math.random() - 0.5);
const MAX_WRONG = 3;

// ── PARTICLE SYSTEM ──────────────────────────────────────────────────────────
function Particles({ trigger, color }) {
  const [particles, setParticles] = useState([]);
  useEffect(() => {
    if (!trigger) return;
    const p = Array.from({ length: 18 }, (_, i) => ({
      id: Date.now() + i, x: 50 + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 8, vy: -(Math.random() * 6 + 3),
      size: Math.random() * 8 + 4, color,
      shape: ["●","★","✦","◆"][Math.floor(Math.random()*4)]
    }));
    setParticles(p);
    const t = setTimeout(() => setParticles([]), 1200);
    return () => clearTimeout(t);
  }, [trigger]);
  return (
    <div style={{ position:"absolute", inset:0, pointerEvents:"none", overflow:"hidden", zIndex:50 }}>
      {particles.map(p => (
        <div key={p.id} style={{
          position:"absolute", left:`${p.x}%`, top:"50%",
          fontSize: p.size, color: p.color,
          animation:`particleFly 1.2s forwards`,
          "--vx": `${p.vx * 20}px`, "--vy": `${p.vy * 20}px`,
        }}>{p.shape}</div>
      ))}
    </div>
  );
}

// ── RIPPLE BUTTON ─────────────────────────────────────────────────────────────
function RippleBtn({ children, onClick, className, disabled, style }) {
  const ref = useRef();
  const handleClick = (e) => {
    if (disabled) return;
    const btn = ref.current;
    const r = btn.getBoundingClientRect();
    const size = Math.min(Math.max(r.width, r.height) * 2, 220);
    const ripple = document.createElement("span");
    ripple.style.cssText = `position:absolute;border-radius:50%;background:rgba(255,255,255,0.25);
      width:${size}px;height:${size}px;
      left:${e.clientX-r.left-size/2}px;
      top:${e.clientY-r.top-size/2}px;
      animation:rippleAnim 0.6s linear forwards;pointer-events:none;`;
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
    onClick && onClick(e);
  };
  return (
    <button ref={ref} onClick={handleClick} className={className} disabled={disabled} style={{ position:"relative", overflow:"hidden", ...style }}>
      {children}
    </button>
  );
}

// ── CIRCULAR TIMER ────────────────────────────────────────────────────────────
function CircularTimer({ total=20, onExpire }) {
  const [t, setT] = useState(total);
  const ref = useRef();
  useEffect(() => {
    setT(total);
    ref.current = setInterval(() => {
      setT(prev => {
        if (prev <= 1) { clearInterval(ref.current); onExpire && onExpire(); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(ref.current);
  }, [total]);
  const pct = t / total;
  const r = 24, circ = 2 * Math.PI * r;
  const color = t > 10 ? "#34d399" : t > 5 ? "#fbbf24" : "#ef4444";
  return (
    <div style={{ position:"relative", width:64, height:64, flexShrink:0 }}>
      <svg width="64" height="64" style={{ transform:"rotate(-90deg)" }}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="#1e293b" strokeWidth="4" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="4"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
          style={{ transition:"stroke-dashoffset 0.9s linear, stroke 0.5s" }} />
      </svg>
      <span style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center",
        fontFamily:"'Bebas Neue', sans-serif", fontSize:22, color, lineHeight:1 }}>{t}</span>
    </div>
  );
}

// ── SCORE POP ─────────────────────────────────────────────────────────────────
function ScorePop({ value, visible }) {
  return visible ? (
    <div style={{ position:"absolute", top:"-20px", right:"10px", fontFamily:"'Bebas Neue', sans-serif",
      fontSize:22, color:"#34d399", animation:"scorePop 0.8s forwards", pointerEvents:"none", zIndex:60 }}>
      +{value}
    </div>
  ) : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOME SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// PLAY MODE MODAL — shown the instant "Play now" is tapped
// ═══════════════════════════════════════════════════════════════════════════════
function PlayModeModal({ onPlayOffline, onPlayRoom, onClose }) {
  return (
    <div className="pm-overlay" onClick={onClose}>
      <div className="pm-modal" onClick={e => e.stopPropagation()}>
        <div className="pm-title">CHOOSE YOUR MATCH</div>
        <RippleBtn className="pm-card pm-card-offline" onClick={onPlayOffline}>
          <span className="pm-card-icon">🏏</span>
          <span className="pm-card-text">
            <span className="pm-card-heading pm-heading-offline">PLAY OFFLINE</span>
            <span className="pm-card-sub">Quick solo round, right now</span>
          </span>
        </RippleBtn>
        <RippleBtn className="pm-card pm-card-room" onClick={onPlayRoom}>
          <span className="pm-card-icon">👥</span>
          <span className="pm-card-text">
            <span className="pm-card-heading pm-heading-room">CREATE OR JOIN ROOM</span>
            <span className="pm-card-sub">Compete live with up to 5 friends</span>
          </span>
        </RippleBtn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM SCREEN — create/join, then the live lobby while players gather
// ═══════════════════════════════════════════════════════════════════════════════
function RoomScreen({ user, onExit, onGameStart, onRequestStart }) {
  const [phase, setPhase] = useState("create-join"); // create-join | lobby
  const [tab, setTab] = useState("create"); // create | join
  const [joinCode, setJoinCode] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [room, setRoom] = useState(null); // live room doc, once created/joined
  const [roomCode, setRoomCode] = useState(null);

  const playerId = useRef(getOrCreateLocalPlayerId()).current;
  const playerName = user?.displayName || nameInput.trim();

  // Live room updates once we're in a room. Every client — host and joiners
  // alike — watches room.status here and navigates to the quiz screen the
  // moment it flips to "playing". This was the actual bug: previously only
  // the host's own button click triggered navigation directly, so joiners'
  // screens had no mechanism to react to the game starting at all, even
  // though the underlying room data was updating correctly for everyone.
  useEffect(() => {
    if (!roomCode) return;
    const roomRef = doc(db, "rooms", roomCode);
    const unsub = onSnapshot(
      roomRef,
      (snap) => {
        if (!snap.exists()) { setError("This room no longer exists."); setPhase("create-join"); setRoomCode(null); return; }
        const data = snap.data();
        console.log("Room snapshot — players now:", Object.entries(data.players || {}).map(([id, p]) => `${p.name} (${id.slice(0,8)})`));
        setRoom(data);
        if (data.status === "playing") {
          onGameStart?.(roomCode);
        }
      },
      (err) => {
        console.error("Room listener error:", err);
        setError("Lost connection to the room. Try leaving and rejoining.");
      }
    );
    return unsub;
  }, [roomCode]);

  // Defensive catch-up: iOS Safari (and mobile browsers generally) can
  // suspend a backgrounded tab's real-time connection to save battery —
  // e.g. exactly the case where you create a room on your phone, then
  // switch away to open it on another device to join. The write from the
  // other device succeeds either way, but the backgrounded tab's listener
  // may not hear about it until something wakes it back up. Rather than
  // relying purely on that connection to self-heal, force a fresh read the
  // moment this tab becomes visible again.
  useEffect(() => {
    if (!roomCode) return;
    const handleVisible = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const snap = await getDoc(doc(db, "rooms", roomCode));
        if (snap.exists()) {
          console.log("Tab became visible — re-synced room state");
          setRoom(snap.data());
        }
      } catch (err) {
        console.error("Visibility re-sync failed:", err);
      }
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [roomCode]);

  const needsName = !user && !nameInput.trim();

  const handleCreate = async () => {
    if (needsName) { setError("Enter a name first."); return; }
    setBusy(true); setError(null);
    try {
      const code = await createRoom({ playerId, playerName });
      setRoomCode(code);
      setPhase("lobby");
    } catch (err) {
      setError(err.message || "Couldn't create a room right now.");
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (needsName) { setError("Enter a name first."); return; }
    if (joinCode.trim().length !== 6) { setError("Room codes are 6 digits."); return; }
    setBusy(true); setError(null);
    try {
      await joinRoom({ code: joinCode.trim(), playerId, playerName });
      setRoomCode(joinCode.trim());
      setPhase("lobby");
    } catch (err) {
      setError(err.message || "Couldn't join that room.");
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = () => {
    if (roomCode) leaveRoom({ code: roomCode, playerId });
    setRoom(null); setRoomCode(null); setPhase("create-join"); setError(null);
  };

  const [copied, setCopied] = useState(false);
  const handleCopyCode = async () => {
    if (!navigator.clipboard || !roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleShareRoom = async () => {
    if (!roomCode) return;
    const text = `Join my CricketIQ room! Code: ${roomCode}`;
    const url = "https://cricketiq.club";
    if (navigator.share) {
      try { await navigator.share({ text, url }); } catch {} // AbortError on cancel — fine, ignore
    } else if (navigator.clipboard) {
      // Desktop fallback — no share sheet available, so copy instead
      try { await navigator.clipboard.writeText(`${text} — play at ${url}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
    }
  };

  if (phase === "lobby" && !room) {
    // Brief gap between setPhase("lobby") and the first Firestore snapshot
    // arriving — show a loading state instead of falling through to the
    // create/join screen, which would be a confusing flash back.
    return (
      <div className="room-root">
        <div className="room-loading">Connecting to room…</div>
      </div>
    );
  }

  if (phase === "lobby" && room) {
    const getMillis = (p) => (p.joinedAt && typeof p.joinedAt.toMillis === "function") ? p.joinedAt.toMillis() : 0;
    const players = Object.entries(room.players || {}).sort((a, b) => getMillis(a[1]) - getMillis(b[1]));
    const isHost = room.hostId === playerId;
    const emptySlots = Math.max(0, MAX_ROOM_PLAYERS - players.length);

    return (
      <div className="room-root">
        <button className="room-back" onClick={handleLeave}>← Leave room</button>
        <div className="room-code-label">ROOM CODE</div>
        <div className="room-code">{roomCode.slice(0,3)} {roomCode.slice(3)}</div>

        <div className="room-share-row">
          <RippleBtn className="room-share-btn" onClick={handleCopyCode}>
            <span className="room-share-icon">{copied ? "✓" : "📋"}</span>
            {copied ? "COPIED" : "COPY CODE"}
          </RippleBtn>
          <RippleBtn className="room-share-btn room-share-primary" onClick={handleShareRoom}>
            <span className="room-share-icon">📤</span>
            SHARE ROOM
          </RippleBtn>
        </div>

        <div className="room-players-label">PLAYERS · {players.length} OF {MAX_ROOM_PLAYERS}</div>
        <div className="room-players-list">
          {players.map(([id, p]) => (
            <div key={id} className="room-player-row">
              <div className="room-player-avatar">{(p.name || "?")[0].toUpperCase()}</div>
              <div className="room-player-name">{p.name}</div>
              {p.isHost && <div className="room-player-host">HOST</div>}
            </div>
          ))}
          {[...Array(emptySlots)].map((_, i) => (
            <div key={`empty-${i}`} className="room-player-row room-player-empty">Waiting for players…</div>
          ))}
        </div>

        {isHost ? (
          <RippleBtn className="room-start-btn" onClick={() => onRequestStart?.(roomCode)} disabled={players.length < 2}>
            {players.length < 2 ? "NEED AT LEAST 2 PLAYERS" : "START GAME"}
          </RippleBtn>
        ) : (
          <div className="room-waiting-host">Waiting for host to start…</div>
        )}

        {error && <p className="room-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="room-root">
      <button className="room-back" onClick={onExit}>← Back</button>
      <div className="room-title">MULTIPLAYER ROOM</div>
      <div className="room-subtitle">Up to {MAX_ROOM_PLAYERS} players per room</div>

      <div className="room-tabs">
        <button className={`room-tab ${tab === "create" ? "room-tab-active" : ""}`} onClick={() => { setTab("create"); setError(null); }}>CREATE</button>
        <button className={`room-tab ${tab === "join" ? "room-tab-active" : ""}`} onClick={() => { setTab("join"); setError(null); }}>JOIN</button>
      </div>

      {!user &&
        <input
          className="room-name-input"
          placeholder="Enter your name"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
          maxLength={20}
        />
      }

      {tab === "create" ? (
        <>
          <p className="room-desc">Tap create, get a 6-digit code, then send it to friends. Anyone with the code can join — you start the match once everyone's in.</p>
          <RippleBtn className="room-primary-btn" onClick={handleCreate} disabled={busy}>
            {busy ? "Creating…" : "CREATE ROOM"}
          </RippleBtn>
        </>
      ) : (
        <>
          <p className="room-desc">Enter the 6-digit code your friend shared with you.</p>
          <input
            className="room-code-input"
            placeholder="000000"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.replace(/\D/g, "").slice(0,6))}
            inputMode="numeric"
            maxLength={6}
          />
          <RippleBtn className="room-primary-btn" onClick={handleJoin} disabled={busy}>
            {busy ? "Joining…" : "JOIN ROOM"}
          </RippleBtn>
        </>
      )}

      {error && <p className="room-error">{error}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM QUIZ SCREEN — synchronized play: everyone sees the same question,
// the room only advances once everyone's answered (or the timer runs out)
// ═══════════════════════════════════════════════════════════════════════════════
function RoomQuizScreen({ roomCode, playerId, onFinish, onLeave }) {
  const [room, setRoom] = useState(null);
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [elim, setElim] = useState([]);
  const [lifelines, setLifelines] = useState({ ff: true, skip: true });
  const [preparedQ, setPreparedQ] = useState(null);
  const [popVal, setPopVal] = useState(0);
  const [showPop, setShowPop] = useState(false);
  const [streak, setStreak] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(ROOM_TIMER_SECONDS);

  const seenIndexRef = useRef(-1); // last question index we've already prepared locally
  const advanceTimeoutRef = useRef(null);

  // Live room state
  useEffect(() => {
    const roomRef = doc(db, "rooms", roomCode);
    const unsub = onSnapshot(
      roomRef,
      (snap) => {
        if (!snap.exists()) { setError("This room no longer exists."); return; }
        setRoom(snap.data());
      },
      (err) => {
        console.error("Room quiz listener error:", err);
        setError("Lost connection to the room. Try rejoining from the home screen.");
      }
    );
    return unsub;
  }, [roomCode]);

  // Same defensive catch-up as the lobby screen — force a fresh read when
  // this tab regains focus, in case the background connection missed an
  // update while the tab was suspended.
  useEffect(() => {
    const handleVisible = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const snap = await getDoc(doc(db, "rooms", roomCode));
        if (snap.exists()) setRoom(snap.data());
      } catch (err) {
        console.error("Visibility re-sync failed:", err);
      }
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [roomCode]);

  // When the shared question index changes, prepare that question locally
  // (shuffle its options) and reset this player's per-question local state.
  useEffect(() => {
    if (!room || !room.questions) return;
    if (room.status === "finished") { onFinish?.(); return; }
    if (room.currentQuestionIndex !== seenIndexRef.current) {
      seenIndexRef.current = room.currentQuestionIndex;
      const q = room.questions[room.currentQuestionIndex];
      if (q) setPreparedQ(prepareQuestion(q));
      setChosen(null);
      setElim([]);
    }
  }, [room?.currentQuestionIndex, room?.status]);

  // Synced countdown, based on the shared questionStartedAt timestamp rather
  // than each device's own clock starting fresh — keeps everyone's timer
  // showing roughly the same remaining time regardless of render timing.
  useEffect(() => {
    if (!room?.questionStartedAt) return;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - room.questionStartedAt) / 1000);
      setSecondsLeft(Math.max(0, ROOM_TIMER_SECONDS - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [room?.questionStartedAt, room?.currentQuestionIndex]);

  const me = room?.players?.[playerId];
  const isHost = room?.hostId === playerId;
  const hasAnsweredCurrent = me && (me.lastAnsweredIndex ?? -1) >= (room?.currentQuestionIndex ?? 0);

  const submitAnswer = async (idx, wasSkip) => {
    if (!room || !preparedQ || chosen !== null) return;
    setChosen(idx ?? -1);
    const correct = !wasSkip && idx === preparedQ.correctIdx;
    const bonus = streak >= 4 ? 10 : streak >= 2 ? 5 : 0;
    const pts = correct ? 10 + bonus : 0;
    if (correct) { setStreak(s => s + 1); setPopVal(pts); setShowPop(true); setTimeout(() => setShowPop(false), 900); }
    else { setStreak(0); }

    const newScore = (me?.score || 0) + pts;
    const newWrong = (me?.wrongCount || 0) + (!wasSkip && !correct ? 1 : 0);
    const questionIndex = room.currentQuestionIndex;
    try {
      await updateDoc(doc(db, "rooms", roomCode), {
        [`players.${playerId}.score`]: newScore,
        [`players.${playerId}.wrongCount`]: newWrong,
        [`players.${playerId}.lastAnsweredIndex`]: questionIndex,
      });

      // If I'm the host and everyone ELSE has already answered (from the
      // most recent state I have), advance right now — don't wait for my
      // own write above to round-trip back through the snapshot listener
      // before the "has everyone answered" check gets a chance to re-run.
      // That round-trip wait is the most likely explanation for the delay:
      // when the host answers last, the room previously wouldn't advance
      // until either that round-trip completed or the timer ran out.
      if (isHost) {
        const othersReady = Object.entries(room.players || {})
          .filter(([id]) => id !== playerId)
          .every(([, p]) => (p.lastAnsweredIndex ?? -1) >= questionIndex);
        if (othersReady) {
          advanceRoomQuestion({ code: roomCode, expectedIndex: questionIndex, totalQuestions: room.questions.length })
            .catch(err => console.error("Immediate advance failed:", err));
        }
      }
    } catch (err) {
      console.error("Failed to submit answer:", err);
    }
  };

  const useFiftyFifty = () => {
    if (!lifelines.ff || chosen !== null || !preparedQ) return;
    setLifelines(l => ({ ...l, ff: false }));
    const wrongIdxs = [0,1,2,3].filter(i => i !== preparedQ.correctIdx);
    const toEliminate = wrongIdxs.sort(() => Math.random()-0.5).slice(0,2);
    setElim(toEliminate);
  };
  const useSkipLifeline = () => {
    if (!lifelines.skip || chosen !== null) return;
    setLifelines(l => ({ ...l, skip: false }));
    submitAnswer(null, true);
  };

  // Host-only: watch for "everyone's answered" and advance immediately
  // rather than waiting out the rest of the timer.
  useEffect(() => {
    if (!isHost || !room || room.status !== "playing") return;
    const players = Object.values(room.players || {});
    if (players.length === 0) return;
    const allAnswered = players.every(p => (p.lastAnsweredIndex ?? -1) >= room.currentQuestionIndex);
    if (allAnswered) {
      advanceRoomQuestion({ code: roomCode, expectedIndex: room.currentQuestionIndex, totalQuestions: room.questions.length })
        .catch(err => console.error("Advance (all-answered) failed:", err));
    }
  }, [room, isHost, roomCode]);

  // Host-only: fallback advancement when the timer runs out, even if not
  // everyone has answered yet.
  useEffect(() => {
    if (!isHost || !room || room.status !== "playing" || !room.questionStartedAt) return;
    if (advanceTimeoutRef.current) clearTimeout(advanceTimeoutRef.current);
    const msRemaining = ROOM_TIMER_SECONDS * 1000 - (Date.now() - room.questionStartedAt);
    advanceTimeoutRef.current = setTimeout(() => {
      advanceRoomQuestion({ code: roomCode, expectedIndex: room.currentQuestionIndex, totalQuestions: room.questions.length })
        .catch(err => console.error("Advance (timeout) failed:", err));
    }, Math.max(0, msRemaining));
    return () => clearTimeout(advanceTimeoutRef.current);
  }, [room?.currentQuestionIndex, room?.questionStartedAt, isHost, roomCode]);

  if (error) {
    return (
      <div className="qs-root">
        <p className="room-error">{error}</p>
        <RippleBtn className="room-primary-btn" onClick={onLeave}>BACK TO HOME</RippleBtn>
      </div>
    );
  }

  if (!room || !preparedQ) {
    return <div className="room-root"><div className="room-loading">Loading match…</div></div>;
  }

  const q = preparedQ;
  const catMeta = CAT_META[q?.cat] || { color:"#60a5fa", icon:"🏏" };
  const labels = ["A","B","C","D"];
  const players = Object.entries(room.players || {});
  const answeredIds = players.filter(([id,p]) => (p.lastAnsweredIndex ?? -1) >= room.currentQuestionIndex).map(([id]) => id);
  const totalQ = room.questions.length;

  return (
    <div className="qs-root">
      <div className="qs-topbar">
        <div className="qs-ll-mini-row">
          <RippleBtn className={`qs-ll-mini ${!lifelines.ff ? "qs-ll-mini-used" : ""}`} onClick={useFiftyFifty} disabled={!lifelines.ff || chosen !== null}>
            <span className="qs-ll-mini-icon">50:50</span>
            {!lifelines.ff && <div className="qs-ll-mini-strike" />}
          </RippleBtn>
          <RippleBtn className={`qs-ll-mini ${!lifelines.skip ? "qs-ll-mini-used" : ""}`} onClick={useSkipLifeline} disabled={!lifelines.skip || chosen !== null}>
            <span className="qs-ll-mini-icon">⏭ SKIP</span>
            {!lifelines.skip && <div className="qs-ll-mini-strike" />}
          </RippleBtn>
        </div>
        <div className="qs-topbar-spacer" />
        <div className="qs-score-wrap">
          <ScorePop value={popVal} visible={showPop} />
          <div className="qs-score">{me?.score || 0} <span>PTS</span></div>
        </div>
      </div>

      <div className="room-progress-track">
        <div className="room-progress-fill" style={{ width: `${((room.currentQuestionIndex + 1) / totalQ) * 100}%` }} />
      </div>

      <div className="qs-card-wrap">
        <div className="qs-card-top">
          <div className="qs-cat-badge" style={{ "--cc": catMeta.color }}>
            <span>{catMeta.icon}</span> {q.cat.toUpperCase()}
          </div>
          <div style={{ position:"relative", width:64, height:64, flexShrink:0 }}>
            <svg width="64" height="64" style={{ transform:"rotate(-90deg)" }}>
              <circle cx="32" cy="32" r="24" fill="none" stroke="#1e293b" strokeWidth="4" />
              <circle cx="32" cy="32" r="24" fill="none" stroke={secondsLeft > 10 ? "#34d399" : secondsLeft > 5 ? "#fbbf24" : "#ef4444"} strokeWidth="4"
                strokeDasharray={2*Math.PI*24} strokeDashoffset={2*Math.PI*24*(1-secondsLeft/ROOM_TIMER_SECONDS)}
                style={{ transition:"stroke-dashoffset 0.9s linear, stroke 0.5s" }} />
            </svg>
            <span style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"'Bebas Neue', sans-serif", fontSize:22, color: secondsLeft > 10 ? "#34d399" : secondsLeft > 5 ? "#fbbf24" : "#ef4444", lineHeight:1 }}>{secondsLeft}</span>
          </div>
        </div>
        <div className="qs-qnum" style={{ color: catMeta.color }}>QUESTION {room.currentQuestionIndex + 1}</div>
        <div className="qs-qtext">{q.q}</div>
      </div>

      <div className="qs-options">
        {q.shuffledOpts.map((opt, idx) => {
          const isElim = elim.includes(idx);
          const isChosen = chosen === idx;
          const isCorrect = (chosen !== null) && idx === q.correctIdx;
          const isWrong = isChosen && idx !== q.correctIdx;
          let state = "idle";
          if (isElim) state = "elim";
          else if (isCorrect) state = "correct";
          else if (isWrong) state = "wrong";
          else if (chosen !== null) state = "dim";
          return (
            <RippleBtn key={idx} className={`qs-opt qs-opt-${state}`} style={{ "--cc": catMeta.color }}
              onClick={() => submitAnswer(idx, false)} disabled={isElim || chosen !== null}>
              <span className={`qs-opt-label qs-opt-label-${state}`}>{labels[idx]}</span>
              <span className="qs-opt-text" style={isElim ? { textDecoration:"line-through", color:"#475569" } : {}}>{opt}</span>
              {isCorrect && <span className="qs-opt-check">✓</span>}
              {isWrong && <span className="qs-opt-cross">✗</span>}
            </RippleBtn>
          );
        })}
      </div>

      {hasAnsweredCurrent &&
        <div className="room-waiting-block">
          <div className="room-waiting-text">Waiting for other players to answer…</div>
          <div className="room-waiting-avatars">
            {players.map(([id, p]) => (
              <div key={id} className={`room-waiting-avatar ${answeredIds.includes(id) ? "room-waiting-avatar-done" : ""}`}>
                {(p.name || "?")[0].toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM LEADERBOARD — shown to everyone once the match ends
// ═══════════════════════════════════════════════════════════════════════════════
function RoomLeaderboardScreen({ roomCode, playerId, onBackHome }) {
  const [room, setRoom] = useState(null);

  useEffect(() => {
    const roomRef = doc(db, "rooms", roomCode);
    const unsub = onSnapshot(roomRef, (snap) => { if (snap.exists()) setRoom(snap.data()); }, () => {});
    return unsub;
  }, [roomCode]);

  if (!room) return <div className="room-root"><div className="room-loading">Loading results…</div></div>;

  const ranked = Object.entries(room.players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.score||0) - (a.score||0));

  return (
    <div className="rs-root">
      <div className="lb-trophy">🏆</div>
      <div className="lb-title">MATCH RESULTS</div>
      <div className="lb-room-code">Room {roomCode.slice(0,3)} {roomCode.slice(3)}</div>

      <div className="lb-list">
        {ranked.map((p, i) => (
          <div key={p.id} className={`lb-row ${i === 0 ? "lb-row-first" : ""}`}>
            <div className="lb-rank" style={{ color: i === 0 ? "#f59e0b" : "#94a3b8" }}>{i + 1}</div>
            <div className="lb-avatar" style={{ background: i === 0 ? "#f59e0b" : "#b5d99c", color: i===0 ? "#412402" : "#0f172a" }}>
              {(p.name || "?")[0].toUpperCase()}
            </div>
            <div className="lb-name">{p.name}</div>
            {p.isHost && <div className="room-player-host">HOST</div>}
            <div className="lb-score" style={{ color: i === 0 ? "#f59e0b" : "#e2e8f0" }}>{p.score || 0}</div>
          </div>
        ))}
      </div>

      <RippleBtn className="rs-cta" onClick={onBackHome}>🏠 BACK TO HOME</RippleBtn>
    </div>
  );
}

function HomeScreen({ onStart, stats, totalQuestions, user, onSignOut, showSignInLink }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => { setTimeout(() => setEntered(true), 80); }, []);

  const [signInStatus, setSignInStatus] = useState("idle"); // idle | working | error
  const handleSignIn = async () => {
    setSignInStatus("working");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Google sign-in failed:", err);
      setSignInStatus("error");
    }
  };

  // Tapping the user chip opens a small confirm menu instead of signing out
  // immediately — signing out is a deliberate second action from there.
  const [showLogoutMenu, setShowLogoutMenu] = useState(false);
  const userMenuRef = useRef(null);
  useEffect(() => {
    if (!showLogoutMenu) return;
    const handleOutside = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowLogoutMenu(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [showLogoutMenu]);

  return (
    <div className="hs-root">
      {/* Stadium lights */}
      <div className="hs-light hs-light-1" />
      <div className="hs-light hs-light-2" />
      <div className="hs-light hs-light-3" />
      {/* Ground rings */}
      <div className="hs-ring hs-ring-1" />
      <div className="hs-ring hs-ring-2" />
      <div className="hs-ring hs-ring-3" />

      {user &&
        <div className="hs-user-wrap" ref={userMenuRef}>
          <button className="hs-user-chip" onClick={() => setShowLogoutMenu(v => !v)} title="Account">
            {user.photoURL
              ? <img src={user.photoURL} alt="" className="hs-user-avatar" referrerPolicy="no-referrer" />
              : <span className="hs-user-avatar hs-user-avatar-fallback">{(user.displayName || "?")[0]}</span>
            }
            <span className="hs-user-name">{user.displayName || user.email}</span>
          </button>
          {showLogoutMenu &&
            <div className="hs-user-menu">
              <button className="hs-user-menu-item" onClick={() => { setShowLogoutMenu(false); onSignOut(); }}>
                Log out
              </button>
            </div>
          }
        </div>
      }

      <div className={`hs-content ${entered ? "hs-in" : ""}`}>
        {/* Logo */}
        <div className="hs-logo-block">
          <div className="hs-ball-wrap">
            <div className="hs-ball">🏏</div>
            <div className="hs-ball-glow" />
          </div>
          <h1 className="hs-title">CRICKET<span>IQ</span></h1>
          <p className="hs-tagline">◆ THE ULTIMATE CRICKET CHALLENGE ◆</p>
        </div>

        {/* Stats */}
        <div className="hs-stats">
          {[
            { val: stats.gamesPlayed, lbl: "MATCHES", icon:"🎮" },
            { val: stats.bestScore,   lbl: "TOP SCORE", icon:"🏆" },
            { val: stats.totalCorrect, lbl: "CORRECT", icon:"✅" },
          ].map((s, i) => (
            <div key={i} className="hs-stat-card">
              <div className="hs-stat-icon">{s.icon}</div>
              <div className="hs-stat-val">{s.val}</div>
              <div className="hs-stat-lbl">{s.lbl}</div>
            </div>
          ))}
        </div>

        {/* Rules */}
        <div className="hs-rules">
          <div className="hs-rules-grid">
            {[
              ["🎯","ENDLESS QUESTIONS","Keep answering correctly to keep going!"],
              ["❤️","3 LIVES","3 wrong answers and the innings ends"],
              ["🃏","2 LIFELINES","50:50 to eliminate wrong options & Skip"],
              ["🔥","STREAK BONUS","Chain correct answers for extra points"],
            ].map(([icon, head, sub], i) => (
              <div key={i} className="hs-rule-item">
                <span className="hs-rule-icon">{icon}</span>
                <div className="hs-rule-text">
                  <div className="hs-rule-head">{head}</div>
                  <div className="hs-rule-sub">{sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        {(user || !showSignInLink) ? (
          <RippleBtn className="hs-cta" onClick={onStart}>
            <span className="hs-cta-inner">
              <span>PLAY NOW</span>
              <span className="hs-cta-arrow">▶</span>
            </span>
            <div className="hs-cta-shine" />
          </RippleBtn>
        ) : (
          <div className="hs-signin-row">
            <p className="hs-signin-prompt">Sign in with Google to keep playing</p>
            <RippleBtn className="sg-google-btn hs-google-btn hs-google-btn-primary" onClick={handleSignIn} disabled={signInStatus === "working"}>
              <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink:0 }}>
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
              </svg>
              {signInStatus === "working" ? "Signing in…" : "Continue with Google"}
            </RippleBtn>
            {signInStatus === "error" &&
              <p className="hs-signin-error">Couldn't sign in — check that popups aren't blocked, then try again.</p>
            }
          </div>
        )}

        {ADSENSE_ENABLED &&
          <div className="hs-ad-strip">
            <AdStrip slot={AD_SLOT_HOME} />
          </div>
        }

        <div className="hs-footer-links">
          <a href="/about.html" target="_blank" rel="noopener noreferrer">About</a>
          <span>·</span>
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUIZ SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function QuizScreen({ questions, onEnd, answeredCorrectly, recentlySeen, onMarkCorrect, showSignInGate, onSignInResolved, user }) {
  // Tracks whether the sign-in gate has already been shown+dismissed within
  // THIS game-over transition (separate from the App-level "ever seen" flag,
  // which persists across sessions).
  const [gateDismissed, setGateDismissed] = useState(false);
  const shouldShowGate = showSignInGate && !gateDismissed;
  const dismissGate = () => { setGateDismissed(true); onSignInResolved?.(); };

  // ── Game-over ad interstitial ── (effect itself is defined further down,
  // after `phase` state exists — see below)
  const [readyForResults, setReadyForResults] = useState(false);
  const adTriggeredRef = useRef(false);

  // correctSeen = correctly answered IDs (excluded forever across all games)
  const correctSeen   = useRef(new Set(answeredCorrectly));
  // shownThisGame = every question shown in this session + last session (no immediate repeats)
  const shownThisGame = useRef(new Set([...answeredCorrectly, ...recentlySeen]));
  // currentQIdRef = stable ref to the on-screen question ID — always excluded from pickNext
  const currentQIdRef = useRef(null);
  // inputLockedRef = true for a brief window right after a new question renders.
  // Guards against a real issue on slower touch-response browsers (notably iOS
  // Safari): if someone taps an answer, doesn't see the reveal animate fast
  // enough, and taps again out of confusion, those extra taps can end up
  // arriving just as the NEXT question mounts — landing on a freshly-enabled
  // button at the same screen position and silently answering it without the
  // user meaning to. This swallows any taps in that brief post-mount window,
  // which real intentional answers (read the question, then tap) never fall
  // inside anyway.
  const inputLockedRef = useRef(false);

  // Pick the next question: never repeats correct answers, current question, or session-seen questions
  const pickNext = () => {
    let pool = questions.filter(
      q => !correctSeen.current.has(q.id) &&
           !shownThisGame.current.has(q.id) &&
           q.id !== currentQIdRef.current
    );
    // Safety: if all unseen questions are exhausted, reset "seen this game" tracking
    // (correctly answered ones stay excluded forever)
    if (pool.length === 0) {
      shownThisGame.current = new Set(correctSeen.current);
      pool = questions.filter(
        q => !correctSeen.current.has(q.id) && q.id !== currentQIdRef.current
      );
    }
    if (pool.length === 0) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    shownThisGame.current.add(pick.id);  // mark shown immediately so goNext never re-picks it
    return prepareQuestion(pick);
  };

  // currentQ is the single stable question state — only swapped inside goNext
  const [currentQ, setCurrentQ] = useState(() => {
    const first = pickNext();
    if (first) currentQIdRef.current = first.id;
    return first;
  });

  const [chosen,   setChosen]   = useState(null);
  const [wrong,    setWrong]    = useState(0);
  const [score,    setScore]    = useState(0);
  const [streak,   setStreak]   = useState(0);
  const maxStreakRef = useRef(0); // highest streak reached this game — used on the share card
  const [answered, setAnswered] = useState(0);
  const [lifelines, setLL]      = useState({ ff: true, skip: true });
  const [elim,     setElim]     = useState([]);
  const [phase,    setPhase]    = useState("question");

  // Fires once per game, right before results are shown (after the sign-in
  // gate, if it was shown). Uses Google's Ad Placement API (adBreak), which
  // only exists on window once the real AdSense script has loaded — which
  // only happens after your site is approved and the real publisher ID is
  // in index.html. Until then, window.adBreak is simply undefined, so this
  // silently falls through to "show results immediately" — zero risk to the
  // live game while ads aren't active yet.
  useEffect(() => {
    if ((phase !== "gameover" && phase !== "complete") || shouldShowGate || adTriggeredRef.current) return;
    adTriggeredRef.current = true;
    if (ADSENSE_ENABLED && typeof window.adBreak === "function") {
      window.adBreak({
        type: "next",
        name: "game_over",
        // adBreakDone fires reliably whether or not an ad actually showed
        // (no fill, blocked, frequency-capped, etc.) — safest hook to resume on.
        adBreakDone: () => setReadyForResults(true),
      });
    } else {
      setReadyForResults(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, shouldShowGate]);

  const [particleTrigger, setPT] = useState(0);
  const [showPop,  setShowPop]  = useState(false);
  const [popVal,   setPopVal]   = useState(0);
  const [timerKey, setTimerKey] = useState(0);
  const [timeUp,   setTimeUp]   = useState(false);
  const [cardFlip, setCardFlip] = useState(false);

  const q       = currentQ;
  const catMeta = CAT_META[q?.cat] || { color:"#60a5fa", icon:"🏏" };

  // goNext: swap question only after animation — reads refs so no stale closure issues
  const goNext = useCallback(() => {
    setCardFlip(true);
    setTimeout(() => {
      const next = pickNext();
      setChosen(null); setElim([]); setTimeUp(false); setShowPop(false); setCardFlip(false);
      if (!next) { setPhase("complete"); return; }
      currentQIdRef.current = next.id;  // update ref before render so pickNext excludes it immediately
      setCurrentQ(next);
      setPhase("question");
      setTimerKey(k => k + 1);
      inputLockedRef.current = true;
      setTimeout(() => { inputLockedRef.current = false; }, 350);
    }, 420);
  }, []);

  const handleTimeUp = useCallback(() => {
    if (phase !== "question" || chosen !== null) return;
    setTimeUp(true);
    const nw = wrong + 1;
    setWrong(nw); setStreak(0); setAnswered(a => a + 1);
    if (nw >= MAX_WRONG) { setTimeout(() => setPhase("gameover"), 1500); }
    else                 { setTimeout(goNext, 1500); }
  }, [phase, chosen, wrong, goNext]);

  const handleAnswer = (idx) => {
    if (phase !== "question" || chosen !== null || timeUp || inputLockedRef.current) return;
    setChosen(idx);
    setAnswered(a => a + 1);
    const correct = idx === q.correctIdx;

    if (correct) {
      const bonus = streak >= 4 ? 10 : streak >= 2 ? 5 : 0;
      const pts   = 10 + bonus;
      const newStreak = streak + 1;
      setScore(s => s + pts); setStreak(newStreak);
      if (newStreak > maxStreakRef.current) maxStreakRef.current = newStreak;
      setPopVal(pts); setShowPop(true); setPT(t => t + 1);
      correctSeen.current.add(q.id);  // add BEFORE goNext so pickNext excludes it
      onMarkCorrect(q.id);
      setTimeout(() => setShowPop(false), 900);
      setTimeout(goNext, 1600);
    } else {
      const nw = wrong + 1;
      setWrong(nw); setStreak(0);
      if (nw >= MAX_WRONG) { setTimeout(() => setPhase("gameover"), 1500); }
      else                 { setTimeout(goNext, 1600); }
    }
  };

  const useFiftyFifty = () => {
    if (!lifelines.ff || phase !== "question" || chosen !== null) return;
    const wrongIdxs = [0, 1, 2, 3].filter(i => i !== q.correctIdx);
    setElim(shuffle(wrongIdxs).slice(0, 2));
    setLL(l => ({ ...l, ff: false }));
  };

  const useSkip = () => {
    if (!lifelines.skip || phase !== "question" || chosen !== null) return;
    setLL(l => ({ ...l, skip: false }));
    setAnswered(a => a + 1);
    goNext();
  };

  // Pass shownThisGame back to parent so next game starts without these questions
  const finishGame = (sc, corr) => onEnd(sc, corr, shownThisGame.current);

  if (phase === "gameover") {
    if (shouldShowGate) return <SignInGate onContinue={dismissGate} />;
    if (!readyForResults) return null; // brief moment while adBreak resolves (instant if ads aren't active yet)
    return <ResultScreen score={score} correct={answered - wrong} total={answered} wrong={wrong} maxStreak={maxStreakRef.current} user={user} reason="gameover" onEnd={() => finishGame(score, answered - wrong)} />;
  }
  if (phase === "complete") {
    if (shouldShowGate) return <SignInGate onContinue={dismissGate} />;
    if (!readyForResults) return null;
    return <ResultScreen score={score} correct={answered} total={answered} wrong={wrong} maxStreak={maxStreakRef.current} user={user} reason="complete" onEnd={() => finishGame(score, answered)} />;
  }

  const livesLeft = MAX_WRONG - wrong;
  const labels    = ["A", "B", "C", "D"];

  return (
    <div className="qs-root">
      {/* Background glow follows category color */}
      <div className="qs-bg-glow" style={{ background: catMeta.color }} />

      {/* Particles */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:100 }}>
        <Particles trigger={particleTrigger} color={catMeta.color} />
      </div>

      {/* TOP BAR */}
      <div className="qs-topbar">
        <div className="qs-lives">
          {[...Array(MAX_WRONG)].map((_,i) => (
            <div key={i} className={`qs-heart ${i < livesLeft ? "alive":"dead"}`}>
              {i < livesLeft ? "❤️" : "🩶"}
            </div>
          ))}
        </div>

        <div className="qs-topbar-divider" />

        <div className="qs-ll-mini-row">
          <RippleBtn className={`qs-ll-mini ${!lifelines.ff ? "qs-ll-mini-used" : ""}`}
            onClick={useFiftyFifty} disabled={!lifelines.ff || chosen !== null}>
            <span className="qs-ll-mini-icon">50:50</span>
            {!lifelines.ff && <div className="qs-ll-mini-strike" />}
          </RippleBtn>
          <RippleBtn className={`qs-ll-mini ${!lifelines.skip ? "qs-ll-mini-used" : ""}`}
            onClick={useSkip} disabled={!lifelines.skip || chosen !== null}>
            <span className="qs-ll-mini-icon">⏭ SKIP</span>
            {!lifelines.skip && <div className="qs-ll-mini-strike" />}
          </RippleBtn>
        </div>

        <div className="qs-topbar-spacer" />

        {streak >= 2 &&
          <div className="qs-streak" style={{ "--sc": catMeta.color }}>
            🔥 {streak}×
          </div>
        }

        <div className="qs-score-wrap" style={{ position:"relative" }}>
          <ScorePop value={popVal} visible={showPop} />
          <div className="qs-score">{score} <span>PTS</span></div>
        </div>
      </div>


      {/* LIVE STATS RIBBON */}
      <div className="qs-ribbon">
        <div className="qs-ribbon-item">
          <span className="qs-ribbon-val" style={{ color: catMeta.color }}>{answered}</span>
          <span className="qs-ribbon-lbl">ANSWERED</span>
        </div>
        <div className="qs-ribbon-sep" />
        <div className="qs-ribbon-item">
          <span className="qs-ribbon-val" style={{ color:"#34d399" }}>{answered - wrong}</span>
          <span className="qs-ribbon-lbl">CORRECT</span>
        </div>
        <div className="qs-ribbon-sep" />
        <div className="qs-ribbon-item">
          <span className="qs-ribbon-val" style={{ color:"#ef4444" }}>{wrong}</span>
          <span className="qs-ribbon-lbl">WRONG</span>
        </div>
        <div className="qs-ribbon-sep" />
        <div className="qs-ribbon-item">
          <span className="qs-ribbon-val" style={{ color:"#a78bfa" }}>{streak}</span>
          <span className="qs-ribbon-lbl">STREAK</span>
        </div>
      </div>

      {/* QUESTION CARD */}
      <div className={`qs-card-wrap ${cardFlip ? "flipping" : ""}`}>
        {/* Cat + Timer row */}
        <div className="qs-card-top">
          <div className="qs-cat-badge" style={{ "--cc": catMeta.color }}>
            <span>{catMeta.icon}</span> {q.cat.toUpperCase()}
          </div>
          <CircularTimer key={timerKey} total={20} onExpire={handleTimeUp} />
        </div>

        {/* Q number strip */}
        <div className="qs-qnum" style={{ color: catMeta.color }}>
          QUESTION {answered + 1}
        </div>

        {/* Question text */}
        <div className="qs-qtext">
          {timeUp ? "⏰ Time's up! The answer was:" : q.q}
        </div>
        {timeUp && <div className="qs-correct-reveal">{q.ans}</div>}
      </div>

      {/* OPTIONS */}
      <div className="qs-options">
        {q.shuffledOpts.map((opt, idx) => {
          const isElim     = elim.includes(idx);
          const isChosen   = chosen === idx;
          const isCorrect  = (chosen !== null || timeUp) && idx === q.correctIdx;
          const isWrong    = isChosen && idx !== q.correctIdx;
          let state = "idle";
          if (isElim)    state = "elim";
          else if (isCorrect) state = "correct";
          else if (isWrong)   state = "wrong";
          else if (chosen !== null || timeUp) state = "dim";

          return (
            <RippleBtn key={idx}
              className={`qs-opt qs-opt-${state}`}
              style={{ "--cc": catMeta.color }}
              onClick={() => handleAnswer(idx)}
              disabled={isElim || chosen !== null || timeUp}
            >
              <span className={`qs-opt-label qs-opt-label-${state}`}>{labels[idx]}</span>
              <span className="qs-opt-text" style={ isElim ? { textDecoration:"line-through", color:"#475569" } : {} }>{opt}</span>
              {isCorrect && <span className="qs-opt-check">✓</span>}
              {isWrong   && <span className="qs-opt-cross">✗</span>}
            </RippleBtn>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGN-IN GATE — shown once, right after the player's first-ever completed game
// ═══════════════════════════════════════════════════════════════════════════════
function SignInGate({ onContinue }) {
  const [status, setStatus] = useState("idle"); // idle | working | error
  const [show, setShow] = useState(false);
  useEffect(() => { setTimeout(() => setShow(true), 100); }, []);

  const handleGoogleSignIn = async () => {
    setStatus("working");
    try {
      await signInWithPopup(auth, googleProvider);
      onContinue();
    } catch (err) {
      // Common cause: popup blocked, or the user closed it — let them retry or skip
      console.error("Google sign-in failed:", err);
      setStatus("error");
    }
  };

  return (
    <div className="sg-root">
      <div className={`sg-content ${show ? "sg-in" : ""}`}>
        <div className="sg-icon">🏏</div>
        <h2 className="sg-title">Nice first round!</h2>
        <p className="sg-sub">Sign in with Google to save your progress — pick up right where you left off, on any device.</p>

        <RippleBtn className="sg-google-btn" onClick={handleGoogleSignIn} disabled={status === "working"}>
          <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink:0 }}>
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
          </svg>
          {status === "working" ? "Signing in…" : "Continue with Google"}
        </RippleBtn>

        {status === "error" &&
          <p className="sg-error">Couldn't complete sign-in — check that popups aren't blocked, then try again.</p>
        }

        <button className="sg-skip" onClick={onContinue}>Skip for now</button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// RESULT SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
// ── SHARE CARD GENERATION ────────────────────────────────────────────────────
// Renders the result as a downloadable/shareable image via the Canvas API
// directly, rather than a DOM-to-image library. Deliberate choice: this
// design uses gradient text and custom web fonts, both of which DOM-to-canvas
// libraries (html2canvas etc.) are known to render inconsistently across
// browsers. Drawing directly gives full, predictable control instead.
function waitForFonts() {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load("700 100px 'Bebas Neue'"),
    document.fonts.load("700 40px 'Barlow Condensed'"),
  ]).then(() => document.fonts.ready).catch(() => {});
}

async function generateShareCardBlob({ score, rank, correct, wrong, maxStreak, userName }) {
  await waitForFonts();

  const W = 1080, H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textAlign = "center";

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#040810");
  bg.addColorStop(1, "#0a1420");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── Layout: each step reports its own real height via ctx.measureText's
  // actualBoundingBoxAscent/Descent, rather than guessed pixel offsets —
  // that guessing is exactly what caused the subtitle/score overlap before.
  // "text" steps are baseline-positioned (need ascent to place correctly);
  // "stats"/"pill" are fixed-height blocks positioned from their top edge.
  const GAP_TIGHT = 12, GAP_SMALL = 26, GAP_MED = 42, GAP_LARGE = 58;
  const cleanSub = rank.sub.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();

  const steps = [
    { type:"text", text:"CRICKETIQ", font:"700 56px 'Bebas Neue'", grad:["#b5d99c","#ffff82"], gap:GAP_LARGE },
    { type:"text", text:rank.icon, font:"120px sans-serif", fill:"#ffffff", gap:GAP_SMALL },
    { type:"text", text:rank.title, font:"700 50px 'Bebas Neue'", fill:rank.color, gap:GAP_TIGHT },
    { type:"text", text:cleanSub, font:"400 28px 'Barlow Condensed', sans-serif", fill:"#94a3b8", gap:GAP_LARGE },
    ...(userName ? [{ type:"text", text:`${userName.toUpperCase()} SCORED`, font:"600 28px 'Barlow Condensed', sans-serif", fill:"#94a3b8", letterSpacing:"3px", gap:GAP_MED }] : []),
    { type:"text", text:String(score), font:"700 200px 'Bebas Neue'", fill:rank.color, gap: userName ? GAP_LARGE : GAP_TIGHT },
    ...(!userName ? [{ type:"text", text:"POINTS", font:"700 32px 'Bebas Neue'", fill:"#475569", letterSpacing:"6px", gap:GAP_LARGE }] : []),
    { type:"stats", gap:GAP_LARGE },
    { type:"text", text:"Think you know cricket better?", font:"400 28px 'Barlow Condensed', sans-serif", fill:"#94a3b8", gap:GAP_MED },
    { type:"pill", gap:0 },
  ];

  // Measure pass
  const metrics = steps.map(s => {
    if (s.type === "stats") return { ascent:0, descent:90 };
    if (s.type === "pill")  return { ascent:0, descent:76 };
    ctx.font = s.font;
    const m = ctx.measureText(s.text);
    const fontPx = parseInt(s.font.match(/(\d+)px/)[1], 10);
    return {
      ascent:  m.actualBoundingBoxAscent  || fontPx * 0.75,
      descent: m.actualBoundingBoxDescent || fontPx * 0.2,
    };
  });
  const totalHeight = metrics.reduce((sum, m, i) => sum + m.ascent + m.descent + steps[i].gap, 0);

  // Center the block, biased slightly toward the top third — reads better
  // than dead-center for a card shaped like this.
  let cursorY = Math.max(60, (H - totalHeight) / 2 - 30);
  const blockStartY = cursorY;

  // Ambient glows, anchored to where the content actually ends up (not
  // fixed absolute positions), so they stay visually correct regardless of
  // exactly how tall the final content block is.
  const glow1cy = blockStartY + totalHeight * 0.22;
  const glow1 = ctx.createRadialGradient(W/2, glow1cy, 20, W/2, glow1cy, 360);
  glow1.addColorStop(0, "rgba(181,217,156,0.20)");
  glow1.addColorStop(1, "rgba(181,217,156,0)");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  const glow2cy = blockStartY + totalHeight * 0.82;
  const glow2 = ctx.createRadialGradient(W/2, glow2cy, 20, W/2, glow2cy, 300);
  glow2.addColorStop(0, "rgba(245,158,11,0.12)");
  glow2.addColorStop(1, "rgba(245,158,11,0)");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Draw pass
  steps.forEach((step, i) => {
    const { ascent, descent } = metrics[i];
    ctx.font = step.font || "";
    if (step.letterSpacing) ctx.letterSpacing = step.letterSpacing;

    if (step.type === "text") {
      const baselineY = cursorY + ascent;
      if (step.grad) {
        const m = ctx.measureText(step.text);
        const g = ctx.createLinearGradient(W/2 - m.width/2, 0, W/2 + m.width/2, 0);
        g.addColorStop(0, step.grad[0]);
        g.addColorStop(1, step.grad[1]);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = step.fill;
      }
      ctx.fillText(step.text, W/2, baselineY);
    } else if (step.type === "stats") {
      const statsBaselineY = cursorY + 44;
      const statsData = [
        { val: correct, lbl: "CORRECT", color: "#34d399" },
        { val: wrong, lbl: "WRONG", color: "#ef4444" },
        { val: `${maxStreak}\u{1F525}`, lbl: "BEST STREAK", color: "#f59e0b" },
      ];
      const colW = 220;
      const startX = W/2 - colW;
      statsData.forEach((s, si) => {
        const x = startX + si * colW;
        ctx.font = "700 44px 'Bebas Neue'";
        ctx.fillStyle = s.color;
        ctx.fillText(String(s.val), x, statsBaselineY);
        ctx.font = "600 20px 'Barlow Condensed', sans-serif";
        ctx.fillStyle = "#64748b";
        ctx.letterSpacing = "2px";
        ctx.fillText(s.lbl, x, statsBaselineY + 34);
        ctx.letterSpacing = "0px";
        if (si > 0) {
          ctx.strokeStyle = "#1e3a5f";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - colW/2, statsBaselineY - 40);
          ctx.lineTo(x - colW/2, statsBaselineY + 16);
          ctx.stroke();
        }
      });
    } else if (step.type === "pill") {
      const pillW = 340, pillH = 76, pillX = W/2 - pillW/2, pillY = cursorY;
      const pillGrad = ctx.createLinearGradient(pillX, 0, pillX + pillW, 0);
      pillGrad.addColorStop(0, "#b5d99c");
      pillGrad.addColorStop(1, "#ffff82");
      ctx.fillStyle = pillGrad;
      const r = pillH / 2;
      ctx.beginPath();
      ctx.moveTo(pillX + r, pillY);
      ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r);
      ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r);
      ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r);
      ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r);
      ctx.closePath();
      ctx.fill();
      ctx.font = "700 36px 'Bebas Neue'";
      ctx.fillStyle = "#0f172a";
      ctx.fillText("cricketiq.club", W/2, pillY + pillH/2 + 13);
    }

    if (step.letterSpacing) ctx.letterSpacing = "0px";
    cursorY += ascent + descent + step.gap;
  });

  return new Promise(resolve => canvas.toBlob(resolve, "image/png", 0.95));
}

function ResultScreen({ score, correct, total, wrong, maxStreak, user, reason, onEnd }) {
  const [show, setShow] = useState(false);
  useEffect(() => { setTimeout(() => setShow(true), 100); }, []);
  const pct  = Math.round((correct / total) * 100);
  const rank = score >= 90
    ? { title:"CRICKET GOD",    sub:"Absolute legend of the game 🐐",  color:"#f59e0b", icon:"👑" }
    : score >= 70
    ? { title:"ALL-ROUNDER",    sub:"Outstanding performance! 🌟",      color:"#34d399", icon:"🏆" }
    : score >= 50
    ? { title:"CLUB CAPTAIN",   sub:"Solid knock, keep practising 🏏",  color:"#38bdf8", icon:"🎖" }
    : score >= 30
    ? { title:"NET PRACTICE",   sub:"More drills needed, champ 💪",     color:"#a78bfa", icon:"🏋" }
    :             { title:"ROOKIE",         sub:"Time to hit the books! 📖",       color:"#ef4444", icon:"😅" };

  const bars = [
    { lbl:"CORRECT",  val: correct, tot: total, color:"#34d399" },
    { lbl:"WRONG",    val: wrong,   tot: total, color:"#ef4444" },
    { lbl:"ACCURACY", val: pct,     tot: 100,   color:"#f59e0b", pct: true },
  ];

  const [shareStatus, setShareStatus] = useState("idle"); // idle | working | error
  const handleShare = async () => {
    setShareStatus("working");
    try {
      const blob = await generateShareCardBlob({
        score, rank, correct, wrong,
        maxStreak: maxStreak || 0,
        userName: user?.displayName || null,
      });
      if (!blob) throw new Error("Image generation failed");

      const shareText = "I just scored " + score + " on CricketIQ \uD83C\uDFCF Think you know cricket better? Beat my score:";
      const shareUrl = "https://cricketiq.club";
      const file = new File([blob], "cricketiq-score.png", { type: "image/png" });

      // Native share sheet, with the image + a genuinely clickable link
      // alongside it — WhatsApp, Instagram, etc. all support file+url together.
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText, url: shareUrl });
      } else {
        // Fallback (mainly desktop browsers without a share sheet): download
        // the image directly, and copy shareable text+link to the clipboard
        // so the link is still easy to paste in wherever they share it.
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "cricketiq-score.png";
        link.click();
        URL.revokeObjectURL(link.href);
        if (navigator.clipboard) {
          try { await navigator.clipboard.writeText(`${shareText} ${shareUrl}`); } catch {}
        }
      }
      setShareStatus("idle");
    } catch (err) {
      // AbortError fires when the user just closes the native share sheet —
      // not a real error, don't show a message for that.
      if (err && err.name === "AbortError") { setShareStatus("idle"); return; }
      console.error("Share failed:", err);
      setShareStatus("error");
    }
  };

  return (
    <div className="rs-root">
      <div className="rs-bg-glow" style={{ background: rank.color }} />
      {/* Confetti dots */}
      {reason === "complete" && [...Array(24)].map((_,i) => (
        <div key={i} className="rs-confetti" style={{
          left: `${Math.random()*100}%`, animationDelay:`${Math.random()*1.5}s`,
          background: ["#f59e0b","#ef4444","#34d399","#38bdf8","#a78bfa"][i%5],
          animationDuration: `${Math.random()*1+1}s`
        }} />
      ))}

      <div className={`rs-content ${show ? "rs-show":""}`}>
        <div className="rs-icon-wrap" style={{ "--ring-color": rank.color }}>
          <div className="rs-icon">{rank.icon}</div>
        </div>

        <div className="rs-result-label" style={{ color: rank.color }}>{rank.title}</div>
        <div className="rs-result-sub">{rank.sub}</div>

        {reason === "complete" &&
          <div className="rs-gameover-tag" style={{ color:"#34d399", background:"#34d39911", borderColor:"#34d39933" }}>🏆 YOU MASTERED ALL QUESTIONS!</div>
        }
        {reason === "gameover" &&
          <div className="rs-gameover-tag">INNINGS ENDED · ALL LIVES LOST</div>
        }

        {/* Big score */}
        <div className="rs-score-block">
          <div className="rs-score-num" style={{ color: rank.color }}>{score}</div>
          <div className="rs-score-lbl">POINTS</div>
        </div>

        {/* Stat bars */}
        <div className="rs-bars">
          {bars.map((b, i) => (
            <div key={i} className="rs-bar-row" style={{ animationDelay:`${0.3 + i*0.15}s` }}>
              <div className="rs-bar-head">
                <span>{b.lbl}</span>
                <span style={{ color: b.color }}>{b.pct ? `${b.val}%` : `${b.val}/${b.tot}`}</span>
              </div>
              <div className="rs-bar-track">
                <div className="rs-bar-fill" style={{ width: show ? `${(b.val/b.tot)*100}%` : "0%", background: b.color }} />
              </div>
            </div>
          ))}
        </div>

        <RippleBtn className="rs-share-cta" onClick={handleShare} disabled={shareStatus === "working"}>
          {shareStatus === "working" ? "Preparing…" : "\uD83D\uDCE4 SHARE MY SCORE"}
        </RippleBtn>
        {shareStatus === "error" &&
          <p className="rs-share-error">Couldn't share right now — try again in a moment.</p>
        }

        <RippleBtn className="rs-cta" onClick={onEnd}>
          🏠 BACK TO HOME
        </RippleBtn>

        {ADSENSE_ENABLED &&
          <div className="rs-ad-strip">
            <AdStrip slot={AD_SLOT_RESULT} />
          </div>
        }
      </div>
    </div>
  );
}

// ── PERSISTENCE (localStorage) ──────────────────────────────────────────────
// Keeps track of which questions this device/browser has already answered
// correctly (excluded forever) and which were shown in the last game
// (excluded from the very next game), so returning players don't see the
// same questions repeated across separate visits — not just within one
// continuous play session.
const LS_CORRECT_KEY = "cricketiq_correct_ids";
const LS_RECENT_KEY  = "cricketiq_recent_ids";
const LS_SEEN_SIGNIN_KEY = "cricketiq_seen_signin_prompt"; // "1" once shown, whether signed in or skipped

function loadIdSet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter(Number.isInteger) : []);
  } catch {
    return new Set(); // localStorage unavailable (private browsing, etc.) — degrade gracefully
  }
}

function saveIdSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // Quota exceeded or unavailable — fine, this is a nice-to-have, not critical
  }
}

function loadFlag(key) {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
function saveFlag(key, value) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen]     = useState("home");
  const [showPlayModeModal, setShowPlayModeModal] = useState(false);
  const [activeRoomCode, setActiveRoomCode] = useState(null);
  const [answered, setAnswered] = useState(() => loadIdSet(LS_CORRECT_KEY)); // correctly answered — excluded forever
  const [recentlySeen, setRecentlySeen] = useState(() => loadIdSet(LS_RECENT_KEY)); // all shown last game — excluded next game
  const [stats, setStats]       = useState({ gamesPlayed:0, bestScore:0, totalCorrect:0 });

  // Persist to localStorage whenever these change, so a returning player
  // (new tab, reopened browser, different day) keeps getting fresh questions.
  useEffect(() => { saveIdSet(LS_CORRECT_KEY, answered); }, [answered]);
  useEffect(() => { saveIdSet(LS_RECENT_KEY, recentlySeen); }, [recentlySeen]);

  // ── Google Sign-In gate ──
  // Shown once, right after the player's first-ever completed game (win or
  // lose). Never asked again after that — whether they signed in or skipped.
  const [user, setUser] = useState(null); // Firebase user object, or null
  const [authReady, setAuthReady] = useState(false); // true once Firebase has checked for an existing session
  const [fontsReady, setFontsReady] = useState(false); // true once Bebas Neue has actually finished loading
  useEffect(() => {
    let cancelled = false;
    waitForFonts().finally(() => { if (!cancelled) setFontsReady(true); });
    // Safety fallback: if font loading somehow hangs (e.g. blocked request),
    // don't leave the splash screen blank forever — show it with whatever
    // font is available after a short wait.
    const fallback = setTimeout(() => { if (!cancelled) setFontsReady(true); }, 1500);
    return () => { cancelled = true; clearTimeout(fallback); };
  }, []);

  // Guarantees the splash screen shows for at least 2 seconds even when
  // everything else (questions, auth, fonts) finishes loading faster than
  // that — otherwise on a fast connection it can flash by almost instantly.
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinSplashElapsed(true), 2000);
    return () => clearTimeout(t);
  }, []);

  const [hasSeenSignInPrompt, setHasSeenSignInPrompt] = useState(() => loadFlag(LS_SEEN_SIGNIN_KEY));

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);
      if (firebaseUser) { setHasSeenSignInPrompt(true); saveFlag(LS_SEEN_SIGNIN_KEY, true); }
    });
    return unsubscribe;
  }, []);

  const markSignInPromptSeen = () => {
    setHasSeenSignInPrompt(true);
    saveFlag(LS_SEEN_SIGNIN_KEY, true);
  };

  // Only gate the very first-ever completed game: no prior games this
  // session/device (stats.gamesPlayed === 0), not already signed in, and
  // not already shown/dismissed before. authReady avoids a flash of the
  // gate before Firebase has had a chance to report an existing session.
  const showSignInGate = authReady && stats.gamesPlayed === 0 && !user && !hasSeenSignInPrompt;

  // Questions now come from the CricketIQ API instead of a bundled array.
  const [questions, setQuestions] = useState(null); // null = not loaded yet
  const [loadError, setLoadError] = useState(null);
  const [loadKey, setLoadKey]     = useState(0); // bump to retry the fetch

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    // Uses /questions/session instead of /questions/game: a much smaller,
    // randomized batch (rather than all 1000 questions every load) that
    // excludes whatever this device has already answered correctly. Faster
    // load, especially on mobile, and it's *why* the no-repeat behavior
    // actually holds across sessions rather than just within one sitting.
    // Deliberately NOT re-run when `answered` changes mid-game — only on
    // initial load / explicit retry (loadKey) — so an in-progress round
    // never gets its question pool swapped out from under it.
    fetch(`${API_BASE_URL}/api/questions/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excludeIds: [...answered], count: 400 }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (cancelled) return;
        if (!data.questions || data.questions.length === 0) {
          throw new Error("API returned no questions");
        }
        setQuestions(data.questions);
      })
      .catch(err => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);


  return (
    <>
      <style>{`
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;600;700&family=Barlow:wght@400;500;600&display=swap');

@keyframes rippleAnim{0%{transform:scale(0);opacity:1}100%{transform:scale(1);opacity:0}}
@keyframes particleFly{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--vx),var(--vy)) scale(0);opacity:0}}
@keyframes scorePop{0%{transform:translateY(0) scale(1);opacity:1}100%{transform:translateY(-40px) scale(1.4);opacity:0}}
@keyframes fadeSlideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes scaleIn{from{opacity:0;transform:scale(0.85)}to{opacity:1;transform:scale(1)}}
@keyframes heartbeat{0%,100%{transform:scale(1)}50%{transform:scale(0.8)}}
@keyframes streakPop{0%{transform:scale(0.5) rotate(-5deg);opacity:0}60%{transform:scale(1.15) rotate(2deg)}100%{transform:scale(1) rotate(0);opacity:1}}
@keyframes glowPulse{0%,100%{opacity:0.18}50%{opacity:0.32}}
@keyframes confettiFall{0%{transform:translateY(-20px) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}
@keyframes ringRotate{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes dotPop{from{transform:scale(0)}to{transform:scale(1)}}
@keyframes cardFlipOut{0%{transform:rotateY(0)}100%{transform:rotateY(-90deg)}}
@keyframes barGrow{from{width:0}to{width:100%}}
@keyframes hsIn{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}
@keyframes ballOrbit{0%,100%{transform:scale(1) rotate(0)}50%{transform:scale(1.08) rotate(8deg)}}
@keyframes lightSweep{0%,100%{opacity:0.06}50%{opacity:0.14}}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#040810}
body{font-family:'Barlow',sans-serif;color:#e2e8f0;overflow-x:hidden;text-size-adjust:100%;-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%}
button{font-family:inherit;cursor:pointer;border:none;outline:none;background:none}
button:disabled{cursor:not-allowed}

/* ── HOME ─────────────────────────────── */
.hs-root{
  min-height:100vh;min-height:100dvh;width:100%;max-width:520px;margin:0 auto;
  padding:calc(28px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(40px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px));
  position:relative;overflow:hidden;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
}
.hs-light{position:absolute;width:500px;height:500px;border-radius:50%;pointer-events:none;animation:lightSweep 4s infinite ease-in-out;}
.hs-user-wrap{position:absolute;top:calc(16px + env(safe-area-inset-top, 0px));right:calc(16px + env(safe-area-inset-right, 0px));z-index:3}
.hs-user-chip{
  display:flex;align-items:center;gap:6px;
  background:#0f172a;border:1px solid #1e3a5f;border-radius:20px;
  padding:4px 12px 4px 4px;
}
.hs-user-avatar{width:24px;height:24px;border-radius:50%;object-fit:cover}
.hs-user-avatar-fallback{display:flex;align-items:center;justify-content:center;background:#334155;color:#e2e8f0;font-size:12px;font-weight:700}
.hs-user-name{font-size:11px;color:#94a3b8;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hs-user-menu{
  position:absolute;top:calc(100% + 6px);right:0;min-width:120px;
  background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;
  padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);
  animation:scaleIn 0.15s ease both;transform-origin:top right;
}
.hs-user-menu-item{
  width:100%;text-align:left;font-size:13px;color:#f87171;
  padding:8px 12px;border-radius:8px;
}
@media (hover: hover) {
  .hs-user-menu-item:hover{background:#ef444422}
}
.hs-light-1{background:radial-gradient(circle,#f59e0b22 0%,transparent 70%);top:-150px;left:-100px;animation-delay:0s}
.hs-light-2{background:radial-gradient(circle,#ef444422 0%,transparent 70%);top:-100px;right:-120px;animation-delay:1.5s}
.hs-light-3{background:radial-gradient(circle,#38bdf822 0%,transparent 70%);bottom:-200px;left:50%;transform:translateX(-50%);animation-delay:3s}
.hs-ring{position:absolute;border-radius:50%;border:1px solid rgba(255,255,255,0.03);left:50%;top:40%;pointer-events:none;}
.hs-ring-1{width:300px;height:300px;transform:translate(-50%,-50%)}
.hs-ring-2{width:500px;height:500px;transform:translate(-50%,-50%)}
.hs-ring-3{width:700px;height:700px;transform:translate(-50%,-50%)}

.hs-content{display:flex;flex-direction:column;align-items:center;gap:22px;width:100%;position:relative;z-index:1;}
.hs-content.hs-in{animation:hsIn 0.25s ease both}

.hs-logo-block{text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}
.hs-ball-wrap{position:relative;display:inline-block;margin-bottom:4px}
.hs-ball{font-size:64px;display:block;animation:ballOrbit 3s ease-in-out infinite;filter:drop-shadow(0 0 24px #f59e0b88)}
.hs-ball-glow{position:absolute;inset:-10px;border-radius:50%;background:radial-gradient(circle,#f59e0b33,transparent 70%);pointer-events:none}
.hs-title{font-family:'Bebas Neue',sans-serif;font-size:64px;letter-spacing:6px;line-height:1;background:linear-gradient(135deg,#b5d99c 0%,#ffff82 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-shadow:none}
.hs-title span{background:linear-gradient(135deg,#b5d99c,#ffff82);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hs-tagline{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:4px;color:#475569;text-transform:uppercase}

.hs-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%}
.hs-stat-card{background:linear-gradient(135deg,#0f172a,#1e293b);border:1px solid #1e3a5f;border-radius:14px;padding:16px 8px;text-align:center;animation:scaleIn 0.25s ease both}
.hs-stat-icon{font-size:22px;margin-bottom:4px}
.hs-stat-val{font-family:'Bebas Neue',sans-serif;font-size:30px;color:#f59e0b}
.hs-stat-lbl{font-size:10px;color:#475569;letter-spacing:2px;text-transform:uppercase;margin-top:2px}

.hs-rules{width:100%;background:linear-gradient(135deg,#0f172a,#1a2744);border:1px solid #1e3a5f;border-radius:16px;padding:18px 16px}
.hs-rules-grid{display:flex;flex-direction:column;gap:12px}
.hs-rule-item{display:flex;gap:12px;align-items:flex-start}
.hs-rule-icon{font-size:20px;flex-shrink:0;margin-top:1px}
.hs-rule-text{flex:1;min-width:0;text-align:left}
.hs-rule-head{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;color:#e2e8f0;letter-spacing:1px;text-align:left}
.hs-rule-sub{font-size:12px;color:#64748b;margin-top:2px;text-align:left}

.hs-cta{
  width:100%;padding:0;border-radius:16px;overflow:hidden;
  background:linear-gradient(135deg,#b5d99c,#ffff82);
  box-shadow:0 8px 32px #b5d99c44;transition:transform 0.2s,box-shadow 0.2s;
}
@media (hover: hover) {
  .hs-cta:hover{transform:translateY(-3px);box-shadow:0 12px 40px #b5d99c66}
  .hs-cta:hover .hs-cta-arrow{transform:translateX(4px)}
}
.hs-cta:active{transform:translateY(0)}
.hs-cta-inner{display:flex;align-items:center;justify-content:center;gap:12px;padding:18px 32px;font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:3px;color:#0f172a}
.hs-cta-arrow{font-size:18px;animation:none;transition:transform 0.2s}
.hs-cta-shine{position:absolute;top:0;left:-100%;width:60%;height:100%;background:linear-gradient(105deg,transparent,rgba(255,255,255,0.2),transparent);animation:shineSlide 3s infinite;pointer-events:none}
.hs-signin-row{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;margin-top:2px}
.hs-signin-prompt{font-family:'Barlow Condensed',sans-serif;font-size:14px;color:#94a3b8;text-align:center;margin:0}
.hs-google-btn{width:100%}
.hs-google-btn-primary{padding:18px;font-size:17px}
.hs-signin-error{font-size:11px;color:#ef4444;text-align:center;max-width:280px;margin:0}
.hs-ad-strip{width:100%;margin-top:8px}
.hs-footer-links{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px;font-size:11px;color:#475569}
.hs-footer-links a{color:#64748b;text-decoration:underline}
.rs-ad-strip{width:100%;margin-top:8px}
@keyframes shineSlide{0%{left:-100%}50%,100%{left:150%}}

.hs-footer{font-size:11px;color:#334155;letter-spacing:2px;text-transform:uppercase}

/* ── QUIZ ─────────────────────────────── */
.qs-root{
  min-height:100vh;min-height:100dvh;width:100%;max-width:520px;margin:0 auto;
  padding:calc(20px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) calc(28px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px));
  display:flex;flex-direction:column;gap:14px;
  position:relative;overflow:hidden;
  transform:translateZ(0);-webkit-transform:translateZ(0);
}
.qs-bg-glow{position:absolute;width:500px;height:500px;border-radius:50%;filter:blur(90px);opacity:0.08;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:0;animation:glowPulse 3s infinite;transition:background 0.5s}

.qs-topbar{display:flex;align-items:center;gap:6px;position:relative;z-index:1;flex-wrap:wrap;row-gap:8px}
.qs-topbar-spacer{flex:1;min-width:4px}
.qs-topbar-divider{width:1px;height:24px;background:#1e3a5f;flex-shrink:0}
.qs-lives{display:flex;gap:4px;flex-shrink:0}
.qs-heart{font-size:19px;transition:all 0.3s}
.qs-heart.dead{animation:heartbeat 0.4s ease}
.qs-score-wrap{position:relative;flex-shrink:0}
.qs-score{font-family:'Bebas Neue',sans-serif;font-size:19px;color:#f59e0b;background:#0f172a;border:1px solid #f59e0b33;border-radius:18px;padding:3px 11px;white-space:nowrap}
.qs-score span{font-size:11px;color:#475569;margin-left:2px}
.qs-streak{font-family:'Bebas Neue',sans-serif;font-size:15px;color:var(--sc);background:color-mix(in srgb,var(--sc) 15%,transparent);border:1px solid color-mix(in srgb,var(--sc) 40%,transparent);border-radius:18px;padding:3px 9px;animation:streakPop 0.4s ease;flex-shrink:0;white-space:nowrap}

.qs-ll-mini-row{display:flex;gap:6px;flex-shrink:0}
.qs-ll-mini{
  display:flex;align-items:center;justify-content:center;gap:3px;
  background:linear-gradient(135deg,#0f172a,#1e293b);
  border:1.5px solid #1e3a5f;border-radius:9px;padding:5px 8px;
  transition:all 0.2s;position:relative;flex-shrink:0;
}
@media (hover: hover) {
  .qs-ll-mini:hover:not(:disabled){border-color:#a78bfa;box-shadow:0 3px 12px #a78bfa22}
}
.qs-ll-mini-icon{font-family:'Bebas Neue',sans-serif;font-size:12px;color:#a78bfa;letter-spacing:0.5px;white-space:nowrap}
.qs-ll-mini-used{opacity:0.35}
.qs-ll-mini-strike{position:absolute;inset:0;border-radius:10px;overflow:hidden}
.qs-ll-mini-strike::after{content:'';position:absolute;top:50%;left:-5%;width:110%;height:1.5px;background:#ef4444;transform:rotate(-20deg)}

.qs-ribbon{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#0f172a,#131c35);border:1px solid #1e3a5f;border-radius:14px;padding:10px 16px;position:relative;z-index:1}
.qs-ribbon-item{display:flex;flex-direction:column;align-items:center;gap:2px;flex:1}
.qs-ribbon-val{font-family:'Bebas Neue',sans-serif;font-size:22px;line-height:1;transition:color 0.3s}
.qs-ribbon-lbl{font-size:9px;color:#475569;letter-spacing:2px;font-family:'Barlow Condensed',sans-serif;font-weight:700}
.qs-ribbon-sep{width:1px;height:28px;background:#1e3a5f}

.qs-card-wrap{
  background:linear-gradient(135deg,#0f172a 0%,#131c35 100%);
  border:1px solid #1e3a5f;border-radius:20px;padding:20px;
  position:relative;z-index:1;
  transform-style:preserve-3d;transition:transform 0.35s ease;
}
.qs-card-wrap.flipping{animation:cardFlipOut 0.4s ease forwards}
.qs-card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.qs-cat-badge{
  font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;
  color:var(--cc);background:color-mix(in srgb,var(--cc) 15%,transparent);
  border:1px solid color-mix(in srgb,var(--cc) 35%,transparent);
  border-radius:20px;padding:5px 12px;display:flex;gap:6px;align-items:center;
}
.qs-qnum{font-family:'Bebas Neue',sans-serif;font-size:13px;letter-spacing:3px;margin-bottom:10px}
.qs-qtext{font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:600;line-height:1.5;color:#e2e8f0}
.qs-correct-reveal{font-family:'Bebas Neue',sans-serif;font-size:20px;color:#34d399;margin-top:8px;letter-spacing:1px}

.qs-options{display:flex;flex-direction:column;gap:10px;position:relative;z-index:1}
.qs-opt{
  display:flex;align-items:center;gap:13px;padding:14px 16px;
  border-radius:14px;border:1.5px solid #1e3a5f;
  background:linear-gradient(135deg,#0f172a,#131c35);
  text-align:left;transition:transform 0.15s,border-color 0.2s,background 0.2s;
  animation:fadeSlideUp 0.35s ease both;
  opacity:1;
  color:#e2e8f0;width:100%;
}
@media (hover: hover) {
  .qs-opt:hover:not(:disabled){transform:translateX(6px);border-color:var(--cc);background:linear-gradient(135deg,#1a2744,#1e2f50)}
}
.qs-opt-label{
  width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  font-family:'Bebas Neue',sans-serif;font-size:16px;flex-shrink:0;
  background:#1e293b;color:#64748b;border:1.5px solid #334155;transition:all 0.2s;
}
.qs-opt-label-correct{background:#34d399;color:#fff;border-color:#34d399;box-shadow:0 0 12px #34d39966}
.qs-opt-label-wrong{background:#ef4444;color:#fff;border-color:#ef4444;box-shadow:0 0 12px #ef444466}
.qs-opt-text{flex:1;font-size:14px;font-weight:500;line-height:1.4}
.qs-opt-check{font-size:20px;color:#34d399;font-weight:900;margin-left:auto}
.qs-opt-cross{font-size:20px;color:#ef4444;font-weight:900;margin-left:auto}

.qs-opt-correct{border-color:#34d399;background:linear-gradient(135deg,#052e16,#0d2818)!important;animation:scaleIn 0.3s ease}
.qs-opt-wrong{border-color:#ef4444;background:linear-gradient(135deg,#2d0707,#1e0f0f)!important;animation:shake 0.4s ease}
.qs-opt-elim{opacity:0.15 !important;pointer-events:none;animation:none !important;filter:grayscale(1);transform:none !important}
.qs-opt-dim{opacity:0.4 !important;pointer-events:none}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}

/* ── RESULT ─────────────────────────── */
.rs-root{
  min-height:100vh;min-height:100dvh;width:100%;max-width:520px;margin:0 auto;
  padding:calc(28px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(28px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px));
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  position:relative;overflow:hidden;gap:0;
  transform:translateZ(0);-webkit-transform:translateZ(0);
}
.rs-bg-glow{position:absolute;width:500px;height:500px;border-radius:50%;filter:blur(100px);opacity:0.12;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;animation:glowPulse 2.5s infinite}
.rs-confetti{position:fixed;width:10px;height:10px;border-radius:2px;animation:confettiFall 2s ease-in both}

.rs-content{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:16px;width:100%;opacity:0;transition:opacity 0.5s,transform 0.5s;transform:translateY(20px)}
.rs-show{opacity:1;transform:translateY(0)}
.rs-icon-wrap{position:relative;display:flex;align-items:center;justify-content:center;width:96px;height:96px;margin:0 auto 24px;isolation:isolate}
.rs-icon-wrap::before{content:'';position:absolute;inset:-12px;border-radius:50%;border:2px solid var(--ring-color,#94a3b8);opacity:0.4;animation:ringRotate 8s linear infinite;pointer-events:none;z-index:-1}
.rs-icon{font-size:80px;line-height:1;display:flex;align-items:center;justify-content:center;animation:scaleIn 0.6s cubic-bezier(.34,1.56,.64,1) both}
.rs-result-label{font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:4px}
.rs-result-sub{font-size:14px;color:#94a3b8;text-align:center}
.rs-gameover-tag{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:3px;color:#ef4444;background:#ef444411;border:1px solid #ef444433;border-radius:20px;padding:4px 14px}

.rs-score-block{text-align:center;margin:4px 0}
.rs-score-num{font-family:'Bebas Neue',sans-serif;font-size:88px;line-height:1;letter-spacing:-2px}
.rs-score-lbl{font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:6px;color:#475569;margin-top:-8px}

.rs-bars{width:100%;background:linear-gradient(135deg,#0f172a,#1a2744);border:1px solid #1e3a5f;border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:16px}
.rs-bar-row{animation:fadeSlideUp 0.5s ease both}
.rs-bar-head{display:flex;justify-content:space-between;font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;color:#94a3b8;margin-bottom:8px}
.rs-bar-track{background:#1e293b;border-radius:6px;height:8px;overflow:hidden}
.rs-bar-fill{height:100%;border-radius:6px;transition:width 1s cubic-bezier(.34,1.2,.64,1)}

.rs-share-cta{
  width:100%;padding:18px;border-radius:16px;margin-top:4px;
  background:linear-gradient(135deg,#b5d99c,#ffff82);
  border:none;
  font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:3px;color:#0f172a;
  transition:all 0.2s;box-shadow:0 4px 16px rgba(181,217,156,0.15);
}
.rs-share-cta:disabled{opacity:0.7}
@media (hover: hover) {
  .rs-share-cta:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 24px rgba(181,217,156,0.25)}
}
.rs-share-error{font-size:12px;color:#ef4444;text-align:center;margin:0}

.rs-cta{
  width:100%;padding:18px;border-radius:16px;
  background:linear-gradient(135deg,#1e293b,#273549);
  border:1.5px solid #334155;
  font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:3px;color:#e2e8f0;
  transition:all 0.2s;margin-top:4px;
}
@media (hover: hover) {
  .rs-cta:hover{border-color:#f59e0b;color:#f59e0b;transform:translateY(-2px);box-shadow:0 6px 20px #f59e0b22}
}

/* ── SIGN-IN GATE ─────────────────────── */
.sg-root{
  min-height:100vh;min-height:100dvh;width:100%;max-width:520px;margin:0 auto;
  padding:calc(28px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(28px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px));
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  position:relative;overflow:hidden;
  transform:translateZ(0);-webkit-transform:translateZ(0);
}
.sg-content{display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;text-align:center;opacity:0;transform:translateY(20px);transition:opacity 0.5s,transform 0.5s}
.sg-in{opacity:1;transform:translateY(0)}
.sg-icon{font-size:64px;line-height:1;display:flex;align-items:center;justify-content:center;height:80px;animation:scaleIn 0.6s cubic-bezier(.34,1.56,.64,1) both}
.sg-title{font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px;margin:0;color:#e2e8f0}
.sg-sub{font-size:14px;color:#94a3b8;line-height:1.5;max-width:340px;margin:0 0 8px}
.sg-google-btn{
  width:100%;max-width:320px;padding:14px 20px;border-radius:14px;
  background:#fff;color:#1f1f1f;
  display:flex;align-items:center;justify-content:center;gap:10px;
  font-family:'Barlow',sans-serif;font-size:15px;font-weight:600;
  transition:all 0.2s;box-shadow:0 4px 16px rgba(0,0,0,0.2);
}
@media (hover: hover) {
  .sg-google-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,0.3)}
}
.sg-google-btn:disabled{opacity:0.7}
.sg-error{font-size:12px;color:#ef4444;max-width:300px;margin:0}
.sg-skip{margin-top:4px;font-size:13px;color:#64748b;text-decoration:underline;background:none;padding:8px}

/* ── PLAY MODE MODAL ──────────────────── */
.pm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.32);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px}
.pm-modal{width:100%;max-width:360px;background:linear-gradient(180deg,#0a1420,#0f172a);border-radius:24px;border:1px solid #1e3a5f;padding:26px 22px;animation:scaleIn 0.25s ease both}
.pm-title{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:#e2e8f0;text-align:center;margin-bottom:20px}
.pm-card{width:100%;display:flex;align-items:center;gap:14px;border-radius:16px;padding:18px;margin-bottom:12px;text-align:left;transition:transform 0.15s}
.pm-card:last-child{margin-bottom:0}
.pm-card-offline{background:linear-gradient(135deg,#0f172a,#1a2744);border:1.5px solid #1e3a5f}
.pm-card-room{background:linear-gradient(135deg,#0f172a,#1a2744);border:1.5px solid #1e3a5f}
.pm-card-icon{font-size:28px;flex-shrink:0}
.pm-card-text{display:flex;flex-direction:column;gap:2px}
.pm-card-heading{font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:1px}
.pm-heading-offline{color:#b5d99c}
.pm-heading-room{color:#c4b5fd}
.pm-card-sub{font-family:'Barlow Condensed',sans-serif;font-size:13px;color:#94a3b8}

/* ── ROOM SCREEN ──────────────────────── */
.room-root{
  min-height:100vh;min-height:100dvh;width:100%;max-width:520px;margin:0 auto;
  padding:calc(20px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(28px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px));
  display:flex;flex-direction:column;position:relative;
  transform:translateZ(0);-webkit-transform:translateZ(0);
}
.room-back{align-self:flex-start;font-family:'Barlow Condensed',sans-serif;font-size:14px;color:#94a3b8;background:none;padding:6px 0;margin-bottom:16px}
.room-title{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;color:#e2e8f0;margin-bottom:4px}
.room-subtitle{font-family:'Barlow Condensed',sans-serif;font-size:13px;color:#64748b;margin-bottom:22px}
.room-tabs{display:flex;background:#0f172a;border-radius:12px;padding:4px;margin-bottom:20px}
.room-tab{flex:1;text-align:center;padding:10px;border-radius:9px;font-family:'Bebas Neue',sans-serif;font-size:14px;letter-spacing:1px;color:#64748b;background:none}
.room-tab-active{background:#ffffff;color:#1f1f1f}
.room-name-input,.room-code-input{
  width:100%;background:#0f172a;border:1.5px solid #1e3a5f;border-radius:12px;
  padding:14px 16px;font-family:'Barlow Condensed',sans-serif;font-size:16px;color:#e2e8f0;
  margin-bottom:16px;box-sizing:border-box;
}
.room-code-input{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:8px;text-align:center}
.room-name-input::placeholder,.room-code-input::placeholder{color:#475569;letter-spacing:normal}
.room-desc{font-family:'Barlow Condensed',sans-serif;font-size:14px;color:#94a3b8;line-height:1.5;margin:0 0 20px}
.room-primary-btn{width:100%;background:linear-gradient(135deg,#b5d99c,#ffff82);color:#0f172a;font-family:'Bebas Neue',sans-serif;font-size:17px;letter-spacing:2px;padding:16px;border-radius:14px}
.room-primary-btn:disabled{opacity:0.7}
.room-error{font-family:'Barlow Condensed',sans-serif;font-size:13px;color:#ef4444;text-align:center;margin-top:14px}

.room-code-label{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:2px;color:#64748b;text-align:center;margin-bottom:8px}
.room-code{font-family:'Bebas Neue',sans-serif;font-size:40px;letter-spacing:9px;color:#b5d99c;text-align:center;margin-bottom:18px}
.room-share-row{display:flex;gap:10px;margin-bottom:26px}
.room-share-btn{flex:1;background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:center;gap:6px;font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:1px;color:#e2e8f0}
.room-share-icon{font-size:14px}
.room-share-primary{background:#ffffff;border-color:transparent;color:#1f1f1f}
.room-players-label{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:#64748b;margin-bottom:10px}
.room-players-list{display:flex;flex-direction:column;gap:8px;margin-bottom:24px;flex:1}
.room-player-row{display:flex;align-items:center;gap:10px;background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;padding:10px 14px}
.room-player-avatar{width:28px;height:28px;border-radius:50%;background:#b5d99c;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:13px;color:#0f172a;flex-shrink:0}
.room-player-name{font-family:'Barlow Condensed',sans-serif;font-size:14px;color:#e2e8f0;flex:1;text-align:left}
.room-player-host{font-family:'Barlow Condensed',sans-serif;font-size:10px;letter-spacing:1px;color:#f59e0b}
.room-player-empty{border-style:dashed;color:#475569;font-family:'Barlow Condensed',sans-serif;font-size:13px;justify-content:center}
.room-start-btn{width:100%;background:linear-gradient(135deg,#b5d99c,#ffff82);color:#0f172a;font-family:'Bebas Neue',sans-serif;font-size:17px;letter-spacing:2px;padding:16px;border-radius:14px}
.room-start-btn:disabled{opacity:0.5}
.room-waiting-host{text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:14px;color:#94a3b8;padding:16px}
.room-loading{text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:15px;color:#94a3b8;padding:60px 20px}

/* ── ROOM QUIZ ────────────────────────── */
.room-waiting-block{margin-top:20px;text-align:center;position:relative;z-index:1}
.room-waiting-text{font-family:'Barlow Condensed',sans-serif;font-size:13px;color:#94a3b8;margin-bottom:10px}
.room-waiting-avatars{display:flex;justify-content:center;gap:6px}
.room-waiting-avatar{width:26px;height:26px;border-radius:50%;background:#1e3a5f;color:#64748b;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:11px;transition:all 0.3s}
.room-waiting-avatar-done{background:#34d399;color:#052e14}
.room-progress-track{width:100%;height:6px;background:#0f172a;border-radius:4px;overflow:hidden;margin:14px 0 4px;position:relative;z-index:1}
.room-progress-fill{height:100%;background:linear-gradient(90deg,#b5d99c,#34d399);border-radius:4px;transition:width 0.5s ease}

/* ── ROOM LEADERBOARD ─────────────────── */
.lb-trophy{font-size:44px;text-align:center;margin-bottom:14px}
.lb-title{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:2px;color:#f59e0b;text-align:center;margin-bottom:4px}
.lb-room-code{font-family:'Barlow Condensed',sans-serif;font-size:12px;color:#64748b;text-align:center;margin-bottom:24px}
.lb-list{display:flex;flex-direction:column;gap:8px;width:100%;margin-bottom:24px}
.lb-row{display:flex;align-items:center;gap:12px;background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;padding:12px 14px}
.lb-row-first{background:linear-gradient(135deg,#2d2408,#3d3010);border-color:#f59e0b}
.lb-rank{font-family:'Bebas Neue',sans-serif;font-size:18px;width:20px;flex-shrink:0}
.lb-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:14px;flex-shrink:0}
.lb-name{font-family:'Barlow Condensed',sans-serif;font-size:15px;color:#e2e8f0;flex:1;text-align:left}
.lb-score{font-family:'Bebas Neue',sans-serif;font-size:20px}
      `}</style>

      {(questions === null || !authReady || !fontsReady || !minSplashElapsed) && !loadError && (
        <div className="hs-root">
          <div className="hs-content hs-in">
            <div className="hs-logo-block">
              <div className="hs-ball-wrap">
                <div className="hs-ball">🏏</div>
                <div className="hs-ball-glow" />
              </div>
              <h1 className="hs-title">CRICKET<span>IQ</span></h1>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="hs-root">
          <div className="hs-content hs-in">
            <div className="hs-logo-block">
              <div className="hs-ball-wrap">
                <div className="hs-ball">🏏</div>
              </div>
              <h1 className="hs-title">CRICKET<span>IQ</span></h1>
              <p className="hs-tagline">COULDN'T REACH THE QUESTION API</p>
            </div>
            <p style={{ color:"#94a3b8", fontSize:14, textAlign:"center", maxWidth:340 }}>
              Make sure the CricketIQ API is running at <code>{API_BASE_URL}</code> (<code>npm start</code> inside <code>cricketiq-api</code>), then retry.
            </p>
            <RippleBtn className="hs-cta" onClick={() => { setQuestions(null); setLoadKey(k => k + 1); }}>
              <span className="hs-cta-inner">
                <span>RETRY</span>
                <span className="hs-cta-arrow">↻</span>
              </span>
            </RippleBtn>
          </div>
        </div>
      )}

      {questions !== null && authReady && fontsReady && minSplashElapsed && screen === "home" && (
        <HomeScreen
          onStart={() => setShowPlayModeModal(true)}
          stats={stats}
          totalQuestions={questions.length}
          user={user}
          onSignOut={() => signOut(auth)}
          showSignInLink={hasSeenSignInPrompt}
        />
      )}

      {showPlayModeModal && (
        <PlayModeModal
          onClose={() => setShowPlayModeModal(false)}
          onPlayOffline={() => { setShowPlayModeModal(false); setScreen("quiz"); }}
          onPlayRoom={() => { setShowPlayModeModal(false); setScreen("room"); }}
        />
      )}

      {screen === "room" && (
        <RoomScreen
          user={user}
          onExit={() => setScreen("home")}
          onRequestStart={async (roomCode) => {
            // Host-only: writes the actual "start" to Firestore. Does NOT
            // navigate directly — every client, including this one, picks
            // up the resulting status change via the shared listener below
            // and navigates through the exact same path.
            try {
              await startRoomGame({ code: roomCode });
            } catch (err) {
              console.error("Failed to start room game:", err);
            }
          }}
          onGameStart={(roomCode) => {
            // Fires for every client (host and joiners alike) the moment
            // room.status flips to "playing" — this is the one and only
            // place navigation into the quiz screen happens.
            setActiveRoomCode(roomCode);
            setScreen("room-quiz");
          }}
        />
      )}

      {screen === "room-quiz" && activeRoomCode && (
        <RoomQuizScreen
          roomCode={activeRoomCode}
          playerId={getOrCreateLocalPlayerId()}
          onFinish={() => setScreen("room-leaderboard")}
          onLeave={() => { setActiveRoomCode(null); setScreen("home"); }}
        />
      )}

      {screen === "room-leaderboard" && activeRoomCode && (
        <RoomLeaderboardScreen
          roomCode={activeRoomCode}
          playerId={getOrCreateLocalPlayerId()}
          onBackHome={() => { setActiveRoomCode(null); setScreen("home"); }}
        />
      )}

      {questions !== null && screen === "quiz" && (
        <QuizScreen
          key={stats.gamesPlayed}
          questions={questions}
          onEnd={(score, correct, seenIds) => {
            setRecentlySeen(seenIds);          // exclude these from next game start
            setStats(s => ({ gamesPlayed: s.gamesPlayed+1, bestScore: Math.max(s.bestScore, score), totalCorrect: s.totalCorrect+correct }));
            setScreen("home");
          }}
          answeredCorrectly={answered}
          recentlySeen={recentlySeen}
          onMarkCorrect={id => setAnswered(prev => new Set([...prev, id]))}
          showSignInGate={showSignInGate}
          onSignInResolved={markSignInPromptSeen}
          user={user}
        />
      )}
    </>
  );
}
