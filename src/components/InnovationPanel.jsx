import React from "react";

export default function InnovationPanel({
  open,
  onClose,
  ideaText, setIdeaText,
  lastEmotion,
  selfieDataUrl,
  onGenerate,
  generated
}) {
  if (!open) return null;

  const moodLine =
    lastEmotion === "happy"     ? "Delightful energy — emphasize virality."
  : lastEmotion === "angry"     ? "Operational edge — emphasize speed & reliability."
  : lastEmotion === "surprised" ? "Wow factor — emphasize novelty."
  :                               "Neutral clarity — structure the model.";

  return (
    <div className="panel-root ui"> {/* 'ui' enables pointer events inside overlay */}
      <div className="idea-modal">
        <div className="idea-card">
          <div className="idea-header">
            <h2>Innovation Canvas</h2>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>

          <p className="mood">{moodLine}</p>

          <div className="idea-grid">
            <div>
              <label className="lbl">Describe your idea (1–3 lines)</label>
              <textarea
                className="idea-input"
                placeholder="Example: AI mirror that recognizes gestures to trigger interactive content at events…"
                rows={6}
                value={ideaText}
                onChange={(e) => setIdeaText(e.target.value)}
              />
              <div className="actions">
                <button className="primary" onClick={onGenerate}>
                  Generate Canvas
                </button>
                <button className="ghost" onClick={onClose}>Close</button>
              </div>
            </div>

            <div>
              {selfieDataUrl ? (
                <>
                  <label className="lbl">Your selfie</label>
                  <img className="selfie-thumb" src={selfieDataUrl} alt="selfie" />
                </>
              ) : (
                <div className="no-selfie">No selfie yet — use “Capture Selfie”.</div>
              )}
              <div className="hint">Tip: press “C” to capture; press “I” to toggle panel.</div>
            </div>
          </div>

          {generated && (
            <div className="canvas-block">
              <h3>Business Model Snapshot</h3>
              <div className="canvas-grid">
                <section><h4>Problem</h4><p>{generated.problem}</p></section>
                <section><h4>Solution</h4><p>{generated.solution}</p></section>
                <section><h4>Customer Segments</h4><p>{generated.customers}</p></section>
                <section><h4>Value Proposition</h4><p>{generated.value}</p></section>
                <section><h4>Channels</h4><p>{generated.channels}</p></section>
                <section><h4>Revenue Streams</h4><p>{generated.revenue}</p></section>
                <section><h4>Cost Structure</h4><p>{generated.costs}</p></section>
                <section><h4>Key Metrics</h4><p>{generated.metrics}</p></section>
                <section><h4>Unfair Advantage</h4><p>{generated.advantage}</p></section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
