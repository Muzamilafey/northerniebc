import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { can, useAuth } from '../lib/auth';
import { Independence, Logo } from './ui';

const NAV = [
  ['/', 'Home'],
  ['/results', 'Live Results'],
  ['/counties', 'Counties'],
  ['/budgets', 'County Budgets'],
  ['/projects', 'Development Projects'],
  ['/accountability', 'Audit & Accountability'],
  ['/reports', 'Reports & Downloads'],
  ['/about', 'About Us']
] as const;

export function Layout() {
  const [open, setOpen] = useState(false);
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const portal = user ? (user.role === 'AGENT' ? '/agent' : '/admin') : null;
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 bg-navy-900 text-white shadow">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2">
          <Link to="/" aria-label="The Northern IEBC home">
            <Logo size={44} />
          </Link>
          <nav className="hidden items-center gap-1 xl:flex" aria-label="Main">
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `rounded-md px-2.5 py-1.5 text-sm ${isActive ? 'bg-white/15 font-semibold' : 'hover:bg-white/10'}`}>
                {label}
              </NavLink>
            ))}
            <NavLink to="/donate" className="ml-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-700">
              Donate
            </NavLink>
            {user ? (
              <>
                <NavLink to={portal!} className="rounded-md px-2.5 py-1.5 text-sm hover:bg-white/10">
                  {user.role === 'AGENT' ? 'Agent portal' : 'Admin'}
                </NavLink>
                <button className="rounded-md px-2.5 py-1.5 text-sm hover:bg-white/10" onClick={async () => { await signOut(); nav('/'); }}>
                  Sign out
                </button>
              </>
            ) : (
              <NavLink to="/login" className="rounded-md px-2.5 py-1.5 text-sm hover:bg-white/10">
                Login
              </NavLink>
            )}
          </nav>
          <div className="flex items-center gap-2 xl:hidden">
            <Link to="/results" className="rounded-md bg-white/10 px-2 py-1 text-xs font-semibold">Results</Link>
            <Link to="/budgets" className="rounded-md bg-white/10 px-2 py-1 text-xs font-semibold">Budgets</Link>
            <button aria-expanded={open} aria-controls="mobile-nav" className="rounded-md p-2 hover:bg-white/10" onClick={() => setOpen(!open)}>
              <span className="sr-only">Menu</span>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" className="border-t border-white/10 px-4 pb-3 xl:hidden" aria-label="Mobile">
            {[...NAV, ['/donate', 'Donate'] as const].map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)} className="block rounded px-2 py-2 text-sm hover:bg-white/10">
                {label}
              </NavLink>
            ))}
            {user ? (
              <>
                <NavLink to={portal!} onClick={() => setOpen(false)} className="block rounded px-2 py-2 text-sm hover:bg-white/10">{user.role === 'AGENT' ? 'Agent portal' : 'Admin'}</NavLink>
                <button className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-white/10" onClick={async () => { setOpen(false); await signOut(); nav('/'); }}>Sign out</button>
              </>
            ) : (
              <NavLink to="/login" onClick={() => setOpen(false)} className="block rounded px-2 py-2 text-sm hover:bg-white/10">Login</NavLink>
            )}
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-gray-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 py-6 text-sm sm:grid-cols-3">
          <div>
            <Logo size={36} />
            <p className="mt-2 text-xs text-gray-600">Garissa · Mandera · Wajir · Isiolo · Marsabit</p>
          </div>
          <div className="space-y-1">
            <Link className="link block" to="/about">Methodology &amp; sources</Link>
            <Link className="link block" to="/accountability#report">Report an issue or request a correction</Link>
            <Link className="link block" to="/donate/transparency">Donation transparency</Link>
            <Link className="link block" to="/privacy">Privacy notice</Link>
          </div>
          <Independence />
        </div>
      </footer>
    </div>
  );
}

/** Side navigation for staff portals. */
export function StaffLayout() {
  const { user, signOut, mfaSetupRequired } = useAuth();
  const nav = useNavigate();
  const r = user?.role;
  const links: [string, string, boolean][] = [
    ['/admin', 'Results dashboard', can.monitor(r)],
    ['/verify', 'Verification queue', can.verify(r)],
    ['/verify/approvals', 'Second-review approvals', can.verify(r) || can.donations(r)],
    ['/admin/users', 'Users & agents', can.manageUsers(r)],
    ['/admin/elections', 'Election setup', can.elections(r)],
    ['/admin/imports', 'Data imports', can.finance(r) || can.elections(r)],
    ['/admin/records', 'Financial & project records', can.finance(r)],
    ['/admin/sources', 'Source registry', can.finance(r)],
    ['/verify/citizen-reports', 'Citizen reports', can.moderate(r)],
    ['/admin/donations', 'Donations', can.donations(r)],
    ['/admin/audit-log', 'Audit log', can.audit(r)],
    ['/admin/account', 'My account & security', true]
  ];
  return (
    <div className="flex min-h-screen flex-col bg-gray-50 lg:flex-row">
      <aside className="bg-navy-900 text-white lg:w-64 lg:shrink-0">
        <div className="flex items-center justify-between p-4">
          <Link to="/"><Logo size={36} /></Link>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible" aria-label="Staff">
          {links.filter(([, , show]) => show).map(([to, label]) => (
            <NavLink key={to} to={to} end className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? 'bg-white/15 font-semibold' : 'hover:bg-white/10'}`}>
              {label}
            </NavLink>
          ))}
          <button className="whitespace-nowrap rounded-md px-3 py-2 text-left text-sm hover:bg-white/10" onClick={async () => { await signOut(); nav('/login'); }}>
            Sign out
          </button>
        </nav>
        {user && <p className="hidden px-4 pb-4 text-xs text-white/70 lg:block">{user.fullName}</p>}
      </aside>
      <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
        {mfaSetupRequired && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Your account must enrol multi-factor authentication before privileged actions are allowed. <Link className="link" to="/admin/account">Set it up now</Link>.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
