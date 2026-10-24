/**
 * Constituencies and county assembly wards (CAWs) of the five covered counties, with their
 * official IEBC codes. Transcribed from the IEBC "Registered Voters per County Assembly Ward
 * for the 2022 General Election" schedule (the 2017 schedule uses the same codes). Boundaries
 * are those delimited in 2012; if the IEBC publishes a new delimitation this list must be
 * replaced from the new gazette notice — never edited from memory.
 */
export const AREAS_SOURCE = {
  name: 'IEBC — Registered Voters per County Assembly Ward, 2022 General Election',
  publisher: 'Independent Electoral and Boundaries Commission',
  url: 'https://www.iebc.or.ke/docs/rov_per_caw.pdf',
  kind: 'ELECTION_PUBLICATION' as const
};

type Area = { code: string; name: string; wards: [code: string, name: string][] };

export const AREAS: Record<string, Area[]> = {
  // Garissa (007)
  '007': [
    { code: '027', name: 'Garissa Township', wards: [['0131', 'Waberi'], ['0132', 'Galbet'], ['0133', 'Township'], ['0134', 'Iftin']] },
    { code: '028', name: 'Balambala', wards: [['0135', 'Balambala'], ['0136', 'Danyere'], ['0137', 'Jara Jara'], ['0138', 'Saka'], ['0139', 'Sankuri']] },
    { code: '029', name: 'Lagdera', wards: [['0140', 'Modogashe'], ['0141', 'Benane'], ['0142', 'Goreale'], ['0143', 'Maalimin'], ['0144', 'Sabena'], ['0145', 'Baraki']] },
    { code: '030', name: 'Dadaab', wards: [['0146', 'Dertu'], ['0147', 'Dadaab'], ['0148', 'Labasigale'], ['0149', 'Damajale'], ['0150', 'Liboi'], ['0151', 'Abakaile']] },
    { code: '031', name: 'Fafi', wards: [['0152', 'Bura'], ['0153', 'Dekaharia'], ['0154', 'Jarajila'], ['0155', 'Fafi'], ['0156', 'Nanighi']] },
    { code: '032', name: 'Ijara', wards: [['0157', 'Hulugho'], ['0158', 'Sangailu'], ['0159', 'Ijara'], ['0160', 'Masalani']] }
  ],
  // Wajir (008)
  '008': [
    { code: '033', name: 'Wajir North', wards: [['0161', 'Gurar'], ['0162', 'Bute'], ['0163', 'Korondile'], ['0164', 'Malkagufu'], ['0165', 'Batalu'], ['0166', 'Danaba'], ['0167', 'Godoma']] },
    { code: '034', name: 'Wajir East', wards: [['0168', 'Wagberi'], ['0169', 'Township'], ['0170', 'Barwago'], ['0171', 'Khorof/Harar']] },
    { code: '035', name: 'Tarbaj', wards: [['0172', 'Elben'], ['0173', 'Sarman'], ['0174', 'Tarbaj'], ['0175', 'Wargadud']] },
    { code: '036', name: 'Wajir West', wards: [['0176', 'Arbajahan'], ['0177', 'Hadado/Athibohol'], ['0178', 'Ademasajide'], ['0179', 'Ganyure/Wagalla']] },
    { code: '037', name: 'Eldas', wards: [['0180', 'Eldas'], ['0181', 'Della'], ['0182', 'Lakoley South/Basir'], ['0183', 'Elnur/Tula Tula']] },
    { code: '038', name: 'Wajir South', wards: [['0184', 'Benane'], ['0185', 'Burder'], ['0186', 'Dadaja Bulla'], ['0187', 'Habasswein'], ['0188', 'Lagboghol South'], ['0189', 'Ibrahim Ure'], ['0190', 'Diif']] }
  ],
  // Mandera (009)
  '009': [
    { code: '039', name: 'Mandera West', wards: [['0191', 'Takaba South'], ['0192', 'Takaba'], ['0193', 'Lagsure'], ['0194', 'Dandu'], ['0195', 'Gither']] },
    { code: '040', name: 'Banissa', wards: [['0196', 'Banissa'], ['0197', 'Derkhale'], ['0198', 'Guba'], ['0199', 'Malkamari'], ['0200', 'Kiliwehiri']] },
    { code: '041', name: 'Mandera North', wards: [['0201', 'Ashabito'], ['0202', 'Guticha'], ['0203', 'Morothile'], ['0204', 'Rhamu'], ['0205', 'Rhamu-Dimtu']] },
    { code: '042', name: 'Mandera South', wards: [['0206', 'Wargadud'], ['0207', 'Kutulo'], ['0208', 'Elwak South'], ['0209', 'Elwak North'], ['0210', 'Shimbir Fatuma']] },
    { code: '043', name: 'Mandera East', wards: [['0211', 'Arabia'], ['0212', 'Township'], ['0213', 'Neboi'], ['0214', 'Khalalio'], ['0215', 'Libehia']] },
    { code: '044', name: 'Lafey', wards: [['0216', 'Sala'], ['0217', 'Fino'], ['0218', 'Lafey'], ['0219', 'Waranqara'], ['0220', 'Alango Gof']] }
  ],
  // Marsabit (010)
  '010': [
    { code: '045', name: 'Moyale', wards: [['0221', 'Butiye'], ['0222', 'Sololo'], ['0223', 'Heillu/Manyatta'], ['0224', 'Golbo'], ['0225', 'Moyale Township'], ['0226', 'Uran'], ['0227', 'Obbu']] },
    { code: '046', name: 'North Horr', wards: [['0228', 'Dukana'], ['0229', 'Maikona'], ['0230', 'Turbi'], ['0231', 'North Horr'], ['0232', 'Illeret']] },
    { code: '047', name: 'Saku', wards: [['0233', 'Sagante/Jaldesa'], ['0234', 'Karare'], ['0235', 'Marsabit Central']] },
    { code: '048', name: 'Laisamis', wards: [['0236', 'Loiyangalani'], ['0237', 'Kargi/South Horr'], ['0238', 'Korr/Ngurunit'], ['0239', 'Log Logo'], ['0240', 'Laisamis']] }
  ],
  // Isiolo (011)
  '011': [
    { code: '049', name: 'Isiolo North', wards: [['0241', 'Wabera'], ['0242', 'Bulla Pesa'], ['0243', 'Chari'], ['0244', 'Cherab'], ['0245', 'Ngare Mara'], ['0246', 'Burat'], ['0247', 'Oldo/Nyiro']] },
    { code: '050', name: 'Isiolo South', wards: [['0248', 'Garbatulla'], ['0249', 'Kinna'], ['0250', 'Sericho']] }
  ]
};
