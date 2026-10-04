export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function viewProgress(rect: DOMRect, vh: number): number {
  return clamp01((vh - rect.top) / (vh + rect.height));
}
