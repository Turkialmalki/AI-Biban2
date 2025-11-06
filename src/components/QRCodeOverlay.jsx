import { useEffect, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

export default function QRCodeOverlay({ onCapture }) {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const [shareUrl, setShareUrl] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('shareUrl') || '';
    if (isLocal && saved) setShareUrl(saved);
    if (!isLocal) setShareUrl(location.origin);
  }, [isLocal]);

  const save = () => {
    localStorage.setItem('shareUrl', shareUrl.trim());
    alert('QR URL saved. Use a device on the same Wi-Fi to scan.');
  };

  const qrValue = isLocal ? (shareUrl || 'http://YOUR-IP:5173') : shareUrl;

  return (
    <div className="qr-container">
      <div className="qr-box" style={{ pointerEvents:'auto' }}>
        <QRCodeCanvas value={qrValue} size={120} includeMargin />
        <p>Scan to open</p>

        {isLocal && (
          <>
            <input
              style={{ marginTop:8, padding:'6px 10px', borderRadius:8, border:'1px solid #333', width:220 }}
              placeholder="http://192.168.1.10:5173"
              value={shareUrl}
              onChange={e => setShareUrl(e.target.value)}
            />
            <button className="capture-btn" style={{ marginTop:10 }} onClick={save}>
              Save QR URL
            </button>
            <p style={{ color:'#aaa', marginTop:6 }}>
              Tip (Mac): run <code>ipconfig getifaddr en0</code> to get your IP.
            </p>
          </>
        )}

        <button className="capture-btn" style={{ marginTop:12 }} onClick={onCapture}>
          Capture Selfie
        </button>
      </div>
    </div>
  );
}
