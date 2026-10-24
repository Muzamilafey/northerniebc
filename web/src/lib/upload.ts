import { api } from './api';

/** Uploads a logo or photo (JPEG, PNG or WebP, max 2 MB) and returns its file id. */
export async function uploadImage(purpose: 'PARTY_LOGO' | 'COUNTY_LOGO' | 'CANDIDATE_PHOTO', file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Use a JPEG, PNG or WebP image');
  if (file.size > 2 * 1024 * 1024) throw new Error('Images must be 2 MB or smaller');
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file);
  return (await api<{ fileId: string }>('/files', { form })).fileId;
}
