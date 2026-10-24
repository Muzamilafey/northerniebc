import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { uploadImage } from '../../lib/upload';
import { ErrorBox, Field, PageHeader, PublicImage, Success } from '../../components/ui';
import { useApi } from '../../lib/useApi';

interface County { _id: string; code: string; name: string; region?: string; logoFileId?: string }

export default function CountiesAdmin() {
  const list = useApi<{ items: County[] }>('/public/counties');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setMsg({});
    try {
      const logo = f.get('logo') as File | null;
      const logoFileId = logo && logo.size > 0 ? await uploadImage('COUNTY_LOGO', logo) : undefined;
      await api('/admin/counties', { body: { code: String(f.get('code')).padStart(3, '0'), name: f.get('name'), region: f.get('region') || undefined, logoFileId } });
      form.reset();
      setMsg({ ok: 'County added.' });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  }
  const update = async (c: County, body: Record<string, unknown>) => {
    try {
      await api(`/admin/counties/${c._id}`, { method: 'PATCH', body });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Counties" subtitle="Counties covered by the platform. Use the official county code (e.g. Garissa 007). Codes cannot be changed after creation." />
      <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={add}>
        <h2 className="font-bold sm:col-span-2 lg:col-span-5">Add county</h2>
        <Field label="County code"><input name="code" className="input" required pattern="\d{1,3}" placeholder="e.g. 012" /></Field>
        <Field label="Name"><input name="name" className="input" required /></Field>
        <Field label="Region (optional)"><input name="region" className="input" /></Field>
        <Field label="Logo (JPEG/PNG/WebP, max 2 MB)"><input name="logo" type="file" accept="image/jpeg,image/png,image/webp" className="input" /></Field>
        <div className="flex items-end"><button className="btn-primary">Add county</button></div>
      </form>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.items.map((c) => (
          <div key={c._id} className="card flex items-center gap-3">
            <PublicImage fileId={c.logoFileId} alt={`${c.name} County logo`} size={64} fallback={c.name} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{c.name}</p>
              <p className="text-xs text-gray-500">Code {c.code}{c.region ? ` · ${c.region}` : ''}</p>
              <div className="mt-1 flex gap-3 text-xs">
                <label className="link cursor-pointer">{c.logoFileId ? 'Replace logo' : 'Upload logo'}<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { await update(c, { logoFileId: await uploadImage('COUNTY_LOGO', file) }); } catch (x) { setMsg({ err: (x as Error).message }); } }} /></label>
                <button className="link" onClick={() => { const region = prompt('Region', c.region ?? ''); if (region !== null) void update(c, { region }); }}>Edit region</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
