import { planningModeLabel } from './planning-mode.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const field = (label, value) => value ? '<div class="task-plan-detail-field"><dt>' + label + '</dt><dd>' + escape(value) + '</dd></div>' : '';

export function renderContractHeader(view) {
  const ratio = view.progress.total ? Math.round(view.progress.done / view.progress.total * 100) : 0;
  const phase = view.complete ? 'Outcomes satisfied' : view.phase === 'blocked' ? 'Needs attention' : view.live ? 'In progress' : 'Progress saved';
  return '<div class="task-plan-eyebrow"><span>Task plan</span><span class="task-plan-phase" data-phase="' + escape(view.phase) + '">' + phase + '</span></div>'
    + '<details class="task-plan-goal" data-plan-disclosure="goal"><summary><h2>' + escape(view.title.slice(0, 160)) + '</h2><span>Full task</span></summary><p class="task-plan-goal-text" tabindex="0">' + escape(view.goal) + '</p></details>'
    + '<div class="task-plan-methods"><span class="task-plan-mode">Planning ' + escape(planningModeLabel(view.planningMode)) + '</span></div>'
    + '<div class="task-plan-progress-copy"><strong>' + view.progress.done + '<span> / ' + view.progress.total + '</span></strong><span>work items satisfied</span></div>'
    + '<div class="task-plan-progress-track" aria-hidden="true"><span class="task-plan-progress-done" style="width:' + ratio + '%"></span></div>'
    + '<section class="task-plan-outcomes" aria-label="Outcome criteria"><h3>Outcomes</h3><ul>' + view.criteria.map(item =>
      '<li><strong>' + escape(item.description || item.id) + '</strong> · ' + item.observedCount + ' / ' + item.targetCount
      + ' · ' + (item.satisfied ? 'Satisfied' : 'Pending evidence') + '</li>').join('') + '</ul></section>'
    + (!view.runtimeCurrent ? '<p>Execution evidence is not current for this plan revision.</p>' : '');
}

export function renderContractInspector(view, item, prefix = 'task-plan') {
  const criteria = view.criteria.filter(value => item.criterionIds.includes(value.id));
  const dependencies = item.dependsOn.map(id => view.byId.get(id)?.title || id);
  return '<div class="task-plan-detail-heading"><div><span class="task-plan-detail-kicker">Work item ' + escape(item.number)
    + '</span><h3 id="' + escape(prefix) + '-detail-title">' + escape(item.title) + '</h3></div><span class="task-plan-detail-status" data-status="' + escape(item.status) + '">' + escape(item.statusLabel) + '</span></div>'
    + '<dl class="task-plan-detail-fields">' + field('Objective', item.objective) + field('Owner', item.owner?.label)
    + field('Depends on', dependencies.join(' · ')) + field('Resources', item.resourceKeys.join('\n'))
    + field('Allowed effects', item.effects.join(', ')) + field('Blocked by', item.blockedReason)
    + '<div class="task-plan-detail-field"><dt>Actual operations</dt><dd>' + item.operationCount + ' recorded'
    + (item.unresolvedCount ? ' · ' + item.unresolvedCount + ' unresolved effects' : '') + '</dd></div></dl>'
    + '<section><h4>Completion evidence</h4><ul>' + criteria.map(value => '<li><strong>' + escape(value.description || value.id) + '</strong> · '
      + value.observedCount + ' / ' + value.targetCount + '<p>' + escape(value.reason) + '</p></li>').join('') + '</ul></section>';
}

export function renderContractJournal(view) {
  const rows = view.operations.map(item => '<tr><td><time datetime="' + escape(item.finishedAt || item.startedAt) + '">' + escape(item.finishedAt || item.startedAt || 'Recorded') + '</time></td>'
    + '<td>' + escape((item.tool || 'Operation') + (item.action ? ' · ' + item.action : '')) + '</td><td>' + escape(view.byId.get(item.workItemId)?.title || item.workItemId) + '</td>'
    + '<td>' + escape(item.deliveryState || 'Recorded') + '</td><td>' + escape(item.effectState || 'Unknown') + (item.code ? ' · ' + escape(item.code) : '') + '</td></tr>').join('');
  return '<details class="task-plan-operation-history" data-plan-disclosure="operation-history"><summary>Actual operation history · ' + view.operations.length + ' shown'
    + (view.omittedOperations ? ' · ' + view.omittedOperations + ' earlier retained' : '') + '</summary><p>Operation delivery and effects are recorded separately from outcome criteria.</p>'
    + (rows ? '<table><thead><tr><th scope="col">Time</th><th scope="col">Operation</th><th scope="col">Work item</th><th scope="col">Delivery</th><th scope="col">Effect</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p>No operation receipts are recorded yet.</p>') + '</details>'
    + (view.findings.length ? '<details data-plan-disclosure="audit-findings"><summary>Reported instruction findings · ' + view.findings.length + '</summary><ul>' + view.findings.map(item => '<li><strong>' + escape(item.ruleId) + '</strong> · ' + escape(item.message) + '</li>').join('') + '</ul></details>' : '');
}
