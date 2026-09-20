import { useEffect, useRef, useState } from 'react';
import type { WheelEvent } from 'react';

import { EVIDENCE_ZOOM_MAX, EVIDENCE_ZOOM_MIN, EVIDENCE_ZOOM_STEP } from '../constants';

export function PrivateImageLightbox({
  image,
  onClose,
}: {
  image: { alt: string; src: string };
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(EVIDENCE_ZOOM_MIN);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  function updateZoom(nextZoom: number) {
    setZoom(Math.min(EVIDENCE_ZOOM_MAX, Math.max(EVIDENCE_ZOOM_MIN, nextZoom)));
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    updateZoom(zoom + (event.deltaY < 0 ? EVIDENCE_ZOOM_STEP : -EVIDENCE_ZOOM_STEP));
  }

  return (
    <div
      aria-labelledby="private-image-preview-title"
      aria-modal="true"
      className="private-image-lightbox"
      onClick={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="dialog"
    >
      <div className="private-image-lightbox-panel">
        <header>
          <div>
            <p className="eyebrow">私有证据截图</p>
            <h2 id="private-image-preview-title">{image.alt}预览</h2>
          </div>
          <div aria-label="图片缩放控制" className="private-image-lightbox-controls" role="group">
            <button
              aria-label="缩小截图"
              disabled={zoom <= EVIDENCE_ZOOM_MIN}
              onClick={() => updateZoom(zoom - EVIDENCE_ZOOM_STEP)}
              type="button"
            >
              −
            </button>
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
            <button
              aria-label="放大截图"
              disabled={zoom >= EVIDENCE_ZOOM_MAX}
              onClick={() => updateZoom(zoom + EVIDENCE_ZOOM_STEP)}
              type="button"
            >
              +
            </button>
            <button
              disabled={zoom === EVIDENCE_ZOOM_MIN}
              onClick={() => updateZoom(1)}
              type="button"
            >
              还原
            </button>
            <button onClick={onClose} ref={closeButtonRef} type="button">
              关闭
            </button>
          </div>
        </header>
        <div
          aria-label="截图预览区域，滚轮可缩放"
          className="private-image-lightbox-stage"
          onWheel={handleWheel}
        >
          <img alt={image.alt} src={image.src} style={{ transform: `scale(${zoom})` }} />
        </div>
      </div>
    </div>
  );
}
