/**
 * Loads reference data that is factual and stable: the five covered counties (with their
 * constitutional county codes) and the official data portals named in the project brief.
 * It does NOT load any election results, budgets, projects or findings — those must come
 * from source documents through the import workflow.
 */
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { County, DataSource } from '../models/index.js';

export const COUNTIES = [
  { code: '007', name: 'Garissa', slug: 'garissa', region: 'North Eastern' },
  { code: '008', name: 'Wajir', slug: 'wajir', region: 'North Eastern' },
  { code: '009', name: 'Mandera', slug: 'mandera', region: 'North Eastern' },
  { code: '010', name: 'Marsabit', slug: 'marsabit', region: 'Upper Eastern' },
  { code: '011', name: 'Isiolo', slug: 'isiolo', region: 'Upper Eastern' }
];

export const OFFICIAL_PORTALS = [
  { name: 'Kenya National Treasury — Bajeti Yetu', publisher: 'The National Treasury', url: 'https://bajetiyetu.treasury.go.ke/', kind: 'PORTAL' },
  { name: 'Office of the Controller of Budget', publisher: 'Office of the Controller of Budget', url: 'https://cob.go.ke/', kind: 'PORTAL' },
  { name: 'Office of the Auditor-General — County Governments Reports', publisher: 'Office of the Auditor-General', url: 'https://www.oagkenya.go.ke/county-governments-reports/', kind: 'PORTAL' },
  { name: 'National Treasury — Intergovernmental Fiscal Relations', publisher: 'The National Treasury', url: 'https://igfr.treasury.go.ke/site/igfrd', kind: 'PORTAL' }
] as const;

export async function seedReference() {
  for (const c of COUNTIES) await County.updateOne({ code: c.code }, { $setOnInsert: c }, { upsert: true });
  for (const p of OFFICIAL_PORTALS) {
    await DataSource.updateOne(
      { url: p.url },
      { $setOnInsert: { ...p, retrievedAt: new Date(), verificationStatus: 'REVIEWED', notes: 'Official portal listed in the platform brief. Individual documents must be registered separately.' } },
      { upsert: true }
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await connectMongo();
  await seedReference();
  console.log('Reference data loaded: 5 counties, 4 official portals.');
  await disconnectMongo();
}
