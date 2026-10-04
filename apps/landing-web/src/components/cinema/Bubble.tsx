import type { CSSProperties } from 'react';

import { petTop, type PetPlacement } from './scenes';

export function SceneBubble({
  text,
  pet,
  depth,
  testId,
}: {
  text: string;
  pet: PetPlacement;
  depth: number;
  testId?: string | undefined;
}) {
  const m = pet.mobile ?? pet;
  const style = {
    ['--d' as string]: depth,
    ['--bx-d' as string]: pet.x,
    ['--by-d' as string]: petTop(pet),
    ['--bx-m' as string]: m.x,
    ['--by-m' as string]: petTop(m),
  } as CSSProperties;
  return (
    <div aria-hidden="true" className="layer bubble-layer" style={style}>
      <div className="bubble-anchor">
        <p data-testid={testId} className="bubble">
          {text}
        </p>
      </div>
    </div>
  );
}

export function Subtitle({ text, testId }: { text: string; testId?: string | undefined }) {
  return (
    <p data-testid={testId} className="subtitle">
      {text}
    </p>
  );
}
