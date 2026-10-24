import { Link } from 'react-router-dom';
import { Independence, PageHeader } from '../../components/ui';

export default function About() {
  return (
    <div className="prose max-w-3xl space-y-5">
      <PageHeader title="About The Northern IEBC" subtitle="Follow the Vote. Follow the Money. — tulinde Kura Zetu." />
      <Independence />
      <section className="card space-y-2 text-sm">
        <h2 className="text-lg font-bold text-navy-900">What we do</h2>
        <p>We help citizens of Garissa, Mandera, Wajir, Isiolo and Marsabit follow elections and public money: polling-station results reported by trained agents, county budgets and Treasury releases, development projects, and audit findings.</p>
      </section>
      <section className="card space-y-2 text-sm" id="methodology">
        <h2 className="text-lg font-bold text-navy-900">Methodology</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Election results.</strong> Agents transcribe figures from the results form at their assigned station and attach a photo of the form. Submissions are stored with a receipt, reviewed by verification officers, and labelled as <em>provisional</em>, <em>verified</em>, or <em>matched against official records</em>. Corrections create new revisions; nothing is silently overwritten. Only one accepted result per station and position is counted, so duplicates and revisions never inflate totals.</li>
          <li><strong>Vote share</strong> = candidate votes ÷ total valid candidate votes for the same position and area × 100. <strong>Reporting coverage</strong> = stations with a qualifying result ÷ registered stations in the area × 100. We never declare a winner.</li>
          <li><strong>Budgets.</strong> Figures come from published documents (Controller of Budget, National Treasury, county budget documents). Each figure records its reporting period, source and verification status. Budgeted, scheduled, released, received, spent and committed funds are always shown separately. A missing figure is shown as “not available”, never as zero.</li>
          <li><strong>Projects.</strong> Financial progress (money paid ÷ budget) and physical progress (from inspections, official reports or labelled observations) are separate measures. Full payment does not mean completion.</li>
          <li><strong>Audit findings</strong> use the wording of the report. Unsupported or irregular expenditure, audit queries and allegations are not findings of theft or misconduct.</li>
          <li><strong>Publication workflow.</strong> Imported → validated → reviewed by a second person → published. Corrections keep the earlier published values and the reason for the change.</li>
        </ul>
      </section>
      <section className="card space-y-2 text-sm">
        <h2 className="text-lg font-bold text-navy-900">Corrections</h2>
        <p>If you believe a figure is wrong, <Link className="link" to="/accountability#report">submit a correction request</Link> with the source you are relying on. Corrections are published with a revision history.</p>
      </section>
      <section className="card space-y-2 text-sm">
        <h2 className="text-lg font-bold text-navy-900">Primary sources</h2>
        <ul className="list-disc pl-5">
          <li><a className="link" href="https://bajetiyetu.treasury.go.ke/" target="_blank" rel="noopener noreferrer">National Treasury — Bajeti Yetu</a></li>
          <li><a className="link" href="https://cob.go.ke/" target="_blank" rel="noopener noreferrer">Office of the Controller of Budget</a></li>
          <li><a className="link" href="https://www.oagkenya.go.ke/county-governments-reports/" target="_blank" rel="noopener noreferrer">Office of the Auditor-General — County reports</a></li>
          <li><a className="link" href="https://igfr.treasury.go.ke/site/igfrd" target="_blank" rel="noopener noreferrer">National Treasury — Intergovernmental Fiscal Relations</a></li>
          <li>Official IEBC publications and authorised election records for each election.</li>
        </ul>
      </section>
    </div>
  );
}

export function Privacy() {
  return (
    <div className="max-w-3xl space-y-4 text-sm">
      <PageHeader title="Privacy notice" subtitle="How we handle personal data, in line with Kenya's Data Protection Act, 2019." />
      <section className="card space-y-2">
        <p><strong>Donors.</strong> We collect the details needed to process your payment (for M-Pesa, your phone number) and, optionally, your name, email and message. Contact details are encrypted at rest. We never store M-Pesa PINs or card security codes; card payments use the provider's hosted checkout. Your name is shown publicly only if you choose a named acknowledgement; amounts are never shown per donor.</p>
        <p><strong>Citizen reporters.</strong> Names and contact details are optional, encrypted, visible only to moderators on explicit request (which is logged), and never published.</p>
        <p><strong>Staff and agents.</strong> We record sign-in activity and actions in an audit log to protect the integrity of the data.</p>
        <p><strong>Agent registration and KRA.</strong> When you register as an agent, we send your national ID number to the Kenya Revenue Authority's PIN Checker to confirm your name and KRA PIN. These details are stored encrypted, are used only to vet agents, and are visible only to the administrators who approve agents (each view is logged). We never show them publicly.</p>
        <p><strong>Results-form photos.</strong> If an agent uses “read the numbers with AI”, the photo of the results form is sent to the AI provider the administrators have chosen (Anthropic or Groq) to read the figures. The reading is advisory and checked by people.</p>
        <p><strong>Retention.</strong> Payment records are retained as required for financial accountability; citizen-report contact details are deleted when no longer needed for follow-up. To exercise your rights (access, correction, deletion where lawful) contact the platform operator shown on the Donate page.</p>
      </section>
    </div>
  );
}
