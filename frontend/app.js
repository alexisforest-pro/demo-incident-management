(() => {
  'use strict';

  const MODEL = 'mistral-large-4';
  const main = document.getElementById('main');
  const dialog = document.getElementById('dialog');
  const dialogContent = document.getElementById('dialog-content');
  const state = {
    incidents: new Map(), stamps: new Map(), drafts: new Map(), chats: new Map(),
    callDrafts: new Map(), busy: new Set(), errors: new Map(), config: null,
    configError: '', loadError: '', connectionError: '',
    view: 'incidents', activeId: null, mainKey: '', modal: null, recording: null,
    sequence: 0, navigation: 0, pollTimer: null, polling: false, booting: false,
    toastTimer: null, refreshPending: false, dataLoaded: false,
    rexPeriod: null, periodError: '', statistics: null, statisticsKey: '',
    statisticsLoading: false, statisticsError: '', statisticsRequest: 0
  };
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    route: '<path d="M5 3v18M19 3v18M5 7h14M5 17h14M9 3v4M15 17v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    phone: '<path d="m7 3 3 5-3 3c1 3 3 5 6 6l3-3 5 3c0 3-2 5-5 4C9 19 5 15 3 8 2 5 4 3 7 3Z"/>',
    message: '<path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z"/><path d="M7 8h10M7 12h7"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/>',
    link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l6-6M16 8l2-2a4 4 0 0 1 6 6l-6 6" transform="translate(1 0) scale(.9)"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
    history: '<path d="M3 3v6h6M3 9a9 9 0 1 1 0 6M12 7v5l4 2"/>',
    send: '<path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5ZM14 2v5h5M8 12h8M8 16h8"/>',
    external: '<path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/>',
    check: '<path d="m5 12 4 4L19 6"/>'
  };
  let KPI = [];

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  const e = escapeHTML;
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  const spinner = '<span class="spinner" aria-hidden="true"></span>';
  const incidentPath = id => `/api/incidents/${encodeURIComponent(id)}`;
  const callPath = (id, callId) => `${incidentPath(id)}/calls/${encodeURIComponent(callId)}`;
  const callKey = (id, callId) => `${id}|${callId}`;
  const chatKey = (id, callId = '') => `chat|${id}|${callId}`;
  const messageKey = id => `message|${id}`;
  const isBusy = key => state.busy.has(key);
  const getIncident = id => state.incidents.get(id);
  const getCall = (id, callId) => getIncident(id)?.events?.find(event => event.type === 'call' && event.id === callId);
  const isREX = incident => !!incident?.rex && incident.status !== 'In progress';
  const detailView = () => state.view === 'detail' || state.view === 'rex-detail';
  const listView = () => state.view === 'rex' || state.view === 'rex-detail' ? 'rex' : 'incidents';
  const viewHash = () => state.view === 'rex-detail' ? `#rex/${encodeURIComponent(state.activeId)}` : state.view === 'detail' ? `#incident/${encodeURIComponent(state.activeId)}` : `#${state.view}`;
  const allIncidents = () => [...state.incidents.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const aiAllowed = () => state.config?.ai_available === true && state.config.model === MODEL;

  function formatted(value, full = false) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return 'Not provided';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', ...(full ? {day: '2-digit', month: 'short', year: 'numeric'} : {}),
      hour: '2-digit', minute: '2-digit'
    }).format(date) + ' UTC';
  }
  function archiveDate(value) {
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? String(value || 'Unknown date') :
      new Intl.DateTimeFormat('en-GB', {timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric'}).format(date) + ' UTC';
  }
  function duration(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min` :
      seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s` : `${seconds} s`;
  }
  function rich(value) {
    return String(value || '').split(/\n\s*\n/).filter(Boolean)
      .map(paragraph => `<p>${e(paragraph).replace(/\n/g, '<br>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p>`).join('');
  }
  const SEVERITIES = [
    {value: 'G3', label: 'SEV1', description: 'Major severity', tone: 'sev1'},
    {value: 'G2', label: 'SEV2', description: 'Significant severity', tone: 'sev2'},
    {value: 'G1', label: 'SEV3', description: 'Moderate severity', tone: 'sev3'}
  ];
  function severityBadge(value) {
    const level = SEVERITIES.find(item => item.value === value);
    return `<span class="badge ${level?.tone || ''}" title="${e(level?.description || 'Severity not provided')}">${e(level?.label || value)}</span>`;
  }
  function callStatus(call, incidentId = '') {
    const labels = {en_cours: 'In progress', termine: 'Completed', processing: 'Processing', error: 'Error', annule: 'Cancelled'};
    const tones = {en_cours: 'amber', termine: 'green', error: 'red', processing: 'purple'};
    const content = `${call.status === 'processing' ? spinner : ''}${e(labels[call.status] || 'Unknown status')}`;
    if (incidentId && call.status === 'en_cours') return `<button class="badge amber call-status-action" type="button" data-action="end-call" data-id="${e(incidentId)}" data-call="${e(call.id)}" title="Review the transcript and end the call" aria-label="In progress — end call ${e(call.title)}" ${recordingLocked() || modalBusy() ? 'disabled' : ''}>${content}</button>`;
    return `<span class="badge ${tones[call.status] || ''}">${content}</span>`;
  }
  function aiNotice() {
    if (!state.config) return 'AI configuration unavailable. Refresh the connection to try again.';
    if (state.config.model !== MODEL) return 'Unexpected server model. AI is disabled in this demo.';
    if (!state.config.ai_available) return `AI not configured on the server. Demo data remains viewable; AI requests are not simulated.`;
    return '';
  }
  function draft(key) {
    if (!state.drafts.has(key)) state.drafts.set(key, {value: '', version: 0});
    return state.drafts.get(key);
  }
  function setDraft(key, value) {
    const current = draft(key);
    current.value = value;
    current.version += 1;
    return current;
  }
  function clearSubmittedDraft(key, snapshot) {
    const current = draft(key);
    if (current.version !== snapshot.version || current.value !== snapshot.value) return;
    setDraft(key, '');
    document.querySelectorAll('[data-draft]').forEach(field => {
      if (field.dataset.draft === key) field.value = '';
    });
  }
  function hydrateDrafts(root) {
    root.querySelectorAll('[data-draft]').forEach(field => { field.value = draft(field.dataset.draft).value; });
  }
  function replaceSlot(id, html) {
    const element = document.getElementById(id);
    if (!element || element._markup === html) return;
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    const action = focused?.dataset.action;
    const focusId = focused?.dataset.id;
    const scroll = element.scrollTop;
    element.innerHTML = html;
    element._markup = html;
    element.scrollTop = scroll;
    if (action) {
      const replacement = [...element.querySelectorAll('[data-action]')].find(button => button.dataset.action === action && button.dataset.id === focusId);
      replacement?.focus({preventScroll: true});
    }
  }
  function setText(id, value) {
    const node = document.getElementById(id);
    if (node && node.textContent !== String(value || '')) node.textContent = value || '';
  }
  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    const region = document.getElementById('toast-region');
    region.innerHTML = `<div class="toast${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}"><span>${e(message)}</span><button data-action="dismiss-toast" aria-label="Dismiss notification">${icon('close')}</button></div>`;
    state.toastTimer = setTimeout(() => { region.replaceChildren(); }, error ? 11000 : 6000);
  }

  class RequestError extends Error {
    constructor(message, status = 0, uncertain = false) {
      super(message); this.status = status; this.uncertain = uncertain;
    }
  }
  async function api(path, body, timeout = body === undefined ? 15000 : 90000) {
    const ticket = ++state.sequence;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? {Accept: 'application/json'} : {'Content-Type': 'application/json', Accept: 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch (_) { throw new RequestError('Server response could not be read.', response.status, body !== undefined); }
      if (!response.ok) {
        const detail = Array.isArray(data.detail) ? data.detail.map(item => item.msg || 'Invalid data').join(' · ') : data.detail;
        throw new RequestError(typeof detail === 'string' ? detail : `The server refused the request (${response.status}).`, response.status);
      }
      state.connectionError = '';
      return {data, ticket};
    } catch (error) {
      if (error instanceof RequestError) throw error;
      state.connectionError = error.name === 'AbortError' ? 'The server is taking too long to respond.' : 'Connection to the server was interrupted.';
      throw new RequestError(state.connectionError + (body !== undefined ? ' Receipt is not confirmed: check the data before retrying.' : ' Retry in a few moments.'), 0, body !== undefined);
    } finally {
      clearTimeout(timer);
      updateStatus();
    }
  }
  function cacheIncident(incoming, ticket) {
    if (!incoming?.id || !Array.isArray(incoming.events)) return false;
    const previous = getIncident(incoming.id);
    if (previous && Number(incoming.revision) < Number(previous.revision)) return false;
    let next = !previous || Number(incoming.revision) > Number(previous.revision) || ticket >= (state.stamps.get(incoming.id) || 0) ? incoming : {...previous};
    if (previous) {
      if (String(previous.summary_updated_at || '') > String(incoming.summary_updated_at || '')) {
        next = {...next, summary: previous.summary, summary_updated_at: previous.summary_updated_at,
          summary_revision: previous.summary_revision, summary_source: previous.summary_source};
      } else if (String(incoming.summary_updated_at || '') > String(previous.summary_updated_at || '')) {
        next = {...next, summary: incoming.summary, summary_updated_at: incoming.summary_updated_at,
          summary_revision: incoming.summary_revision, summary_source: incoming.summary_source};
      }
      if (Number(previous.impact?.revision) > Number(next.impact?.revision) ||
          (Number(previous.impact?.revision) === Number(next.impact?.revision) && String(previous.impact?.updated_at || '') > String(next.impact?.updated_at || ''))) {
        next = {...next, impact: previous.impact};
      }
    }
    state.incidents.set(next.id, next);
    state.stamps.set(next.id, Math.max(ticket, state.stamps.get(next.id) || 0));
    return true;
  }
  function cacheIncidents(incidents, ticket) {
    const identifiers = new Set(incidents.map(item => item.id));
    state.incidents.forEach((_, id) => {
      if (!identifiers.has(id) && ticket >= (state.stamps.get(id) || 0)) {
        state.incidents.delete(id); state.stamps.delete(id);
      }
    });
    incidents.forEach(item => cacheIncident(item, ticket));
    state.dataLoaded = true;
  }
  function updateStatus() {
    setText('connection-status', state.connectionError ? `Degraded connection · ${state.connectionError}` : state.dataLoaded ? 'Backend connected · JSON storage' : 'Connecting to backend…');
    setText('config-status', state.configError ? `Configuration: ${state.configError}` : state.config ?
      (state.config.model !== MODEL ? 'AI · incompatible server model' : !state.config.ai_available ? 'AI not configured' : '') : 'AI configuration pending');
    setText('nav-count', state.dataLoaded ? String(allIncidents().filter(item => item.status === 'In progress').length) : '—');
    setText('rex-count', state.dataLoaded ? String(allIncidents().filter(isREX).length) : '—');
    document.querySelectorAll('.rail-link').forEach(button => {
      const selected = button.dataset.action === listView();
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  function hasBackgroundWork() {
    return allIncidents().some(item => item.impact?.status === 'running' || item.events.some(event => event.type === 'call' && event.status === 'processing'));
  }
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (!hasBackgroundWork() || state.polling) return;
    state.pollTimer = setTimeout(poll, state.connectionError ? 6000 : 2800);
  }
  async function poll() {
    if (state.polling) return;
    state.polling = true;
    try {
      const {data, ticket} = await api('/api/incidents');
      if (!Array.isArray(data.incidents)) throw new RequestError('Invalid incident list.');
      cacheIncidents(data.incidents, ticket);
      refreshUI();
    } catch (error) {
      state.connectionError = error.message;
      updateStatus();
    } finally { state.polling = false; schedulePoll(); }
  }
  async function load(force = false) {
    if (state.booting) return;
    state.booting = true;
    state.loadError = '';
    document.querySelector('[data-action="reload-config"]').disabled = true;
    const results = await Promise.allSettled([api('/api/config'), api('/api/incidents')]);
    if (results[0].status === 'fulfilled') {
      state.config = results[0].value.data; state.configError = '';
      KPI = (state.config.kpi_definitions || []).map(item => [item.key, item.label]);
    } else { state.configError = results[0].reason.message; }
    if (results[1].status === 'fulfilled' && Array.isArray(results[1].value.data.incidents)) {
      cacheIncidents(results[1].value.data.incidents, results[1].value.ticket);
    } else { state.loadError = results[1].status === 'rejected' ? results[1].reason.message : 'Invalid incident list.'; }
    state.booting = false;
    document.querySelector('[data-action="reload-config"]').disabled = false;
    if (!state.incidents.size) state.mainKey = '';
    refreshUI();
    if (state.mainKey === '' && state.incidents.size) await routeFromHash();
    else if (force && !state.loadError && !state.configError) toast('Connection and data refreshed.');
    if (force && state.view === 'rex') void loadStatistics(true);
  }
  function recordingLocked() {
    return !!state.recording || state.modal?.starting === true;
  }
  async function navigate(view, id = null, writeHash = true) {
    if (recordingLocked()) { toast('Stop and confirm the call, or explicitly cancel it, before navigating.', true); return false; }
    if (dialog.open && !closeDialog()) return false;
    if (view === 'detail' && isREX(getIncident(id))) view = 'rex-detail';
    state.view = view; state.activeId = id;
    const token = ++state.navigation;
    if (writeHash) history.replaceState(null, '', viewHash());
    refreshUI();
    main.focus({preventScroll: true});
    window.scrollTo({top: 0, behavior: 'instant'});
    if (view === 'rex') void loadStatistics();
    if (detailView()) {
      try {
        const {data, ticket} = await api(incidentPath(id));
        cacheIncident(data, ticket);
        if (token === state.navigation && state.activeId === id) { state.loadError = ''; refreshUI(); }
        schedulePoll();
      } catch (error) {
        if (token !== state.navigation || state.activeId !== id) return true;
        state.loadError = error.message; refreshUI();
      }
    }
    return true;
  }
  async function routeFromHash() {
    const hash = location.hash.slice(1);
    const match = hash.match(/^(incident|rex)\/(.+)$/);
    if (match) {
      let id;
      try { id = decodeURIComponent(match[2]); } catch (_) { id = ''; }
      if (id) return navigate(match[1] === 'rex' ? 'rex-detail' : 'detail', id, false);
    }
    return navigate(hash === 'rex' ? 'rex' : 'incidents', null, false);
  }

  function overviewRow(incident) {
    const calls = incident.events.filter(event => event.type === 'call');
    return `<tr class="incident-row ${e(SEVERITIES.find(level => level.value === incident.severity)?.tone || '')}" data-incident-row>
      <th scope="row" class="incident-reference">${e(incident.id)}</th>
      <td><div class="incident-state">${severityBadge(incident.severity)}<span class="badge${incident.status === 'In progress' ? ' teal' : ''}">${e(incident.status)}</span></div></td>
      <td><time datetime="${e(incident.started_at)}">${e(formatted(incident.started_at, true))}</time></td>
      <td class="incident-event"><button class="incident-title" data-action="open-incident" data-id="${e(incident.id)}" aria-label="Open ${e(incident.title)}" title="${e(incident.title)} — ${e(incident.description)}">${e(incident.title)}</button><span class="incident-location" title="${e(incident.location)}">${e(incident.location)}</span></td>
      <td class="incident-sector"><strong>${e(incident.region)}</strong><span>${e(incident.line)}</span></td>
      <td class="incident-recovery">${e(isREX(incident) ? formatted(incident.ended_at, true) : incident.estimated_end)}</td>
      <td class="incident-communications"><strong>${e(incident.events.length)} exchanges</strong><span>${e(calls.length)} calls</span></td>
    </tr>`;
  }
  function presetPeriod(months) {
    const today = new Date();
    return {start: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months + 1, 1)).toISOString().slice(0, 10), end: today.toISOString().slice(0, 10)};
  }
  function ensureRexPeriod() {
    if (!state.rexPeriod) {
      state.rexPeriod = presetPeriod(12);
      setDraft('rex-period', '12');
      setDraft('rex-start', state.rexPeriod.start);
      setDraft('rex-end', state.rexPeriod.end);
    }
    return state.rexPeriod;
  }
  function periodMarkup() {
    const custom = draft('rex-period').value === 'custom';
    return `<form class="period-filter" data-form="rex-period"><label for="rex-period">Period · UTC</label><select id="rex-period" data-draft="rex-period">${[3, 6, 12, 24, 36].map(months => `<option value="${months}">Last ${months} months</option>`).join('')}<option value="custom">Custom dates</option></select><div id="period-dates" class="period-dates" ${custom ? '' : 'hidden'}><label for="rex-start">From<input id="rex-start" type="date" data-draft="rex-start" required></label><label for="rex-end">To<input id="rex-end" type="date" data-draft="rex-end" required></label><button class="btn small primary" type="submit">Apply</button></div></form>`;
  }
  function applyPresetPeriod(months) {
    state.rexPeriod = presetPeriod(months); state.periodError = '';
    setDraft('rex-start', state.rexPeriod.start); setDraft('rex-end', state.rexPeriod.end);
    document.getElementById('rex-start').value = state.rexPeriod.start;
    document.getElementById('rex-end').value = state.rexPeriod.end;
    updateOverview(); void loadStatistics();
  }
  function applyCustomPeriod() {
    const start = draft('rex-start').value;
    const end = draft('rex-end').value;
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
    if (!valid(start) || !valid(end) || start > end || months > 120) {
      state.periodError = 'Choose valid dates, in order, spanning at most 120 months. The previous period remains displayed.';
      updateOverview(); return;
    }
    state.rexPeriod = {start, end}; state.periodError = '';
    updateOverview(); void loadStatistics();
  }
  async function loadStatistics(force = false) {
    const period = ensureRexPeriod();
    const key = `${period.start}|${period.end}`;
    if (!force && state.statisticsKey === key && (state.statisticsLoading || state.statistics)) return;
    const request = ++state.statisticsRequest;
    state.statisticsKey = key; state.statistics = null; state.statisticsError = ''; state.statisticsLoading = true;
    if (state.view === 'rex') updateOverview();
    try {
      const {data} = await api(`/api/incident-statistics?start_date=${encodeURIComponent(period.start)}&end_date=${encodeURIComponent(period.end)}`);
      if (data.synthetic !== true || !Array.isArray(data.months) || data.start_date !== period.start || data.end_date !== period.end || data.months.some(month => !/^\d{4}-\d{2}$/.test(month.month) || ![month.G3, month.G2, month.G1, month.total].every(value => Number.isSafeInteger(value) && value >= 0) || month.total !== month.G3 + month.G2 + month.G1)) throw new RequestError('Invalid demo statistics.');
      if (request === state.statisticsRequest) state.statistics = data;
    } catch (error) {
      if (request === state.statisticsRequest) state.statisticsError = error.status === 404 ?
        'The server has not loaded the chart yet. Restart the backend (make demo), then try again.' : error.message;
    }
    finally {
      if (request === state.statisticsRequest) { state.statisticsLoading = false; if (state.view === 'rex') updateOverview(); }
    }
  }
  function statisticsMarkup() {
    const period = ensureRexPeriod();
    const header = `<div class="panel-heading chart-heading"><div><h2 id="chart-title">${icon('history')}Incidents by month and severity</h2><p>${e(archiveDate(period.start))} to ${e(archiveDate(period.end))} · Incident start date</p></div><span class="badge synthetic">Synthetic demo data</span></div>`;
    if (state.statisticsError) return header + `<div class="error-box" role="alert">${e(state.statisticsError)}<br><button class="btn small" data-action="retry-statistics">Retry the chart</button></div>`;
    if (state.statisticsLoading || !state.statistics) return header + `<div class="chart-loading" role="status">${spinner}Loading statistics…</div>`;
    const months = state.statistics.months;
    const total = months.reduce((sum, month) => sum + month.total, 0);
    const legend = `<div class="chart-summary"><strong>${e(total)} incidents over ${e(months.length)} months</strong><div class="chart-legend">${SEVERITIES.map(level => `<span><i class="${e(level.tone)}"></i>${e(level.label)} · ${e(months.reduce((sum, month) => sum + month[level.value], 0))}</span>`).join('')}</div></div>`;
    if (!total) return header + legend + '<div class="empty">No incidents in the statistical dataset for this period.</div>';
    const maximum = Math.max(...months.map(month => month.total));
    const step = Math.max(1, Math.ceil(maximum / 4));
    const ceiling = step * 4;
    const width = Math.max(720, months.length * 62 + 70);
    const height = 280;
    const top = 28, bottom = 222, left = 45, right = 14;
    const plotHeight = bottom - top;
    const column = (width - left - right) / months.length;
    const monthLabel = month => new Intl.DateTimeFormat('en-GB', {timeZone: 'UTC', month: 'short', year: '2-digit'}).format(new Date(`${month}-01T00:00:00Z`));
    const grid = Array.from({length: 5}, (_, index) => {
      const value = index * step;
      const y = bottom - value / ceiling * plotHeight;
      return `<line class="chart-gridline" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis" x="${left - 9}" y="${y + 4}" text-anchor="end">${value}</text>`;
    }).join('');
    const bars = months.map((month, index) => {
      const x = left + column * index + column * .2;
      const barWidth = column * .6;
      let accumulated = 0;
      const label = monthLabel(month.month);
      const layers = SEVERITIES.map(level => {
        const count = month[level.value];
        const segmentHeight = count / ceiling * plotHeight;
        accumulated += count;
        return count ? `<rect class="chart-segment ${e(level.tone)}" data-month="${e(month.month)}" data-severity="${e(level.label)}" data-count="${e(count)}" x="${x}" y="${bottom - accumulated / ceiling * plotHeight}" width="${barWidth}" height="${segmentHeight}"><title>${e(label)} · ${e(level.label)}: ${e(count)} incidents</title></rect>` : '';
      }).join('');
      return `<g>${layers}<text class="chart-total" x="${x + barWidth / 2}" y="${bottom - month.total / ceiling * plotHeight - 7}" text-anchor="middle">${e(month.total)}</text><text class="chart-axis" x="${x + barWidth / 2}" y="${bottom + 23}" text-anchor="middle">${e(label)}</text></g>`;
    }).join('');
    return header + legend + `<div class="chart-scroll" role="region" aria-label="Monthly histogram, horizontal scrolling" tabindex="0"><svg class="severity-chart" viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-labelledby="chart-svg-title chart-svg-description"><title id="chart-svg-title">Incidents per month, broken down by severity</title><desc id="chart-svg-description">${e(total)} incidents. Synthetic demo data. SEV1 in red, SEV2 in pink, SEV3 in orange. Heights indicate counts, not percentages.</desc>${grid}${bars}<text class="chart-axis" x="${width / 2}" y="${height - 6}" text-anchor="middle">Month · UTC</text></svg></div>`;
  }
  function overviewMarkup() {
    const rex = state.view === 'rex';
    const filterPrefix = rex ? 'rex' : 'overview';
    if (rex) ensureRexPeriod();
    return `<div class="page-heading"><div><div class="eyebrow">${rex ? 'CONTINUOUS IMPROVEMENT' : 'REAL-TIME SUPERVISION'}</div><h1>${rex ? 'REX' : 'Ongoing incidents'}</h1><p>${rex ? 'Lessons learned: understand past events and track preventive actions.' : 'A shared view of the situation, communications, and impacts.'}</p></div><div class="overview-heading-actions">${rex ? periodMarkup() : ''}<button class="btn" data-action="refresh-data">${icon('refresh')}Refresh</button></div></div>
      ${rex ? '<div id="period-error" class="inline-error" role="alert"></div>' : '<div id="overview-stats" class="overview-stats"></div>'}<div id="overview-error"></div>${rex ? '<section id="incident-chart" class="panel incident-chart" aria-labelledby="chart-title"></section>' : ''}
      <div class="section-heading overview-heading"><h2>${icon(rex ? 'history' : 'route')}${rex ? 'Past events' : 'Operational situation'} <span id="overview-count" class="count"></span></h2><span class="badge synthetic">Synthetic demo data</span></div>
      <div class="overview-tools"><div class="search-field">${icon('search')}<input type="search" data-draft="${filterPrefix}-search" aria-label="${rex ? 'Search for a lessons-learned report' : 'Search for an incident'}" placeholder="Search a location, a line, an incident…"></div><select data-draft="${filterPrefix}-severity" aria-label="Filter by severity"><option value="">All severities</option>${SEVERITIES.map(level => `<option value="${e(level.value)}">${e(level.label)} · ${e(level.description)}</option>`).join('')}</select></div>
      <div class="incident-table-scroll" role="region" aria-label="Event list, horizontal scrolling" tabindex="0"><table class="incident-table" aria-label="${rex ? 'Lessons learned' : 'Operational situation'}"><colgroup><col class="reference-column"><col class="state-column"><col class="started-column"><col><col class="sector-column"><col class="recovery-column"><col class="communications-column"></colgroup><thead><tr><th scope="col">Reference</th><th scope="col">Severity / status</th><th scope="col">Start · UTC</th><th scope="col">Event / location</th><th scope="col">Sector / line</th><th scope="col">${rex ? 'End · UTC' : 'Estimated recovery'}</th><th scope="col">Communications</th></tr></thead><tbody id="incident-rows"></tbody></table></div>`;
  }
  function updateOverview() {
    const rex = state.view === 'rex';
    const filterPrefix = rex ? 'rex' : 'overview';
    const records = allIncidents().filter(item => rex ? isREX(item) : item.status === 'In progress');
    const period = rex ? ensureRexPeriod() : null;
    const incidents = period ? records.filter(item => {
      const date = new Date(item.started_at).toISOString().slice(0, 10);
      return date >= period.start && date <= period.end;
    }) : records;
    if (rex) {
      setText('period-error', state.periodError);
      replaceSlot('incident-chart', statisticsMarkup());
    }
    if (!rex) {
      const stats = [
        [incidents.length, 'Ongoing incidents', 'route', ''],
        ...SEVERITIES.map(level => [incidents.filter(item => item.severity === level.value).length, `${level.label} · ${level.description}`, 'alert', level.tone])
      ];
      replaceSlot('overview-stats', stats.map(([value, label, name, tone]) => `<div class="stat-card ${tone}"><span class="stat-icon ${tone}">${icon(name)}</span><div><strong>${e(value)}</strong><p>${e(label)}</p></div></div>`).join(''));
    }
    replaceSlot('overview-error', state.loadError ? `<div class="error-box" role="alert">${e(state.loadError)}<br><button class="btn small" data-action="refresh-data">Retry</button></div>` : '');
    const search = draft(`${filterPrefix}-search`).value.trim().toLocaleLowerCase('en');
    const severity = draft(`${filterPrefix}-severity`).value;
    const filtered = incidents.filter(item => (!severity || item.severity === severity) && (!search || [item.id, item.title, item.location, item.line, item.region, item.category].join(' ').toLocaleLowerCase('en').includes(search)));
    setText('overview-count', `${filtered.length} / ${incidents.length}${rex ? ' in the period' : ''}`);
    replaceSlot('incident-rows', filtered.length ? filtered.map(overviewRow).join('') : '<tr><td colspan="7" class="empty">No incidents match the filters.</td></tr>');
  }
  function detailMarkup(incident) {
    return `<div class="detail-body"><div class="detail-navigation"><button class="btn back-button" data-action="return-list">${icon('back')}Back</button><span>${isREX(incident) ? 'REX · Lessons learned' : 'Ongoing incidents'}</span></div><div id="detail-error"></div><header id="incident-head" class="incident-head"></header><div class="operations-grid situation-grid"><section id="incident-summary" class="summary-panel" aria-label="Situation summary"></section><section id="impact-panel" class="panel"></section></div>${isREX(incident) ? '<div class="operations-grid rex-grid"><section id="rex-review" class="panel rex-review"></section><aside id="rex-actions" class="panel rex-actions"></aside></div>' : '<div id="incident-related" class="related-bar"></div>'}
      <div class="operations-grid"><section class="panel timeline-panel" aria-labelledby="communications-title"><div class="section-heading"><h2 id="communications-title">${icon('message')}Communications <span id="event-count" class="count"></span></h2></div>
      <form class="message-form" data-form="message" data-incident="${e(incident.id)}"><label for="message-content">Write your message</label><textarea id="message-content" data-draft="${e(messageKey(incident.id))}" maxlength="6000" required placeholder="Share an update, a decision, or field information…"></textarea><div class="form-bottom"><small>Information saved to the thread.<br>Impacts are recalculated in the background.</small><div class="button-row"><button id="message-submit" class="btn primary" type="submit">${icon('send')}Send message</button><button class="btn purple" type="button" data-action="new-call" data-id="${e(incident.id)}">${icon('phone')}Start a call</button></div></div><div id="message-error" class="inline-error" role="alert"></div></form><div id="timeline-events" class="timeline" aria-label="Communications thread, most recent first"></div></section>
      <aside class="right-column" aria-label="Decision support"><section class="panel" aria-labelledby="assistant-title"><div class="panel-heading"><h2 id="assistant-title">${icon('spark')}Incident assistant</h2><span class="badge teal">IA</span></div>${chatMarkup(incident.id)}<p id="assistant-config-note" class="impact-note"></p></section>${isREX(incident) ? '' : '<section id="history-panel" class="panel history-panel"></section>'}</aside></div></div>`;
  }
  function timelineEvent(event, incident) {
    const meta = `<div class="event-meta"><strong>${e(event.author || 'Coordination')}</strong><span>${e(event.role)}</span><time datetime="${e(event.created_at)}" title="${e(formatted(event.created_at, true))}">${e(formatted(event.created_at))}</time></div>`;
    if (event.type !== 'call') return `<article class="event"><span class="event-dot">${icon('message')}</span>${meta}<p class="event-message">${e(event.content)}</p></article>`;
    const local = state.callDrafts.get(callKey(incident.id, event.id));
    return `<article class="event call-event${event.status === 'termine' ? ' call-finished' : ''}"><span class="event-dot">${icon('phone')}</span>${meta}<div class="call-card"><div class="call-header"><button class="call-title" data-action="open-call" data-id="${e(incident.id)}" data-call="${e(event.id)}">${icon('phone')}${e(event.title)}</button>${callStatus(event, incident.id)}</div><div class="call-info"><span>${e((event.participants || []).join(' · '))}</span><span>${event.duration_seconds ? e(duration(event.duration_seconds)) : 'Duration not provided'}</span>${event.synthetic ? '<span class="badge synthetic">Synthetic demo data</span>' : '<span>Browser microphone</span>'}${local?.url ? '<span>Local audio available</span>' : ''}</div>${event.status === 'termine' && event.summary ? `<div class="call-summary structured">${rich(event.summary)}</div>` : ''}${event.status === 'processing' ? '<p class="small muted">Summary in preparation, then impact recalculation…</p>' : ''}${event.status === 'error' ? `<p class="inline-error">${e(event.error || 'Processing failed. The transcript remains available.')}</p>` : ''}${local?.phase === 'review' && ['en_cours', 'error'].includes(event.status) ? '<p class="small muted">Transcript to confirm · draft kept in this page.</p>' : ''}<div class="call-actions">${event.status === 'en_cours' ? `<button data-action="join-call" data-id="${e(incident.id)}" data-call="${e(event.id)}" ${recordingLocked() || modalBusy() ? 'disabled' : ''}>Join the call ${icon('phone')}</button>` : ''}<button data-action="open-call" data-id="${e(incident.id)}" data-call="${e(event.id)}">${event.status === 'error' ? 'Open and retry' : local?.phase === 'review' ? 'Resume draft' : 'Summary, transcript, and chat'} ${icon('arrow')}</button></div></div></article>`;
  }
  function impactMarkup(incident) {
    const impact = incident.impact || {};
    const statusLabels = {confirmed: 'Confirmed', estimated: 'Estimated', unknown: 'Not provided'};
    return `<div class="panel-heading"><h2>${icon('users')}Operational impact</h2>${impact.status === 'running' ? `<span class="badge teal">${spinner}Calculating</span>` : '<span class="badge">6 indicators</span>'}</div>
      <div class="impact-grid">${KPI.map(([key, fallback]) => {
        const item = (impact.items || []).find(candidate => candidate.key === key) || {key, label: fallback, value: null, status: 'unknown', source: ''};
        const source = item.source === 'header' ? 'Incident header' : item.source ? incident.events.find(event => event.id === item.source) : null;
        const sourceLabel = typeof source === 'string' ? source : source ? `${source.type === 'call' ? 'Call' : 'Message'} · ${formatted(source.created_at)}` : 'Source not provided';
        return `<div class="kpi"><div class="kpi-label">${e(fallback || item.label)}</div><div class="kpi-value">${e(item.value == null || item.value === '' ? '—' : item.value)}</div><span class="badge ${item.status === 'confirmed' ? 'teal' : item.status === 'estimated' ? 'amber' : ''}">${e(statusLabels[item.status] || statusLabels.unknown)}</span><div class="kpi-source" title="${e(item.source)}">${e(sourceLabel)}</div></div>`;
      }).join('')}</div><div class="impact-note">${impact.status === 'error' ? `<div class="inline-error" role="alert">${e(impact.error || 'Unable to recalculate impacts. The latest figures are kept.')}</div>` : ''}${Number(impact.revision) < Number(incident.revision) ? 'The displayed assessment does not yet cover all the latest communications.' : 'Values extracted from the available information, with no extrapolation.'}</div><div class="impact-foot"><span>${impact.origin === 'mistral' ? 'Updated:' : 'Synthetic demo data'} ${e(formatted(impact.updated_at))}</span><button class="text-button" data-action="retry-impact" data-id="${e(incident.id)}" ${impact.status === 'running' || isBusy(`impact|${incident.id}`) || !aiAllowed() ? 'disabled' : ''}>${impact.status === 'error' ? 'Retry' : 'Recalculate'}</button></div>`;
  }
  function historyMarkup(incident) {
    return `<div class="panel-heading"><h2>${icon('history')}Similar incidents</h2><span class="badge synthetic">Synthetic demo data</span></div><div class="history-list">${(incident.history || []).map(item => `<article class="history-item"><div class="history-item-top"><span>${e(item.id)} · ${e(archiveDate(item.date))}</span><span class="confidence">${e(item.confidence)} %</span></div><button data-action="open-history" data-id="${e(incident.id)}" data-history="${e(item.id)}">${e(item.title)}</button><p>${e(item.location)} · ${e(item.category)}</p></article>`).join('') || '<div class="empty">No history available.</div>'}</div><p class="impact-note">Synthetic demo data</p>`;
  }
  function rexReviewMarkup(incident) {
    const review = incident.rex;
    return `<div class="panel-heading"><h2>${icon('file')}Lessons learned</h2><span class="badge synthetic">Synthetic demo data</span></div><div class="rex-copy structured"><section><h3>What happened</h3>${rich(review.what_happened)}</section><section><h3>Consequences</h3>${rich(review.consequences)}</section><section><h3>Root cause analysis · The 5 whys</h3><p class="impact-note">Understand the causes and improve the system, without seeking individual blame.</p><ol class="five-whys">${review.five_whys.map(item => `<li><h4>${e(item.question)}</h4><p>${e(item.answer)}</p></li>`).join('')}</ol></section></div>`;
  }
  function rexActionsMarkup(incident) {
    const labels = {a_faire: 'To do', en_cours: 'In progress', termine: 'Completed'};
    const items = incident.rex.action_items;
    return `<div class="panel-heading"><h2>${icon('check')}Follow-up actions</h2><span class="badge teal">${e(items.filter(item => item.status === 'termine').length)} / ${e(items.length)}</span></div><div class="action-items">${items.map(item => {
      const key = `action|${incident.id}|${item.id}`;
      return `<article class="action-item"><h3>${e(item.title)}</h3><dl><div><dt>Owner</dt><dd>${e(item.owner)}</dd></div><div><dt>Deadline</dt><dd><time datetime="${e(item.deadline)}">${e(archiveDate(item.deadline))}</time></dd></div></dl><label>Status<select data-rex-action="${e(item.id)}" data-id="${e(incident.id)}" ${isBusy(key) ? 'disabled' : ''}>${Object.entries(labels).map(([value, label]) => `<option value="${e(value)}" ${item.status === value ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>${state.errors.get(key) ? `<p class="inline-error" role="alert">${e(state.errors.get(key))}</p>` : ''}</article>`;
    }).join('')}</div><p class="impact-note">Synthetic demo data. Status changes are saved.</p>`;
  }
  async function updateActionStatus(id, actionId, status) {
    const key = `action|${id}|${actionId}`;
    if (isBusy(key)) return;
    state.busy.add(key); state.errors.delete(key); refreshUI();
    try {
      const {data, ticket} = await api(`${incidentPath(id)}/rex/actions/${encodeURIComponent(actionId)}`, {status});
      cacheIncident(data, ticket);
    } catch (error) { state.errors.set(key, error.message); if (error.uncertain) void reconcile(id); }
    finally { state.busy.delete(key); refreshUI(); }
  }
  function updateDetail(incident) {
    replaceSlot('detail-error', state.loadError ? `<div class="error-box" role="alert">${e(state.loadError)}<br><button class="btn small" data-action="refresh-data">Retry</button></div>` : '');
    replaceSlot('incident-head', `<div class="incident-kicker"><span class="eyebrow">${e(incident.id)}</span>${severityBadge(incident.severity)}<span class="badge teal">${e(incident.status)}</span><span class="badge synthetic">Synthetic demo data</span></div><div class="heading-row"><h1>${e(incident.title)}</h1><button class="btn" data-action="summary" data-id="${e(incident.id)}" ${isBusy(`summary|${incident.id}`) || !aiAllowed() ? 'disabled' : ''}>${isBusy(`summary|${incident.id}`) ? spinner : icon('refresh')}${isBusy(`summary|${incident.id}`) ? 'Generating…' : 'Regenerate summary'}</button></div><div class="metadata"><span>${icon('route')}Affected line: ${e(incident.line)}</span><span>${icon('clock')}Start: ${e(formatted(incident.started_at, true))}</span><span>${isREX(incident) ? 'End: ' + e(formatted(incident.ended_at, true)) : 'Estimated recovery: ' + e(incident.estimated_end)}</span></div>`);
    replaceSlot('incident-summary', `<div class="section-heading"><h2>${icon('spark')}Situation summary</h2><span class="badge ${incident.summary_source === 'mistral' ? 'teal' : 'synthetic'}">${incident.summary_source === 'mistral' ? 'AI summary' : 'Synthetic demo data'}</span></div>${isBusy(`summary|${incident.id}`) ? `<div class="loading-bar" role="status">${spinner}Analyzing communications. This may take a minute.</div>` : ''}<div class="summary-copy structured">${rich(incident.summary) || '<p>Summary unavailable.</p>'}</div><div class="summary-foot">${icon('clock')}Updated: ${e(formatted(incident.summary_updated_at))}${Number(incident.summary_revision) < Number(incident.revision) ? '<span class="badge amber">New information is available</span>' : ''}</div>${state.errors.get(`summary|${incident.id}`) ? `<div class="inline-error" role="alert">${e(state.errors.get(`summary|${incident.id}`))} <button class="text-button" data-action="summary" data-id="${e(incident.id)}" ${!aiAllowed() ? 'disabled' : ''}>Retry</button></div>` : ''}`);
    replaceSlot('incident-related', `<span>${icon('link')}Related incidents</span>${(incident.related_ids || []).map(id => `<button class="related-chip" data-action="open-incident" data-id="${e(id)}" title="${e(getIncident(id)?.title || id)}">${icon('link')}${e(id)}</button>`).join('') || '<span>None</span>'}<button class="text-button" data-action="related" data-id="${e(incident.id)}">Edit links</button>`);
    setText('event-count', String(incident.events.length));
    replaceSlot('timeline-events', [...incident.events].reverse().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map(event => timelineEvent(event, incident)).join('') || '<div class="empty">No communications.</div>');
    const sending = isBusy(`message|${incident.id}`);
    const button = document.getElementById('message-submit');
    button.disabled = sending;
    button.innerHTML = sending ? `${spinner}Sending…` : `${icon('send')}Send message`;
    setText('message-error', state.errors.get(`message|${incident.id}`));
    replaceSlot('impact-panel', impactMarkup(incident));
    if (isREX(incident)) {
      replaceSlot('rex-review', rexReviewMarkup(incident));
      replaceSlot('rex-actions', rexActionsMarkup(incident));
    } else replaceSlot('history-panel', historyMarkup(incident));
    setText('assistant-config-note', aiNotice());
    updateChat(chatKey(incident.id));
  }
  function refreshUI() {
    if (state.composing) { state.refreshPending = true; return; }
    updateStatus();
    if (!state.incidents.size) {
      main.innerHTML = state.loadError ? `<div class="error-box" role="alert"><h2>Unable to connect</h2><p>${e(state.loadError)}</p><button class="btn primary" data-action="refresh-data">Retry</button></div>` : state.dataLoaded ? '<div class="empty"><h2>No incidents</h2><p>Add an incident in the JSON file, then refresh the data.</p><button class="btn" data-action="refresh-data">Refresh</button></div>' : `<div class="initial-loading" role="status">${spinner}Connecting to the supervision center…</div>`;
      return;
    }
    const key = detailView() ? `detail|${state.activeId}` : state.view;
    const incident = getIncident(state.activeId);
    if (state.mainKey !== key) {
      main.innerHTML = detailView() ? incident ? detailMarkup(incident) : `<div class="error-box" role="alert">Incident not found or inaccessible.<p>${e(state.loadError)}</p><button class="btn" data-action="return-list">Back</button></div>` : overviewMarkup();
      state.mainKey = key;
      hydrateDrafts(main);
    }
    setText('breadcrumb-label', detailView() ? `${listView() === 'rex' ? 'REX' : 'Ongoing incidents'} / ${state.activeId}` : state.view === 'rex' ? 'REX' : 'Ongoing incidents');
    if (detailView() && incident) updateDetail(incident);
    else if (!detailView()) updateOverview();
    updateModal();
    schedulePoll();
  }

  function chatSession(key) {
    if (!state.chats.has(key)) state.chats.set(key, {messages: [], pending: false, failed: null});
    return state.chats.get(key);
  }
  function chatMarkup(id, callId = '') {
    const key = chatKey(id, callId);
    return `<div data-chat="${e(key)}"><p class="chat-intro">${callId ? 'Query the confirmed transcript of this call. The draft and audio are not sent to the chat.' : 'Questions about the situation, decisions, and related incidents. Answers do not replace operating instructions.'}</p>${!callId ? `<div class="chat-suggestions"><button class="suggestion" data-action="suggestion" data-id="${e(id)}" data-question="What are the priorities and the points to confirm?">Priorities and points to confirm</button><button class="suggestion" data-action="suggestion" data-id="${e(id)}" data-question="Summarize the latest decisions and the passenger impact.">Decisions and passenger impact</button></div>` : ''}<div class="chat-messages" data-chat-messages aria-live="polite" aria-relevant="additions text"></div><div class="inline-error" data-chat-error role="alert"></div><form class="chat-form" data-form="chat" data-incident="${e(id)}" data-call="${e(callId)}"><label class="eyebrow" for="${callId ? 'call-question' : 'incident-question'}">Your question</label><div class="input-row"><textarea id="${callId ? 'call-question' : 'incident-question'}" data-draft="${e(key)}" maxlength="3000" required placeholder="Ask a question…" rows="2"></textarea><button class="btn primary" type="submit" aria-label="Send the question">${icon('send')}</button></div></form></div>`;
  }
  function updateChat(key) {
    const session = chatSession(key);
    document.querySelectorAll('[data-chat]').forEach(root => {
      if (root.dataset.chat !== key) return;
      const messages = root.querySelector('[data-chat-messages]');
      const nearBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 45;
      const html = session.messages.map(item => `<div class="chat-message ${item.role === 'user' ? 'user' : 'assistant'}"><div class="chat-role">${item.role === 'user' ? 'You' : 'Assistant'}</div><div class="structured">${rich(item.content)}</div>${item.status === 'failed' ? '<p class="inline-error">Question not processed.</p>' : ''}</div>`).join('') + (session.pending ? `<div class="chat-message assistant" role="status">${spinner}The assistant is analyzing the information…</div>` : '');
      if (messages._markup !== html) { messages.innerHTML = html; messages._markup = html; if (nearBottom) messages.scrollTop = messages.scrollHeight; }
      const error = root.querySelector('[data-chat-error]');
      error.innerHTML = session.failed ? `${e(session.failed.error)} <button class="text-button" data-action="retry-chat" data-chat-key="${e(key)}">Retry this question</button>` : '';
      const callId = root.querySelector('form').dataset.call;
      const id = root.querySelector('form').dataset.incident;
      const allowed = aiAllowed() && (!callId || !!getCall(id, callId)?.transcript?.trim());
      const submit = root.querySelector('button[type="submit"]');
      submit.disabled = session.pending || !allowed;
      submit.innerHTML = session.pending ? spinner : icon('send');
      submit.setAttribute('aria-label', session.pending ? 'Response in progress' : 'Send the question');
      root.querySelectorAll('[data-action="retry-chat"]').forEach(button => { button.disabled = session.pending || !allowed; });
    });
  }
  async function sendChat(id, callId = '', retry = false) {
    const key = chatKey(id, callId);
    const session = chatSession(key);
    if (session.pending || !aiAllowed()) return;
    const snapshot = {...draft(key)};
    const previousFailure = retry ? session.failed : null;
    const question = (previousFailure ? previousFailure.question : snapshot.value).trim();
    if (!question || question.length > 3000) { toast('Enter a question of 1 to 3,000 characters.', true); return; }
    if (callId && !getCall(id, callId)?.transcript?.trim()) { toast('Confirm the transcript before querying this call.', true); return; }
    const historyTurns = previousFailure ? previousFailure.history : session.messages.filter(item => item.status === 'sent').slice(-20).map(item => ({role: item.role, content: item.content.slice(0, 8000)}));
    const userTurn = previousFailure ? session.messages.find(item => item.id === previousFailure.turnId) : {id: ++state.sequence, role: 'user', content: question, status: 'pending'};
    if (!previousFailure) session.messages.push(userTurn); else userTurn.status = 'pending';
    session.pending = true; session.failed = null; updateChat(key);
    try {
      const {data} = await api(`${callId ? callPath(id, callId) : incidentPath(id)}/chat`, {question, history: historyTurns});
      if (typeof data.answer !== 'string' || !data.answer.trim()) throw new RequestError('The assistant returned an empty answer.');
      userTurn.status = 'sent';
      session.messages.push({id: ++state.sequence, role: 'assistant', content: data.answer, status: 'sent'});
      if (!retry) clearSubmittedDraft(key, snapshot);
    } catch (error) {
      userTurn.status = 'failed'; session.failed = {question, history: historyTurns, turnId: userTurn.id, error: error.message};
    } finally { session.pending = false; updateChat(key); updateStatus(); }
  }
  async function sendMessage(id) {
    const key = messageKey(id);
    if (isBusy(key)) return;
    const snapshot = {...draft(key)};
    const content = snapshot.value.trim();
    if (!content || content.length > 6000) { toast('Enter a message of 1 to 6,000 characters.', true); return; }
    state.busy.add(key); state.errors.delete(key); refreshUI();
    try {
      const {data, ticket} = await api(`${incidentPath(id)}/messages`, {content});
      cacheIncident(data, ticket); clearSubmittedDraft(key, snapshot); toast('Message added. Impacts are being recalculated.');
    } catch (error) { state.errors.set(key, error.message); if (error.uncertain) void reconcile(id); }
    finally { state.busy.delete(key); refreshUI(); }
  }
  async function reconcile(id) {
    try { const {data, ticket} = await api(incidentPath(id)); cacheIncident(data, ticket); refreshUI(); } catch (_) { updateStatus(); }
  }
  async function incidentAI(id, kind) {
    const key = `${kind}|${id}`;
    if (isBusy(key) || !aiAllowed()) return;
    state.busy.add(key); state.errors.delete(key); refreshUI();
    try {
      const {data, ticket} = await api(`${incidentPath(id)}/${kind}`, {});
      cacheIncident(kind === 'summary' ? data.incident : data, ticket);
      if (kind === 'summary') { toast('Summary updated from the incident information.'); }
      else toast('Impact recalculation started.');
    } catch (error) { state.errors.set(key, error.message); toast(error.message, true); if (error.status === 409 || error.uncertain) void reconcile(id); }
    finally { state.busy.delete(key); refreshUI(); }
  }

  function modalBusy() {
    const modal = state.modal;
    return !!modal && (modal.starting || modal.saving || modal.canceling || modal.relatedSaving);
  }
  function dialogHeader(title, subtitle, eyebrow = 'COMMUNICATIONS') {
    return `<header class="dialog-header"><div><div class="eyebrow">${e(eyebrow)}</div><h2 id="dialog-title" tabindex="-1">${e(title)}</h2><p>${e(subtitle)}</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></header>`;
  }
  function openModal(modal, html, internal = false) {
    if (!internal && (recordingLocked() || modalBusy())) { toast('Finish or cancel the current action before opening another dialog.', true); return false; }
    const returnFocus = state.modal?.returnFocus || document.activeElement;
    state.modal = {...modal, returnFocus};
    dialogContent.innerHTML = html;
    hydrateDrafts(dialogContent);
    document.body.classList.add('dialog-open');
    if (!dialog.open) dialog.showModal();
    dialogContent.querySelector('[autofocus], #dialog-title')?.focus({preventScroll: true});
    return true;
  }
  function closeDialog() {
    if (recordingLocked() || modalBusy()) { toast('Stop the recording or explicitly cancel the call. An in-progress save must finish.', true); return false; }
    const modal = state.modal;
    if (modal?.kind === 'call') {
      const local = state.callDrafts.get(callKey(modal.id, modal.callId));
      if (local?.phase === 'review') toast('Audio and transcript kept in this page. Reopen the call to confirm them.');
    }
    state.modal = null;
    dialog.close();
    document.body.classList.remove('dialog-open');
    if (modal?.returnFocus?.isConnected) modal.returnFocus.focus({preventScroll: true});
    else main.focus({preventScroll: true});
    return true;
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener('close', () => {
    if (state.modal && recordingLocked()) { dialog.showModal(); return; }
    state.modal = null; document.body.classList.remove('dialog-open');
  });
  dialog.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].filter(item => !item.disabled);
    const current = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    if (tabs[next]) { tabs[next].click(); tabs[next].focus(); }
  });

  function openRelated(id) {
    const incident = getIncident(id);
    if (!incident) return;
    const key = `related|${id}`;
    if (!state.relatedDrafts) state.relatedDrafts = new Map();
    if (!state.relatedDrafts.has(id)) state.relatedDrafts.set(id, new Set(incident.related_ids || []));
    const selection = state.relatedDrafts.get(id);
    openModal({kind: 'related', id, key}, `${dialogHeader('Link incidents', incident.title, 'SHARED SITUATION')}<div class="dialog-body"><p class="notice">Choose the ongoing incidents to include in the context of this incident. Saving replaces its links; reverse links are not modified.</p><form id="related-form" data-form="related" data-incident="${e(id)}"><div class="related-options">${allIncidents().filter(item => item.id !== id && item.status === 'In progress').map(item => `<label class="related-option"><input type="checkbox" data-related-id="${e(item.id)}" ${selection.has(item.id) ? 'checked' : ''}><span><strong>${e(item.title)}</strong><small>${e(item.id)} · ${e(item.location)} · ${severityBadge(item.severity)}</small></span></label>`).join('') || '<p class="muted">No other ongoing incidents.</p>'}</div><div id="related-error" class="inline-error" role="alert"></div></form></div><footer class="dialog-footer"><button class="btn" data-action="close-dialog">Close</button><button class="btn primary" type="submit" form="related-form" id="related-submit">Save links</button></footer>`);
  }
  function syncRelatedDraft() {
    if (state.modal?.kind !== 'related') return;
    const selection = new Set([...dialog.querySelectorAll('[data-related-id]:checked')].map(input => input.dataset.relatedId));
    state.relatedDrafts.set(state.modal.id, selection);
  }
  async function saveRelated(id) {
    const modal = state.modal;
    if (!modal || modal.kind !== 'related' || modal.id !== id || modal.relatedSaving) return;
    syncRelatedDraft();
    const submitted = [...state.relatedDrafts.get(id)];
    modal.relatedSaving = true; setText('related-error', ''); updateModal();
    try {
      const {data, ticket} = await api(`${incidentPath(id)}/related`, {related_ids: submitted});
      cacheIncident(data, ticket); state.relatedDrafts.delete(id);
      modal.relatedSaving = false;
      if (state.modal === modal) closeDialog();
      toast('Links saved. The context and impacts will be updated.');
    } catch (error) { if (state.modal === modal) setText('related-error', error.message); if (error.uncertain) void reconcile(id); }
    finally { modal.relatedSaving = false; refreshUI(); }
  }
  function openHistory(id, historyId) {
    const incident = getIncident(id);
    const item = incident?.history?.find(entry => entry.id === historyId);
    if (!item) { toast('History entry not found.', true); return; }
    openModal({kind: 'history', id}, `${dialogHeader(item.title, `${item.id} · ${archiveDate(item.date)}`, 'Synthetic demo data')}<div class="dialog-body"><div class="notice amber">Synthetic demo data</div><div class="archive-meta">${severityBadge(item.severity)}<span class="badge">${e(item.category)}</span><span class="badge teal">Similarity ${e(item.confidence)} %</span><span class="badge">${e(item.location)}</span></div><div class="structured">${rich(item.summary)}</div></div><footer class="dialog-footer"><button class="btn" data-action="close-dialog">Close</button><button class="btn primary" data-action="open-rex" data-id="${e(item.id)}">Open the documentation archive ${icon('arrow')}</button></footer>`);
  }
  function openNewCall(id) {
    const incident = getIncident(id);
    if (!incident) return;
    const blocker = allIncidents().flatMap(item => item.events.filter(event => event.type === 'call' && event.status === 'en_cours' && !event.synthetic).map(call => ({id: item.id, call})))[0];
    const mode = draft(`call-mode|${id}`).value || 'microphone';
    const supported = !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && window.isSecureContext;
    openModal({kind: 'new-call', id}, `${dialogHeader('Add a call', incident.title, 'OPERATIONAL COORDINATION')}<div class="dialog-body">${blocker ? `<div class="notice amber">A microphone call is already open. Finish or cancel it before creating another.<br><button class="text-button" data-action="open-call" data-id="${e(blocker.id)}" data-call="${e(blocker.call.id)}">Open ${e(blocker.call.title)}</button></div>` : ''}<form id="new-call-form" class="new-call-form" data-form="new-call" data-incident="${e(id)}"><div class="field"><label for="call-title">Call title</label><input id="call-title" type="text" maxlength="180" data-draft="call-title|${e(id)}" placeholder="Coordination call" autofocus></div><fieldset class="record-options"><legend>Transcript source</legend><label class="record-option"><input type="radio" name="call-mode" value="microphone" ${mode === 'microphone' ? 'checked' : ''}><span><strong>${icon('mic')}Real microphone</strong><span>Local recording and, if available, browser speech recognition in English (en-US). The transcript must be reviewed before sending. Only your microphone is captured, not an external phone call.</span></span></label><label class="record-option"><input type="radio" name="call-mode" value="synthetic" ${mode === 'synthetic' ? 'checked' : ''}><span><strong>${icon('file')}Synthetic demo data</strong><span>Synthetic demo data. No microphone, no generated audio, and no speech recognition.</span></span></label></fieldset><div class="notice">Audio is never uploaded. The confirmed transcript is stored locally by the server. Browser recognition may use its own speech service; it is separate from Mistral.</div>${!supported ? '<div class="notice amber">The microphone requires HTTPS or localhost, MediaRecorder, and browser permission. Use a compatible browser or the "Synthetic demo data" option.</div>' : ''}<div id="new-call-error" class="inline-error" role="alert"></div></form></div><footer class="dialog-footer"><button class="btn" data-action="close-dialog">Close</button><button id="cancel-start" class="btn danger" data-action="cancel-start" hidden>Cancel start</button><button id="new-call-submit" class="btn primary" type="submit" form="new-call-form" ${blocker ? 'disabled' : ''}>${icon(mode === 'synthetic' ? 'file' : 'mic')}${mode === 'synthetic' ? 'Create call' : 'Start microphone'}</button></footer>`);
    if (state.modal?.kind === 'new-call') state.modal.blocked = !!blocker;
  }
  function syncNewCallMode() {
    const modal = state.modal;
    if (modal?.kind !== 'new-call') return;
    const mode = dialog.querySelector('[name="call-mode"]:checked')?.value || 'microphone';
    setDraft(`call-mode|${modal.id}`, mode);
    const button = document.getElementById('new-call-submit');
    if (button && !modal.starting) button.innerHTML = `${icon(mode === 'synthetic' ? 'file' : 'mic')}${mode === 'synthetic' ? 'Create call' : 'Start microphone'}`;
  }
  function ensureCallDraft(id, call) {
    const key = callKey(id, call.id);
    if (!state.callDrafts.has(key)) {
      const transcriptKey = `transcript|${id}|${call.id}`;
      if (!state.drafts.has(transcriptKey)) setDraft(transcriptKey, call.transcript || '');
      state.callDrafts.set(key, {id, callId: call.id, transcriptKey, duration: call.duration_seconds || 0,
        phase: ['en_cours', 'error'].includes(call.status) ? 'review' : 'saved',
        confirmed: false, blob: null, url: '', mime: '', note: '', error: ''});
    }
    return state.callDrafts.get(key);
  }
  function openCall(id, callId, tab = 'summary', internal = false) {
    const call = getCall(id, callId);
    if (!call) { toast('Call not found. Refresh the data.', true); return; }
    ensureCallDraft(id, call);
    const opened = openModal({kind: 'call', id, callId, tab}, `${dialogHeader(call.title, `${id} · ${formatted(call.created_at, true)}`, 'COORDINATION CALL')}<div id="call-dialog-meta" class="dialog-details" style="padding:0 26px 16px"></div><div class="dialog-tabs" role="tablist" aria-label="Call information">${[['summary', 'Summary', 'file'], ['transcription', 'Transcript', 'message'], ['chat', 'Chat', 'spark']].map(([key, label, name]) => `<button id="call-tab-${key}" role="tab" data-action="call-tab" data-tab="${key}" aria-controls="call-tab-content" aria-selected="${key === tab}" tabindex="${key === tab ? 0 : -1}">${icon(name)}${label}</button>`).join('')}</div><div class="dialog-body"><div id="call-dialog-notice"></div><div id="call-audio"></div><section id="call-tab-content" role="tabpanel" aria-labelledby="call-tab-${e(tab)}"></section><div id="call-dialog-error" class="inline-error" role="alert"></div></div><footer id="call-dialog-footer" class="dialog-footer"></footer>`, internal);
    if (opened) { renderCallTab(); updateModal(); }
  }
  function renderCallTab() {
    const modal = state.modal;
    if (modal?.kind !== 'call' || state.recording) return;
    const call = getCall(modal.id, modal.callId);
    if (!call) return;
    const local = ensureCallDraft(modal.id, call);
    const panel = document.getElementById('call-tab-content');
    panel.setAttribute('aria-labelledby', `call-tab-${modal.tab}`);
    if (modal.tab === 'summary') {
      panel.innerHTML = '<div id="call-summary-copy" class="structured"></div>';
    } else if (modal.tab === 'chat') {
      panel.innerHTML = chatMarkup(modal.id, modal.callId) + (aiNotice() ? `<p class="recognition-note">${e(aiNotice())}</p>` : '');
    } else if (['en_cours', 'error'].includes(call.status)) {
      panel.innerHTML = `<form id="call-finish-form" data-form="finish-call" data-incident="${e(modal.id)}" data-call="${e(modal.callId)}"><label for="call-transcript">Transcript to review and correct</label><textarea id="call-transcript" class="transcript-editor" data-draft="${e(local.transcriptKey)}" maxlength="60000" required placeholder="Type or paste the actual transcript of the call here. No text is invented."></textarea><p class="draft-note">This draft and any audio are kept as long as this page stays open, even if you close this dialog. Only the confirmed transcript will be sent.</p><label class="related-option"><input id="transcript-confirmed" type="checkbox" ${local.confirmed ? 'checked' : ''}><span>I have reviewed the transcript and confirm saving it.</span></label></form>`;
    } else {
      panel.innerHTML = `<h3>Saved transcript</h3><p id="saved-transcript" class="transcript-text">${e(call.transcript || 'No transcript saved for this call.')}</p>`;
    }
    hydrateDrafts(panel);
    modal.renderedTab = modal.tab;
    modal.renderedStatus = call.status;
    updateModal();
  }
  function syncTranscriptDraft(key) {
    const [, id, callId] = key.split('|');
    const local = state.callDrafts.get(callKey(id, callId));
    if (!local) return;
    local.confirmed = false;
    const checkbox = document.getElementById('transcript-confirmed');
    if (checkbox && state.modal?.id === id && state.modal?.callId === callId) checkbox.checked = false;
    updateModal();
  }
  function callFooter(modal, call, local) {
    const locked = recordingLocked();
    const pending = modal.saving || modal.canceling;
    const editable = ['en_cours', 'error'].includes(call.status);
    const recording = state.recording && state.recording.id === modal.id && state.recording.callId === modal.callId;
    return `${recording ? `<button class="btn danger" data-action="cancel-call" ${pending ? 'disabled' : ''}>${icon('close')}Cancel and delete the recording</button><button id="stop-recording" class="btn primary" data-action="stop-recording" ${state.recording.stopping || pending ? 'disabled' : ''}>${state.recording.stopping ? spinner : icon('stop')}${state.recording.stopping ? 'Finalizing the transcript…' : 'Stop and review'}</button>` : `${editable ? `<button class="btn danger" data-action="cancel-call" ${pending ? 'disabled' : ''}>${modal.canceling ? spinner : icon('close')}${modal.canceling ? 'Canceling…' : 'Cancel call'}</button>` : ''}<button class="btn" data-action="close-dialog" ${locked || pending ? 'disabled' : ''}>Close</button>${editable && !locked ? modal.tab === 'transcription' ? `<button id="finish-call-submit" class="btn primary" type="submit" form="call-finish-form" ${pending || !local.confirmed || !draft(local.transcriptKey).value.trim() ? 'disabled' : ''}>${modal.saving ? spinner : icon('check')}${modal.saving ? 'Saving…' : call.status === 'error' ? 'Confirm and restart the summary' : 'Confirm and finish'}</button>` : '<button class="btn primary" data-action="review-transcript">Review the transcript</button>' : ''}`}`;
  }
  function updateModal() {
    const modal = state.modal;
    if (!modal || !dialog.open) return;
    const locked = recordingLocked() || modalBusy();
    dialog.querySelectorAll('[data-action="close-dialog"]').forEach(button => { button.disabled = locked; });
    if (modal.kind === 'new-call') {
      dialog.querySelectorAll('input').forEach(field => { field.disabled = !!modal.starting; });
      const submit = document.getElementById('new-call-submit');
      if (submit) { submit.disabled = !!modal.starting || modal.blocked; if (modal.starting) submit.innerHTML = `${spinner}Starting…`; else syncNewCallMode(); }
      const cancel = document.getElementById('cancel-start');
      if (cancel) { cancel.hidden = !modal.starting; cancel.disabled = !!state.startingCall?.cancelRequested; }
      return;
    }
    if (modal.kind === 'related') {
      dialog.querySelectorAll('[data-related-id]').forEach(input => { input.disabled = !!modal.relatedSaving; });
      const button = document.getElementById('related-submit');
      if (button) { button.disabled = !!modal.relatedSaving; button.innerHTML = modal.relatedSaving ? `${spinner}Saving…` : 'Save links'; }
      return;
    }
    if (modal.kind !== 'call') return;
    const call = getCall(modal.id, modal.callId);
    if (!call) return;
    const local = ensureCallDraft(modal.id, call);
    const recording = state.recording && state.recording.id === modal.id && state.recording.callId === modal.callId;
    replaceSlot('call-dialog-meta', `${callStatus(call)}${call.synthetic ? '<span class="badge synthetic">Synthetic demo data</span>' : '<span class="badge">Real microphone</span>'}<span class="badge">${e((call.participants || []).join(' · '))}</span><span class="badge">${e(duration(local.duration || call.duration_seconds))}</span>`);
    dialog.querySelectorAll('[role="tab"]').forEach(button => {
      button.disabled = !!recording || !!modal.starting || !!modal.canceling || !!modal.saving;
      button.setAttribute('aria-selected', String(button.dataset.tab === modal.tab));
      button.tabIndex = button.dataset.tab === modal.tab ? 0 : -1;
    });
    const notices = [];
    if (modal.starting) notices.push('<div class="loading-bar" role="status">' + spinner + 'Requesting permission and preparing the microphone… <button class="text-button" data-action="cancel-start">Cancel</button></div>');
    if (call.synthetic) notices.push('<p class="notice purple">Synthetic demo data. This call was not recorded with a microphone and has no audio.</p>');
    if (!call.synthetic && !recording && !local.url && call.status === 'en_cours') notices.push('<p class="notice amber">No local audio available in this page. You can start the microphone on this call or type a real manual transcript.</p><button class="btn small purple" data-action="resume-microphone">Start microphone</button>');
    if (call.status === 'processing') notices.push(`<div class="loading-bar" role="status">${spinner}The transcript is saved. Summary in preparation, then impact recalculation.</div>`);
    if (call.status === 'annule') notices.push('<p class="notice">Call cancelled. It remains visible for traceability; no processing is started.</p>');
    if (local.note) notices.push(`<p class="notice amber">${e(local.note)}</p>`);
    if (!aiAllowed() && ['en_cours', 'error'].includes(call.status)) notices.push(`<p class="notice amber">${e(aiNotice())} The transcript can be saved, but the summary may fail.</p>`);
    replaceSlot('call-dialog-notice', notices.join(''));
    if (!recording) {
      const audio = local.url ? `<div class="audio-preview"><strong class="small">Local recording · ${e(duration(local.duration))}</strong><audio controls preload="metadata" src="${e(local.url)}" aria-label="Listen to this call recording"></audio><div class="button-row"><a class="btn small" href="${e(local.url)}" download="${e(String(call.id).replace(/[^a-zA-Z0-9_-]/g, '_'))}.${local.mime.includes('mp4') ? 'm4a' : local.mime.includes('ogg') ? 'ogg' : 'webm'}">${icon('download')}Download audio</a></div><p class="audio-caption">Audio kept only in memory in this browser, not sent to the server. Download it before reloading or leaving the page.</p></div>` : '';
      replaceSlot('call-audio', audio);
    }
    if (!recording && modal.renderedStatus !== call.status) {
      renderCallTab(); return;
    }
    if (modal.tab === 'summary') {
      replaceSlot('call-summary-copy', call.summary ? `${rich(call.summary)}<p class="recognition-note">${call.summary_source === 'mistral' ? 'Summary generated by AI' : 'Synthetic demo data'}</p>` : `<p class="muted">${call.status === 'en_cours' ? 'The summary will be generated after the transcript is stopped and confirmed.' : call.status === 'processing' ? 'The summary is being generated.' : call.status === 'error' ? 'The summary could not be generated. Review the transcript and restart processing.' : 'No summary available.'}</p>`);
    }
    if (modal.tab === 'chat') updateChat(chatKey(modal.id, modal.callId));
    if (modal.tab === 'transcription' && !recording) {
      const editor = document.getElementById('call-transcript');
      if (editor) {
        editor.readOnly = !!modal.saving || !['en_cours', 'error'].includes(call.status);
        const checkbox = document.getElementById('transcript-confirmed');
        if (checkbox) checkbox.disabled = editor.readOnly;
      } else if (['en_cours', 'error'].includes(call.status) && modal.renderedStatus !== call.status) {
        renderCallTab(); return;
      } else setText('saved-transcript', call.transcript || 'No transcript saved for this call.');
    }
    setText('call-dialog-error', local.error || (call.status === 'error' ? call.error || 'Processing failed. Review the transcript, then retry.' : ''));
    replaceSlot('call-dialog-footer', callFooter(modal, call, local));
  }
  async function createCall(id) {
    const modal = state.modal;
    if (modal?.kind !== 'new-call' || modal.id !== id || isBusy('create-call') || modal.blocked) return;
    const titleKey = `call-title|${id}`;
    const snapshot = {...draft(titleKey)};
    const title = snapshot.value.trim() || null;
    const synthetic = (dialog.querySelector('[name="call-mode"]:checked')?.value || 'microphone') === 'synthetic';
    if (title && title.length > 180) { setText('new-call-error', 'The title cannot exceed 180 characters.'); return; }
    if (!synthetic && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')) {
      setText('new-call-error', 'Recording unavailable: use HTTPS or localhost and a compatible browser. The other option is labeled "Synthetic demo data".'); return;
    }
    const session = {id, callId: null, cancelRequested: false};
    state.startingCall = session; state.busy.add('create-call'); modal.starting = true; setText('new-call-error', ''); updateModal();
    try {
      const {data, ticket} = await api(`${incidentPath(id)}/calls`, {title, synthetic});
      if (!data.call?.id || !data.incident) throw new RequestError('Invalid call creation response.');
      cacheIncident(data.incident, ticket); session.callId = data.call.id;
      ensureCallDraft(id, data.call); clearSubmittedDraft(titleKey, snapshot);
      openCall(id, data.call.id, 'transcription', true);
      if (session.cancelRequested) { state.startingCall = null; await cancelCall(id, data.call.id); return; }
      if (synthetic) { state.startingCall = null; toast('Call created. Synthetic demo data. Review the transcript before confirming.'); }
      else {
        state.modal.starting = true; updateModal();
        await startMicrophone(id, data.call.id, session);
      }
    } catch (error) {
      if (session.callId) await microphoneFailed(id, session.callId, error);
      else {
        if (state.modal === modal) setText('new-call-error', error.message);
        if (error.uncertain || error.status === 409) { await reconcile(id); if (error.uncertain) toast('Creation not confirmed. Check the thread and cancel any incomplete call before retrying.', true); }
      }
    } finally {
      if (state.startingCall === session) state.startingCall = null;
      state.busy.delete('create-call'); modal.starting = false;
      if (state.modal?.kind === 'call' && state.modal.id === id && state.modal.callId === session.callId) state.modal.starting = false;
      refreshUI();
    }
  }
  async function finishCall(id, callId) {
    const call = getCall(id, callId);
    const key = `finish|${callKey(id, callId)}`;
    if (!call || !['en_cours', 'error'].includes(call.status) || isBusy(key) || recordingLocked()) return;
    const local = ensureCallDraft(id, call);
    const transcript = draft(local.transcriptKey).value.trim();
    if (!local.confirmed || !transcript || transcript.length > 60000) {
      local.error = 'Review a non-empty transcript (60,000 characters maximum), then check the confirmation.'; updateModal(); return;
    }
    const modal = state.modal?.kind === 'call' && state.modal.id === id && state.modal.callId === callId ? state.modal : null;
    state.busy.add(key); local.error = ''; if (modal) modal.saving = true; updateModal();
    try {
      const {data, ticket} = await api(`${callPath(id, callId)}/finish`, {transcript, duration_seconds: Math.min(14400, Math.max(0, Math.round(local.duration)))});
      cacheIncident(data, ticket); local.phase = 'saved';
      toast('Transcript saved. Summary and impacts processing.');
    } catch (error) { local.error = error.message; if (error.uncertain || error.status === 409) await reconcile(id); }
    finally { state.busy.delete(key); if (modal) modal.saving = false; refreshUI(); }
  }
  function discardCallDraft(id, callId) {
    const key = callKey(id, callId);
    const local = state.callDrafts.get(key);
    if (!local) return;
    if (local.url) URL.revokeObjectURL(local.url);
    local.url = ''; local.blob = null; local.phase = 'cancelled'; local.confirmed = false;
    setDraft(local.transcriptKey, '');
    if (state.modal?.id === id && state.modal?.callId === callId) {
      const editor = document.getElementById('call-transcript');
      if (editor) editor.value = '';
    }
  }
  async function cancelCall(id, callId) {
    const call = getCall(id, callId);
    const key = `cancel|${callKey(id, callId)}`;
    if (!call || isBusy(key) || isBusy(`finish|${callKey(id, callId)}`)) return;
    const modal = state.modal?.kind === 'call' && state.modal.id === id && state.modal.callId === callId ? state.modal : null;
    const local = ensureCallDraft(id, call);
    if (!['en_cours', 'error'].includes(call.status)) { local.error = 'A finished or processing call cannot be cancelled.'; updateModal(); return; }
    state.busy.add(key); if (modal) modal.canceling = true; local.error = ''; updateModal();
    if (state.startingCall?.id === id && state.startingCall.callId === callId) state.startingCall.cancelRequested = true;
    if (state.recording?.id === id && state.recording.callId === callId) {
      const recording = state.recording; tearDownCapture(recording); state.recording = null;
    }
    try {
      const {data, ticket} = await api(`${callPath(id, callId)}/cancel`, {});
      cacheIncident(data, ticket); discardCallDraft(id, callId); local.note = 'Call cancelled. Microphone resources and the local audio draft have been released.';
      if (modal && state.modal === modal) renderCallTab();
      toast('Call cancelled. Microphone released and local audio deleted.');
    } catch (error) {
      local.error = `The microphone is stopped, but server cancellation failed: ${error.message}`;
      local.phase = 'review'; if (error.uncertain || error.status === 409) await reconcile(id);
      if (modal && state.modal === modal) renderCallTab();
    } finally { state.busy.delete(key); if (modal) { modal.canceling = false; modal.starting = false; } refreshUI(); }
  }
  async function microphoneFailed(id, callId, error) {
    if (state.recording?.id === id && state.recording.callId === callId) { tearDownCapture(state.recording); state.recording = null; }
    if (state.startingCall?.id === id && state.startingCall.callId === callId) state.startingCall = null;
    const call = getCall(id, callId);
    const local = call ? ensureCallDraft(id, call) : null;
    const reason = error.name === 'NotAllowedError' ? 'Microphone permission denied.' : error.name === 'NotFoundError' ? 'No microphone detected.' : error.name === 'NotReadableError' ? 'Microphone inaccessible or used by another application.' : error.message || 'The microphone failed.';
    if (state.modal?.kind === 'call') state.modal.starting = false;
    if (call && ['en_cours', 'error'].includes(call.status)) await cancelCall(id, callId);
    if (local) local.note = `${reason} ${getCall(id, callId)?.status === 'annule' ? 'The incomplete call was cancelled on the server side.' : 'The call still needs to be cancelled on the server side; use Cancel call to retry.'} No audio or transcript was created.`;
    toast(local?.note || reason, true); updateModal();
  }
  async function resumeMicrophone() {
    const modal = state.modal;
    if (modal?.kind !== 'call' || recordingLocked() || modalBusy()) return;
    const call = getCall(modal.id, modal.callId);
    if (!call || call.synthetic || call.status !== 'en_cours') return;
    const session = {id: modal.id, callId: modal.callId, cancelRequested: false};
    state.startingCall = session; modal.starting = true; modal.tab = 'transcription'; renderCallTab(); updateModal();
    try { await startMicrophone(modal.id, modal.callId, session); }
    catch (error) { await microphoneFailed(modal.id, modal.callId, error); }
    finally { if (state.startingCall === session) state.startingCall = null; modal.starting = false; refreshUI(); }
  }
  async function handleDialogAction(button) {
    const action = button.dataset.action;
    const modal = state.modal;
    if (action === 'new-call') openNewCall(button.dataset.id);
    else if (action === 'open-call') openCall(button.dataset.id, button.dataset.call);
    else if (['join-call', 'end-call'].includes(action)) {
      const call = getCall(button.dataset.id, button.dataset.call);
      if (call?.status === 'en_cours') openCall(button.dataset.id, button.dataset.call, 'transcription');
    }
    else if (action === 'related') openRelated(button.dataset.id);
    else if (action === 'open-history') openHistory(button.dataset.id, button.dataset.history);
    else if (action === 'close-dialog') closeDialog();
    else if (action === 'call-tab' && modal?.kind === 'call' && !recordingLocked() && !modalBusy()) { modal.tab = button.dataset.tab; renderCallTab(); }
    else if (action === 'review-transcript' && modal?.kind === 'call' && !recordingLocked()) { modal.tab = 'transcription'; renderCallTab(); }
    else if (action === 'stop-recording') await stopRecording();
    else if (action === 'resume-microphone') await resumeMicrophone();
    else if (action === 'cancel-start') {
      const session = state.startingCall;
      if (session) {
        session.cancelRequested = true;
        if (session.callId) await cancelCall(session.id, session.callId);
        else setText('new-call-error', 'Cancellation requested. The call will be cancelled as soon as the server responds.');
        updateModal();
      }
    } else if (action === 'cancel-call' && modal?.kind === 'call') await cancelCall(modal.id, modal.callId);
  }
  async function handleDialogSubmit(form) {
    if (form.dataset.form === 'new-call') await createCall(form.dataset.incident);
    else if (form.dataset.form === 'related') await saveRelated(form.dataset.incident);
    else if (form.dataset.form === 'finish-call') await finishCall(form.dataset.incident, form.dataset.call);
  }
  dialog.addEventListener('change', event => {
    if (event.target.id !== 'transcript-confirmed' || state.modal?.kind !== 'call') return;
    const local = state.callDrafts.get(callKey(state.modal.id, state.modal.callId));
    if (local) { local.confirmed = event.target.checked; local.error = ''; updateModal(); }
  });

  function releaseTracks(stream) {
    stream?.getTracks().forEach(track => { try { track.stop(); } catch (_) { /* Track already stopped. */ } });
  }
  function recognitionFallback(recording, message) {
    recording.manual = true;
    recording.recognitionNote = `${message} Real audio continues to be recorded. Type or paste a manual transcript before confirming; no text is invented.`;
    clearTimeout(recording.restartTimer);
    try { recording.recognition?.abort(); } catch (_) { /* Recognition already stopped. */ }
    setText('recognition-note', recording.recognitionNote);
  }
  function liveRecognitionText(recording) {
    const finals = [...recording.finalSegments.values()].join(' ').trim();
    setText('live-transcript', [finals, recording.interim].filter(Boolean).join(' ') || 'Waiting for recognized speech. You can type a manual transcript below.');
    const node = document.getElementById('live-transcript');
    if (node) node.scrollTop = node.scrollHeight;
  }
  function startRecognition(recording) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { recognitionFallback(recording, 'Speech recognition unavailable in this browser (SpeechRecognition not supported).'); return; }
    try {
      const recognition = new Recognition();
      recording.recognition = recognition;
      recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 1;
      let generation = 0;
      recognition.onstart = () => { generation += 1; recording.recognitionActive = true; };
      recognition.onresult = event => {
        if (recording.discard || recording.manual) return;
        const interim = [];
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = String(result[0]?.transcript || '').trim();
          if (result.isFinal && text) recording.finalSegments.set(`${generation}:${index}`, text);
          else if (text) interim.push(text);
        }
        recording.interim = interim.join(' '); recording.silentEnds = 0;
        liveRecognitionText(recording);
      };
      recognition.onerror = event => {
        if (recording.discard || recording.stopping || event.error === 'aborted') return;
        const reasons = {
          'not-allowed': 'Speech recognition permission denied.',
          'service-not-allowed': 'The browser speech service is unavailable.',
          network: 'The browser speech service is not responding (network error).',
          'audio-capture': 'The speech service cannot access the microphone.',
          'language-not-supported': 'The speech service does not support English (en-US).'
        };
        if (event.error === 'no-speech') {
          setText('recognition-note', 'No speech detected. Audio recording continues; manual input remains possible.');
        } else recognitionFallback(recording, reasons[event.error] || `Speech recognition interrupted (${String(event.error || 'unknown error')}).`);
      };
      recognition.onend = () => {
        recording.recognitionActive = false;
        recording.resolveRecognitionEnd?.();
        if (recording.discard || recording.stopping || recording.manual || state.recording !== recording) return;
        recording.silentEnds += 1;
        if (recording.silentEnds > 4) { recognitionFallback(recording, 'The speech engine stopped several times.'); return; }
        recording.restartTimer = setTimeout(() => {
          if (recording.discard || recording.stopping || recording.manual || state.recording !== recording) return;
          try { recognition.start(); } catch (_) { recognitionFallback(recording, 'Speech recognition cannot restart.'); }
        }, 400);
      };
      recognition.start();
      setText('recognition-note', 'Browser recognition in English (en-US). Results are provisional and must be reviewed. Manual input can be added below.');
    } catch (_) { recognitionFallback(recording, 'Unable to start the browser speech recognition.'); }
  }
  async function startMicrophone(id, callId, session) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || !window.isSecureContext) throw new Error('The microphone requires HTTPS or localhost and MediaRecorder.');
    let expired = false;
    let permissionTimer;
    const acquisition = navigator.mediaDevices.getUserMedia({audio: true}).then(stream => {
      if (expired || session.cancelRequested || state.startingCall !== session) { releaseTracks(stream); return null; }
      return stream;
    });
    let stream;
    try {
      stream = await Promise.race([acquisition, new Promise((_, reject) => {
        permissionTimer = setTimeout(() => { expired = true; reject(new Error('Microphone permission was not received after 30 seconds. Retry after checking permissions.')); }, 30000);
      })]);
    } finally { clearTimeout(permissionTimer); }
    if (!stream || session.cancelRequested || getCall(id, callId)?.status !== 'en_cours') {
      releaseTracks(stream);
      if (getCall(id, callId)?.status === 'en_cours') await cancelCall(id, callId);
      return;
    }
    const call = getCall(id, callId);
    const local = ensureCallDraft(id, call);
    let recorder;
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported?.(type));
      recorder = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream);
    } catch (error) { releaseTracks(stream); throw error; }
    const recording = {id, callId, stream, recorder, chunks: [], started: performance.now(), stopping: false,
      discard: false, manual: false, finalSegments: new Map(), interim: '', silentEnds: 0,
      recognitionActive: false, recognition: null, recognitionNote: '', restartTimer: null, timer: null,
      audioDone: null, resolveAudio: null, resolveRecognitionEnd: null};
    recording.audioDone = new Promise(resolve => { recording.resolveAudio = resolve; });
    recorder.ondataavailable = event => { if (!recording.discard && event.data?.size) recording.chunks.push(event.data); };
    recorder.onstop = () => {
      recording.resolveAudio();
      if (!recording.stopping && !recording.discard && state.recording === recording) void stopRecording();
    };
    recorder.onerror = event => {
      if (!recording.discard) void microphoneFailed(id, callId, event.error || new Error('Microphone recording failed.'));
    };
    stream.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (!recording.stopping && !recording.discard && state.recording === recording) void microphoneFailed(id, callId, new Error('The microphone was disconnected during recording.'));
    }));
    state.recording = recording;
    local.phase = 'recording'; local.confirmed = false; local.error = ''; local.note = '';
    if (state.modal?.kind === 'call') { state.modal.starting = false; state.modal.tab = 'transcription'; }
    const panel = document.getElementById('call-tab-content');
    panel.innerHTML = `<div class="recording-panel"><div class="recording-heading"><strong><span class="record-indicator" aria-hidden="true"></span>Microphone recording</strong><span id="recording-clock">0 s</span></div><div id="live-transcript" aria-label="Provisional speech transcript">Waiting for recognized speech…</div><p id="recognition-note" class="recognition-note"></p></div><label for="recording-manual">Manual transcript or notes (optional during recording)</label><textarea id="recording-manual" class="transcript-editor" data-draft="${e(local.transcriptKey)}" maxlength="60000" placeholder="If recognition is unavailable, type the real transcript here. These notes will be kept with the recognized speech."></textarea><p class="draft-note">Stop the recording first. The last speech results will be awaited before review and confirmation.</p>`;
    hydrateDrafts(panel);
    try { recorder.start(1000); } catch (error) { tearDownCapture(recording); state.recording = null; throw error; }
    state.startingCall = null;
    startRecognition(recording);
    recording.timer = setInterval(() => {
      const elapsed = Math.floor((performance.now() - recording.started) / 1000);
      setText('recording-clock', duration(elapsed));
      if (elapsed >= 14400 && !recording.stopping) { local.note = 'The four-hour limit is reached. Review the transcript before confirming.'; void stopRecording(); }
    }, 1000);
    updateModal(); refreshUI();
    document.getElementById('stop-recording')?.focus({preventScroll: true});
  }
  function waitFor(promise, milliseconds) {
    let timer;
    return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]).finally(() => clearTimeout(timer));
  }
  async function stopRecording() {
    const recording = state.recording;
    if (!recording || recording.stopping || recording.discard) return;
    recording.stopping = true; clearInterval(recording.timer); clearTimeout(recording.restartTimer);
    const local = state.callDrafts.get(callKey(recording.id, recording.callId));
    local.duration = Math.min(14400, Math.round((performance.now() - recording.started) / 1000));
    updateModal();
    try {
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      const audioFinished = await waitFor(recording.audioDone.then(() => true), 5000);
      releaseTracks(recording.stream);
      if (!audioFinished) local.note = 'The browser did not confirm audio finalization. Check playback and the transcript before finishing.';
      if (recording.recognition && !recording.manual) {
        const recognitionEnded = new Promise(resolve => { recording.resolveRecognitionEnd = () => resolve(true); });
        try { recording.recognition.stop(); } catch (_) { recording.resolveRecognitionEnd(); }
        const ended = await waitFor(recognitionEnded, 3500);
        if (!ended) {
          local.note = 'The speech engine did not confirm its last results. Final speech already received is kept; manually fill in the missing passages.';
          try { recording.recognition.abort(); } catch (_) { /* Recognition already stopped. */ }
        }
      }
      if (recording.discard || state.recording !== recording) return;
      const manual = draft(local.transcriptKey).value.trim();
      const recognized = [...recording.finalSegments.values()].join(' ').trim();
      const transcript = [manual, recognized].filter(Boolean).join('\n\n');
      setDraft(local.transcriptKey, transcript);
      local.confirmed = false; local.phase = 'review';
      if (recording.manual) local.note = recording.recognitionNote;
      if (recording.chunks.length) {
        if (local.url) URL.revokeObjectURL(local.url);
        local.mime = recording.recorder.mimeType || recording.chunks[0].type || 'audio/webm';
        local.blob = new Blob(recording.chunks, {type: local.mime});
        local.url = URL.createObjectURL(local.blob);
      } else local.note = 'No audio data was provided by the browser. Type a real manual transcript or cancel this call.';
      tearDownCapture(recording, false); state.recording = null;
      if (state.modal?.kind === 'call' && state.modal.id === recording.id && state.modal.callId === recording.callId) { state.modal.tab = 'transcription'; renderCallTab(); }
      refreshUI(); toast('Recording stopped. Review and confirm the transcript before finishing the call.');
      document.getElementById('call-transcript')?.focus({preventScroll: true});
    } catch (error) { await microphoneFailed(recording.id, recording.callId, error); }
  }
  function tearDownCapture(recording, discard = true) {
    if (!recording) return;
    recording.discard = true;
    clearInterval(recording.timer); clearTimeout(recording.restartTimer);
    try { if (recording.recorder.state !== 'inactive') recording.recorder.stop(); } catch (_) { /* Recorder already stopped. */ }
    try { recording.recognition?.abort(); } catch (_) { /* Recognition already stopped. */ }
    releaseTracks(recording.stream);
    recording.resolveAudio?.(); recording.resolveRecognitionEnd?.();
    if (discard) recording.chunks.length = 0;
  }
  function cancelOnExit(id, callId) {
    try {
      const body = new Blob(['{}'], {type: 'application/json'});
      if (navigator.sendBeacon?.(`${callPath(id, callId)}/cancel`, body)) return;
      void fetch(`${callPath(id, callId)}/cancel`, {method: 'POST', credentials: 'same-origin', keepalive: true, headers: {'Content-Type': 'application/json'}, body: '{}'}).catch(() => {});
    } catch (_) { /* The server also recovers interrupted microphone calls on restart. */ }
  }
  window.addEventListener('beforeunload', event => {
    const recording = state.recording;
    const starting = state.startingCall;
    const unsaved = [...state.callDrafts.values()].some(local => local.phase === 'review' && (local.url || draft(local.transcriptKey).value.trim()));
    if (recording || starting || unsaved) { event.preventDefault(); event.returnValue = ''; }
    if (recording) {
      tearDownCapture(recording); state.recording = null; cancelOnExit(recording.id, recording.callId);
      const local = state.callDrafts.get(callKey(recording.id, recording.callId));
      if (local) { local.phase = 'review'; local.note = 'The microphone was stopped during the exit attempt. Check the server status before resuming.'; }
      if (state.modal?.kind === 'call') renderCallTab();
      void reconcile(recording.id);
    }
    if (starting) { starting.cancelRequested = true; if (starting.callId) cancelOnExit(starting.id, starting.callId); }
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(state.pollTimer);
    if (state.recording) { cancelOnExit(state.recording.id, state.recording.callId); tearDownCapture(state.recording); state.recording = null; }
    state.callDrafts.forEach(local => { if (local.url) URL.revokeObjectURL(local.url); local.url = ''; local.blob = null; });
  });

  async function handleAction(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (button.disabled) return;
    if (action === 'return-list') await navigate(listView());
    else if (action === 'rex') await navigate('rex');
    else if (action === 'retry-statistics') await loadStatistics(true);
    else if (action === 'open-rex') await navigate('rex-detail', id);
    else if (action === 'incidents') await navigate('incidents');
    else if (action === 'open-incident') await navigate('detail', id);
    else if (action === 'reload-config' || action === 'refresh-data') await load(true);
    else if (action === 'dismiss-toast') document.getElementById('toast-region').replaceChildren();
    else if (action === 'summary') await incidentAI(id, 'summary');
    else if (action === 'retry-impact') await incidentAI(id, 'impact');
    else if (action === 'suggestion') {
      const key = chatKey(id); setDraft(key, button.dataset.question);
      const field = document.getElementById('incident-question');
      if (field) { field.value = draft(key).value; field.focus(); }
    } else if (action === 'retry-chat') {
      const [, incidentId, callId] = button.dataset.chatKey.split('|');
      await sendChat(incidentId, callId, true);
    } else await handleDialogAction(button);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]') || event.target.closest('[data-incident-row]')?.querySelector('[data-action="open-incident"]');
    if (button) { event.preventDefault(); void handleAction(button).catch(error => toast(error.message || 'Action failed.', true)); }
    const brand = event.target.closest('.brand');
    if (brand) { event.preventDefault(); void navigate('incidents'); }
  });
  document.addEventListener('input', event => {
    const key = event.target.dataset.draft;
    if (!key) return;
    setDraft(key, event.target.value);
    if (key === 'overview-search' || key === 'rex-search') updateOverview();
    if (key.startsWith('transcript|')) syncTranscriptDraft(key);
  });
  document.addEventListener('change', event => {
    if (event.target.dataset.draft === 'rex-period') {
      setDraft('rex-period', event.target.value);
      const custom = event.target.value === 'custom';
      document.getElementById('period-dates').hidden = !custom;
      if (!custom) applyPresetPeriod(Number(event.target.value));
      return;
    }
    if (event.target.dataset.rexAction) {
      void updateActionStatus(event.target.dataset.id, event.target.dataset.rexAction, event.target.value).catch(error => toast(error.message, true));
      return;
    }
    const key = event.target.dataset.draft;
    if (key === 'overview-severity' || key === 'rex-severity') { setDraft(key, event.target.value); updateOverview(); }
    if (event.target.matches('[data-related-id]')) syncRelatedDraft();
    if (event.target.name === 'call-mode') syncNewCallMode();
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    if (form.dataset.form === 'rex-period') { applyCustomPeriod(); return; }
    const work = form.dataset.form === 'message' ? sendMessage(form.dataset.incident) :
      form.dataset.form === 'chat' ? sendChat(form.dataset.incident, form.dataset.call) : handleDialogSubmit(form);
    void Promise.resolve(work).catch(error => toast(error.message || 'Sending failed.', true));
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target.closest('form')) {
      event.preventDefault(); event.target.closest('form').requestSubmit();
    }
  });
  document.addEventListener('compositionstart', () => { state.composing = true; });
  document.addEventListener('compositionend', () => {
    state.composing = false;
    if (state.refreshPending) { state.refreshPending = false; refreshUI(); }
  });
  window.addEventListener('hashchange', () => {
    if (recordingLocked()) {
      history.replaceState(null, '', viewHash());
      toast('Navigation is locked during recording.', true);
    } else void routeFromHash();
  });
  window.addEventListener('online', () => { void load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && hasBackgroundWork() && !state.polling) { clearTimeout(state.pollTimer); void poll(); } });
  function tick() { setText('clock', formatted(new Date().toISOString())); }
  document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
  tick(); setInterval(tick, 30000);
  void load().then(() => routeFromHash()).catch(error => toast(error.message, true));
})();
