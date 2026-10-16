import { useState, useEffect, useRef, useCallback } from "react";

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
  ear_threshold: 0.20,
  sleep_frame_threshold: 15,
  no_face_frame_threshold: 20,
  blink_rate_low: 8,
  blink_rate_high: 25,
  nose_left_bound: 0.3,
  nose_right_bound: 0.7,
  head_pitch_threshold: 20,
  head_yaw_threshold: 30,
  posture_shoulder_threshold: 0.05,
  alert_cooldown_seconds: 5,
  alert_volume: 0.8,
  desktop_notifications: true,
  pomodoro_work_minutes: 25,
  pomodoro_break_minutes: 5,
  pomodoro_long_break_minutes: 15,
  pomodoro_cycles_before_long_break: 4,
  privacy_mode: false,
  ambient_sound_enabled: false,
  ambient_volume_focused: 0.5,
  ambient_volume_distracted: 0.1,
  notion_enabled: false,
  notion_token: "",
  notion_database_id: "",
  camera_index: 0,
};

const ACHIEVEMENT_DEFS = [
  { id: "first_session", name: "First Steps", desc: "Complete your first session", icon: "🚀" },
  { id: "focus_90", name: "Sharp Mind", desc: "Achieve 90%+ focus", icon: "🧠" },
  { id: "focus_100", name: "In The Zone", desc: "Achieve 100% focus", icon: "⚡" },
  { id: "30_min", name: "Deep Work", desc: "Complete a 30-min session", icon: "⏱" },
  { id: "60_min", name: "Marathon Focus", desc: "Complete a 60-min session", icon: "🏅" },
  { id: "5_sessions", name: "Consistent", desc: "Complete 5 sessions", icon: "📅" },
  { id: "streak_3", name: "3-Day Streak", desc: "3 consecutive days", icon: "🔥" },
  { id: "streak_7", name: "Week Warrior", desc: "7 consecutive days", icon: "🏆" },
  { id: "no_alerts", name: "Unwavering", desc: "Session with zero alerts", icon: "🎯" },
];

const STATE_CONFIG = {
  focused: { label: "FOCUSED", bg: "#16a34a", text: "#dcfce7", dot: "#22c55e" },
  drowsy:  { label: "WAKE UP!", bg: "#dc2626", text: "#fee2e2", dot: "#ef4444" },
  away:    { label: "LOOK HERE", bg: "#d97706", text: "#fef3c7", dot: "#f59e0b" },
  no_face: { label: "NO FACE",  bg: "#4b5563", text: "#f3f4f6", dot: "#9ca3af" },
};

// ── EAR helper ────────────────────────────────────────────────────────────────
function calcEAR(lm, idx) {
  const dist = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  return (dist(idx[1], idx[5]) + dist(idx[2], idx[4])) / (2 * dist(idx[0], idx[3]));
}

// ── Blink Detector ────────────────────────────────────────────────────────────
class BlinkDetector {
  constructor(threshold = 0.20, minClosed = 2, windowSec = 60) {
    this.threshold = threshold;
    this.minClosed = minClosed;
    this.windowSec = windowSec;
    this._closedFrames = 0;
    this._inBlink = false;
    this._blinkTimes = [];
    this.totalBlinks = 0;
  }
  update(ear) {
    if (ear < this.threshold) {
      this._closedFrames++;
    } else {
      if (this._inBlink && this._closedFrames >= this.minClosed) {
        this.totalBlinks++;
        this._blinkTimes.push(Date.now() / 1000);
      }
      this._closedFrames = 0;
      this._inBlink = false;
    }
    if (this._closedFrames >= this.minClosed) this._inBlink = true;
    const cutoff = Date.now() / 1000 - this.windowSec;
    this._blinkTimes = this._blinkTimes.filter(t => t > cutoff);
  }
  get blinksPerMinute() {
    if (!this._blinkTimes.length) return 0;
    const elapsed = Date.now() / 1000 - this._blinkTimes[0];
    if (elapsed < 1) return 0;
    return (this._blinkTimes.length / elapsed) * 60;
  }
}

// ── Focus State Machine ───────────────────────────────────────────────────────
class FocusStateMachine {
  constructor(cfg) {
    this.cfg = cfg;
    this.sleepFrames = 0;
    this.noFaceFrames = 0;
    this.focusFrames = 0;
    this.totalFrames = 0;
    this.state = "focused";
    this.drowsyFrames = 0;
    this.awayFrames = 0;
  }
  get focusScore() {
    if (this.totalFrames === 0) return 100;
    return Math.round((this.focusFrames / this.totalFrames) * 100);
  }
  update(faceFound, ear, pitch, yaw, noseX) {
    this.totalFrames++;
    const cfg = this.cfg;
    if (!faceFound) {
      this.noFaceFrames++;
      this.sleepFrames = 0;
      this.state = "no_face";
      return this.state;
    }
    this.noFaceFrames = 0;
    const lookingAway =
      (noseX !== null && (noseX < cfg.nose_left_bound || noseX > cfg.nose_right_bound)) ||
      (yaw !== null && Math.abs(yaw) > cfg.head_yaw_threshold);
    const eyesClosed = ear < cfg.ear_threshold;
    if (eyesClosed) this.sleepFrames++;
    else this.sleepFrames = 0;
    if (this.sleepFrames > cfg.sleep_frame_threshold) {
      this.state = "drowsy"; this.drowsyFrames++;
    } else if (lookingAway) {
      this.state = "away"; this.awayFrames++;
    } else {
      this.state = "focused"; this.focusFrames++;
    }
    return this.state;
  }
  get focusPct()  { return this.totalFrames ? Math.round(this.focusFrames  / this.totalFrames * 100) : 0; }
  get drowsyPct() { return this.totalFrames ? Math.round(this.drowsyFrames / this.totalFrames * 100) : 0; }
  get awayPct()   { return this.totalFrames ? Math.round(this.awayFrames   / this.totalFrames * 100) : 0; }
}

