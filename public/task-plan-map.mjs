import { planAncestors, planKindLabel, planLogicFields, planBranchText, planAttemptHistory } from './task-plan-model.mjs';

// These are views of saved nodes, never a second editable planning document.
// Node IDs and relation targets stay attached to the original task revision.
export const PLAN_MAP_ZOOM = Object.freeze({ min: 0.35, max: 2.5, step: 0.2, readableMin: 0.9 });
const clean = value => Array.from(String(value ?? '')).filter(character => { const code = character.codePointAt(0); return code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff; }).join('');
export const escapePlanXML = value => clean(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
const bounded = value => Math.min(PLAN_MAP_ZOOM.max, Math.max(PLAN_MAP_ZOOM.min, Number.isFinite(value) ? value : 1));
export const planMapZoom = value => Math.round(bounded(value) * 100) / 100;
const keyFor = id => `step:${id}`;

// An open inspector can leave a short canvas. Fitting its height would make
// labels unreadable even when there is ample width. Keep at least 11.7px of
// the native 13px title size; larger trees scroll, with explicit zoom-out for
// an overview. Automatic fitting never enlarges past the native reading size.
export function planMapFitZoom(map, availableWidth) {
  const ratio = Number.isFinite(availableWidth) && availableWidth > 0 && Number.isFinite(map?.width) && map.width > 0 ? availableWidth / map.width : 1;
  return planMapZoom(Math.max(PLAN_MAP_ZOOM.readableMin, Math.min(1, ratio)));
}

export function planMapContains(view, focusId, id) {
  return !focusId || focusId === id || planAncestors(view, id).includes(focusId);
}

export function reconcilePlanMapSession(view, session = {}) {
  const mapFocusId = view.byId.has(session.mapFocusId) ? session.mapFocusId : null;
  return { ...session, presentation: session.presentation === 'map' ? 'map' : 'outline', mapFocusId: planMapContains(view, mapFocusId, session.selectedId) ? mapFocusId : null, mapZoom: planMapZoom(session.mapZoom) };
}

/** Deterministic left-to-right layout. Sibling order is the persisted order. */
export function taskPlanMap(view, { focusId = null, collapsed = new Set() } = {}) {
  const focus = view.byId.get(focusId), width = 232, height = 110, gapX = 80, gapY = 22, pad = 28;
  const goal = { id: null, key: 'goal', isGoal: true, title: view.goal || view.title, number: '', kind: view.plan.layout || 'sequence', status: '', statusLabel: 'Goal', children: view.roots, branch: 'included', branchLogic: view.plan.branch };
  const nodes = [], byId = new Map(), edges = [], externalDependencies = []; let row = 0, maxDepth = 0;
  function position(source, depth) {
    const node = { ...source, key: source.isGoal ? 'goal' : keyFor(source.id), width, height, x: pad + depth * (width + gapX), y: 0, isGoal: source.isGoal === true, collapsed: !source.isGoal && source.children.length > 0 && collapsed.has(source.id) };
    nodes.push(node); if (node.id !== null) byId.set(node.id, node); maxDepth = Math.max(maxDepth, depth);
    const children = node.collapsed ? [] : source.children;
    if (children.length) {
      const laidOut = children.map(child => position(child, depth + 1));
      node.y = (laidOut[0].y + laidOut.at(-1).y) / 2;
      for (const child of laidOut) edges.push({ from: node.key, to: child.key, sourceId: node.id, targetId: child.id, relation: ['parallel', 'choice'].includes(node.kind) ? node.kind : 'sequence', source: node, target: child });
    } else { node.y = pad + row * (height + gapY); row++; }
    return node;
  }
  if (view.nodes.length) position(focus || goal, 0);
  for (const target of nodes) for (const sourceId of target.dependsOn || []) {
    const source = byId.get(sourceId);
    if (source) edges.push({ from: source.key, to: target.key, sourceId, targetId: target.id, relation: 'dependency', source, target });
    else if (view.byId.has(sourceId)) externalDependencies.push({ sourceId, targetId: target.id });
  }
  return { nodes, byId, edges, externalDependencies, focusId: focus?.id || null, width: nodes.length ? pad * 2 + (maxDepth + 1) * width + maxDepth * gapX : width + pad * 2, height: nodes.length ? pad * 2 + Math.max(1, row) * (height + gapY) - gapY : height + pad * 2 };
}

function titleLines(value, limit = 27, maxLines = 3) {
  const words = clean(value).replace(/\s+/g, ' ').trim().split(' '), lines = []; let line = '';
  for (const word of words) {
    if (line && Array.from(`${line} ${word}`).length > limit) { lines.push(line); line = ''; }
    let rest = Array.from(word);
    while (rest.length > limit) { if (line) { lines.push(line); line = ''; } lines.push(rest.splice(0, limit).join('')); }
    if (rest.length) line += `${line ? ' ' : ''}${rest.join('')}`;
  }
  if (line) lines.push(line);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) visible[maxLines - 1] = `${Array.from(visible[maxLines - 1]).slice(0, limit - 1).join('')}…`;
  return visible.length ? visible : [''];
}

