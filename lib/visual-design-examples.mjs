// Authored illustrations of visual arguments, not a chart-type menu or reusable claim data.
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const t=(x,y,s,size=16,color='#d4dbe2',weight=400)=>`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(s)}</text>`;
const line=(x1,y1,x2,y2,color='#414a55',extra='')=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ${extra}/>`;
const doc=(title,summary,height,body)=>({version:2,kind:'custom',title,summary,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}" viewBox="0 0 760 ${height}" font-family="Segoe UI, Arial, sans-serif"><title>${esc(title)}</title><desc>${esc(summary)}</desc><rect width="760" height="${height}" rx="6" fill="#14181e"/>${body}</svg>`});
export const VISUAL_DESIGN_EXAMPLES=[
 {lesson:'Make the dependence visible. These three reports share a source; the converging lines and source count carry the argument. Repeated boxes or three evidence votes would obscure it.',document:doc('Three reports. One underlying source.','Illustrative example, not a real intelligence finding. A news report, an analyst note and a briefing all derive from the same source. They provide one independent source, not three confirmations. Seek an independently collected observation.',370,
  t(28,34,'SOURCE DEPENDENCE',11,'#94a1af',600)+t(28,72,'Three reports. One underlying source.',26,'#edf0f3',600)+
  ['News report','Analyst note','Briefing'].map((s,i)=>t(28+i*250,126,s,17)+t(28+i*250,151,'Repeats the same account',13,'#9faab6')+line(28+i*250,168,218+i*250,168)).join('')+
  '<path d="M 123 177 C 123 209 380 190 380 218 M 373 177 L 380 218 M 623 177 C 623 209 380 190 380 218" fill="none" stroke="#7d9baa" stroke-width="1.5"/>'+
  t(278,249,'1 independent source',20,'#e1e7ed',600)+t(158,277,'Repeated reporting is not independent confirmation.',15,'#b2bdc8')+
  line(28,293,732,293)+t(28,325,'NEXT CHECK',11,'#a9bdca',600)+t(146,325,'Seek an independently collected observation.',16)+t(28,352,'Illustrative analysis',11,'#8c98a5'))},
 {lesson:'Use alignment to make the discriminating evidence stand out. Shared observations are quiet; the observation that would change the assessment receives the single accent. Blank space separates evidence from the next collection step.',document:doc('The shared evidence cannot decide the case.','Illustrative competing-explanations comparison. Port congestion and falling inventories are compatible with both supply disruption and a demand surge. Shortages on unaffected routes would weaken the disruption explanation and support the demand explanation; that observation has not yet been collected.',404,
  t(28,34,'COMPETING EXPLANATIONS',11,'#94a1af',600)+t(28,72,'The shared evidence cannot decide the case.',24,'#edf0f3',600)+
  t(28,121,'Observation',13,'#9faab6')+t(325,121,'Supply disruption',17,'#e1e7ed',600)+t(550,121,'Demand surge',17,'#e1e7ed',600)+line(28,137,732,137)+
  t(28,173,'Port congestion')+t(325,173,'Consistent')+t(550,173,'Consistent')+line(28,191,732,191,'#2c343f')+
  t(28,225,'Falling inventories')+t(325,225,'Consistent')+t(550,225,'Consistent')+
  '<rect x="28" y="250" width="704" height="68" rx="3" fill="#23282d"/><rect x="28" y="250" width="3" height="68" fill="#b9a786"/>'+
  t(42,275,'Shortages on unaffected routes',15,'#e4dfd5',600)+t(42,298,'Not yet observed',13,'#b7b0a3')+t(325,286,'Would weaken',16,'#d7c7ac')+t(550,286,'Would support',16,'#d7c7ac')+
  t(28,355,'COLLECTION PRIORITY',11,'#a9bdca',600)+t(28,382,'Compare shortages on affected and unaffected routes.',17))},
 {lesson:'Represent missingness as missingness. Two aligned lanes separate event time from reporting coverage. The gap is the analytical feature; no invented event or continuous line fills it.',document:doc('A reporting gap leaves the interval unresolved.','Illustrative timeline. An event was reported on Monday and another on Friday. Reporting was absent Tuesday through Thursday. The gap does not establish that nothing happened during those days.',352,
  t(28,34,'TIME AND COVERAGE',11,'#94a1af',600)+t(28,72,'A reporting gap leaves the interval unresolved.',24,'#edf0f3',600)+
  ['Mon','Tue','Wed','Thu','Fri'].map((s,i)=>t(187+i*120,115,s,13,'#9faab6')).join('')+
  t(28,165,'Reported events',14,'#b6c0ca')+line(200,161,680,161,'#414a55','stroke-dasharray="3 6"')+
  '<circle cx="200" cy="161" r="5" fill="#b8cbd5"/><circle cx="680" cy="161" r="5" fill="#b8cbd5"/>'+
  t(170,189,'Event A',14)+t(650,189,'Event B',14)+t(28,243,'Reporting coverage',14,'#b6c0ca')+
  '<rect x="180" y="225" width="72" height="20" rx="2" fill="#647d8a"/><rect x="630" y="225" width="72" height="20" rx="2" fill="#647d8a"/>'+
  line(268,235,612,235,'#8d867b','stroke-dasharray="4 5"')+t(336,269,'Unknown — no reporting',15,'#c6b99f')+
  line(28,291,732,291)+t(28,325,'Do not infer an uneventful interval from missing reports.',17))},
];
