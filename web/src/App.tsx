import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout, StaffLayout } from './components/Layout';
import { Loading } from './components/ui';
import { useAuth, type Role } from './lib/auth';
import Home from './pages/public/Home';

const Results = lazy(() => import('./pages/public/Results'));
const Station = lazy(() => import('./pages/public/Station'));
const Counties = lazy(() => import('./pages/public/Counties').then((m) => ({ default: m.Counties })));
const CountyPage = lazy(() => import('./pages/public/Counties').then((m) => ({ default: m.CountyPage })));
const Budgets = lazy(() => import('./pages/public/Budgets'));
const DepartmentPage = lazy(() => import('./pages/public/Budgets').then((m) => ({ default: m.DepartmentPage })));
const Projects = lazy(() => import('./pages/public/Projects'));
const ProjectDetail = lazy(() => import('./pages/public/Projects').then((m) => ({ default: m.ProjectDetail })));
const Accountability = lazy(() => import('./pages/public/Accountability'));
const FindingDetail = lazy(() => import('./pages/public/Accountability').then((m) => ({ default: m.FindingDetail })));
const Reports = lazy(() => import('./pages/public/Reports'));
const About = lazy(() => import('./pages/public/About'));
const Privacy = lazy(() => import('./pages/public/About').then((m) => ({ default: m.Privacy })));
const Donate = lazy(() => import('./pages/public/Donate'));
const DonationStatusPage = lazy(() => import('./pages/public/Donate').then((m) => ({ default: m.DonationStatusPage })));
const Transparency = lazy(() => import('./pages/public/Donate').then((m) => ({ default: m.Transparency })));
const DonationTerms = lazy(() => import('./pages/public/Donate').then((m) => ({ default: m.DonationTerms })));
const Register = lazy(() => import('./pages/public/Register'));
const RegisterConfirm = lazy(() => import('./pages/public/Register').then((m) => ({ default: m.RegisterConfirm })));
const AspirantList = lazy(() => import('./pages/admin/aspirants/AspirantList'));
const AspirantNew = lazy(() => import('./pages/admin/aspirants/AspirantNew'));
const Parties = lazy(() => import('./pages/admin/aspirants/Parties'));
const Coverage = lazy(() => import('./pages/admin/Coverage'));
const CountiesAdmin = lazy(() => import('./pages/admin/CountiesAdmin'));
const SettingsPage = lazy(() => import('./pages/admin/Settings'));
const Search = lazy(() => import('./pages/public/Search'));
const Login = lazy(() => import('./pages/public/Login'));
const ForgotPassword = lazy(() => import('./pages/public/Login').then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('./pages/public/Login').then((m) => ({ default: m.ResetPassword })));

const AgentLayout = lazy(() => import('./pages/agent/Agent').then((m) => ({ default: m.AgentLayout })));
const AgentHome = lazy(() => import('./pages/agent/Agent').then((m) => ({ default: m.AgentHome })));
const CountScreen = lazy(() => import('./pages/agent/Agent').then((m) => ({ default: m.CountScreen })));
const AgentHistory = lazy(() => import('./pages/agent/Agent').then((m) => ({ default: m.AgentHistory })));

const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const Users = lazy(() => import('./pages/admin/Users'));
const Elections = lazy(() => import('./pages/admin/Elections'));
const Imports = lazy(() => import('./pages/admin/Imports'));
const ImportJob = lazy(() => import('./pages/admin/Imports').then((m) => ({ default: m.ImportJob })));
const Records = lazy(() => import('./pages/admin/Records'));
const Sources = lazy(() => import('./pages/admin/Records').then((m) => ({ default: m.Sources })));
const DonationsAdmin = lazy(() => import('./pages/admin/Donations'));
const Account = lazy(() => import('./pages/admin/Account'));
const AuditLog = lazy(() => import('./pages/admin/Account').then((m) => ({ default: m.AuditLog })));
const Queue = lazy(() => import('./pages/verify/Verify'));
const SubmissionDetail = lazy(() => import('./pages/verify/Verify').then((m) => ({ default: m.SubmissionDetail })));
const Approvals = lazy(() => import('./pages/verify/Verify').then((m) => ({ default: m.Approvals })));
const CitizenModeration = lazy(() => import('./pages/verify/Verify').then((m) => ({ default: m.CitizenModeration })));