function relationPath(edge) {
  const { source, target } = edge;
  if (edge.relation === 'dependency') {
    const fromX = source.x + source.width / 2, toX = target.x + target.width / 2;
    const downward = target.y >= source.y, fromY = source.y + (downward ? source.height : 0), toY = target.y + (downward ? 0 : target.height);
    const bend = Math.max(18, Math.abs(toY - fromY) / 2);
    return `M${fromX},${fromY} C${fromX},${fromY + (downward ? bend : -bend)} ${toX},${toY - (downward ? bend : -bend)} ${toX},${toY}`;
  }
  const fromX = source.x + source.width, fromY = source.y + source.height / 2, toX = target.x, toY = target.y + target.height / 2, bend = (fromX + toX) / 2;
  return `M${fromX},${fromY} C${bend},${fromY} ${bend},${toY} ${toX},${toY}`;
}

const standaloneStyle = `svg{color:#d7e6f4;font-family:system-ui,sans-serif}.task-plan-map-node-surface{fill:var(--task-plan-map-surface);stroke:currentColor;stroke-opacity:.36;stroke-width:1}.is-goal .task-plan-map-node-surface{fill:var(--task-plan-map-surface-goal)}.is-selected .task-plan-map-node-surface,.is-current .task-plan-map-node-surface{fill:var(--task-plan-map-surface-active);stroke-opacity:.9;stroke-width:2}.task-plan-map-title{fill:currentColor;font-size:13px;font-weight:550}.task-plan-map-number,.task-plan-map-status,.task-plan-map-kind{fill:currentColor;font-size:10px;opacity:.8}.task-plan-map-node[data-status=done]{color:#9be5c8}.task-plan-map-node[data-status=blocked]{color:#f2c295}.task-plan-map-node[data-branch=not-selected]{opacity:.55}.task-plan-map-edge{fill:none;stroke:currentColor;stroke-opacity:.44;stroke-width:1.5}.task-plan-map-edge[data-relation=parallel]{stroke-dasharray:4 3}.task-plan-map-edge[data-relation=choice]{stroke-dasharray:1 4}.task-plan-map-edge[data-relation=dependency]{stroke:#e4bb92;stroke-dasharray:7 4;stroke-opacity:.8}.task-plan-map-arrow{fill:currentColor}.task-plan-map-node:focus .task-plan-map-node-surface{stroke-width:3;stroke-opacity:1}`;

