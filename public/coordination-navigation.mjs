const destinations = [
  ['planning', 'planning', 'Planning', 'Shape objectives and steps'],
  ['swarms', 'projects', 'Swarms', 'Coordinate saved team plans'],
  ['schedules', 'operations', 'Schedules', 'Manage cronjobs and run history'],
];

/** Shared destinations only: navigating never submits or starts work. */
export function coordinationNavigation(active) {
  return `<nav class="coordination-navigation" aria-label="Planning, swarms and schedules">${destinations.map(([id, action, label, detail]) => `<button type="button" data-action="${action}"${id === active ? ' aria-current="page" disabled' : ''}><strong>${label}</strong><span>${detail}</span></button>`).join('')}</nav>`;
}