// ── Pomodoro Timer ────────────────────────────────────────────────────────────
class PomodoroTimer {
  constructor(cfg) {
    this.cfg = cfg;
    this.state = "idle";
    this._start = null;
    this._cycle = 0;
  }
  start() {
    if (this.state === "idle") { this.state = "work"; this._start = Date.now() / 1000; this._cycle = 0; }
  }
  stop() { this.state = "idle"; this._start = null; }
  get durationSeconds() {
    const d = { work: this.cfg.pomodoro_work_minutes * 60, short_break: this.cfg.pomodoro_break_minutes * 60, long_break: this.cfg.pomodoro_long_break_minutes * 60 };
    return d[this.state] || 1500;
  }
  get elapsed()       { return this._start ? Date.now() / 1000 - this._start : 0; }
  get remaining()     { return Math.max(0, this.durationSeconds - this.elapsed); }
  get remainingStr()  { const s = Math.round(this.remaining); return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; }
  get progress()      { return this.state === "idle" ? 0 : Math.min(1, this.elapsed / this.durationSeconds); }
  get isBreak()       { return this.state === "short_break" || this.state === "long_break"; }
  tick() {
    if (this.state === "idle" || !this._start) return null;
    if (this.remaining <= 0) {
      let event;
      if (this.state === "work") {
        this._cycle++;
        if (this._cycle % (this.cfg.pomodoro_cycles_before_long_break || 4) === 0) { this.state = "long_break"; event = "long_break"; }
        else { this.state = "short_break"; event = "short_break"; }
      } else { this.state = "work"; event = "work"; }
      this._start = Date.now() / 1000;
      return event;
    }
    return null;
  }
}

// ── Session Logger ────────────────────────────────────────────────────────────
class SessionLogger {
  constructor() {
    this.events = [];
    this.startTime = Date.now() / 1000;
    const now = new Date();
    this.sessionId = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
  }
  log(event) { this.events.push(event); }
  summary() {
    if (!this.events.length) return null;
    const dur = Date.now() / 1000 - this.startTime;
    const focused = this.events.filter(e => e.state === "focused");
    const drowsy  = this.events.filter(e => e.state === "drowsy");
    const away    = this.events.filter(e => e.state === "away");
    return {
      session_id: this.sessionId,
      date: new Date().toISOString().slice(0, 10),
      duration_min: Math.round(dur / 60 * 100) / 100,
      focus_pct:  Math.round(focused.length / this.events.length * 1000) / 10,
      drowsy_pct: Math.round(drowsy.length  / this.events.length * 1000) / 10,
      away_pct:   Math.round(away.length    / this.events.length * 1000) / 10,
      total_alerts: this.events.filter(e => ["drowsy","away"].includes(e.state)).length,
      avg_blink_rate: Math.round(this.events.reduce((s,e) => s+e.blink_rate,0) / this.events.length * 10) / 10,
      final_focus_score: this.events[this.events.length-1]?.focus_score ?? 0,
    };
  }
}

// ── Streak / Achievements ─────────────────────────────────────────────────────
function checkStreak(history, days) {
  if (history.length < days) return false;
  const dates = [...new Set(history.map(s => s.date).filter(Boolean))].sort();
  if (dates.length < days) return false;
  let streak = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    const diff = (new Date(dates[i]) - new Date(dates[i-1])) / 86400000;
    if (diff === 1) { streak++; if (streak >= days) return true; }
    else streak = 1;
  }
  return false;
}

/** Webcam only — MediaPipe `@mediapipe/camera_utils` has no real ESM exports under Vite, so we use getUserMedia directly. */
async function acquireWebcamStream(cameraIndex = 0) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera not available — use HTTPS or localhost with a modern browser.");
  }
  const base = { width: { ideal: 640 }, height: { ideal: 480 } };
  let constraints = { video: { ...base, facingMode: "user" }, audio: false };
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput"
    );
    if (inputs.length) {
      const i = Math.min(Math.max(0, cameraIndex | 0), inputs.length - 1);
      const id = inputs[i]?.deviceId;
      if (id) constraints = { video: { ...base, deviceId: { exact: id } }, audio: false };
    }
  } catch (_) { /* use facingMode fallback */ }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (constraints.video.deviceId) {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...base, facingMode: "user" },
        audio: false,
      });
    }
    throw e;
  }
}

function checkAchievements(summary, history) {
  const checks = [
    { id: "first_session", fn: (s)    => s.duration_min > 0 },
    { id: "focus_90",      fn: (s)    => s.focus_pct >= 90 },
    { id: "focus_100",     fn: (s)    => s.focus_pct === 100 },
    { id: "30_min",        fn: (s)    => s.duration_min >= 30 },
    { id: "60_min",        fn: (s)    => s.duration_min >= 60 },
    { id: "5_sessions",    fn: (s, h) => h.length >= 5 },
    { id: "streak_3",      fn: (s, h) => checkStreak(h, 3) },
    { id: "streak_7",      fn: (s, h) => checkStreak(h, 7) },
    { id: "no_alerts",     fn: (s)    => s.total_alerts === 0 && s.duration_min >= 10 },
  ];
  return checks.filter(c => { try { return c.fn(summary, history); } catch { return false; } }).map(c => c.id);
}

// ── Audio helper ──────────────────────────────────────────────────────────────
function useAlertAudio(cfg, alertAudioRef) {
  const lastAlertRef = useRef(0);
  return useCallback(() => {
    const now = Date.now() / 1000;
    if (now - lastAlertRef.current < (cfg.alert_cooldown_seconds || 5)) return;
    lastAlertRef.current = now;
    if (alertAudioRef.current) {
      alertAudioRef.current.volume = cfg.alert_volume ?? 0.8;
      alertAudioRef.current.currentTime = 0;
      alertAudioRef.current.play().catch(() => {});
    }
  }, [cfg, alertAudioRef]);
}

// ── UI Components ─────────────────────────────────────────────────────────────
function CircularProgress({ value, size = 120, stroke = 8, color = "#22c55e", children }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#374151" strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ - (value / 100) * circ}
          style={{ transition: "stroke-dashoffset 0.5s ease" }} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
}

function Bar({ value, max = 100, color, height = 6 }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div style={{ background: "#1f2937", borderRadius: 99, height, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 99, transition: "width 0.4s ease" }} />
    </div>
  );
}