/** Client-side route guard for UX only; the API enforces every permission itself. */
function RequireRole({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/portal" replace />;
  return <>{children}</>;
}

function Portal() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'AGENT') return <Navigate to="/agent" replace />;
  if (user.role === 'FINANCE_OFFICER') return <Navigate to="/admin/records" replace />;
  if (user.role === 'VERIFICATION_OFFICER') return <Navigate to="/verify" replace />;
  return <Navigate to="/admin" replace />;
}

const STAFF: Role[] = ['SUPER_ADMIN', 'REGIONAL_ADMIN', 'COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR', 'VERIFICATION_OFFICER', 'FINANCE_OFFICER'];

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="results" element={<Results />} />
          <Route path="results/stations/:stationId" element={<Station />} />
          <Route path="counties" element={<Counties />} />
          <Route path="counties/:slug" element={<CountyPage />} />
          <Route path="budgets" element={<Budgets />} />
          <Route path="budgets/departments/:id" element={<DepartmentPage />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:reference" element={<ProjectDetail />} />
          <Route path="accountability" element={<Accountability />} />
          <Route path="accountability/findings/:key" element={<FindingDetail />} />
          <Route path="reports" element={<Reports />} />
          <Route path="about" element={<About />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="donate" element={<Donate />} />
          <Route path="donate/status/:reference" element={<DonationStatusPage />} />
          <Route path="donate/transparency" element={<Transparency />} />
          <Route path="donate/terms" element={<DonationTerms />} />
          <Route path="search" element={<Search />} />
          <Route path="register" element={<Register />} />
          <Route path="register/confirm" element={<RegisterConfirm />} />
          <Route path="login" element={<Login />} />
          <Route path="forgot-password" element={<ForgotPassword />} />
          <Route path="reset-password" element={<ResetPassword />} />
          <Route path="portal" element={<Portal />} />
          <Route path="*" element={<div className="card">Page not found.</div>} />
        </Route>
        <Route path="agent" element={<RequireRole roles={['AGENT']}><AgentLayout /></RequireRole>}>
          <Route index element={<AgentHome />} />
          <Route path="count/:electionId/:stationId/:position" element={<CountScreen />} />
          <Route path="history" element={<AgentHistory />} />
        </Route>
        <Route element={<RequireRole roles={STAFF}><StaffLayout /></RequireRole>}>
          <Route path="admin" element={<Dashboard />} />
          <Route path="admin/users" element={<Users />} />
          <Route path="admin/elections" element={<Elections />} />
          <Route path="admin/imports" element={<Imports />} />
          <Route path="admin/imports/:id" element={<ImportJob />} />
          <Route path="admin/records" element={<Records />} />
          <Route path="admin/sources" element={<Sources />} />
          <Route path="admin/donations" element={<DonationsAdmin />} />
          <Route path="admin/audit-log" element={<AuditLog />} />
          <Route path="admin/account" element={<Account />} />
          <Route path="admin/settings" element={<SettingsPage />} />
          <Route path="admin/aspirants" element={<AspirantList />} />
          <Route path="admin/aspirants/new" element={<AspirantNew />} />
          <Route path="admin/parties" element={<Parties />} />
          <Route path="admin/coverage" element={<Coverage />} />
          <Route path="admin/counties" element={<CountiesAdmin />} />
          <Route path="verify" element={<Queue />} />
          <Route path="verify/submissions/:id" element={<SubmissionDetail />} />
          <Route path="verify/approvals" element={<Approvals />} />
          <Route path="verify/citizen-reports" element={<CitizenModeration />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
