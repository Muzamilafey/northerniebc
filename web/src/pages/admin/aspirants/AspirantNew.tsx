import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorBox, Field, Loading, PageHeader, PublicImage } from '../../../components/ui';
import { api } from '../../../lib/api';
import { POSITION_LABELS } from '../../../lib/format';
import { uploadImage } from '../../../lib/upload';
import { useApi } from '../../../lib/useApi';
import { CatalogTabs, SCOPE_HELP, SCOPE_OF, useAreas, type ElectionLite, type Party } from './shared';

function Section({ step, title, hint, children }: { step: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy-900 text-sm font-bold text-white" aria-hidden="true">{step}</span>
        <div>
          <h2 className="font-bold text-navy-900">{title}</h2>
          {hint && <p className="text-sm text-gray-600">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function AspirantNew() {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const elections = useApi<{ items: ElectionLite[] }>('/admin/elections');
  const parties = useApi<{ items: Party[] }>('/admin/parties');

  const [electionId, setElectionId] = useState(sp.get('electionId') ?? '');
  const eid = electionId || elections.data?.items[0]?._id || '';
  const positions = elections.data?.items.find((e) => e._id === eid)?.positions.filter((p) => p.enabled).map((p) => p.position) ?? [];
  const [position, setPosition] = useState(sp.get('position') ?? '');
  const pos = positions.includes(position) ? position : positions[0] ?? '';
  const scope = SCOPE_OF[pos];
  const [countyId, setCountyId] = useState(sp.get('countyId') ?? '');
  const [constituencyId, setConstituencyId] = useState(sp.get('constituencyId') ?? '');
  const [wardId, setWardId] = useState(sp.get('wardId') ?? '');
  const { counties, constituencies, wards } = useAreas(eid, countyId, constituencyId);
  const scopeRefId = scope === 'COUNTY' ? countyId : scope === 'CONSTITUENCY' ? constituencyId : scope === 'WARD' ? wardId : '';
  const areaLabel = useMemo(() => {
    const n = (l: { _id: string; name: string }[] | undefined, id: string) => l?.find((x) => x._id === id)?.name;
    if (scope === 'NATIONAL') return 'National';
    if (scope === 'COUNTY') return n(counties.data?.items, countyId) ? `${n(counties.data?.items, countyId)} County` : '';
    if (scope === 'CONSTITUENCY') return n(constituencies.data?.items, constituencyId) ? `${n(constituencies.data?.items, constituencyId)} Constituency` : '';
    return n(wards.data?.items, wardId) ? `${n(wards.data?.items, wardId)} Ward` : '';
  }, [scope, countyId, constituencyId, wardId, counties.data, constituencies.data, wards.data]);

  const [fullName, setFullName] = useState('');
  const [partyId, setPartyId] = useState('');
  const [ballotOrder, setBallotOrder] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return setPhotoUrl(null);
    const u = URL.createObjectURL(photo);
    setPhotoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo]);
  const party = parties.data?.items.find((p) => p._id === partyId);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [added, setAdded] = useState<string[]>([]);

  async function submit(e: FormEvent<HTMLFormElement>, another: boolean) {
    e.preventDefault();
    setErr('');
    if (scope !== 'NATIONAL' && !scopeRefId) return setErr(`Choose the ${scope?.toLowerCase()} this aspirant is contesting in.`);
    if (!partyId) return setErr('Choose a party, or Independent.');
    setBusy(true);
    try {
      const photoFileId = photo ? await uploadImage('CANDIDATE_PHOTO', photo) : undefined;
      await api('/admin/candidates', {
        body: {
          electionId: eid,
          position: pos,
          fullName: fullName.trim(),
          ...(partyId === 'IND' ? { independent: true } : { partyId }),
          scopeRefId: scope === 'NATIONAL' ? null : scopeRefId,
          ballotOrder: ballotOrder ? Number(ballotOrder) : undefined,
          sourceReference: sourceReference.trim() || undefined,
          photoFileId
        }
      });
      if (another) {
        setAdded((a) => [fullName.trim(), ...a]);
        setFullName('');
        setPartyId('');
        setBallotOrder('');
        setPhoto(null);
        document.getElementById('asp-name')?.focus();
      } else {
        const back = new URLSearchParams({ electionId: eid, position: pos, ...(countyId ? { countyId } : {}), ...(constituencyId ? { constituencyId } : {}), ...(wardId ? { wardId } : {}) });
        navigate(`/admin/aspirants?${back}`, { state: { saved: `${fullName.trim()} added to the ${POSITION_LABELS[pos]} ballot.` } });
      }
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const anotherRef = useRef(false);
  if (elections.loading) return <Loading />;

  return (
    <div>
      <PageHeader title="Add aspirant" subtitle="Add someone to the ballot. Use the name exactly as gazetted." actions={<Link to="/admin/aspirants" className="btn-outline">← All aspirants</Link>} />
      <CatalogTabs />
      <form className="grid gap-6 lg:grid-cols-[1fr_20rem]" onSubmit={(e) => void submit(e, anotherRef.current)}>
        <div className="space-y-6">
          <Section step={1} title="Contest" hint="Which race is this aspirant in?">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Election">
                <select className="input" value={eid} onChange={(e) => { setElectionId(e.target.value); setCountyId(''); setConstituencyId(''); setWardId(''); }}>
                  {elections.data?.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}
                </select>
              </Field>
              <Field label="Position" hint={scope ? SCOPE_HELP[scope] : undefined}>
                <select className="input" value={pos} onChange={(e) => setPosition(e.target.value)} required>
                  {!positions.length && <option value="">No positions enabled</option>}
                  {positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}
                </select>
              </Field>
              {scope && scope !== 'NATIONAL' && (
                <Field label="County">
                  <select className="input" value={countyId} onChange={(e) => { setCountyId(e.target.value); setConstituencyId(''); setWardId(''); }} required>
                    <option value="">Choose county…</option>
                    {counties.data?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                  </select>
                </Field>
              )}
              {(scope === 'CONSTITUENCY' || scope === 'WARD') && (
                <Field label="Constituency">
                  <select className="input" value={constituencyId} disabled={!countyId} onChange={(e) => { setConstituencyId(e.target.value); setWardId(''); }} required>
                    <option value="">{countyId ? 'Choose constituency…' : 'Choose a county first'}</option>
                    {constituencies.data?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                  </select>
                </Field>
              )}
              {scope === 'WARD' && (
                <Field label="Ward">
                  <select className="input" value={wardId} disabled={!constituencyId} onChange={(e) => setWardId(e.target.value)} required>
                    <option value="">{constituencyId ? 'Choose ward…' : 'Choose a constituency first'}</option>
                    {wards.data?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                  </select>
                </Field>
              )}
            </div>
            {!positions.length && <p className="mt-3 text-sm text-amber-800">Enable positions for this election under <Link className="link" to="/admin/elections">Election setup</Link> first.</p>}
            {countyId && constituencies.data?.items.length === 0 && (scope === 'CONSTITUENCY' || scope === 'WARD') && (
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">No constituencies are loaded for this county yet. Load the official IEBC list under <Link className="link" to="/admin/counties">Counties</Link>.</p>
            )}
          </Section>

          <Section step={2} title="Aspirant" hint="As printed on the ballot paper.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Full name"><input id="asp-name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={3} maxLength={200} autoComplete="off" /></Field>
              </div>
              <Field label="Party" hint={parties.data && !parties.data.items.length ? 'No parties yet — add them under Parties.' : undefined}>
                <select className="input" value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
                  <option value="">Choose…</option>
                  <option value="IND">Independent</option>
                  {parties.data?.items.filter((p) => p.active).map((p) => <option key={p._id} value={p._id}>{p.name} ({p.abbreviation})</option>)}
                </select>
              </Field>
              <Field label="Ballot order (optional)"><input className="input" type="number" min={0} value={ballotOrder} onChange={(e) => setBallotOrder(e.target.value)} /></Field>
              <div className="sm:col-span-2">
                <Field label="Source reference" hint="Where this nomination is published, e.g. Kenya Gazette notice number."><input className="input" value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} maxLength={300} /></Field>
              </div>
            </div>
          </Section>

          <Section step={3} title="Photo" hint="Optional. JPEG, PNG or WebP, up to 2 MB. A clear, front-facing portrait works best.">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 p-6 text-center text-sm text-gray-600 transition hover:border-brand-500 hover:bg-brand-50/40">
              {photoUrl ? <img src={photoUrl} alt="Selected photo" className="h-28 w-28 rounded-full object-cover" /> : <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-2xl" aria-hidden="true">📷</span>}
              <span className="font-semibold text-navy-800">{photo ? 'Choose a different photo' : 'Choose a photo'}</span>
              {photo && <span className="text-xs">{photo.name}</span>}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </label>
            {photo && <button type="button" className="link mt-2 text-sm" onClick={() => setPhoto(null)}>Remove photo</button>}
          </Section>

          {err && <ErrorBox error={err} />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link to="/admin/aspirants" className="btn-outline">Cancel</Link>
            <button type="submit" className="btn-outline" disabled={busy || !pos} onClick={() => (anotherRef.current = true)}>Save &amp; add another</button>
            <button type="submit" className="btn-accent" disabled={busy || !pos} onClick={() => (anotherRef.current = false)}>{busy ? 'Saving…' : 'Save aspirant'}</button>
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="card">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Ballot preview</p>
            <div className="flex items-center gap-3">
              {photoUrl ? <img src={photoUrl} alt="" className="h-16 w-16 rounded-full object-cover" /> : <PublicImage fileId={null} alt={fullName || 'Aspirant'} fallback={fullName || '?'} size={64} rounded="rounded-full" />}
              <div className="min-w-0">
                <p className="truncate font-semibold text-navy-900">{fullName || 'Aspirant name'}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-gray-700">
                  {partyId && partyId !== 'IND' && <PublicImage fileId={party?.logoFileId} alt="" fallback={party?.abbreviation} size={20} />}
                  {partyId === 'IND' ? 'Independent' : party ? `${party.name} (${party.abbreviation})` : 'No party chosen'}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">{pos ? POSITION_LABELS[pos] : 'Position'}{areaLabel ? ` · ${areaLabel}` : ''}</p>
              </div>
            </div>
          </div>
          {added.length > 0 && (
            <div className="card">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Added just now</p>
              <ul className="space-y-1 text-sm">{added.map((n, i) => <li key={i} className="flex items-center gap-2"><span className="text-teal-700" aria-hidden="true">✓</span>{n}</li>)}</ul>
              <Link to={`/admin/aspirants?electionId=${eid}&position=${pos}`} className="link mt-2 inline-block text-sm">View in list</Link>
            </div>
          )}
        </aside>
      </form>
    </div>
  );
}
