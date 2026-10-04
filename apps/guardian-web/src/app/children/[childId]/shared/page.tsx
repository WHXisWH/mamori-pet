import { SharedArtworkGallery } from '@/components/SharedArtworkGallery';

export default async function SharedPage({ params }: { params: Promise<{ childId: string }> }) {
  const { childId } = await params;
  return <SharedArtworkGallery key={childId} childId={childId} />;
}
