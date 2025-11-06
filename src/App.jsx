import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import Particles from "./components/Particles.jsx";

import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-webgl";
import * as faceDetection from "@tensorflow-models/face-detection";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";

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

// ===== Strict thumbs-up helpers =====
const IDX = {
  WRIST: 0,
  TH_CMC: 1, TH_MCP: 2, TH_IP: 3, TH_TIP: 4,
  IN_MCP: 5, IN_PIP: 6, IN_DIP: 7, IN_TIP: 8,
  MI_MCP: 9, MI_PIP:10, MI_DIP:11, MI_TIP:12,
  RI_MCP:13, RI_PIP:14, RI_DIP:15, RI_TIP:16,
  PI_MCP:17, PI_PIP:18, PI_DIP:19, PI_TIP:20,
};

// tip “below” PIP (curled) — y larger means lower on screen
function tipBelowPIP(hand, tipIdx, pipIdx, margin = 12) {
  const tip = hand.keypoints[tipIdx];
  const pip = hand.keypoints[pipIdx];
  if (!tip || !pip) return false;
  return tip.y > (pip.y + margin);
}

// angle between (MCP→TIP) vector and “up” (0,-1). 0°=perfect up, 90°=sideways
function angleToUp(vx, vy) {
  const dot = (vx*0) + (vy*-1);
  const mag = Math.hypot(vx, vy) || 1e-6;
  const cos = Math.max(-1, Math.min(1, dot/mag));
  return Math.acos(cos) * 180 / Math.PI;
}

// Quality gate: reject very low-confidence hands (some cams are noisy)
function handConf(hand) {
  // tfjs hand-pose-detection returns score or score[0]
  const s = Array.isArray(hand.score) ? hand.score[0] : hand.score;
  return (typeof s === 'number' ? s : 1); // default 1 if absent
}

// STRICT thumbs-up (orientation + curled other fingers + palm roughly upright)
function robustThumbsUpStrict(hand) {
  if (!hand?.keypoints) return false;
  const k = hand.keypoints;

  // 1) Thumb pointing upwards
  const vx = k[IDX.TH_TIP].x - k[IDX.TH_MCP].x;
  const vy = k[IDX.TH_TIP].y - k[IDX.TH_MCP].y;
  const angUp = angleToUp(vx, vy);        // smaller is “more up”
  const thumbUp = angUp < 30;             // make stricter/looser (25–40)

  // 2) Other fingers curled (tips below PIPs)
  const indexCurled  = tipBelowPIP(hand, IDX.IN_TIP, IDX.IN_PIP);
  const middleCurled = tipBelowPIP(hand, IDX.MI_TIP, IDX.MI_PIP);
  const ringCurled   = tipBelowPIP(hand, IDX.RI_TIP, IDX.RI_PIP);
  const pinkyCurled  = tipBelowPIP(hand, IDX.PI_TIP, IDX.PI_PIP);

  // 3) Palm roughly vertical (wrist below index MCP) — filters sideways cases
  const palmUpright = k[IDX.WRIST]?.y > (k[IDX.IN_MCP]?.y ?? 0) - 8;

  return thumbUp && indexCurled && middleCurled && ringCurled && pinkyCurled && palmUpright;
}


