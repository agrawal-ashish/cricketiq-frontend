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
            <div key={i} className="hs-stat-card" style={{ animationDelay:`${i*0.1}s` }}>
              <div className="hs-stat-icon">{s.icon}</div>
              <div className="hs-stat-val">{s.val}</div>
              <div className="hs-stat-lbl">{s.lbl}</div>
            </div>
          ))}
        </div>

        {/* Rules */}
        <div className="hs-rules">
          <div className="hs-rules-title">HOW TO PLAY</div>
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
        <RippleBtn className="hs-cta" onClick={onStart}>
          <span className="hs-cta-inner">
            <span>PLAY NOW</span>
            <span className="hs-cta-arrow">▶</span>
          </span>
          <div className="hs-cta-shine" />
        </RippleBtn>

        {!user && showSignInLink &&
          <div className="hs-signin-row">
            <RippleBtn className="sg-google-btn hs-google-btn" onClick={handleSignIn} disabled={signInStatus === "working"}>
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
        }

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
function QuizScreen({ questions, onEnd, answeredCorrectly, recentlySeen, onMarkCorrect, showSignInGate, onSignInResolved }) {
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
    if (phase !== "question" || chosen !== null || timeUp) return;
    setChosen(idx);
    setAnswered(a => a + 1);
    const correct = idx === q.correctIdx;

    if (correct) {
      const bonus = streak >= 4 ? 10 : streak >= 2 ? 5 : 0;
      const pts   = 10 + bonus;
      setScore(s => s + pts); setStreak(s => s + 1);
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
    return <ResultScreen score={score} correct={answered - wrong} total={answered} wrong={wrong} reason="gameover" onEnd={() => finishGame(score, answered - wrong)} />;
  }
  if (phase === "complete") {
    if (shouldShowGate) return <SignInGate onContinue={dismissGate} />;
    if (!readyForResults) return null;
    return <ResultScreen score={score} correct={answered} total={answered} wrong={wrong} reason="complete" onEnd={() => finishGame(score, answered)} />;
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
              style={{ "--cc": catMeta.color, animationDelay:`${idx * 0.07}s` }}
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
function ResultScreen({ score, correct, total, wrong, reason, onEnd }) {
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
body{font-family:'Barlow',sans-serif;color:#e2e8f0;overflow-x:hidden}
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
.hs-in > *{animation:hsIn 0.6s ease both}
.hs-in > *:nth-child(1){animation-delay:0s}
.hs-in > *:nth-child(2){animation-delay:0.1s}
.hs-in > *:nth-child(3){animation-delay:0.2s}
.hs-in > *:nth-child(4){animation-delay:0.3s}
.hs-in > *:nth-child(5){animation-delay:0.4s}

.hs-logo-block{text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}
.hs-ball-wrap{position:relative;display:inline-block;margin-bottom:4px}
.hs-ball{font-size:64px;display:block;animation:ballOrbit 3s ease-in-out infinite;filter:drop-shadow(0 0 24px #f59e0b88)}
.hs-ball-glow{position:absolute;inset:-10px;border-radius:50%;background:radial-gradient(circle,#f59e0b33,transparent 70%);pointer-events:none}
.hs-title{font-family:'Bebas Neue',sans-serif;font-size:64px;letter-spacing:6px;line-height:1;background:linear-gradient(135deg,#b5d99c 0%,#ffff82 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-shadow:none}
.hs-title span{background:linear-gradient(135deg,#b5d99c,#ffff82);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hs-tagline{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:4px;color:#475569;text-transform:uppercase}

.hs-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%}
.hs-stat-card{background:linear-gradient(135deg,#0f172a,#1e293b);border:1px solid #1e3a5f;border-radius:14px;padding:16px 8px;text-align:center;animation:scaleIn 0.4s ease both}
.hs-stat-icon{font-size:22px;margin-bottom:4px}
.hs-stat-val{font-family:'Bebas Neue',sans-serif;font-size:30px;color:#f59e0b}
.hs-stat-lbl{font-size:10px;color:#475569;letter-spacing:2px;text-transform:uppercase;margin-top:2px}

.hs-rules{width:100%;background:linear-gradient(135deg,#0f172a,#1a2744);border:1px solid #1e3a5f;border-radius:16px;padding:18px 16px}
.hs-rules-title{font-family:'Bebas Neue',sans-serif;font-size:14px;letter-spacing:4px;color:#f59e0b;margin-bottom:14px}
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
.hs-signin-row{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;margin-top:2px}
.hs-google-btn{width:100%}
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
      `}</style>

      {questions === null && !loadError && (
        <div className="hs-root">
          <div className="hs-content hs-in">
            <div className="hs-logo-block">
              <div className="hs-ball-wrap">
                <div className="hs-ball">🏏</div>
                <div className="hs-ball-glow" />
              </div>
              <h1 className="hs-title">CRICKET<span>IQ</span></h1>
              <p className="hs-tagline">◆ LOADING QUESTIONS… ◆</p>
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

      {questions !== null && screen === "home" && (
        <HomeScreen
          onStart={() => setScreen("quiz")}
          stats={stats}
          totalQuestions={questions.length}
          user={user}
          onSignOut={() => signOut(auth)}
          showSignInLink={hasSeenSignInPrompt}
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
        />
      )}
    </>
  );
}
