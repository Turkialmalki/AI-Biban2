// src/components/QRShareModal.jsx
import { QRCodeCanvas } from 'qrcode.react';

export default function QRShareModal({ open, url, onClose }) {
  if (!open) return null;
  return (
    <div className="idea-modal ui">
      <div className="idea-card" style={{ maxWidth: 520 }}>
        <div className="idea-header">
          <h2>Scan to Download</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        {url ? (
          <>
            <div style={{ display:'flex', justifyContent:'center', margin:'12px 0' }}>
              <QRCodeCanvas value={url} size={220} />
            </div>
            <p className="hint" style={{ textAlign:'center' }}>
              Or open: <a href={url} target="_blank" rel="noreferrer">{url.slice(0,70)}…</a>
            </p>
          </>
        ) : (
          <p>Preparing link…</p>
        )}
      </div>
    </div>
  );
}