function StatCard({ label, value, unit, color = "#9ca3af", sub }) {
  return (
    <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.5px" }}>
        {value}<span style={{ fontSize: 13, fontWeight: 400, color: "#6b7280", marginLeft: 4 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Toast({ toasts }) {
  return (
    <div style={{ position: "fixed", top: 20, right: 20, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type === "achievement" ? "#1c1917" : "#111827",
          border: `1px solid ${t.type === "achievement" ? "#ca8a04" : "#374151"}`,
          borderRadius: 10, padding: "12px 16px", color: "#f9fafb", fontSize: 13,
          display: "flex", alignItems: "center", gap: 10, minWidth: 260,
          animation: "slideIn 0.3s ease",
        }}>
          <span style={{ fontSize: 20 }}>{t.icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t.title}</div>
            <div style={{ color: "#9ca3af", fontSize: 12 }}>{t.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({ cfg, onChange, onClose }) {
  const [local, setLocal] = useState({ ...cfg });
  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));
  const Slider = ({ k, label, min, max, step = 0.01 }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <label style={{ fontSize: 12, color: "#9ca3af" }}>{label}</label>
        <span style={{ fontSize: 12, color: "#e5e7eb", fontFamily: "monospace" }}>{Number(local[k]).toFixed(step < 1 ? 2 : 0)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={local[k]}
        onChange={e => set(k, step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value))}
        style={{ width: "100%", accentColor: "#6366f1" }} />
    </div>
  );
  const Toggle = ({ k, label }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <label style={{ fontSize: 13, color: "#d1d5db" }}>{label}</label>
      <div onClick={() => set(k, !local[k])} style={{ width: 40, height: 22, borderRadius: 99, background: local[k] ? "#6366f1" : "#374151", position: "relative", cursor: "pointer", transition: "background 0.2s" }}>
        <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: local[k] ? 20 : 2, transition: "left 0.2s" }} />
      </div>
    </div>
  );
  const TextInput = ({ k, label, type = "text" }) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>{label}</label>
      <input type={type} value={local[k] || ""} onChange={e => set(k, e.target.value)}
        style={{ width: "100%", background: "#1f2937", border: "1px solid #374151", borderRadius: 8, padding: "8px 12px", color: "#f9fafb", fontSize: 13, boxSizing: "border-box" }} />
    </div>
  );
  const tabs = ["Detection", "Alerts", "Pomodoro", "Notion", "Camera"];
  const [tab, setTab] = useState("Detection");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 16, width: 540, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 24px 0", borderBottom: "1px solid #1e293b" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>⚙️ Settings</h2>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 20 }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {tabs.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ background: tab===t ? "#1e293b" : "none", border: "none", color: tab===t ? "#f9fafb" : "#6b7280", padding: "8px 14px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: 13, fontWeight: tab===t ? 600 : 400 }}>{t}</button>
            ))}
          </div>
        </div>
        <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
          {tab === "Detection" && <><Slider k="ear_threshold" label="EAR threshold (eye closure)" min={0.10} max={0.40} /><Slider k="sleep_frame_threshold" label="Sleep frame count" min={5} max={60} step={1} /><Slider k="no_face_frame_threshold" label="No-face frame count" min={5} max={60} step={1} /><Slider k="nose_left_bound" label="Nose left bound" min={0.1} max={0.5} /><Slider k="nose_right_bound" label="Nose right bound" min={0.5} max={0.9} /><Slider k="head_yaw_threshold" label="Head yaw threshold (°)" min={10} max={60} step={1} /><Slider k="posture_shoulder_threshold" label="Posture threshold" min={0.01} max={0.20} /></>}
          {tab === "Alerts" && <><Slider k="alert_volume" label="Alert volume" min={0} max={1} /><Slider k="alert_cooldown_seconds" label="Alert cooldown (seconds)" min={1} max={30} step={1} /><Toggle k="desktop_notifications" label="Desktop notifications" /></>}
          {tab === "Pomodoro" && <><Slider k="pomodoro_work_minutes" label="Work duration (min)" min={5} max={60} step={1} /><Slider k="pomodoro_break_minutes" label="Short break (min)" min={1} max={30} step={1} /><Slider k="pomodoro_long_break_minutes" label="Long break (min)" min={5} max={60} step={1} /><Slider k="pomodoro_cycles_before_long_break" label="Cycles before long break" min={2} max={8} step={1} /></>}
          {tab === "Notion" && <><Toggle k="notion_enabled" label="Enable Notion sync" /><TextInput k="notion_token" label="Integration token" type="password" /><TextInput k="notion_database_id" label="Database ID" /><p style={{ fontSize: 12, color: "#6b7280", marginTop: 0 }}>Create an integration at notion.so/my-integrations, share your database with it, then paste credentials above.</p></>}
          {tab === "Camera" && <><Slider k="camera_index" label="Camera index" min={0} max={5} step={1} /><Toggle k="privacy_mode" label="Privacy mode (hides video feed)" /><Toggle k="ambient_sound_enabled" label="Ambient music" /><Slider k="ambient_volume_focused" label="Ambient volume (focused)" min={0} max={1} /><Slider k="ambient_volume_distracted" label="Ambient volume (distracted)" min={0} max={1} /></>}
        </div>
        <div style={{ padding: "16px 24px", borderTop: "1px solid #1e293b", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "none", border: "1px solid #374151", color: "#9ca3af", padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Cancel</button>
          <button onClick={() => { onChange(local); onClose(); }} style={{ background: "#6366f1", border: "none", color: "#fff", padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Save & Apply</button>
        </div>
      </div>
    </div>
  );
}

function SessionHistoryPanel({ sessions, onClose }) {
  if (!sessions.length) return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 16, padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
        <p style={{ color: "#9ca3af" }}>No sessions recorded yet. Start a session to track your focus!</p>
        <button onClick={onClose} style={{ background: "#6366f1", border: "none", color: "#fff", padding: "10px 24px", borderRadius: 8, cursor: "pointer", marginTop: 16 }}>Close</button>
      </div>
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 16, width: "min(700px, 95vw)", maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>📈 Session History</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#0f172a", position: "sticky", top: 0 }}>
                {["Date","Duration","Focus %","Drowsy %","Away %","Alerts","Blink/min","Score"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: "#6b7280", fontWeight: 500, borderBottom: "1px solid #1e293b" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...sessions].reverse().map((s, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #111827" }}>
                  <td style={{ padding: "12px 16px", color: "#e5e7eb" }}>{s.date}</td>
                  <td style={{ padding: "12px 16px", color: "#e5e7eb" }}>{s.duration_min}m</td>
                  <td style={{ padding: "12px 16px", color: s.focus_pct >= 70 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{s.focus_pct}%</td>
                  <td style={{ padding: "12px 16px", color: "#f59e0b" }}>{s.drowsy_pct}%</td>
                  <td style={{ padding: "12px 16px", color: "#60a5fa" }}>{s.away_pct}%</td>
                  <td style={{ padding: "12px 16px", color: s.total_alerts > 0 ? "#ef4444" : "#22c55e" }}>{s.total_alerts}</td>
                  <td style={{ padding: "12px 16px", color: "#e5e7eb" }}>{s.avg_blink_rate}</td>
                  <td style={{ padding: "12px 16px", color: "#a78bfa", fontWeight: 600 }}>{s.final_focus_score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function FocusMirror() {
  const [cfg, setCfg] = useState({ ...DEFAULTS });
  const [isRunning, setIsRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [toasts, setToasts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [unlockedAchievements, setUnlockedAchievements] = useState([]);
  const [cameraError, setCameraError] = useState(null);

  // Live detection state
  const [state, setState] = useState("no_face");
  const [ear, setEar] = useState(0);
  const [blinkRate, setBlinkRate] = useState(0);
  const [totalBlinks, setTotalBlinks] = useState(0);
  const [focusScore, setFocusScore] = useState(100);
  const [pitch, setPitch] = useState(null);
  const [yaw, setYaw] = useState(null);
  const [postureSlouching, setPostureSlouching] = useState(false);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [focusPct, setFocusPct] = useState(0);
  const [drowsyPct, setDrowsyPct] = useState(0);
  const [awayPct, setAwayPct] = useState(0);
  const [totalAlerts, setTotalAlerts] = useState(0);

  // Pomodoro
  const [pomoState, setPomoState] = useState("idle");
  const [pomoRemaining, setPomoRemaining] = useState("25:00");
  const [pomoProgress, setPomoProgress] = useState(0);
  const [pomoLabel, setPomoLabel] = useState("");
  const [pomoRunning, setPomoRunning] = useState(false);

  // Refs
  const videoRef         = useRef(null);   // capture element — must stay mounted for MediaPipe (any tab)
  const previewVideoRef  = useRef(null);   // optional mirror for Live Detection tab UI
  const focusMachineRef  = useRef(null);
  const blinkDetRef      = useRef(null);
  const sessionLogRef    = useRef(null);
  const pomoRef          = useRef(null);
  const captureLoopRef   = useRef(null);   // { active: boolean } — stops FaceMesh frame pump
  const faceMeshRef      = useRef(null);   // MediaPipe FaceMesh instance
  const alertAudioRef    = useRef(null);
  const toastCounterRef  = useRef(0);
  const sessionStartRef  = useRef(null);
  const alertCountRef    = useRef(0);
  const lastAlertStateRef= useRef(null);
  const pomoDurRef       = useRef(null);   // setInterval for pomodoro + duration

  const addToast = useCallback((title, message, icon = "🔔", type = "info", duration = 3500) => {
    const id = ++toastCounterRef.current;
    setToasts(p => [...p, { id, title, message, icon, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), duration);
  }, []);

  const playAlert = useAlertAudio(cfg, alertAudioRef);

  // ── Called by MediaPipe on every frame ───────────────────────────────────────
  const handleResults = useCallback((results) => {
    const fm = focusMachineRef.current;
    const bd = blinkDetRef.current;
    if (!fm || !bd) return;

    let newState, earVal = 0, noseX = null, pitchVal = null, yawVal = null;

    if (!results.multiFaceLandmarks?.length) {
      newState = fm.update(false, 0, null, null, null);
    } else {
      const lm = results.multiFaceLandmarks[0];

      // EAR (Eye Aspect Ratio) using MediaPipe landmark indices
      const leftEAR  = calcEAR(lm, [33, 160, 158, 133, 153, 144]);
      const rightEAR = calcEAR(lm, [362, 385, 387, 263, 373, 380]);
      earVal = (leftEAR + rightEAR) / 2;

      // Nose X for head turn detection
      noseX = lm[1].x;

      // Rough yaw from nose vs eye midpoint
      const leftEye  = lm[33];
      const rightEye = lm[263];
      const eyeMidX  = (leftEye.x + rightEye.x) / 2;
      yawVal  = (noseX - eyeMidX) * 200; // scale to degrees-ish
      pitchVal = (lm[10].y - lm[152].y) * 100; // forehead vs chin

      bd.update(earVal);
      newState = fm.update(true, earVal, pitchVal, yawVal, noseX);

      setEar(Math.round(earVal * 1000) / 1000);
      setBlinkRate(Math.round(bd.blinksPerMinute * 10) / 10);
      setTotalBlinks(bd.totalBlinks);
      setPitch(Math.round(pitchVal * 10) / 10);
      setYaw(Math.round(yawVal * 10) / 10);

      // Rough posture: check if shoulder landmarks exist and are uneven
      if (lm[11] && lm[12]) {
        const shoulderDiff = Math.abs(lm[11].y - lm[12].y);
        setPostureSlouching(shoulderDiff > (cfg.posture_shoulder_threshold || 0.05));
      }
    }

    setState(newState);
    setFocusScore(fm.focusScore);
    setFocusPct(fm.focusPct);
    setDrowsyPct(fm.drowsyPct);
    setAwayPct(fm.awayPct);

    // Log every 10 frames
    if (fm.totalFrames % 10 === 0) {
      sessionLogRef.current?.log({
        state: newState, ear: earVal,
        blink_rate: blinkDetRef.current?.blinksPerMinute ?? 0,
        focus_score: fm.focusScore,
        timestamp: Date.now() / 1000,
      });
    }

    // Alerts
    if (["drowsy", "no_face", "away"].includes(newState)) {
      if (newState !== lastAlertStateRef.current) {
        playAlert();
        const msgs = { drowsy: "Wake up! You're getting drowsy.", away: "Look at the screen!", no_face: "No face detected — are you there?" };
        addToast(STATE_CONFIG[newState].label, msgs[newState],
          newState === "drowsy" ? "😴" : newState === "away" ? "👀" : "📷", "alert", 3000);
        alertCountRef.current++;
        setTotalAlerts(alertCountRef.current);
        lastAlertStateRef.current = newState;
      }
    } else {
      lastAlertStateRef.current = null;
    }
  }, [cfg, playAlert, addToast]);

  // ── Start session ─────────────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    setCameraError(null);
    focusMachineRef.current = new FocusStateMachine(cfg);
    blinkDetRef.current     = new BlinkDetector(cfg.ear_threshold);
    sessionLogRef.current   = new SessionLogger();
    pomoRef.current         = new PomodoroTimer(cfg);
    alertCountRef.current   = 0;
    lastAlertStateRef.current = null;
    setTotalAlerts(0);
    setSessionDuration(0);
    sessionStartRef.current = Date.now() / 1000;

    try {
      // Face mesh is a legacy script: attaches FaceMesh to globalThis; Vite import() has no usable exports.
      await import("@mediapipe/face_mesh");
      const FaceMesh = globalThis.FaceMesh;
      if (typeof FaceMesh !== "function") {
        throw new Error("FaceMesh failed to load — check network and @mediapipe/face_mesh install.");
      }

      const faceMesh = new FaceMesh({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      faceMesh.onResults(handleResults);
      faceMeshRef.current = faceMesh;

      if (!videoRef.current) throw new Error("Video element not ready");

      const stream = await acquireWebcamStream(cfg.camera_index ?? 0);
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const loop = { active: true };
      captureLoopRef.current = loop;
      const pump = () => {
        if (!loop.active) return;
        const v = videoRef.current;
        const fm = faceMeshRef.current;
        const frame =
          fm && v && !v.paused && v.readyState >= 2
            ? fm.send({ image: v }).catch((e) => console.error("FaceMesh send:", e))
            : Promise.resolve();
        frame.finally(() => {
          if (loop.active) requestAnimationFrame(pump);
        });
      };
      requestAnimationFrame(pump);

      if (stream && previewVideoRef.current) {
        previewVideoRef.current.srcObject = stream;
        previewVideoRef.current.play().catch(() => {});
      }

    } catch (err) {
      console.error("Camera/MediaPipe error:", err);
      if (captureLoopRef.current) {
        captureLoopRef.current.active = false;
        captureLoopRef.current = null;
      }
      if (faceMeshRef.current) {
        try { faceMeshRef.current.close(); } catch (_) {}
        faceMeshRef.current = null;
      }
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
      setCameraError(err.message || "Could not start camera");
      // Don't block session — still run pomodoro/timer without detection
    }

    setIsRunning(true);
    addToast("Session started", "Focus Mirror is now tracking your focus.", "▶️", "info");

    // Interval for duration + pomodoro tick (these don't need camera)
    pomoDurRef.current = setInterval(() => {
      if (sessionStartRef.current) {
        setSessionDuration(Math.round(Date.now() / 1000 - sessionStartRef.current));
      }
      const pomo = pomoRef.current;
      if (pomo) {
        const event = pomo.tick();
        setPomoState(pomo.state);
        setPomoRemaining(pomo.remainingStr);
        setPomoProgress(pomo.progress);
        const labels = { work: "WORK", short_break: "SHORT BREAK", long_break: "LONG BREAK", idle: "" };
        setPomoLabel(labels[pomo.state] || "");
        if (event === "work")        addToast("Pomodoro", "Back to work! Stay focused.", "🍅");
        if (event === "short_break") addToast("Pomodoro", "Short break — stretch and rest!", "☕");
        if (event === "long_break")  addToast("Pomodoro", "Long break! Great work.", "🌟");
      }
    }, 500);

  }, [cfg, addToast, handleResults]);

  // ── Stop session ──────────────────────────────────────────────────────────────
  const stopSession = useCallback(() => {
    setIsRunning(false);

    if (captureLoopRef.current) {
      captureLoopRef.current.active = false;
      captureLoopRef.current = null;
    }
    if (faceMeshRef.current) { try { faceMeshRef.current.close(); } catch(_) {} faceMeshRef.current = null; }

    // Stop video stream tracks
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = null;
    }

    // Stop timers
    if (pomoDurRef.current) { clearInterval(pomoDurRef.current); pomoDurRef.current = null; }
    if (pomoRef.current) pomoRef.current.stop();
    setPomoState("idle"); setPomoRunning(false);

    const summary = sessionLogRef.current?.summary();
    if (summary && summary.duration_min > 0.1) {
      setSessions(prev => {
        const newSessions = [...prev, summary];
        const prevUnlocked = new Set(unlockedAchievements);
        const nowUnlocked = checkAchievements(summary, newSessions);
        const newlyUnlocked = nowUnlocked.filter(id => !prevUnlocked.has(id));
        if (newlyUnlocked.length) {
          setUnlockedAchievements(p => [...new Set([...p, ...newlyUnlocked])]);
          newlyUnlocked.forEach(id => {
            const ach = ACHIEVEMENT_DEFS.find(a => a.id === id);
            if (ach) addToast("Achievement unlocked!", `${ach.name} — ${ach.desc}`, ach.icon, "achievement", 6000);
          });
        }
        return newSessions;
      });
      addToast("Session saved", `Focused ${summary.focus_pct}% over ${summary.duration_min.toFixed(1)} min`, "📊", "info");
    }
  }, [unlockedAchievements, addToast]);

  // Cleanup on unmount
  useEffect(() => () => { if (isRunning) stopSession(); }, []);

  // When user opens Live Detection after starting on another tab, attach stream to preview video
  useEffect(() => {
    if (!isRunning || cameraError) return;
    const stream = videoRef.current?.srcObject;
    if (stream && previewVideoRef.current) {
      if (previewVideoRef.current.srcObject !== stream) {
        previewVideoRef.current.srcObject = stream;
        previewVideoRef.current.play().catch(() => {});
      }
    }
  }, [isRunning, activeTab, cameraError]);

  const togglePomodoro = useCallback(() => {
    if (!pomoRef.current) return;
    if (pomoRef.current.state === "idle") {
      pomoRef.current.start();
      setPomoRunning(true);
      addToast("Pomodoro started", `${cfg.pomodoro_work_minutes} min work session`, "🍅", "info");
    } else {
      pomoRef.current.stop();
      setPomoRunning(false);
      setPomoState("idle");
      addToast("Pomodoro stopped", "Timer reset", "⏹", "info");
    }
  }, [cfg, addToast]);

  const formatDuration = (secs) => `${Math.floor(secs/60)}:${String(secs%60).padStart(2,"0")}`;

  const stateConf  = STATE_CONFIG[state] || STATE_CONFIG.focused;
  const bpmColor   = blinkRate < cfg.blink_rate_low || blinkRate > cfg.blink_rate_high ? "#f59e0b" : "#22c55e";
  const pomoColors = { work: "#22c55e", short_break: "#60a5fa", long_break: "#a78bfa", idle: "#4b5563" };
  const pomoColor  = pomoColors[pomoState] || "#4b5563";

  const tabStyle = (t) => ({
    background: activeTab === t ? "#1e293b" : "none", border: "none",
    color: activeTab === t ? "#f9fafb" : "#6b7280",
    padding: "10px 20px", borderRadius: 10, cursor: "pointer", fontSize: 14,
    fontWeight: activeTab === t ? 600 : 400, transition: "all 0.2s",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#030712", color: "#f9fafb", fontFamily: "'Inter', 'Segoe UI', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { cursor: pointer; }
        input[type=range]::-webkit-slider-thumb { background: #6366f1; }
        @keyframes slideIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #111827; } ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }
      `}</style>

      <audio ref={alertAudioRef} preload="auto" src={`${import.meta.env.BASE_URL}alert.wav`} />

      <Toast toasts={toasts} />
      {/* Always mounted: MediaPipe Camera needs this ref even when Live Detection tab is not active */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "fixed",
          left: -9999,
          top: 0,
          width: 640,
          height: 480,
          opacity: 0,
          pointerEvents: "none",
          zIndex: -1,
        }}
      />
      {showSettings && <SettingsPanel cfg={cfg} onChange={setCfg} onClose={() => setShowSettings(false)} />}
      {showHistory  && <SessionHistoryPanel sessions={sessions} onClose={() => setShowHistory(false)} />}

      {/* Header */}
      <div style={{ borderBottom: "1px solid #111827", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.5px", background: "linear-gradient(135deg, #6366f1 0%, #818cf8 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Focus Mirror
          </div>
          <div style={{ fontSize: 10, background: "#1e293b", border: "1px solid #374151", color: "#9ca3af", padding: "3px 8px", borderRadius: 99, letterSpacing: "0.05em" }}>BETA</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["dashboard","detection","pomodoro","achievements"].map(t => (
            <button key={t} onClick={() => setActiveTab(t)} style={tabStyle(t)}>
              {{ dashboard:"Dashboard", detection:"Live Detection", pomodoro:"Pomodoro", achievements:"Achievements" }[t]}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowHistory(true)} style={{ background: "#1e293b", border: "1px solid #374151", color: "#d1d5db", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>📈 History</button>
          <button onClick={() => setShowSettings(true)} style={{ background: "#1e293b", border: "1px solid #374151", color: "#d1d5db", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>⚙️ Settings</button>
          <button onClick={isRunning ? stopSession : startSession} style={{
            background: isRunning ? "#dc2626" : "#16a34a", border: "none", color: "#fff",
            padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600,
            boxShadow: isRunning ? "0 0 20px rgba(220,38,38,0.3)" : "0 0 20px rgba(22,163,74,0.3)",
          }}>
            {isRunning ? "⏹ Stop" : "▶ Start Session"}
          </button>
        </div>
      </div>

      {/* Camera error banner */}
      {cameraError && (
        <div style={{ background: "#7f1d1d", borderBottom: "1px solid #ef4444", padding: "10px 24px", fontSize: 13, color: "#fca5a5", display: "flex", alignItems: "center", gap: 8 }}>
          <span>📷</span>
          <strong>Camera error:</strong> {cameraError} — Allow camera access, use HTTPS or localhost, and ensure <code>@mediapipe/face_mesh</code> is installed.
        </div>
      )}

      {/* Status Bar */}
      {isRunning && (
        <div style={{ background: stateConf.bg + "22", borderBottom: `1px solid ${stateConf.dot}44`, padding: "10px 24px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: stateConf.dot, animation: "pulse 1.5s ease-in-out infinite" }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: stateConf.dot, letterSpacing: "0.08em" }}>{stateConf.label}</span>
          </div>
          <div style={{ color: "#6b7280", fontSize: 12 }}>|</div>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Session: <strong style={{ color: "#e5e7eb" }}>{formatDuration(sessionDuration)}</strong></span>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Focus: <strong style={{ color: "#22c55e" }}>{focusPct}%</strong></span>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Alerts: <strong style={{ color: totalAlerts > 0 ? "#ef4444" : "#22c55e" }}>{totalAlerts}</strong></span>
          {postureSlouching && <span style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>⚠ Straighten up!</span>}
          {pomoRunning && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: pomoColor }}>
              🍅 {pomoLabel} <strong>{pomoRemaining}</strong>
            </div>
          )}
        </div>
      )}

      <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>

        {/* DASHBOARD TAB */}
        {activeTab === "dashboard" && (
          <div>
            {!isRunning && (
              <div style={{ textAlign: "center", padding: "60px 0 40px" }}>
                <div style={{ fontSize: 80, marginBottom: 20 }}>🪞</div>
                <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 12, background: "linear-gradient(135deg, #6366f1 0%, #818cf8 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  Focus Mirror
                </h1>
                <p style={{ color: "#6b7280", fontSize: 16, marginBottom: 32, maxWidth: 500, margin: "0 auto 32px" }}>
                  Real-time drowsiness & focus detection using your webcam. Track blinks, head pose, posture, and more.
                </p>
                <button onClick={startSession} style={{ background: "linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)", border: "none", color: "#fff", padding: "16px 40px", borderRadius: 12, cursor: "pointer", fontSize: 16, fontWeight: 700, boxShadow: "0 0 40px rgba(99,102,241,0.4)" }}>
                  ▶ Start Monitoring
                </button>
                <div style={{ display: "flex", justifyContent: "center", gap: 32, marginTop: 48, flexWrap: "wrap" }}>
                  {[["👁️","Drowsiness","EAR-based eye tracking"],["🧭","Head Pose","Pitch & yaw estimation"],["🍅","Pomodoro","Smart work/break timer"],["🏆","Achievements","9 unlockable badges"]].map(([icon,title,desc]) => (
                    <div key={title} style={{ textAlign: "center", maxWidth: 140 }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb", marginBottom: 4 }}>{title}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>{desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isRunning && (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginBottom: 24 }}>
                  <StatCard label="Focus Score" value={focusScore} unit="%" color={focusScore >= 70 ? "#22c55e" : "#ef4444"} sub={`${focusPct}% of session`} />
                  <StatCard label="Duration" value={formatDuration(sessionDuration)} color="#e5e7eb" sub="Current session" />
                  <StatCard label="Blink Rate" value={blinkRate.toFixed(1)} unit="bpm" color={bpmColor} sub={`Total: ${totalBlinks}`} />
                  <StatCard label="EAR" value={ear.toFixed(3)} color="#a78bfa" sub={`Threshold: ${cfg.ear_threshold}`} />
                  <StatCard label="Alerts" value={totalAlerts} color={totalAlerts > 0 ? "#ef4444" : "#22c55e"} sub="This session" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24 }}>
                  <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 16, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
                    <CircularProgress value={focusScore} size={160} stroke={10} color={focusScore >= 70 ? "#22c55e" : focusScore >= 40 ? "#f59e0b" : "#ef4444"}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "JetBrains Mono", color: "#f9fafb" }}>{focusScore}%</div>
                        <div style={{ fontSize: 11, color: "#6b7280" }}>focus score</div>
                      </div>
                    </CircularProgress>
                    <div style={{ width: "100%" }}>
                      {[["Focused",focusPct,"#22c55e"],["Drowsy",drowsyPct,"#ef4444"],["Away",awayPct,"#f59e0b"]].map(([label,val,color]) => (
                        <div key={label} style={{ marginBottom: 10 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                            <span style={{ color: "#9ca3af" }}>{label}</span>
                            <span style={{ color, fontWeight: 600 }}>{val}%</span>
                          </div>
                          <Bar value={val} color={color} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div style={{ background: stateConf.bg + "33", border: `1px solid ${stateConf.dot}55`, borderRadius: 16, padding: 24, display: "flex", alignItems: "center", gap: 16 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", background: stateConf.dot, flexShrink: 0, animation: "pulse 1.5s ease-in-out infinite" }} />
                      <div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: stateConf.dot, letterSpacing: "0.05em" }}>{stateConf.label}</div>
                        <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 4 }}>
                          {state==="focused" ? "Excellent! You're in the zone." : state==="drowsy" ? "Your eyes are closing — take a breath!" : state==="away" ? "Look back at the screen." : "Position yourself in front of the camera."}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: 16 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>Head Pose</div>
                        {pitch !== null ? (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                              <span style={{ fontSize: 12, color: "#9ca3af" }}>Pitch</span>
                              <span style={{ fontFamily: "monospace", color: "#e5e7eb" }}>{pitch > 0 ? "+" : ""}{pitch?.toFixed(1)}°</span>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                              <span style={{ fontSize: 12, color: "#9ca3af" }}>Yaw</span>
                              <span style={{ fontFamily: "monospace", color: "#e5e7eb" }}>{yaw > 0 ? "+" : ""}{yaw?.toFixed(1)}°</span>
                            </div>
                          </>
                        ) : <div style={{ color: "#4b5563", fontSize: 12 }}>No face detected</div>}
                      </div>
                      <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: 16 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>Posture</div>
                        <div style={{ fontSize: 28, marginBottom: 4 }}>{postureSlouching ? "⚠️" : "✅"}</div>
                        <div style={{ fontSize: 12, color: postureSlouching ? "#f59e0b" : "#22c55e" }}>{postureSlouching ? "Slouching detected" : "Posture OK"}</div>
                      </div>
                    </div>
                    <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: 16 }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>Blink Analysis</div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                        <span style={{ fontSize: 12, color: "#9ca3af" }}>Rate</span>
                        <span style={{ fontFamily: "monospace", color: bpmColor, fontWeight: 600 }}>{blinkRate.toFixed(1)} bpm</span>
                      </div>
                      <Bar value={blinkRate} max={35} color={bpmColor} height={8} />
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#4b5563", marginTop: 4 }}>
                        <span>Low strain (&lt;{cfg.blink_rate_low})</span>
                        <span>High fatigue (&gt;{cfg.blink_rate_high})</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* LIVE DETECTION TAB */}
        {activeTab === "detection" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 24 }}>
              <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 16, padding: 20 }}>
                <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>Eye Detection</div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                    <span style={{ color: "#9ca3af" }}>EAR (avg)</span>
                    <span style={{ fontFamily: "monospace", color: ear < cfg.ear_threshold ? "#ef4444" : "#22c55e" }}>{ear.toFixed(3)}</span>
                  </div>
                  <Bar value={ear} max={0.5} color={ear < cfg.ear_threshold ? "#ef4444" : "#22c55e"} height={8} />
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                    <span style={{ color: "#9ca3af" }}>Threshold</span>
                    <span style={{ fontFamily: "monospace", color: "#9ca3af" }}>{cfg.ear_threshold.toFixed(2)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: ear < cfg.ear_threshold ? "#ef4444" : "#22c55e", fontWeight: 600, marginTop: 8 }}>
                    {ear < cfg.ear_threshold ? "👁 Eyes CLOSED" : "👁 Eyes OPEN"}
                  </div>
                </div>
              </div>
              <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 16, padding: 20 }}>
                <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>Head Orientation</div>
                <div style={{ position: "relative", width: 80, height: 80, margin: "0 auto 12px", background: "#1f2937", borderRadius: "50%", border: "2px solid #374151" }}>
                  {pitch !== null && yaw !== null && (
                    <div style={{
                      position: "absolute", width: 12, height: 12, borderRadius: "50%",
                      background: Math.abs(yaw) > cfg.head_yaw_threshold ? "#ef4444" : "#6366f1",
                      top: `${50 + (pitch / 40) * 40}%`, left: `${50 + (yaw / 60) * 40}%`,
                      transform: "translate(-50%, -50%)", transition: "all 0.1s",
                    }} />
                  )}
                  {pitch === null && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#4b5563" }}>NO FACE</div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center" }}>
                  {pitch !== null ? `Pitch: ${pitch > 0 ? "+" : ""}${pitch.toFixed(1)}°  Yaw: ${yaw > 0 ? "+" : ""}${yaw.toFixed(1)}°` : "No face detected"}
                </div>
              </div>
              <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 16, padding: 20 }}>
                <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>Blink Monitor</div>
                <CircularProgress value={Math.min(100, (blinkRate / 30) * 100)} size={80} stroke={6} color={bpmColor}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: bpmColor, fontFamily: "monospace" }}>{blinkRate.toFixed(0)}</div>
                </CircularProgress>
                <div style={{ marginTop: 12, fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#9ca3af" }}>
                    <span>Total blinks</span><span style={{ color: "#e5e7eb" }}>{totalBlinks}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#9ca3af", marginTop: 4 }}>
                    <span>Health range</span><span style={{ color: "#22c55e" }}>{cfg.blink_rate_low}–{cfg.blink_rate_high} bpm</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: bpmColor }}>
                    {blinkRate < cfg.blink_rate_low ? "⚠ Low rate — eye strain risk" : blinkRate > cfg.blink_rate_high ? "⚠ High rate — fatigue detected" : "✓ Healthy blink rate"}
                  </div>
                </div>
              </div>
            </div>

            {/* Real camera feed */}
            <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 16, padding: 24 }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                Camera Feed {isRunning && !cameraError ? "🟢 Live" : cameraError ? "🔴 Error" : "⚪ Inactive"}
              </div>
              {cfg.privacy_mode ? (
                <div style={{ height: 300, display: "flex", alignItems: "center", justifyContent: "center", color: "#4b5563", flexDirection: "column", gap: 12 }}>
                  <div style={{ fontSize: 48 }}>🕶️</div>
                  <div>Privacy mode active — video feed hidden</div>
                </div>
              ) : (
                <div style={{ height: 300, background: "#0f172a", borderRadius: 12, position: "relative", overflow: "hidden" }}>
                  <video
                    ref={previewVideoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: "100%", height: "100%", objectFit: "cover", borderRadius: 12,
                      display: isRunning && !cameraError ? "block" : "none",
                      transform: "scaleX(-1)", // mirror effect
                    }}
                  />
                  {(!isRunning || cameraError) && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151", fontSize: 15, flexDirection: "column", gap: 8 }}>
                      <div style={{ fontSize: 40 }}>📷</div>
                      <div>{cameraError ? `Error: ${cameraError}` : "Start session to activate camera"}</div>
                    </div>
                  )}
                  {/* State overlay on video */}
                  {isRunning && !cameraError && (
                    <div style={{ position: "absolute", top: 12, left: 12, background: stateConf.bg + "dd", color: "#fff", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700 }}>
                      {stateConf.label}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* POMODORO TAB */}
        {activeTab === "pomodoro" && (
          <div style={{ maxWidth: 500, margin: "0 auto" }}>
            <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 20, padding: 40, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 24 }}>
                {pomoState === "idle" ? "Pomodoro Timer" : `${{ work:"Work Session", short_break:"Short Break", long_break:"Long Break" }[pomoState]} — ${pomoRef.current?._cycle || 0} cycles`}
              </div>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 32 }}>
                <CircularProgress value={Math.round(pomoProgress * 100)} size={220} stroke={12} color={pomoColor}>
                  <div>
                    <div style={{ fontSize: 52, fontWeight: 800, fontFamily: "JetBrains Mono", color: "#f9fafb", lineHeight: 1.1 }}>{pomoRemaining}</div>
                    <div style={{ fontSize: 13, color: pomoColor, marginTop: 6, fontWeight: 600 }}>
                      {pomoState === "idle" ? "Ready" : { work:"🍅 FOCUS", short_break:"☕ BREAK", long_break:"🌟 REST" }[pomoState]}
                    </div>
                  </div>
                </CircularProgress>
              </div>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                {!isRunning ? (
                  <div style={{ color: "#6b7280", fontSize: 14 }}>Start a session to use the Pomodoro timer</div>
                ) : (
                  <button onClick={togglePomodoro} style={{ background: pomoRunning ? "#374151" : "#6366f1", border: "none", color: "#fff", padding: "14px 36px", borderRadius: 12, cursor: "pointer", fontSize: 16, fontWeight: 700 }}>
                    {pomoRunning ? "⏹ Stop Pomodoro" : "▶ Start Pomodoro"}
                  </button>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 32 }}>
                {[["Work",`${cfg.pomodoro_work_minutes} min`,"#22c55e"],["Short Break",`${cfg.pomodoro_break_minutes} min`,"#60a5fa"],["Long Break",`${cfg.pomodoro_long_break_minutes} min`,"#a78bfa"],["Cycles/Long",`${cfg.pomodoro_cycles_before_long_break}`,"#f59e0b"]].map(([label,val,color]) => (
                  <div key={label} style={{ background: "#0f172a", borderRadius: 10, padding: "12px 16px", textAlign: "left" }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "monospace" }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ACHIEVEMENTS TAB */}
        {activeTab === "achievements" && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 8 }}>{unlockedAchievements.length} / {ACHIEVEMENT_DEFS.length} unlocked</div>
              <Bar value={unlockedAchievements.length} max={ACHIEVEMENT_DEFS.length} color="#f59e0b" height={6} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {ACHIEVEMENT_DEFS.map(a => {
                const unlocked = unlockedAchievements.includes(a.id);
                return (
                  <div key={a.id} style={{ background: unlocked ? "#1c1917" : "#111827", border: `1px solid ${unlocked ? "#854d0e" : "#1f2937"}`, borderRadius: 14, padding: 20, display: "flex", gap: 16, alignItems: "flex-start", opacity: unlocked ? 1 : 0.6, transition: "all 0.3s" }}>
                    <div style={{ fontSize: 36, flexShrink: 0, filter: unlocked ? "none" : "grayscale(1)" }}>{a.icon}</div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: unlocked ? "#fbbf24" : "#6b7280", marginBottom: 4 }}>{a.name}</div>
                      <div style={{ fontSize: 12, color: unlocked ? "#9ca3af" : "#4b5563" }}>{a.desc}</div>
                      {unlocked && <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 6, fontWeight: 600 }}>✓ UNLOCKED</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
