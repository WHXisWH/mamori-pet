import Link from 'next/link';

function Omamori() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M9 3.2c0-1 1.3-1.5 3-1.5s3 .5 3 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect x="5.5" y="4" width="13" height="17.5" rx="3.2" fill="currentColor" opacity="0.18" />
      <rect
        x="5.5"
        y="4"
        width="13"
        height="17.5"
        rx="3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M12 9.2c-1-1.4-3.2-.8-3.2.9 0 1.6 2 2.8 3.2 3.7 1.2-.9 3.2-2.1 3.2-3.7 0-1.7-2.2-2.3-3.2-.9Z"
        fill="currentColor"
      />
      <path d="M8.5 17h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function HelpButton({ label = '困ったとき' }: { label?: string }) {
  return (
    <Link
      href="/help"
      aria-label="困ったときの連絡先をひらく"
      data-testid="help-button"
      className="grade-tap tap-target z-50 inline-flex items-center justify-center gap-1.5 rounded-full border border-calm/30 bg-white/85 px-3 text-sm font-bold text-calm-deep shadow-soft backdrop-blur hover:bg-white focus-visible:outline-4 focus-visible:outline-calm-deep"
    >
      <Omamori />
      <span>{label}</span>
    </Link>
  );
}
