import { IslandSprite as IslandItemSprite, islandItemLabel } from '@/components/island/sprites';

export { islandItemLabel };

export function IslandSprite({
  itemId,
  size = 96,
  className = '',
}: {
  itemId: string;
  size?: number;
  className?: string;
}) {
  const label = islandItemLabel(itemId);
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="island-sprite"
      data-item={itemId}
      className={`inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <IslandItemSprite id={itemId} size={size} />
    </span>
  );
}
