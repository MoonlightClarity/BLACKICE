const destinations = [
  ['planning', 'planning', 'Planning'],
  ['swarms', 'projects', 'Swarms'],
  ['schedules', 'operations', 'Schedules'],
];

/** Keep peer work areas available without repeating a full navigation strip. */
export function coordinationNavigation(active) {
  const label = destinations.find(([id]) => id === active)?.[2] || 'Work area';
  return '<nav class="coordination-navigation" aria-label="Planning, swarms and schedules"><details class="coordination-picker" data-detail="coordination-area"><summary aria-label="Work area: ' + label + '"><strong>' + label + '</strong><span>Change area</span></summary><div class="coordination-destinations">' + destinations.map(([id, action, name]) => '<button type="button" data-action="' + action + '"' + (id === active ? ' aria-current="page" disabled' : '') + '>' + name + '</button>').join('') + '</div></details></nav>';
}
