import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from 'react';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'calm';
export type ButtonSize = 'md' | 'lg' | 'xl';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-leaf text-white hover:bg-leaf-deep shadow-soft',
  calm: 'bg-calm text-white hover:bg-calm-deep shadow-soft',
  secondary: 'bg-white text-ink border-2 border-cream-deep hover:border-calm shadow-soft',
  ghost: 'bg-transparent text-ink-soft hover:bg-cream-deep',
  danger: 'bg-blush text-ink hover:brightness-95',
};

const SIZE: Record<ButtonSize, string> = {
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg',
  xl: 'px-8 py-4 text-xl',
};

export function Button({
  variant = 'primary',
  size = 'lg',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}): ReactElement {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'grade-tap tap-target inline-flex items-center justify-center gap-2 rounded-full font-bold transition',
        'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-calm-deep',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'active:scale-[0.98]',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div {...rest} className={cx('rounded-card bg-white p-5 shadow-soft', className)}>
      {children}
    </div>
  );
}

export function SpeechBubble({
  children,
  tail = 'bottom',
  tone = 'pet',
  className,
}: {
  children: ReactNode;
  tail?: 'bottom' | 'left' | 'right' | 'none';
  tone?: 'pet' | 'child' | 'system';
  className?: string;
}): ReactElement {
  const toneClass =
    tone === 'child'
      ? 'bg-calm text-white'
      : tone === 'system'
        ? 'bg-cream-deep text-ink-soft'
        : 'bg-white text-ink shadow-soft';
  const tailClass =
    tail === 'bottom'
      ? 'after:left-1/2 after:-bottom-2 after:-translate-x-1/2'
      : tail === 'left'
        ? 'after:-left-2 after:top-4'
        : tail === 'right'
          ? 'after:-right-2 after:top-4'
          : 'after:hidden';
  return (
    <div
      className={cx(
        'relative inline-block max-w-[85%] rounded-bubble px-5 py-3 leading-relaxed',
        "after:absolute after:h-4 after:w-4 after:rotate-45 after:content-['']",
        tone === 'child'
          ? 'after:bg-calm'
          : tone === 'system'
            ? 'after:bg-cream-deep'
            : 'after:bg-white',
        toneClass,
        tailClass,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'grade-tap tap-target inline-flex items-center justify-center rounded-full bg-white text-ink shadow-soft transition hover:bg-cream-deep',
        'focus-visible:outline-4 focus-visible:outline-calm-deep',
        className,
      )}
    >
      {children}
    </button>
  );
}

export { cx };
