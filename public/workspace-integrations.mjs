/** Product entry points report current availability, never infer verification from a catalog. */
export function workspaceIntegrations(status = {}) {
  const browser = status.browser || {}, email = status.email || {}, projects = status.projects || {}, operations = status.operations || {};
  return [
    { id: 'browser', action: 'contained-browser', icon: 'eye', title: 'Background browser',
      description: 'Work with pages inside Activity using the contained browser.',
      state: browser.available === true && browser.contained === true && (!browser.browsers?.relay || browser.browsers.relay.available === true) ? 'Available in Activity' : 'Contained browser unavailable',
      ready: browser.available === true && browser.contained === true && (!browser.browsers?.relay || browser.browsers.relay.available === true) },
    { id: 'email', action: 'email', icon: 'mail', title: 'Email',
      description: 'Configure background mailbox reading and local message drafts.',
      state: email.storage?.healthy === false || email.state === 'unavailable' ? 'Email storage needs attention' : email.state === 'error' ? 'Connection needs attention' : !email.configured || !email.enabled ? 'Setup required' : email.account?.observed ? 'Last mailbox operation recorded' : email.cli?.checked ? 'CLI checked · mailbox unchecked' : 'Configured · check CLI', ready: false },
    { id: 'planning', action: 'planning', icon: 'plan', title: 'Planning',
      description: 'Edit the agent’s saved objectives, steps, branches and dependencies. Off keeps existing plans and notes.',
      state: status.storage?.healthy === false ? 'Storage needs attention' : 'Shared plans, readiness and evidence',
      ready: status.storage?.healthy !== false },
    { id: 'swarm', action: 'projects', icon: 'workflow', title: 'Swarm projects',
      description: 'Shared dependencies, specialist work, review criteria and saved results.',
      state: projects.healthy === false ? 'Projects need attention' : projects.blockedReason ? 'Execution paused · plans and history available' : 'Plans and execution history',
      ready: projects.healthy !== false && !projects.blockedReason },
    { id: 'schedules', action: 'operations', icon: 'clock', title: 'Schedules & jobs',
      description: 'Calendar cron, timezones, pause controls and durable job receipts.',
      state: operations.healthy === false ? 'Scheduler needs attention' : operations.blockedReason ? 'Paused · open schedules for details' : operations.paused ? 'Paused · runs while BLACKICE is open' : 'Runs while BLACKICE is open',
      ready: operations.healthy !== false && !operations.paused && !operations.blockedReason },
  ];
}