export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
// Stability counters + cooldown
const cooldownRef  = useRef(0);     // frames to ignore after arming

  const [detectors, setDetectors] = useState(null);
  const [ready, setReady] = useState(false);

  const [emotion, setEmotion] = useState("neutral");
  const [effect, setEffect] = useState("standby");
  const [hud, setHud] = useState({ face: "—", hands: "—" });
  const thumbHoldRef = useRef(0); // counts consecutive frames of thumbs-up

  // idle → armed (10s countdown) → generating → done
  const [phase, setPhase] = useState("idle");
  const [count, setCount] = useState(10);
  const emotionBuckets = useRef({
    happy: 0,
    surprised: 0,
    angry: 0,
    neutral: 0,
  });

  const [selfie, setSelfie] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [showShare, setShowShare] = useState(false);

  // ---------- helpers ----------
  function inferEmotion(faceBox, prevArea) {
    if (!faceBox) return { emo: "neutral", area: prevArea };
    const { width: w, height: h } = faceBox;
    const area = w * h;
    const ratio = h / w;
    let emo = "neutral";
    if (ratio > 1.12) emo = "happy";
    else if (ratio < 0.88) emo = "angry";
    const change = prevArea ? Math.abs(area - prevArea) / prevArea : 0;
    if (change > 0.22) emo = "surprised";
    return { emo, area };
  }

  function bothHandsUp(hands, faceTopY) {
    if (hands.length < 2 || faceTopY == null) return false;
    const tip = (h) => h.keypoints?.[8];
    const a = tip(hands[0]),
      b = tip(hands[1]);
    if (!a || !b) return false;
    return a.y < faceTopY && b.y < faceTopY;
  }

  function thumbsUp(hand) {
    if (!hand?.keypoints) return false;
    const t = hand.keypoints[4],
      i = hand.keypoints[8],
      m = hand.keypoints[12];
    if (!t || !i || !m) return false;
    return t.y < i.y - 10 && t.y < m.y - 10;
  }

  function captureSelfieFromVideo() {
    const v = videoRef.current;
    if (!v?.videoWidth) return "";
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ict = c.getContext("2d");
    ict.scale(-1, 1);
    ict.drawImage(v, -c.width, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  // ---------- camera ----------
  useEffect(() => {
    let stream;
    (async () => {
      const v = videoRef.current;
      v.setAttribute("autoplay", "");
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
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

      const facePath =
        "https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4";
      const handsPath = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4";

      const faceDetector = await faceDetection.createDetector(
        faceDetection.SupportedModels.MediaPipeFaceDetector,
        {
          runtime: "mediapipe",
          solutionPath: facePath,
          modelType: "short",
          maxFaces: 1,
        }
      );
      const handDetector = await handPoseDetection.createDetector(
        handPoseDetection.SupportedModels.MediaPipeHands,
        {
          runtime: "mediapipe",
          solutionPath: handsPath,
          modelType: "lite",
          maxHands: 2,
        }
      );

      setDetectors({ faceDetector, handDetector });
      setReady(true);
    })().catch((e) => alert("AI load error: " + e.message));
  }, []);

  // ---------- main loop ----------
  useEffect(() => {
    if (!ready || !detectors || !canvasRef.current || !videoRef.current) return;

    const v = videoRef.current;
    const cnv = canvasRef.current;
    const ctx = cnv.getContext("2d");

    let raf,
      lastFaceArea = 0,
      lastHandX = null,
      waveCount = 0;

    const loop = async () => {
      if (!v.videoWidth) {
        raf = requestAnimationFrame(loop);
        return;
      }

      cnv.width = v.videoWidth;
      cnv.height = v.videoHeight;
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(v, -cnv.width, 0, cnv.width, cnv.height);
      ctx.restore();

      const [faces, hands] = await Promise.all([
        detectors.faceDetector.estimateFaces(v),
        detectors.handDetector.estimateHands(v),
      ]);

      setHud({
        face: faces?.length ? "✓" : "—",
        hands: String(hands.length || 0),
      });

      const faceBox = faces[0]?.box;
      const { emo, area } = inferEmotion(faceBox, lastFaceArea);
      lastFaceArea = area;
      setEmotion(emo);
      setEffect(
        emo === "happy"
          ? "aura"
          : emo === "angry"
          ? "flames"
          : emo === "surprised"
          ? "shockwave"
          : "standby"
      );

      // idle → armed
      // if (phase === "idle" && faceBox) {
      //   const faceTop = faceBox.y;
      //   const twoUp = bothHandsUp(hands, faceTop);
      //   const anyThumb = hands.some(thumbsUp);
      //   if (twoUp || anyThumb) {
      //     setPhase("armed");
      //     setCount(10);
      //     emotionBuckets.current = { happy:0, surprised:0, angry:0, neutral:0 };
      //   }
      // }

      // --- Gesture arming (idle → armed) — ONLY thumbs-up, held stable ---
         // ===== ONLY strict thumbs-up (held) → armed =====
      if (cooldownRef.current > 0) cooldownRef.current -= 1;

      // Must see a face to avoid background triggers
      if (phase === "idle" && faces[0]) {
        // (Optional) gate on face size to avoid far-background faces
        const faceArea = faces[0].box?.width * faces[0].box?.height;
        const largeEnoughFace = faceArea ? faceArea > 8000 : true; // tune as needed

        if (largeEnoughFace) {
          // Any hand that is confident AND passes strict thumbs-up
          const goodThumb = hands.some(
            (h) => handConf(h) >= 0.7 && robustThumbsUpStrict(h)
          );

          if (goodThumb) {
            // increase steadily when held
            thumbHoldRef.current += 1;
          } else {
            // decay (hysteresis), not an instant reset
            thumbHoldRef.current = Math.max(0, thumbHoldRef.current - 3);
          }

          // Need ~0.6s of stable thumbs-up @ ~60fps → 36 frames
          if (thumbHoldRef.current >= 36 && cooldownRef.current === 0) {
            setPhase("armed");
            setCount(10);
            emotionBuckets.current = { happy:0, surprised:0, angry:0, neutral:0 };
            thumbHoldRef.current = 0;
            cooldownRef.current = 60; // ~1s cooldown to prevent immediate re-arming
          }
        } else {
          // face too small — do not accumulate
          thumbHoldRef.current = 0;
        }
      }

      // If face disappears, drop accumulation
      if (phase === "idle" && !faces[0]) {
        thumbHoldRef.current = 0;
      }


      // collect emotion during countdown
      if (phase === "armed") {
        emotionBuckets.current[emo] += 1;
      }

      // a little flair while idle
      if (phase === "idle" && hands.length >= 1) {
        const kp = hands[0].keypoints?.[8];
        if (kp) {
          if (lastHandX != null) {
            const dx = Math.abs(kp.x - lastHandX);
            if (dx > 35) waveCount++;
            if (waveCount > 5) {
              setEffect("beam");
              waveCount = 0;
            }
          }
          lastHandX = kp.x;
        }
      }

      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => cancelAnimationFrame(raf);
  }, [ready, detectors, phase]);

  // ---------- finish & upload (THIS is the Blob upload spot) ----------
  async function finishAndUpload(shot, dominantEmotion, innovationType) {
    try {
      // 1) Build PDF
      const pdf = buildVisitorPdf(shot, {
        timestamp: new Date().toLocaleString(),
        emotion: dominantEmotion,
        innovationType,
      });

      // 2) IMPORTANT: Build a Blob before uploading
      const blob = pdf.output("blob");

      // 3) Upload to Supabase
      const id = `${Date.now()}-${crypto?.randomUUID?.() || uuidv4()}.pdf`;
      const path = `p/${id}`;

      const { error: upErr } = await supabase.storage
        .from("booth-pdfs")
        .upload(path, blob, { contentType: "application/pdf", upsert: true });

      if (upErr) throw upErr;

      // 4) Signed URL (24h)
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

  // ---------- countdown + calling finishAndUpload ----------
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
            Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]?.[0] ||
            "neutral";
          const innovationType = EMO_TO_THEME[dominant];

          setPhase("generating");

          // CALL THE BLOB UPLOAD FLOW HERE:
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

    return () => {
      clearInterval(everySec);
      clearInterval(check);
    };
  }, [phase]);

  // ---------- UI ----------
  const title =
    phase === "armed"
      ? `Capturing… ${count}s`
      : phase === "generating"
      ? "Generating PDF…"
      : phase === "done"
      ? "صورتك جاهزه"
      : effect === "aura"
      ? "HAPPY HERO"
      : effect === "flames"
      ? "RAGE MODE"
      : effect === "shockwave"
      ? "SHOCKWAVE"
      : effect === "beam"
      ? "مستعد تاخذ صوره"
      : "التقط لك صوره من مركز الابتكار";

  const titleClass =
    emotion === "happy"
      ? "title happy"
      : emotion === "angry"
      ? "title angry"
      : emotion === "surprised"
      ? "title surprised"
      : "title neutral";

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
          اذا مستعد عطنا 👍 وراح يلتقط لك صوره 
        </div>

        <div className="hud ui">
          <div>
            Face: <b>{hud.face}</b>
          </div>
          <div>
            Hands: <b>{hud.hands}</b>
          </div>
          <div>
            Emotion: <b>{emotion}</b>
          </div>
          <div>
            Mode: <b>{phase}</b>
          </div>
        </div>

        <Canvas className="particles-canvas">
          <Particles effect={effect} />
        </Canvas>

        <QRShareModal
          open={showShare}
          url={shareUrl}
          onClose={() => setShowShare(false)}
        />

        {(phase === "armed" || phase === "generating") && (
          <div className="count-overlay ui">
            <div className="ring"></div>
            <div className="count-text">
              {phase === "armed" ? `${count}` : "Generating…"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
