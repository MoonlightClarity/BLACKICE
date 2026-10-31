const ACTIVE = new Set(['queued','running','waiting','awaiting_input','cancelling','starting']);
const TERMINAL = new Set(['completed','succeeded','failed','cancelled','interrupted','skipped']);
const LABELS = {queued:'Queued',running:'Running',waiting:'Waiting',awaiting_input:'Needs input',cancelling:'Stopping',starting:'Starting',completed:'Completed',succeeded:'Succeeded',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted',skipped:'Skipped',blocked:'Blocked',paused:'Paused'};

/** Presentation keeps the recorded outcome separate from whether work has settled. */
export function activityStatus(item = {}) {
  const raw = typeof item.status === 'string' ? item.status : '';
  const status = raw.toLowerCase();
  if (item.statusConflict || item.settled === true && ACTIVE.has(status)) return {label:'Status conflict',tone:'attention',description:'The recorded status is '+(raw||'unknown')+' but the record also says work has settled.'};
  if (item.settled === false && TERMINAL.has(status)) {
    const label = status === 'failed' ? 'Failed · stopping' : status === 'cancelled' ? 'Cancelling' : status === 'interrupted' ? 'Interrupted · stopping' : 'Finishing';
    return {label,tone:status === 'failed' || status === 'interrupted' ? 'attention' : 'active',description:'Recorded outcome: '+raw+'. Work has not settled yet.'};
  }
  const tone = ['failed','interrupted','blocked','awaiting_input','waiting'].includes(status) ? 'attention' : ACTIVE.has(status) ? 'active' : ['completed','succeeded'].includes(status) ? 'success' : 'neutral';
  return {label:Object.hasOwn(LABELS,status) ? LABELS[status] : (raw ? 'Unknown: '+raw : 'Unknown'),tone,description:raw ? 'Recorded status: '+raw+(item.settled == null ? '. Settlement was not recorded.' : '.') : 'No lifecycle status was recorded.'};
}
/** Receipt badges describe the status at that event, separately from live work. */
export function activityEvidenceStatus(event = {}) {
  const recorded = typeof event?.status === 'string' ? event.status : '';
  const raw = recorded || (event?.success === false ? 'failed' : event?.success === true ? 'succeeded' : '');
  if (!raw) return null;
  const states = {
    inprogress:{label:'In progress at this event',tone:'neutral'},
    unresolved:{label:'Unresolved',tone:'attention'},
    recovered:{label:'Recovered',tone:'neutral'},
  };
  const key = raw.toLowerCase();
  const state = Object.hasOwn(states,key) ? states[key] : activityStatus({status:raw});
  return {...state,description:(recorded ? 'Recorded receipt status: '+recorded+'.' : 'Recorded receipt success: '+event.success+'.')+' This describes this event; the run status is shown separately.'};
}

export function activityKey(item) { return String(item?.kind || 'runs')+':'+String(item?.id || ''); }
export function activityErrorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  try { return JSON.stringify(value); } catch { return String(value); }
}
export function activityTimestamp(value) {
  const stamp = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(stamp) : 'Time unavailable';
}
export function activityDuration(item = {}, now = Date.now()) {
  const start = Date.parse(item.startedAt || '');
  const live = item.active === true || item.settled === false;
  const end = live ? now : Date.parse(item.finishedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.floor((end-start)/1000);
  if (seconds < 60) return seconds+'s';
  if (seconds < 3600) return Math.floor(seconds/60)+'m '+seconds%60+'s';
  return Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m';
}
export function activityListPath({source='runs',status='all',q='',offset=0,limit=40} = {}) {
  const query = new URLSearchParams({source,status,q:String(q).slice(0,200),offset:String(offset),limit:String(limit)});
  return '/api/activity?'+query;
}
export function activityDetailPath(item, {offset=0,limit=50} = {}) {
  if (!item?.id || !['runs','tools'].includes(item.kind)) throw Error('Select a saved activity record.');
  return '/api/activity/'+item.kind+'/'+encodeURIComponent(item.id)+'?'+new URLSearchParams({offset:String(offset),limit:String(limit)});
}
export function activityEventRelevant(event, source = 'runs') {
  if (!event || typeof event.type !== 'string') return false;
  if (event.type === 'runtime.status') return true;
  if (event.type === 'chatgpt-connector.updated') return source !== 'runs';
  return ['run.updated','node.updated','agent.event','execution.updated','conversations.updated','conversations.changed','task.updated'].includes(event.type) && source !== 'tools';
}
