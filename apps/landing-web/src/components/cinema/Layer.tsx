import type { CSSProperties, ReactNode } from 'react';

export const VIEW_W = 1600;
export const VIEW_H = 900;

export function Layer({
  depth,
  children,
  className = '',
  style,
  label,
  inner,
}: {
  depth: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  label?: string;
  inner?: { className?: string; style?: CSSProperties };
}) {
  const svg = (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid slice"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {children}
    </svg>
  );
  return (
    <div className={`layer ${className}`} style={{ ['--d' as string]: depth, ...style }}>
      {inner ? (
        <div className={`absolute inset-0 ${inner.className ?? ''}`} style={inner.style}>
          {svg}
        </div>
      ) : (
        svg
      )}
    </div>
  );
}

export function LightLayer({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <Layer depth={depth} className="light-layer animate-beam">
      {children}
    </Layer>
  );
}

export function BlurFilter({ id, amount }: { id: string; amount: number }) {
  return (
    <filter id={id} x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation={amount} />
    </filter>
  );
}
