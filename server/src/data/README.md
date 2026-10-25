# Reference data

## `areas.ts` — constituencies and county assembly wards

24 constituencies and 120 wards of Garissa, Wajir, Mandera, Marsabit and Isiolo with their IEBC codes, from the IEBC *Registered Voters per County Assembly Ward, 2022 General Election* schedule. The codes and names were checked against the polling-station register below (all 120 ward codes agree).

## `stations2022.ts` — polling stations

2,384 polling stations (streams) with their 15-digit IEBC codes, names and registered voters, from the IEBC *Register of Voters per Polling Station, 2022 General Election* (`https://www.iebc.or.ke/docs/rov_per_polling_station.pdf`).

The IEBC site could not be reached from the build environment, so the list was taken from two independent, public text extractions of that IEBC PDF and reconciled:

| Extraction | Rows (5 counties) |
| --- | --- |
| `github.com/kigenchesire/kenya-polling-stations-data` (`polling_stations.json`, 46,229 rows nationally — the IEBC national station count) | 2,384 |
| `github.com/CollinsNasongo/CoundysAPI` (`etl/app/data/2022/rov_per_polling_station_2022.csv`) | 2,382 |

Reconciliation (codes normalised to digits):

- 2,382 stations appear in both with the same code, ward and constituency.
- 2 stations are only in the first extraction (long names broke the second one's parsing): `008036017607201` Abaqmathobe Nursery and Primary School (22 voters) and `011050024800501` Sayyidah Fatimah Girls Educational Complex (593 voters).
- Registered voters agree for every common station except two, where the second extraction joined the number at the end of the registration-centre name onto the count (a defect its README documents): `007030014902301` Borehole 2 → 462 (not 2,462) and `009043021201801` Border Point 1 → 351 (not 1,351).
- Names were taken from the second extraction, which does not truncate long names.

Checks against figures published separately by the IEBC / Kenya Gazette:

- Ward totals for 14 wards (Hulugho, Sangailu, Ijara, Masalani, Benane (Wajir South), Butiye, Sagante/Jaldesa, Karare, Marsabit Central, Loiyangalani, Kargi/South Horr, Korr/Ngurunit, Logo Logo, Laisamis) equal the sums of their stations exactly.
- County totals equal the published 2022 county registers exactly: Garissa 201,473; Wajir 207,758; Mandera 217,030; Marsabit 166,912; Isiolo 89,504 (882,677 in all).

These are the **2022** register figures. When the IEBC publishes the register for a later election, import it through *Data imports → POLLING_STATIONS*; changed figures are reported as conflicts and never overwritten silently.
