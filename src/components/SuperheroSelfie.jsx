export default function SuperheroSelfie({ image, emotion, onClose }) {
  const title =
    emotion === 'happy' ? 'HAPPY HERO' :
    emotion === 'angry' ? 'RAGE MODE' :
    emotion === 'surprised' ? 'SHOCKWAVE' :
    'STAND BY';
  const download = () => {
    const a = document.createElement('a');
    a.href = image;
    a.download = `superhero-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <div className="selfie-modal" onClick={onClose}>
      <div className="selfie-content" onClick={(e) => e.stopPropagation()}>
        <img src={image} alt="Selfie" />
        <h2>{title}</h2>
        <div>
          <button onClick={download}>Download</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
