import { useEffect, useState } from 'react';
import { getToken } from '../lib/api';

/** Private files need the bearer token, so they are fetched as blobs rather than linked directly. */
export function AuthFile({ fileId, name, mime }: { fileId: string; name?: string; mime?: string }) {
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let revoke: string | undefined;
    fetch(`/api/files/${fileId}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? 'Not available (access denied or awaiting malware scan)' : 'Could not load file');
        revoke = URL.createObjectURL(await r.blob());
        setUrl(revoke);
      })
      .catch((e) => setErr((e as Error).message));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [fileId]);
  if (err) return <p className="text-xs text-red-700">{err}</p>;
  if (!url) return <p className="text-xs text-gray-500">Loading file…</p>;
  if (mime?.startsWith('image/')) return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={name ?? 'Evidence'} className="max-h-96 rounded border" /></a>;
  return <a className="link text-sm" href={url} download={name}>{name ?? 'Download file'}</a>;
}
