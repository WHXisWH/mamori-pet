import type {
  ArtworkFormFields,
  ArtworkRes,
  PetRequest,
  PetRequestCompleteReq,
  PetRequestCompleteRes,
  PetRequestDeclineRes,
  PetRequestsRes,
} from '@ijime/api-types';

import { childRequest } from './api';

export type RequestNarrative = { mode: 'typed' | 'voice_transcript'; text: string };

export async function fetchPetRequests(): Promise<PetRequest[]> {
  const res = await childRequest<PetRequestsRes>('/v1/child/pet-requests');
  return res.items;
}

export async function fetchPetRequest(requestId: string): Promise<PetRequest | null> {
  const items = await fetchPetRequests();
  return items.find((item) => item.requestId === requestId) ?? null;
}

export function completePetRequest(
  requestId: string,
  body: PetRequestCompleteReq,
): Promise<PetRequestCompleteRes> {
  return childRequest<PetRequestCompleteRes>(
    `/v1/child/pet-requests/${encodeURIComponent(requestId)}/complete`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function declinePetRequest(requestId: string): Promise<PetRequestDeclineRes> {
  return childRequest<PetRequestDeclineRes>(
    `/v1/child/pet-requests/${encodeURIComponent(requestId)}/decline`,
    { method: 'POST' },
  );
}

export function uploadRequestArtwork(input: {
  png: Blob;
  type: Extract<ArtworkFormFields['type'], 'drawing' | 'story'>;
  requestId: string;
  promptId: string;
  save: boolean;
  narrative: RequestNarrative | null;
}): Promise<ArtworkRes> {
  const form = new FormData();
  form.set('image', input.png, 'drawing.png');
  form.set('type', input.type);
  form.set('requestId', input.requestId);
  form.set('promptId', input.promptId);
  form.set('save', input.save ? 'true' : 'false');
  form.set('narrativeMode', input.narrative?.mode ?? 'typed');
  if (input.narrative) form.set('narrativeText', input.narrative.text);
  return childRequest<ArtworkRes>('/v1/child/artworks', { method: 'POST', body: form });
}
