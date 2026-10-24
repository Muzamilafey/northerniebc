import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { can, ROLE_LABELS, useAuth, type Role } from '../lib/auth';
import { Icon, type IconName } from './icons';
import { useSiteFlags } from '../lib/siteFlags';
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
  // When administrators close agent sign-in, the public Login button is hidden (staff use the footer link).
  const showLogin = useSiteFlags()?.agentLogin !== false;
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
              showLogin && (
                <NavLink to="/login" className="rounded-md px-2.5 py-1.5 text-sm hover:bg-white/10">
                  Login
                </NavLink>
              )
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
              showLogin && <NavLink to="/login" onClick={() => setOpen(false)} className="block rounded px-2 py-2 text-sm hover:bg-white/10">Login</NavLink>
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
            {!user && <Link className="block text-xs text-gray-500 hover:underline" to="/login">Staff sign-in</Link>}
          </div>
          <Independence />
        </div>
      </footer>
    </div>
  );
}

type NavItem = { to: string; label: string; icon: IconName; show: boolean; end?: boolean };

function StaffNav({ groups, onNavigate }: { groups: [string, NavItem[]][]; onNavigate?: () => void }) {
  return (
    <nav className="space-y-6 px-3" aria-label="Staff">
      {groups.map(([group, items]) => {
        const visible = items.filter((i) => i.show);
        if (!visible.length) return null;
        return (
          <div key={group}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">{group}</p>
            <ul className="space-y-0.5">
              {visible.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-white/10 font-semibold text-white shadow-inner ring-1 ring-white/10' : 'text-white/75 hover:bg-white/5 hover:text-white'}`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={isActive ? 'text-brand-400' : 'text-white/50 group-hover:text-white/80'}><Icon name={i.icon} /></span>
                        {i.label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Side navigation for staff portals; a slide-out drawer on phones. */
export function StaffLayout() {
  const { user, signOut, mfaSetupRequired } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [location.pathname]);
  const r = user?.role;
  const catalog = r === 'SUPER_ADMIN' || r === 'REGIONAL_ADMIN';
  const groups: [string, NavItem[]][] = [
    ['Overview', [{ to: '/admin', label: 'Results dashboard', icon: 'chart', show: can.monitor(r), end: true }]],
    [
      'Results',
      [
        { to: '/verify', label: 'Verification queue', icon: 'check', show: can.verify(r), end: true },
        { to: '/verify/approvals', label: 'Second-review approvals', icon: 'scale', show: can.verify(r) || can.donations(r) }
      ]
    ],
    [
      'Election',
      [
        { to: '/admin/elections', label: 'Election setup', icon: 'ballot', show: can.elections(r) },
        { to: '/admin/aspirants', label: 'Aspirants', icon: 'person', show: catalog },
        { to: '/admin/parties', label: 'Parties', icon: 'flag', show: catalog },
        { to: '/admin/counties', label: 'Counties & areas', icon: 'map', show: r === 'SUPER_ADMIN' },
        { to: '/admin/users', label: 'Users & agents', icon: 'users', show: can.manageUsers(r) }
      ]
    ],
    [
      'Data & money',
      [
        { to: '/admin/imports', label: 'Data imports', icon: 'upload', show: can.finance(r) || can.elections(r) },
        { to: '/admin/records', label: 'Financial & project records', icon: 'wallet', show: can.finance(r) },
        { to: '/admin/sources', label: 'Source registry', icon: 'book', show: can.finance(r) },
        { to: '/verify/citizen-reports', label: 'Citizen reports', icon: 'chat', show: can.moderate(r) },
        { to: '/admin/donations', label: 'Donations', icon: 'heart', show: can.donations(r) }
      ]
    ],
    [
      'System',
      [
        { to: '/admin/audit-log', label: 'Audit log', icon: 'list', show: can.audit(r) },
        { to: '/admin/settings', label: 'Settings', icon: 'cog', show: r === 'SUPER_ADMIN' },
        { to: '/admin/account', label: 'My account & security', icon: 'lock', show: true }
      ]
    ]
  ];
  const initials = (user?.fullName ?? '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const out = async () => {
    await signOut();
    nav('/login');
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 py-5">
        <Link to="/" className="text-white"><Logo size={36} /></Link>
        <button className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><Icon name="x" /></button>
      </div>
      <div className="flex-1 overflow-y-auto pb-6"><StaffNav groups={groups} onNavigate={() => setOpen(false)} /></div>
      {user && (
        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white" aria-hidden="true">{initials}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white" title={user.fullName}>{user.fullName}</p>
              <p className="truncate text-xs text-white/60">{ROLE_LABELS[user.role as Role] ?? user.role}</p>
            </div>
            <button className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white" onClick={() => void out()} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      {/* Desktop sidebar */}
      <aside className="hidden bg-navy-900 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-72 lg:shrink-0">{sidebar}</aside>
      {/* Phone top bar + drawer */}
      <header className="sticky top-0 z-30 flex items-center justify-between bg-navy-900 px-4 py-3 text-white shadow lg:hidden">
        <Link to="/"><Logo size={30} /></Link>
        <button className="rounded-lg p-2 hover:bg-white/10" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}><Icon name="menu" className="h-6 w-6" /></button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="animate-backdrop absolute inset-0 bg-navy-900/60" onClick={() => setOpen(false)} />
          <aside className="animate-dialog absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-navy-900 shadow-2xl">{sidebar}</aside>
        </div>
      )}
      <main id="main" className="min-w-0 flex-1">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {mfaSetupRequired && (
            <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <Icon name="lock" />
              <p className="flex-1">Your account must enrol multi-factor authentication before privileged actions are allowed.</p>
              <Link className="btn-outline btn-sm" to="/admin/account">Set it up now</Link>
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