export function renderTaskPlanMapSVG(view, session = {}, { prefix = 'blackice-task-map', standalone = false, wholePlan = false } = {}) {
  prefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'blackice-task-map';
  const map = taskPlanMap(view, { focusId: wholePlan ? null : session.mapFocusId, collapsed: wholePlan ? new Set() : session.collapsed || new Set() }), e = escapePlanXML;
  const zoom = standalone ? 1 : planMapZoom(session.mapZoom), ids = { title: `${prefix}-title`, help: `${prefix}-help`, surface: `${prefix}-surface`, active: `${prefix}-active`, goal: `${prefix}-goal`, arrow: `${prefix}-arrow` };
  const gradient = (id, from, to) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}" stop-opacity=".92"/><stop offset="1" stop-color="${to}" stop-opacity=".72"/></linearGradient>`;
  const definitions = `<defs>${gradient(ids.surface, '#1c3342', '#0c1b28')}${gradient(ids.active, '#365b70', '#173343')}${gradient(ids.goal, '#2c4758', '#142e3e')}<marker id="${ids.arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="task-plan-map-arrow" d="M1 1L9 5L1 9Z"/></marker></defs>`;
  const edges = map.edges.map(edge => `<path class="task-plan-map-edge" data-relation="${edge.relation}" data-source-id="${e(edge.sourceId || '')}" data-target-id="${e(edge.targetId)}" d="${relationPath(edge)}"${edge.relation === 'dependency' ? ` marker-end="url(#${ids.arrow})"` : ''}><title>${e(edge.relation === 'dependency' ? `${edge.target.title} depends on ${edge.source.title}` : `${planKindLabel(edge.relation)}: ${edge.source.title} → ${edge.target.title}`)}</title></path>`).join('');
  const nodes = map.nodes.map(node => {
    const selected = session.selectedId === node.id, active = view.planningEnabled && view.focus?.id === node.id;
    const control = node.isGoal ? 'role="img"' : `role="button" tabindex="${selected ? '0' : '-1'}" aria-pressed="${selected}" data-plan-action="map-select" data-plan-map-node="${e(node.id)}" data-step-id="${e(node.id)}"${active ? ' aria-current="step"' : ''}`;
    const details = [node.isGoal ? 'Goal' : `Step ${node.number}`, node.title, node.statusLabel, node.branchRole ? node.branchRole + ' path' : '', node.isGroup ? planKindLabel(node.kind) : '', node.collapsed ? `${node.children.length} substeps collapsed` : '', node.branchLogic ? planBranchText(node.branchLogic, id => view.byId.get(id)?.title || id) : node.condition ? `Condition: ${node.condition}` : '', node.attempt > 1 ? 'Attempt ' + node.attempt : ''].filter(Boolean).join('. ');
    const lines = titleLines(node.title).map((line, index) => `<tspan x="14" dy="${index ? '17' : '0'}">${e(line)}</tspan>`).join('');
    return `<g class="task-plan-map-node${node.isGoal ? ' is-goal' : ''}${selected ? ' is-selected' : ''}${active ? ' is-current' : ''}" ${control} data-status="${e(node.status)}" data-kind="${e(node.kind)}" data-branch="${e(node.branch)}" aria-label="${e(details)}" transform="translate(${node.x} ${node.y})"><title>${e(details)}</title><rect class="task-plan-map-node-surface" width="${node.width}" height="${node.height}" rx="12"/><text class="task-plan-map-number" x="14" y="19">${e(node.isGoal ? 'Goal' : node.number)}</text><text class="task-plan-map-status" x="${node.width - 14}" y="19" text-anchor="end">${e(node.isGoal ? '' : node.statusLabel)}</text><text class="task-plan-map-title" x="14" y="41">${lines}</text><text class="task-plan-map-kind" x="14" y="97">${e(node.collapsed ? `${node.children.length} substeps · collapsed` : node.branchRole ? node.branchRole + (node.isSelectedOption ? ' · Chosen path' : ' path') : node.isGoal || node.isGroup ? planKindLabel(node.kind) : node.isSelectedOption ? 'Chosen path' : node.branch === 'option' ? 'Alternative' : '')}</text></g>`;
  }).join('');
  const metadata = standalone ? `<metadata>${e(JSON.stringify({ taskId: view.taskId, revision: view.state.revision, goal: view.goal, plan: view.plan, steps: view.state.steps || [] }))}</metadata>` : '';
  const exportStyle = standaloneStyle.replaceAll('var(--task-plan-map-surface)', `url(#${ids.surface})`).replaceAll('var(--task-plan-map-surface-active)', `url(#${ids.active})`).replaceAll('var(--task-plan-map-surface-goal)', `url(#${ids.goal})`);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="task-plan-map" width="${Math.round(map.width * zoom)}" height="${Math.round(map.height * zoom)}" viewBox="0 0 ${map.width} ${map.height}" role="group" aria-labelledby="${ids.title}" aria-describedby="${ids.help}"${standalone ? '' : ` style="--task-plan-map-surface:url(#${ids.surface});--task-plan-map-surface-active:url(#${ids.active});--task-plan-map-surface-goal:url(#${ids.goal})"`}><title id="${ids.title}">${e(map.focusId ? `${view.byId.get(map.focusId).title} — branch map` : `${view.title} — task mind map`)}</title><desc id="${ids.help}">The saved task tree. Step numbers show order, dotted branches show alternatives, and dashed arrows show dependencies. Select a step to inspect its notes and evidence. Arrow keys navigate, Enter opens details, and F focuses a branch.</desc>${definitions}${standalone ? `<style>${exportStyle}</style>` : ''}${metadata}<g class="task-plan-map-edges" aria-hidden="true">${edges}</g><g class="task-plan-map-nodes">${nodes}</g></svg>`;
}

/** Conservative common Freeplane/FreeMind XML subset; no executable content. */
export function exportTaskPlanMM(view) {
  const e = escapePlanXML, ids = new Map(view.nodes.map((node, index) => [node.id, `BLACKICE_STEP_${index + 1}`]));
  // XML normalizes literal attribute whitespace. References preserve multiline
  // goals and titles in editors instead of silently turning them into spaces.
  const a = value => e(value).replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
  const attribute = (name, value) => value === undefined || value === null || value === '' ? '' : `<attribute NAME="${a(name)}" VALUE="${a(value)}"/>`;
  function renderNode(node, depth) {
    const fields = [['Done when', node.doneWhen], ['Expected result', node.result], ['Evidence', node.evidence], ['Note', node.note], ['Condition', node.condition], ...planLogicFields(view, node), ['Path', node.branchRole], ['Blocked by', node.blockedReason], ['Why skipped', node.skipReason], ['Current attempt', node.attempt > 1 ? String(node.attempt) : ''], ...planAttemptHistory(node).map(attempt => ['Attempt ' + (attempt.attempt || '?'), [attempt.status, attempt.at ? 'Archived on: ' + attempt.at : '', attempt.reason, ...attempt.fields.map(([label, value]) => label + ': ' + value)].filter(Boolean).join('\n')])].filter(([, value]) => value);
    const note = fields.length ? `<richcontent TYPE="NOTE"><html xmlns="http://www.w3.org/1999/xhtml"><head/><body>${fields.map(([label, value]) => `<p><b>${label}: </b>${e(value).replace(/\r\n|\r|\n/g, '<br/>')}</p>`).join('')}</body></html></richcontent>` : '';
    const links = node.dependsOn.filter(id => ids.has(id)).map(id => `<arrowlink DESTINATION="${ids.get(id)}" STARTARROW="DEFAULT" ENDARROW="NONE"/>`).join('');
    return `<node ID="${ids.get(node.id)}" TEXT="${a(node.title)}"${depth === 1 ? ' POSITION="right"' : ''}>${attribute('BLACKICE step ID', node.id)}${attribute('Order', node.number)}${attribute('Kind', node.kind)}${attribute('Status', node.status)}${attribute('Branch', node.branch)}${attribute('Selected child', node.selectedChildId)}${note}${links}${node.children.map(child => renderNode(child, depth + 1)).join('')}</node>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1"><node ID="BLACKICE_GOAL" TEXT="${a(view.goal || view.title)}">${attribute('BLACKICE task ID', view.taskId)}${attribute('Task revision', view.state.revision)}${attribute('Root relation', view.plan.layout || 'sequence')}${attribute('Selected child', view.plan.selectedChildId)}${planLogicFields(view, { branchLogic: view.plan.branch, selectedChildId: view.plan.selectedChildId }).map(([label, value]) => attribute(label, value)).join('')}${view.roots.map(node => renderNode(node, 1)).join('')}</node></map>\n`;
}

export function taskPlanExport(view, format = 'svg') {
  if (!['svg', 'mm'].includes(format)) throw new Error('Choose SVG or Freeplane (.mm).');
  if (!view.nodes.length) throw new Error('There are no saved steps to export yet.');
  const stem = clean(view.title).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'task-plan';
  return { fileName: `${stem}.${format}`, contentType: format === 'svg' ? 'image/svg+xml;charset=utf-8' : 'application/xml;charset=utf-8', text: format === 'svg' ? `<?xml version="1.0" encoding="UTF-8"?>\n${renderTaskPlanMapSVG(view, {}, { standalone: true, wholePlan: true })}` : exportTaskPlanMM(view) };
}
