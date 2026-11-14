import {SVG_MATERIAL_EXAMPLE} from './visual-material-example.mjs';
// Worked constructions, not templates. Geometry/data are deliberately inspectable.
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const text=(x,y,s,size=16,fill='#d4dbe2',extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
const doc=(title,summary,w,h,body)=>({version:2,kind:'custom',title,summary,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Segoe UI, Arial, sans-serif"><title>${esc(title)}</title><desc>${esc(summary)}</desc>${body}</svg>`});

// Demonstration values only. Missing day 3 must break the path, never become zero.
export const SVG_DATA_EXAMPLE_VALUES=[{day:1,minutes:18},{day:2,minutes:12},{day:3,minutes:null},{day:4,minutes:15},{day:5,minutes:9}];
export const svgDataExamplePoint=({day,minutes})=>({x:56+(day-1)/4*272,y:minutes===null?null:196-minutes/20*144});
const points=SVG_DATA_EXAMPLE_VALUES.map(svgDataExamplePoint);
const data={
 lesson:'Data construction from explicitly illustrative inputs: days 1-5 have 18,12,missing,15,9 minutes. Map x=56+(day-1)/4*272 and y=196-value/20*144. Use a quiet bordered panel with a recessed plotting surface, aligned typography and subordinate grid lines. Keep the data geometry flat and exact. Draw ticks/grid behind points. Start a new path after missing day 3; never substitute zero or imply measured continuity. Endpoint labels make the visible change readable. This demonstrates coordinate derivation and honest gaps, not a recommended chart for every dataset.',
 document:doc('Response time with a missing day','Illustrative data, not a measured service result. Median response times: day 1 18 minutes; day 2 12 minutes; day 3 not recorded; day 4 15 minutes; day 5 9 minutes. The vertical scale runs from 0 to 20 minutes. Two disconnected line segments preserve the reporting gap. These five days do not establish a causal explanation.',360,268,
 '<rect width="360" height="268" fill="#14181e"/><rect x="2" y="2" width="356" height="264" rx="4" fill="#1c232b" stroke="#414a55"/><path d="M 8 3 H 352" stroke="#58616a" stroke-width="0.75"/><rect x="52" y="44" width="280" height="156" rx="2" fill="#12191f" stroke="#303c46"/>'+text(24,28,'Median response time (min)',18,'#d4dbe2','font-weight="600"')+
 [0,10,20].map(v=>{const y=196-v/20*144;return `<path d="M 56 ${y} H 328" fill="none" stroke="#414a55" stroke-width="0.75"/>`+text(43,y+5,String(v),14,'#a8b2be','text-anchor="end"');}).join('')+
 `<path d="M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y} M ${points[3].x} ${points[3].y} L ${points[4].x} ${points[4].y}" fill="none" stroke="#9fb8c6" stroke-width="2"/>`+
 points.filter(p=>p.y!==null).map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" fill="#b7cbd5"/>`).join('')+
 SVG_DATA_EXAMPLE_VALUES.map((v,i)=>text(points[i].x,220,String(v.day),14,'#a8b2be','text-anchor="middle"')).join('')+
 text(56,254,'Day',14,'#a8b2be')+text(180,254,'3: not recorded',14,'#c6b99f')+
 text(67,94,'18',14)+text(310,156,'9',14)),
};

const ux={
 lesson:'UX construction: a fictional mobile file-save screen in an error state, not a functioning app. A 24-unit inset aligns heading, field and recovery action; title/body/helper sizes establish hierarchy. The error sits beside its cause and the proposed action resolves it without overwriting. Spacing is derived from content blocks, with 48-unit controls and room for two error lines. At desktop width recompose the layout; do not scale this whole screen.',
 document:doc('Save a revised field note','Static UX study, not interactive controls. A mobile save screen contains a filename field set to Field notes, an inline error saying a file with that name already exists, a prominent Save a copy recovery action and a secondary Cancel action. Saving a copy keeps the existing file. Intended keyboard order is filename, Save a copy, Cancel; that behavior is proposed, not implemented by the SVG.',360,364,
 '<rect width="360" height="364" fill="#14181e"/>'+text(24,38,'Save field note',20)+text(24,68,'Keep the original or save a new copy.',16,'#a8b2be')+
 text(24,112,'Filename',14)+
 '<rect x="24" y="124" width="312" height="48" rx="5" fill="#20262d" stroke="#c6b99f"/>'+text(40,154,'Field notes',16)+
 text(24,198,'A file with this name already exists.',14,'#d9c7a8')+text(24,218,'Save a copy to keep both versions.',14,'#a8b2be')+
 '<rect x="24" y="246" width="312" height="48" rx="5" fill="#9fb8c6"/>'+text(180,276,'Save a copy',16,'#14181e','text-anchor="middle" font-weight="600"')+
 text(180,334,'Cancel',16,'#a8b2be','text-anchor="middle"')),
};
export const SVG_CRAFT_EXAMPLES={illustration:[SVG_MATERIAL_EXAMPLE],data:[data],ux:[ux]};
export const SVG_GENERAL_EXAMPLES=[SVG_MATERIAL_EXAMPLE,data,ux];
