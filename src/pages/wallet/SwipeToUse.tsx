// Deliberate swipe: the knob must travel ~60% of the track before release
// counts. A tap or nervous nudge springs back.
import { useRef, useState } from 'react';
import { ChevronsRight } from 'lucide-react';

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function SwipeToUse({ label, onComplete, disabled }: {
  label: string;
  onComplete: () => void;
  disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef(0);

  const KNOB = 56;

  function maxTravel(): number {
    return (track.current?.clientWidth ?? 300) - KNOB - 8;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (disabled) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    start.current = e.clientX - x;
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    setX(Math.max(0, Math.min(maxTravel(), e.clientX - start.current)));
  }

  function onPointerUp() {
    if (!dragging) return;
    setDragging(false);
    if (x >= maxTravel() * 0.6) {
      setX(maxTravel());
      onComplete();
      setTimeout(() => setX(0), 400);
    } else {
      setX(0);
    }
  }

  // Keyboard path: pressing a key is deliberate in a way a stray tap is not,
  // so Enter/Space completes directly (the swipe guards against touch slips).
  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setX(maxTravel());
      onComplete();
      setTimeout(() => setX(0), 400);
    }
  }

  return (
    <div
      ref={track}
      className={`relative h-16 rounded-full bg-muted select-none touch-none overflow-hidden ${disabled ? 'opacity-40' : ''}`}
    >
      <div
        className="absolute inset-0 flex items-center justify-center gap-1 text-sm font-medium text-muted-foreground transition-opacity"
        style={{ opacity: 1 - x / (maxTravel() || 1) }}
        aria-hidden="true"
      >
        {label} <ChevronsRight className="size-4" />
      </div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        className="absolute top-1 left-1 h-14 w-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        style={{
          transform: `translateX(${x}px)`,
          transition: dragging || reducedMotion() ? 'none' : 'transform 200ms ease',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        aria-label={label}
      >
        <ChevronsRight aria-hidden="true" className="size-6" />
      </div>
    </div>
  );
}
