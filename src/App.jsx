import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import Particles from "./components/Particles.jsx";

import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-webgl";
import * as faceDetection from "@tensorflow-models/face-detection";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";
import * as faceLandmarksDetection from "@tensorflow-models/face-landmarks-detection";

import { buildVisitorPdf } from "./utils/pdf";
import { v4 as uuidv4 } from "uuid";
import QRShareModal from "./components/QRShareModal.jsx";
import { supabase } from "./lib/supabase";

const EMO_TO_THEME = {
  happy: "Experience & Growth (viral UX, community loops)",
  surprised: "Frontier & Novelty (new interfaces, emerging tech)",
  angry: "Ops & Efficiency (speed, reliability, automation)",
  neutral: "Clarity & Trust (data, compliance, governance)",
};

// ---------- small utils ----------
function dist(a, b) {
  if (!a || !b) return 0;
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
function ema(prev, value, alpha = 0.25) {
  if (prev == null) return value;
  return prev + alpha * (value - prev);
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // stability & cooldown
  const cooldownRef  = useRef(0);
  const happyHoldRef = useRef(0);

  const [detectors, setDetectors] = useState(null);
  const [ready, setReady] = useState(false);

  const [emotion, setEmotion] = useState("neutral");
  const [effect, setEffect] = useState("standby");
  const [hud, setHud] = useState({ face: "—", hands: "—", smile: "—" });

  // smoothers
  const eyeEMARef    = useRef(null);
  const widthEMARef  = useRef(null);
  const heightEMARef = useRef(null);

  // idle → armed (10s countdown) → generating → done
  const [phase, setPhase] = useState("idle");
  const [count, setCount] = useState(10);
  const emotionBuckets = useRef({ happy: 0, surprised: 0, angry: 0, neutral: 0 });

  const [selfie, setSelfie] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [showShare, setShowShare] = useState(false);
// baseline + live width trackers
const widthBaseRef = useRef(1.05);   // rolling neutral baseline (width/eye)
const widthNowRef  = useRef(1.05);   // latest width/eye for HUD
const heightNowRef = useRef(0.25);   // latest height/eye for HUD

  // ---------- camera ----------
  useEffect(() => {
    let stream;
    (async () => {
      const v = videoRef.current;
      v.setAttribute("autoplay", "");
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      v.srcObject = stream;
      await v.play();
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  // ---------- models ----------
  useEffect(() => {
    (async () => {
      await tf.setBackend("webgl");
      await tf.ready();

      const facePath = "https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4";
      const handsPath = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4";
      const meshPath  = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4";

      const faceDetector = await faceDetection.createDetector(
        faceDetection.SupportedModels.MediaPipeFaceDetector,
        { runtime: "mediapipe", solutionPath: facePath, modelType: "short", maxFaces: 1 }
      );

      const handDetector = await handPoseDetection.createDetector(
        handPoseDetection.SupportedModels.MediaPipeHands,
        { runtime: "mediapipe", solutionPath: handsPath, modelType: "lite", maxHands: 2 }
      );

      const landmarksDetector = await faceLandmarksDetection.createDetector(
        faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
        { runtime: "mediapipe", solutionPath: meshPath, refineLandmarks: false }
      );

      setDetectors({ faceDetector, handDetector, landmarksDetector });
      setReady(true);
    })().catch((e) => alert("AI load error: " + e.message));
  }, []);

  // ---------- simple smile score ----------
  // score = width/eye - 0.15*height/eye  (no baseline; robust & fast)
  // score = (width_now - width_baseline)
// baseline adapts slowly; "smiling" when > +0.06 (~+6%)
function smileScore(lm) {
  const L_MOUTH = 61, R_MOUTH = 291, U_LIP = 13, L_LIP = 14, L_EYE = 33, R_EYE = 263;

  const eyeW = dist(lm[L_EYE], lm[R_EYE]);
  if (!eyeW) return { score: 0, pct: 0, w: 0, h: 0 };

  // normalize distances by eye distance, then smooth a bit
  eyeEMARef.current = ema(eyeEMARef.current, eyeW, 0.25);
  const e = eyeEMARef.current || eyeW;

  const wRaw = dist(lm[L_MOUTH], lm[R_MOUTH]) / e;
  const hRaw = dist(lm[U_LIP],   lm[L_LIP])   / e;

  widthEMARef.current  = ema(widthEMARef.current,  wRaw, 0.35);
  heightEMARef.current = ema(heightEMARef.current, hRaw, 0.35);

  const w = widthEMARef.current ?? wRaw;
  const h = heightEMARef.current ?? hRaw;

  // update baseline SLOWLY (follows neutral but ignores huge smiles)
  // (use small alpha so it won't chase a smile instantly)
  const alphaBase = 0.02;
  widthBaseRef.current = (1 - alphaBase) * widthBaseRef.current + alphaBase * Math.min(w, 1.25);

  // live values for HUD
  widthNowRef.current  = w;
  heightNowRef.current = h;

  // smiling rule: not an “O” (too open), and +6% wider than baseline
  const margin = 0.06;
  const notTooOpen = h < 0.65;
  const score = (w - widthBaseRef.current) * (notTooOpen ? 1 : 0.5); // penalize big open mouth a bit

  // Map to 0..1 for HUD: 0 → baseline, 0.25 → 100%
  const pct = Math.max(0, Math.min(1, score / 0.25));

  return { score, pct, w, h };
}


  // ---------- main loop ----------
  useEffect(() => {
    if (!ready || !detectors || !canvasRef.current || !videoRef.current) return;

    const v = videoRef.current;
    const cnv = canvasRef.current;
    const ctx = cnv.getContext("2d");

    let raf, lastFaceArea = 0, lastHandX = null, waveCount = 0;

    const loop = async () => {
      if (!v.videoWidth) { raf = requestAnimationFrame(loop); return; }

      // mirror draw
      cnv.width = v.videoWidth; cnv.height = v.videoHeight;
      ctx.save(); ctx.scale(-1, 1); ctx.drawImage(v, -cnv.width, 0, cnv.width, cnv.height); ctx.restore();

      const [faces, hands, facesLM] = await Promise.all([
        detectors.faceDetector.estimateFaces(v),
        detectors.handDetector.estimateHands(v),
detectors.landmarksDetector.estimateFaces(v, { flipHorizontal: true }),
      ]);

      const faceBox = faces[0]?.box;
      const lm      = facesLM?.[0]?.keypoints;

      // --- emotion from simple smile score ---
      let emo = "neutral";
      let area = lastFaceArea;
      let smilePctText = "—";

      if (lm) {
        const {score, pct} = smileScore(lm);
        smilePctText = `${Math.round(pct * 100)}%`;
        if (score >= 0.05) {        // <<— easy, camera-agnostic threshold
          emo = "happy";
        }
      }

      // fallback for other emotions (same as before)
      if (emo !== "happy" && faceBox) {
        const { width: w, height: h } = faceBox;
        area = w * h;
        const ratio = h / w;
        if (ratio < 0.88) emo = "angry";
        const change = lastFaceArea ? Math.abs(area - lastFaceArea) / lastFaceArea : 0;
        if (change > 0.22) emo = "surprised";
      }

      lastFaceArea = area;
      setEmotion(emo);
      setEffect(emo === "happy" ? "aura" : emo === "angry" ? "flames" : emo === "surprised" ? "shockwave" : "standby");

      // HUD
      setHud({
        face: faces?.length ? "✓" : "—",
        hands: String(hands.length || 0),
        smile: smilePctText,
      });

      // ===== Arm when happy with tiny hold =====
      if (cooldownRef.current > 0) cooldownRef.current -= 1;

      if (phase === "idle" && faces[0]) {
        // lower face-size gate so you don't have to be too close
        const faceArea = faces[0].box?.width * faces[0].box?.height;
        const largeEnoughFace = faceArea ? faceArea > 2000 : true;

        if (largeEnoughFace) {
          if (emo === "happy") {
            happyHoldRef.current += 1;        // accumulate
          } else {
            happyHoldRef.current = 0;         // reset fast
          }

          // ~3 frames at ~60fps → very responsive
          if (happyHoldRef.current >= 1 && cooldownRef.current === 0) {
            setPhase("armed");
            setCount(10);
            emotionBuckets.current = { happy:0, surprised:0, angry:0, neutral:0 };
            happyHoldRef.current = 0;
            cooldownRef.current = 40;         // ~1s cooldown
          }
        } else {
          happyHoldRef.current = 0;
        }
      }

      // collect emotion during countdown
      if (phase === "armed") {
        emotionBuckets.current[emo] += 1;
      }

      // flair while idle
      if (phase === "idle" && hands.length >= 1) {
        const kp = hands[0].keypoints?.[8];
        if (kp) {
          if (lastHandX != null) {
            const dx = Math.abs(kp.x - lastHandX);
            if (dx > 35) waveCount++;
            if (waveCount > 5) { setEffect("beam"); waveCount = 0; }
          }
          lastHandX = kp.x;
        }
      }

      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => cancelAnimationFrame(raf);
  }, [ready, detectors, phase]);

  // ---------- finish & upload ----------
  async function finishAndUpload(shot, dominantEmotion, innovationType) {
    try {
      const pdf = buildVisitorPdf(shot, {
        timestamp: new Date().toLocaleString(),
        emotion: dominantEmotion,
        innovationType,
      });
      const blob = pdf.output("blob");

      const id = `${Date.now()}-${crypto?.randomUUID?.() || uuidv4()}.pdf`;
      const path = `p/${id}`;

      const { error: upErr } = await supabase.storage
        .from("booth-pdfs")
        .upload(path, blob, { contentType: "application/pdf", upsert: true });
      if (upErr) throw upErr;

      const { data: signed, error: signErr } = await supabase.storage
        .from("booth-pdfs")
        .createSignedUrl(path, 60 * 60 * 24);
      if (signErr) throw signErr;

      setShareUrl(signed?.signedUrl || "");
      setShowShare(true);
    } catch (e) {
      console.error("[SUPABASE] upload/sign error:", e);
      alert("Upload failed: " + (e.message || JSON.stringify(e)));
    }
  }

  // ---------- countdown ----------
  useEffect(() => {
    if (phase !== "armed") return;
    setEffect("beam");

    const everySec = setInterval(() => setCount((c) => c - 1), 1000);
    const check = setInterval(() => {
      setCount((c) => {
        if (c <= 0) {
          clearInterval(everySec);
          clearInterval(check);

          const shot = captureSelfieFromVideo();
          setSelfie(shot);

          const buckets = emotionBuckets.current;
          const dominant =
            Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]?.[0] || "neutral";
          const innovationType = EMO_TO_THEME[dominant];

          setPhase("generating");

          finishAndUpload(shot, dominant, innovationType).finally(() => {
            setEffect("heart");
            setTimeout(() => {
              setPhase("done");
              setTimeout(() => {
                setPhase("idle");
                setEffect("standby");
              }, 2500);
            }, 800);
          });

          return 0;
        }
        return c;
      });
    }, 150);

    return () => { clearInterval(everySec); clearInterval(check); };
  }, [phase]);

  // ---------- UI ----------
  const title =
    phase === "armed" ? `Capturing… ${count}s` :
    phase === "generating" ? "Generating PDF…" :
    phase === "done" ? "صورتك جاهزه" :
    effect === "aura" ? "HAPPY HERO" :
    effect === "flames" ? "RAGE MODE" :
    effect === "shockwave" ? "SHOCKWAVE" :
    effect === "beam" ? "مستعد تاخذ صوره" :
    "التقط لك صوره من مركز الابتكار";

  const titleClass =
    emotion === "happy" ? "title happy" :
    emotion === "angry" ? "title angry" :
    emotion === "surprised" ? "title surprised" :
    "title neutral";

  function captureSelfieFromVideo() {
    const v = videoRef.current;
    if (!v?.videoWidth) return "";
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ict = c.getContext("2d");
    ict.scale(-1, 1);
    ict.drawImage(v, -c.width, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  return (
    <div className="booth">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
      />
      <canvas ref={canvasRef} className="mirror" />

      <div className="overlay">
        <h1 className={titleClass}>{title}</h1>
        <div className="subtitle" style={{ fontSize: "2rem", fontWeight: "600", marginTop: "1rem" }}>
          إذا مستعد — «ابتسم 😊» وراح يبدأ العد التنازلي
        </div>

        <div className="hud ui">
          <div>Face: <b>{hud.face}</b></div>
          <div>Hands: <b>{hud.hands}</b></div>
          <div>Smile: <b>{hud.smile}</b></div>
          <div>Emotion: <b>{emotion}</b></div>
          <div>Mode: <b>{phase}</b></div>
        </div>

        <Canvas className="particles-canvas">
          <Particles effect={effect} />
        </Canvas>

        <QRShareModal open={showShare} url={shareUrl} onClose={() => setShowShare(false)} />

        {(phase === "armed" || phase === "generating") && (
          <div className="count-overlay ui">
            <div className="ring"></div>
            <div className="count-text">{phase === "armed" ? `${count}` : "Generating…"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
