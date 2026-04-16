/* ──────────────────────────────────────────────────────────────────────────
   EC-Streamer — Frontend Application
   Single-file vanilla JS app. Polls /api/status every 3 s.
   ────────────────────────────────────────────────────────────────────────── */

const App = (() => {
  'use strict';

  // ── Shared state ──────────────────────────────────────────────────────────
  let _videos  = [];   // cached video list
  let _lastStatus = {};
  let _tlDrag  = null; // active timeline drag state
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  // Lazily get (or create) the floating drag-time tooltip element
  function _tlTooltip() {
    let el = document.getElementById('tlDragTooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tlDragTooltip';
      el.className = 'tl-drag-tooltip';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }

  // ── Bootstrap modal helpers ───────────────────────────────────────────────
  const _modal = id => bootstrap.Modal.getOrCreateInstance(document.getElementById(id));

  // ── Toast notifications ───────────────────────────────────────────────────
  function toast(msg, type = 'success') {
    const id  = 'toast_' + Date.now();
    const col = type === 'success' ? 'bg-success' : type === 'error' ? 'bg-danger' : 'bg-warning text-dark';
    const el  = document.createElement('div');
    el.innerHTML = `
      <div id="${id}" class="toast align-items-center text-white ${col} border-0" role="alert">
        <div class="d-flex">
          <div class="toast-body">${msg}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto"
            data-bs-dismiss="toast"></button>
        </div>
      </div>`;
    document.getElementById('toastContainer').appendChild(el.firstElementChild);
    const t = new bootstrap.Toast(document.getElementById(id), { delay: 3500 });
    t.show();
    document.getElementById(id).addEventListener('hidden.bs.toast', () =>
      document.getElementById(id)?.remove());
  }

  // ── API helpers ───────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const d = await r.json(); msg = d.detail || JSON.stringify(d); } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  // ── Tab navigation ────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('#mainTabs .nav-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('#mainTabs .nav-link').forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        const tab = a.dataset.tab;
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('d-none'));
        document.getElementById('tab-' + tab).classList.remove('d-none');
        if (tab === 'library')  library.load();
        if (tab === 'schedule') schedule.load();
        if (tab === 'settings') settings.load();
        if (tab === 'overlays') { bumpers.load(); lowerThirds.load(); }
      });
    });
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function fmtDuration(sec) {
    if (!sec || sec <= 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${pad(s)}s`;
  }
  function fmtSize(bytes) {
    if (!bytes) return '—';
    if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    return (bytes / 1e3).toFixed(0) + ' KB';
  }
  function fmtUptime(isoStart) {
    if (!isoStart) return '—';
    const sec = Math.floor((Date.now() - new Date(isoStart).getTime()) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(t) { return t || '—'; }

  // ── Stream controls ───────────────────────────────────────────────────────
  const stream = {
    async start() {
      try { const r = await api('POST', '/api/stream/start'); toast(r.status); status.poll(); }
      catch (e) { toast(e.message, 'error'); }
    },
    async stop() {
      try { const r = await api('POST', '/api/stream/stop'); toast(r.status); status.poll(); }
      catch (e) { toast(e.message, 'error'); }
    },
    async restart() {
      try { const r = await api('POST', '/api/stream/restart'); toast(r.status); status.poll(); }
      catch (e) { toast(e.message, 'error'); }
    },
    async clearOverride() {
      try { await api('POST', '/api/stream/clear-override'); toast('Override cleared'); status.poll(); }
      catch (e) { toast(e.message, 'error'); }
    },
  };

  // ── Status polling ────────────────────────────────────────────────────────
  const status = {
    _timer: null,
    start() { this.poll(); this._timer = setInterval(() => this.poll(), 3000); },
    async poll() {
      try {
        const s = await api('GET', '/api/status');
        _lastStatus = s;
        this.render(s);
      } catch {}
    },
    render(s) {
      const running = s.running && s.process_alive;
      // Navbar badge
      const badge = document.getElementById('navStatus');
      const dot   = badge.querySelector('.status-dot');
      if (running) {
        badge.className = 'badge bg-danger fs-6 px-3 py-2';
        dot.classList.add('live');
        badge.innerHTML = `<span class="status-dot live me-1"></span>LIVE`;
      } else if (s.running) {
        badge.className = 'badge bg-warning text-dark fs-6 px-3 py-2';
        badge.innerHTML = `<span class="status-dot me-1" style="background:#ffc107"></span>STARTING`;
      } else {
        badge.className = 'badge bg-secondary fs-6 px-3 py-2';
        badge.innerHTML = `<span class="status-dot me-1"></span>OFFLINE`;
      }

      // Uptime
      const uptime = fmtUptime(s.started_at);
      document.getElementById('navUptime').textContent = s.running ? uptime : '';

      // Controls
      document.getElementById('btnStart').disabled   = s.running;
      document.getElementById('btnStop').disabled    = !s.running;
      document.getElementById('btnRestart').disabled = !s.running;
      document.getElementById('btnClearOverride')
        .classList.toggle('d-none', !s.override_active);

      // Now Playing card
      const item = s.current_item;
      const icon = document.getElementById('playingIcon');
      if (item && item.type === 'video') {
        icon.innerHTML = '<i class="bi bi-play-circle-fill playing-glow"></i>';
        document.getElementById('playingBadge').className = 'badge ms-auto bg-danger';
        document.getElementById('playingBadge').textContent = s.override_active ? 'OVERRIDE' : 'PLAYING';
        document.getElementById('playingTitle').textContent = item.title || '—';
        document.getElementById('playingSubtitle').textContent =
          item.started_at ? 'Started at ' + new Date(item.started_at).toLocaleTimeString() : '';
        document.getElementById('playingFile').textContent = item.filename || '';
      } else if (item && item.type === 'filler') {
        icon.innerHTML = '<i class="bi bi-pause-circle text-warning"></i>';
        document.getElementById('playingBadge').className = 'badge ms-auto bg-warning text-dark';
        document.getElementById('playingBadge').textContent = 'FILLER';
        document.getElementById('playingTitle').textContent = 'Standby / Filler';
        document.getElementById('playingSubtitle').textContent = 'Streaming placeholder content';
        document.getElementById('playingFile').textContent = '';
      } else {
        icon.innerHTML = '<i class="bi bi-stop-circle text-secondary"></i>';
        document.getElementById('playingBadge').className = 'badge ms-auto bg-secondary';
        document.getElementById('playingBadge').textContent = 'IDLE';
        document.getElementById('playingTitle').textContent = '—';
        document.getElementById('playingSubtitle').textContent = 'Stream not running';
        document.getElementById('playingFile').textContent = '';
      }

      // Stats row
      document.getElementById('statStatus').textContent   = running ? '🟢 Live' : (s.running ? '🟡 Starting' : '🔴 Off');
      document.getElementById('statStarted').textContent  = s.started_at ? new Date(s.started_at).toLocaleTimeString() : '—';
      document.getElementById('statOverride').textContent = s.override_active ? 'Active' : 'None';
      document.getElementById('statUptime').textContent   = s.running ? uptime : '—';

      // Logs
      this.renderLogs(s.logs || []);

      // Next scheduled
      this.renderNextScheduled();
    },
    renderLogs(logs) {
      const viewer = document.getElementById('logViewer');
      const atBottom = viewer.scrollHeight - viewer.scrollTop <= viewer.clientHeight + 20;
      viewer.innerHTML = logs.map(l => {
        const msg   = l.message || '';
        let cls = '';
        if (/error/i.test(msg))   cls = 'log-error';
        else if (/warn/i.test(msg)) cls = 'log-warn';
        return `<div><span class="log-time">${l.time}</span><span class="${cls}">${escHtml(msg)}</span></div>`;
      }).join('');
      if (atBottom) viewer.scrollTop = viewer.scrollHeight;
    },
    async renderNextScheduled() {
      try {
        const items = await api('GET', '/api/schedule');
        const enabled = items.filter(i => i.enabled);
        const now  = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        const today  = now.getDay(); // 0=Sun JS → convert to 0=Mon
        const jsToMon = (today + 6) % 7;

        // Find the soonest upcoming item today/next-occurrence
        let best = null, bestDiff = Infinity;
        for (const item of enabled) {
          const [h, m] = item.start_time.split(':').map(Number);
          const itemMins = h * 60 + m;
          let diff = itemMins - nowMins;

          if (item.recurrence === 'once') {
            if (!item.date) continue;
            const d = new Date(item.date + 'T00:00:00');
            const dayDiff = Math.round((d - new Date(now.toDateString())) / 86400000);
            if (dayDiff < 0) continue;
            diff += dayDiff * 1440;
          } else if (item.recurrence === 'weekly') {
            const days = (item.days_of_week || '').split(',').map(Number).filter(n => !isNaN(n));
            let minDayDiff = Infinity;
            for (const d of days) {
              let dd = (d - jsToMon + 7) % 7;
              if (dd === 0 && diff < 0) dd = 7;
              if (dd < minDayDiff) minDayDiff = dd;
            }
            if (minDayDiff === Infinity) continue;
            diff += minDayDiff * 1440;
          } else if (item.recurrence === 'daily') {
            if (diff < 0) diff += 1440;
          }

          if (diff >= 0 && diff < bestDiff) { bestDiff = diff; best = item; }
        }

        const card = document.getElementById('nextScheduledCard');
        if (best) {
          const hh = Math.floor(bestDiff / 60), mm = bestDiff % 60;
          const inStr = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
          card.innerHTML = `
            <div class="fw-semibold">${escHtml(best.video_title)}</div>
            <div class="small text-secondary">${best.start_time} · ${best.recurrence}</div>
            <div class="small text-info mt-1">In ~ ${inStr}</div>`;
        } else {
          card.innerHTML = '<div class="text-secondary small">No upcoming schedule</div>';
        }
      } catch {}
    },
  };

  // ── Library ───────────────────────────────────────────────────────────────
  const library = {
    _file: null,
    async load() {
      try {
        _videos = await api('GET', '/api/videos');
        this.render();
      } catch (e) { toast('Failed to load library: ' + e.message, 'error'); }
    },
    render() {
      const tbody = document.getElementById('libraryBody');
      document.getElementById('libraryEmpty').classList.toggle('d-none', _videos.length > 0);
      document.getElementById('libraryTable').classList.toggle('d-none', _videos.length === 0);
      tbody.innerHTML = _videos.map(v => `
        <tr>
          <td class="text-secondary">${v.id}</td>
          <td>
            <div class="fw-semibold">${escHtml(v.title)}</div>
            ${v.title !== v.filename ? `<div class="text-secondary small font-monospace">${escHtml(v.filename)}</div>` : ''}
          </td>
          <td class="text-secondary small font-monospace">${escHtml(v.filename)}</td>
          <td>${fmtDuration(v.duration)}</td>
          <td>${fmtSize(v.size)}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-success me-1" title="Play Now"
              onclick="App.library.playNow(${v.id})">
              <i class="bi bi-play-fill"></i> Play Now</button>
            <button class="btn btn-sm btn-outline-secondary me-1" title="Edit"
              onclick="App.library.openEdit(${v.id})">
              <i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-danger" title="Delete"
              onclick="App.library.confirmDelete(${v.id}, '${escAttr(v.title)}')">
              <i class="bi bi-trash"></i></button>
          </td>
        </tr>`).join('');
    },
    async playNow(id) {
      try {
        const r = await api('POST', `/api/stream/play-now/${id}`);
        toast(`Playing: ${r.title}`);
        status.poll();
      } catch (e) { toast(e.message, 'error'); }
    },
    openUpload() {
      this._file = null;
      document.getElementById('uploadTitle').value = '';
      document.getElementById('uploadFileInfo').classList.add('d-none');
      document.getElementById('uploadProgress').classList.add('d-none');
      document.getElementById('uploadZone').classList.remove('drag-over');
      document.getElementById('fileInput').value = '';
      _modal('uploadModal').show();
    },
    dragOver(e) { e.preventDefault(); document.getElementById('uploadZone').classList.add('drag-over'); },
    dragLeave()  { document.getElementById('uploadZone').classList.remove('drag-over'); },
    drop(e) {
      e.preventDefault();
      document.getElementById('uploadZone').classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) this._setFile(f);
    },
    fileSelected(e) { if (e.target.files[0]) this._setFile(e.target.files[0]); },
    _setFile(f) {
      this._file = f;
      document.getElementById('uploadFileName').textContent = f.name;
      document.getElementById('uploadFileSize').textContent = fmtSize(f.size);
      document.getElementById('uploadFileInfo').classList.remove('d-none');
      if (!document.getElementById('uploadTitle').value)
        document.getElementById('uploadTitle').value = f.name.replace(/\.[^.]+$/, '');
    },
    async upload() {
      if (!this._file) { toast('Select a file first', 'warning'); return; }
      const fd = new FormData();
      fd.append('file', this._file);
      const title = document.getElementById('uploadTitle').value.trim();
      if (title) fd.append('title', title);

      document.getElementById('uploadProgress').classList.remove('d-none');
      document.getElementById('btnUpload').disabled = true;
      const bar  = document.getElementById('uploadProgressBar');
      const text = document.getElementById('uploadProgressText');

      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/videos/upload');
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
              const pct = Math.round(e.loaded / e.total * 100);
              bar.style.width  = pct + '%';
              text.textContent = `${pct}% — ${fmtSize(e.loaded)} / ${fmtSize(e.total)}`;
            }
          };
          xhr.onload  = () => xhr.status < 400 ? resolve() : reject(new Error('Upload failed: ' + xhr.status));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(fd);
        });
        toast('Upload complete!');
        _modal('uploadModal').hide();
        this.load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        document.getElementById('btnUpload').disabled = false;
        bar.style.width = '0%';
      }
    },
    openEdit(id) {
      const v = _videos.find(x => x.id === id);
      if (!v) return;
      document.getElementById('editVideoId').value    = id;
      document.getElementById('editVideoTitle').value = v.title;
      _modal('editVideoModal').show();
    },
    async saveEdit() {
      const id    = parseInt(document.getElementById('editVideoId').value);
      const title = document.getElementById('editVideoTitle').value.trim();
      try {
        await api('PUT', `/api/videos/${id}`, { title });
        toast('Saved');
        _modal('editVideoModal').hide();
        this.load();
      } catch (e) { toast(e.message, 'error'); }
    },
    confirmDelete(id, name) {
      document.getElementById('deleteModalBody').textContent = `Delete "${name}"? This will also remove it from the schedule.`;
      const btn = document.getElementById('btnConfirmDelete');
      btn.onclick = async () => {
        try {
          await api('DELETE', `/api/videos/${id}`);
          toast('Deleted');
          _modal('deleteModal').hide();
          this.load();
        } catch (e) { toast(e.message, 'error'); }
      };
      _modal('deleteModal').show();
    },
  };

  // ── Schedule ──────────────────────────────────────────────────────────────
  const schedule = {
    _items: [],
    async load() {
      try {
        this._items = await api('GET', '/api/schedule');
        const v = localStorage.getItem('scheduleView') || 'table';
        if (v === 'timeline') this.renderTimeline();
        else this.render();
      } catch (e) { toast('Failed to load schedule: ' + e.message, 'error'); }
    },
    render() {
      const tbody = document.getElementById('scheduleBody');
      document.getElementById('scheduleEmpty').classList.toggle('d-none', this._items.length > 0);
      document.getElementById('scheduleTable').classList.toggle('d-none', this._items.length === 0);
      tbody.innerHTML = this._items.map(item => {
        let when = '';
        if (item.recurrence === 'once')    when = item.date || '—';
        else if (item.recurrence === 'daily')  when = 'Every day';
        else if (item.recurrence === 'weekly') {
          const days = (item.days_of_week || '').split(',').map(Number).filter(n => !isNaN(n));
          when = days.map(d => DAYS[d]).join(', ') || '—';
        }
        const badge = item.recurrence === 'once'   ? 'bg-secondary' :
                      item.recurrence === 'daily'  ? 'bg-info text-dark' : 'bg-primary';
        return `
          <tr class="${item.enabled ? '' : 'opacity-50'}">
            <td class="fw-bold">${item.start_time}</td>
            <td>
              <span class="badge ${badge} me-1">${item.recurrence}</span>
              ${escHtml(when)}
            </td>
            <td>${escHtml(item.video_title)}</td>
            <td>${fmtDuration(item.video_duration)}</td>
            <td>${item.priority}</td>
            <td>
              <div class="form-check form-switch mb-0">
                <input class="form-check-input" type="checkbox" ${item.enabled ? 'checked' : ''}
                  onchange="App.schedule.toggle(${item.id}, this.checked)" />
              </div>
            </td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary me-1" onclick="App.schedule.openEdit(${item.id})">
                <i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-danger"
                onclick="App.schedule.confirmDelete(${item.id}, '${escAttr(item.video_title)}')">
                <i class="bi bi-trash"></i></button>
            </td>
          </tr>`;
      }).join('');
    },
    _populateVideoSelect() {
      const sel = document.getElementById('schedVideo');
      sel.innerHTML = _videos.length
        ? _videos.map(v => `<option value="${v.id}">${escHtml(v.title)}</option>`).join('')
        : '<option disabled>No videos in library</option>';
    },
    async _populateBumperSelects() {
      try {
        const bList = await api('GET', '/api/bumpers');
        const none1 = '<option value="">None (use global if enabled)</option>';
        const none2 = '<option value="">None</option>';
        const opts  = bList.map(b =>
          `<option value="${b.id}">${escHtml(b.title)} (${fmtDuration(b.duration)})</option>`
        ).join('');
        document.getElementById('schedBumperPre').innerHTML  = none1 + opts;
        document.getElementById('schedBumperPost').innerHTML = none2 + opts;
      } catch {}
    },
    async openAdd() {
      try { _videos = await api('GET', '/api/videos'); } catch {}
      if (!_videos.length) { toast('Upload a video first', 'warning'); return; }
      document.getElementById('schedItemId').value = '';
      document.getElementById('scheduleModalTitle').innerHTML =
        '<i class="bi bi-calendar-plus me-2"></i>Add Schedule Item';
      this._populateVideoSelect();
      document.getElementById('schedTime').value      = '12:00';
      document.getElementById('schedRecurrence').value = 'once';
      document.getElementById('schedDate').value      = new Date().toISOString().split('T')[0];
      document.getElementById('schedTitle').value     = '';
      document.getElementById('schedPriority').value  = '0';
      document.getElementById('schedEnabled').checked = true;
      document.querySelectorAll('.sched-day').forEach(c => c.checked = false);
      this.onRecurrenceChange();
      await this._populateBumperSelects();
      document.getElementById('schedBumperPre').value  = '';
      document.getElementById('schedBumperPost').value = '';
      _modal('scheduleModal').show();
    },
    openEdit(id) {
      const item = this._items.find(x => x.id === id);
      if (!item) return;
      document.getElementById('schedItemId').value = id;
      document.getElementById('scheduleModalTitle').innerHTML =
        '<i class="bi bi-calendar-event me-2"></i>Edit Schedule Item';
      if (!_videos.length) api('GET', '/api/videos').then(v => { _videos = v; this._populateVideoSelect(); });
      else this._populateVideoSelect();
      document.getElementById('schedVideo').value       = item.video_id;
      document.getElementById('schedTime').value        = item.start_time;
      document.getElementById('schedRecurrence').value  = item.recurrence;
      document.getElementById('schedDate').value        = item.date || '';
      document.getElementById('schedTitle').value       = item.title || '';
      document.getElementById('schedPriority').value    = item.priority;
      document.getElementById('schedEnabled').checked   = item.enabled;
      const days = (item.days_of_week || '').split(',').map(Number);
      document.querySelectorAll('.sched-day').forEach(c => c.checked = days.includes(parseInt(c.value)));
      this.onRecurrenceChange();
      this._populateBumperSelects().then(() => {
        document.getElementById('schedBumperPre').value  = item.bumper_pre_id  || '';
        document.getElementById('schedBumperPost').value = item.bumper_post_id || '';
      });
      _modal('scheduleModal').show();
    },
    onRecurrenceChange() {
      const rec = document.getElementById('schedRecurrence').value;
      document.getElementById('schedDateGroup').style.display =
        rec === 'once' ? '' : 'none';
      document.getElementById('schedDaysGroup').style.display =
        rec === 'weekly' ? '' : 'none';
    },
    async save() {
      const id       = document.getElementById('schedItemId').value;
      const rec      = document.getElementById('schedRecurrence').value;
      const days     = [...document.querySelectorAll('.sched-day:checked')].map(c => c.value).join(',');
      const bPre     = parseInt(document.getElementById('schedBumperPre').value)  || null;
      const bPost    = parseInt(document.getElementById('schedBumperPost').value) || null;
      const payload  = {
        video_id:     parseInt(document.getElementById('schedVideo').value),
        start_time:   document.getElementById('schedTime').value,
        recurrence:   rec,
        date:         rec === 'once' ? document.getElementById('schedDate').value : null,
        days_of_week: rec === 'weekly' ? days : null,
        title:        document.getElementById('schedTitle').value.trim() || null,
        priority:     parseInt(document.getElementById('schedPriority').value) || 0,
        enabled:      document.getElementById('schedEnabled').checked,
        bumper_pre_id:  bPre,
        bumper_post_id: bPost,
      };
      try {
        if (id) await api('PUT',  `/api/schedule/${id}`, payload);
        else    await api('POST', '/api/schedule', payload);
        toast('Schedule saved');
        _modal('scheduleModal').hide();
        this.load();
      } catch (e) { toast(e.message, 'error'); }
    },
    async toggle(id, enabled) {
      try { await api('PUT', `/api/schedule/${id}`, { enabled }); this.load(); }
      catch (e) { toast(e.message, 'error'); this.load(); }
    },
    confirmDelete(id, name) {
      document.getElementById('deleteModalBody').textContent = `Remove schedule for "${name}"?`;
      document.getElementById('btnConfirmDelete').onclick = async () => {
        try {
          await api('DELETE', `/api/schedule/${id}`);
          toast('Removed');
          _modal('deleteModal').hide();
          this.load();
        } catch (e) { toast(e.message, 'error'); }
      };
      _modal('deleteModal').show();
    },

    setView(v) {
      localStorage.setItem('scheduleView', v);
      document.getElementById('btnViewTable').classList.toggle('active', v === 'table');
      document.getElementById('btnViewTimeline').classList.toggle('active', v === 'timeline');
      document.getElementById('scheduleTableWrap').classList.toggle('d-none', v !== 'table');
      document.getElementById('timelineView').classList.toggle('d-none', v !== 'timeline');
      if (v !== 'table') document.getElementById('scheduleEmpty').classList.add('d-none');
      if (v === 'timeline') this.renderTimeline();
      else this.render();
    },

    renderTimeline() {
      const el = document.getElementById('timelineView');
      if (!el) return;
      if (!this._items.length) {
        el.innerHTML = '<div class="text-center text-secondary py-5"><i class="bi bi-calendar-x display-4 d-block mb-2"></i>No schedule items yet.</div>';
        return;
      }
      const DAY_LABELS = ['All Days', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const COLORS     = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
                          '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];
      const now        = new Date();
      const todayDow   = (now.getDay() + 6) % 7;  // 0 = Monday
      const nowMins    = now.getHours() * 60 + now.getMinutes();
      const pct        = m => (m / 1440 * 100).toFixed(3) + '%';

      let rulerHtml = '';
      for (let h = 0; h <= 24; h++) {
        const lbl = (h % 3 === 0) ? `<span>${pad(h)}:00</span>` : '';
        rulerHtml += `<div class="tl-ruler-mark" style="left:${pct(h * 60)}">${lbl}</div>`;
      }
      let html = `
        <div class="tl-ruler-row">
          <div class="tl-side-label"></div>
          <div class="tl-ruler">${rulerHtml}</div>
        </div>`;

      for (let row = 0; row < 8; row++) {
        const label      = DAY_LABELS[row];
        const isDailyRow = row === 0;
        const rowDow     = row - 1;  // 0 = Mon when row = 1
        const isToday    = !isDailyRow && rowDow === todayDow;
        let itemsHtml = '';

        for (const item of this._items) {
          if (!item.enabled) continue;
          let show = false;
          if (isDailyRow && item.recurrence === 'daily') show = true;
          else if (!isDailyRow) {
            if (item.recurrence === 'weekly') {
              const dd = (item.days_of_week || '').split(',').map(Number);
              if (dd.includes(rowDow)) show = true;
            } else if (item.recurrence === 'once' && item.date) {
              const dt  = new Date(item.date + 'T12:00:00');
              const dow = (dt.getDay() + 6) % 7;
              if (dow === rowDow) show = true;
            }
          }
          if (!show) continue;

          const [hh, mm] = item.start_time.split(':').map(Number);
          const startMin = hh * 60 + mm;
          const durMin   = Math.max(5, Math.ceil((item.video_duration || 300) / 60));
          const width    = Math.min(durMin, 1440 - startMin);
          if (width <= 0) continue;

          const col   = COLORS[item.video_id % COLORS.length];
          const title = escHtml(item.title || item.video_title || '?');
          const hasBumper = item.bumper_pre_id ? ' tl-has-bumper' : '';
          itemsHtml += `
            <div class="tl-item${hasBumper}"
              draggable="true"
              style="left:${pct(startMin)};width:${pct(width)};background:${col}"
              title="${title} @ ${item.start_time} (${fmtDuration(item.video_duration)})"
              ondragstart="App.schedule.tlDragStart(event,${item.id},${startMin},${rowDow})"
              ondragend="App.schedule.tlDragEnd(event)"
              onclick="App.schedule.openEdit(${item.id})">
              <span class="tl-item-label">${title}</span>
            </div>`;
        }

        const nowLine = (isDailyRow || isToday)
          ? `<div class="tl-now-line" style="left:${pct(nowMins)}"></div>` : '';

        html += `
          <div class="tl-row${isToday ? ' tl-today' : ''}">
            <div class="tl-side-label">${label}</div>
            <div class="tl-track"
              data-dow="${isDailyRow ? 'all' : rowDow}"
              ondragover="App.schedule.tlDragOver(event)"
              ondragleave="App.schedule.tlDragLeave(event)"
              ondrop="App.schedule.tlDrop(event)">${nowLine}${itemsHtml}</div>
          </div>`;
      }
      el.innerHTML = html;
    },

    // ── Timeline drag-and-drop ───────────────────────────────────────────
    tlDragStart(e, id, startMin, rowDow) {
      _tlDrag = { id, startMin, rowDow };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
      e.currentTarget.classList.add('is-dragging');
      e.stopPropagation();
    },
    tlDragEnd(e) {
      e.currentTarget.classList.remove('is-dragging');
      _tlTooltip().style.display = 'none';
    },
    tlDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drag-over');
      // Compute snapped time and show tooltip next to cursor
      const track  = e.currentTarget;
      const rect   = track.getBoundingClientRect();
      const relX   = Math.max(0, e.clientX - rect.left);
      const snapMin = Math.min(1435, Math.round((relX / rect.width) * 1440 / 15) * 15);
      const label   = pad(Math.floor(snapMin / 60)) + ':' + pad(snapMin % 60);
      // Vertical drop-position indicator via CSS custom property
      const snapPct = (snapMin / 1440 * 100).toFixed(3) + '%';
      track.style.setProperty('--tl-drop-x', snapPct);
      const tip = _tlTooltip();
      tip.textContent = label;
      tip.style.display = 'block';
      // Position just above & right of cursor, kept inside viewport
      const tipW = tip.offsetWidth || 60;
      let tx = e.clientX + 14;
      if (tx + tipW > window.innerWidth - 8) tx = e.clientX - tipW - 10;
      tip.style.left = tx + 'px';
      tip.style.top  = (e.clientY - 32) + 'px';
    },
    tlDragLeave(e) {
      e.currentTarget.classList.remove('drag-over');
      // Only hide tooltip if we actually left all tracks
      if (!e.relatedTarget || !e.relatedTarget.closest('.tl-track')) {
        _tlTooltip().style.display = 'none';
      }
    },
    async tlDrop(e) {
      e.preventDefault();
      const track = e.currentTarget;
      track.classList.remove('drag-over');
      if (!_tlDrag) return;
      const rect   = track.getBoundingClientRect();
      const relX   = Math.max(0, e.clientX - rect.left);
      const newMin = Math.min(1435, Math.round((relX / rect.width) * 1440 / 15) * 15);
      const newTime = pad(Math.floor(newMin / 60)) + ':' + pad(newMin % 60);
      const targetDow = track.dataset.dow;
      const item = this._items.find(x => x.id === _tlDrag.id);
      if (!item) { _tlDrag = null; return; }
      const payload = { start_time: newTime };
      if (targetDow !== 'all' && item.recurrence === 'weekly') {
        const targetDowInt = parseInt(targetDow);
        if (!isNaN(targetDowInt)) {
          const days = (item.days_of_week || '').split(',').map(Number).filter(n => !isNaN(n));
          const newDays = days.map(d => d === _tlDrag.rowDow ? targetDowInt : d);
          payload.days_of_week = [...new Set(newDays)].sort().join(',');
        }
      }
      const savedId = _tlDrag.id;
      _tlDrag = null;
      _tlTooltip().style.display = 'none';
      try {
        await api('PUT', `/api/schedule/${savedId}`, payload);
        toast(`Moved to ${newTime}`);
        await this.load();
      } catch (err) { toast(err.message, 'error'); }
    },
  };

  // ── Bumpers ────────────────────────────────────────────────────────────────
  const bumpers = {
    _items: [],
    _file:  null,
    async load() {
      try {
        this._items = await api('GET', '/api/bumpers');
        this.render();
      } catch (e) { toast('Failed to load bumpers: ' + e.message, 'error'); }
    },
    render() {
      const tbody = document.getElementById('bumpersBody');
      if (!tbody) return;
      document.getElementById('bumpersEmpty').classList.toggle('d-none', this._items.length > 0);
      document.getElementById('bumpersTable').classList.toggle('d-none', this._items.length === 0);
      tbody.innerHTML = this._items.map(b => `
        <tr>
          <td class="text-secondary">${b.id}</td>
          <td class="fw-semibold">${escHtml(b.title)}</td>
          <td>${fmtDuration(b.duration)}</td>
          <td>${fmtSize(b.size)}</td>
          <td class="text-center">
            <div class="form-check form-switch mb-0 d-flex justify-content-center">
              <input class="form-check-input" type="checkbox" ${b.enabled ? 'checked' : ''}
                onchange="App.bumpers.toggle(${b.id}, this.checked)" />
            </div>
          </td>
          <td class="text-end">
            <button class="btn btn-sm btn-outline-danger"
              onclick="App.bumpers.confirmDelete(${b.id}, '${escAttr(b.title)}')">
              <i class="bi bi-trash"></i></button>
          </td>
        </tr>`).join('');
    },
    openUpload() {
      this._file = null;
      document.getElementById('bumperTitle').value = '';
      document.getElementById('bumperFileInfo').classList.add('d-none');
      document.getElementById('bumperUploadProgress').classList.add('d-none');
      document.getElementById('bumperDropZone').classList.remove('drag-over');
      document.getElementById('bumperFileInput').value = '';
      _modal('bumperUploadModal').show();
    },
    dragOver(e)  { e.preventDefault(); document.getElementById('bumperDropZone').classList.add('drag-over'); },
    dragLeave()  { document.getElementById('bumperDropZone').classList.remove('drag-over'); },
    drop(e) {
      e.preventDefault();
      document.getElementById('bumperDropZone').classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) this._setFile(f);
    },
    fileSelected(e) { if (e.target.files[0]) this._setFile(e.target.files[0]); },
    _setFile(f) {
      this._file = f;
      document.getElementById('bumperFileName').textContent = f.name;
      document.getElementById('bumperFileSize').textContent = fmtSize(f.size);
      document.getElementById('bumperFileInfo').classList.remove('d-none');
      if (!document.getElementById('bumperTitle').value)
        document.getElementById('bumperTitle').value = f.name.replace(/\.[^.]+$/, '');
    },
    async upload() {
      if (!this._file) { toast('Select a file first', 'warning'); return; }
      const fd = new FormData();
      fd.append('file', this._file);
      const title = document.getElementById('bumperTitle').value.trim();
      if (title) fd.append('title', title);
      document.getElementById('bumperUploadProgress').classList.remove('d-none');
      document.getElementById('btnBumperUpload').disabled = true;
      const bar  = document.getElementById('bumperProgressBar');
      const text = document.getElementById('bumperProgressText');
      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/bumpers/upload');
          xhr.upload.onprogress = ev => {
            if (ev.lengthComputable) {
              const pct = Math.round(ev.loaded / ev.total * 100);
              bar.style.width  = pct + '%';
              text.textContent = `${pct}%`;
            }
          };
          xhr.onload  = () => xhr.status < 400 ? resolve() : reject(new Error('Upload failed'));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(fd);
        });
        toast('Bumper uploaded!');
        _modal('bumperUploadModal').hide();
        this.load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        document.getElementById('btnBumperUpload').disabled = false;
        bar.style.width = '0%';
      }
    },
    async toggle(id, enabled) {
      try { await api('PUT', `/api/bumpers/${id}`, { enabled }); this.load(); }
      catch (e) { toast(e.message, 'error'); this.load(); }
    },
    confirmDelete(id, name) {
      document.getElementById('deleteModalBody').textContent = `Delete bumper "${name}"?`;
      document.getElementById('btnConfirmDelete').onclick = async () => {
        try {
          await api('DELETE', `/api/bumpers/${id}`);
          toast('Deleted');
          _modal('deleteModal').hide();
          this.load();
        } catch (e) { toast(e.message, 'error'); }
      };
      _modal('deleteModal').show();
    },
  };

  // ── Lower thirds ───────────────────────────────────────────────────────────
  const lowerThirds = {
    _items: [],
    async load() {
      try {
        this._items = await api('GET', '/api/lower-thirds');
        this.render();
      } catch (e) { toast('Failed to load lower thirds: ' + e.message, 'error'); }
    },
    render() {
      const tbody = document.getElementById('ltBody');
      if (!tbody) return;
      document.getElementById('ltEmpty').classList.toggle('d-none', this._items.length > 0);
      document.getElementById('ltTable').classList.toggle('d-none', this._items.length === 0);
      tbody.innerHTML = this._items.map(lt => {
        const timing = `${lt.trigger_offset}s – ${lt.trigger_offset + lt.duration}s`;
        const scope  = lt.schedule_item_id ? `Slot #${lt.schedule_item_id}` : 'Global';
        return `
          <tr class="${lt.enabled ? '' : 'opacity-50'}">
            <td class="text-secondary">${lt.id}</td>
            <td class="fw-semibold">${escHtml(lt.label || '—')}</td>
            <td>
              <div>${escHtml(lt.line1 || '')}</div>
              ${lt.line2 ? `<div class="text-secondary small">${escHtml(lt.line2)}</div>` : ''}
            </td>
            <td class="small text-secondary">${lt.position || ''}</td>
            <td class="small font-monospace text-secondary">${timing}</td>
            <td><span class="badge ${lt.schedule_item_id ? 'bg-warning text-dark' : 'bg-secondary'}">${scope}</span></td>
            <td class="text-center">
              <div class="form-check form-switch mb-0 d-flex justify-content-center">
                <input class="form-check-input" type="checkbox" ${lt.enabled ? 'checked' : ''}
                  onchange="App.lowerThirds.toggle(${lt.id}, this.checked)" />
              </div>
            </td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary me-1"
                onclick="App.lowerThirds.openEdit(${lt.id})"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-danger"
                onclick="App.lowerThirds.confirmDelete(${lt.id})"><i class="bi bi-trash"></i></button>
            </td>
          </tr>`;
      }).join('');
    },
    async _populateScheduleItems() {
      const sel = document.getElementById('ltScheduleItem');
      if (!sel) return;
      sel.innerHTML = '<option value="">Global (all scheduled videos)</option>';
      try {
        const items = await api('GET', '/api/schedule');
        items.forEach(item => {
          const opt = document.createElement('option');
          opt.value = item.id;
          opt.textContent = `${item.start_time} – ${item.video_title} (${item.recurrence})`;
          sel.appendChild(opt);
        });
      } catch {}
    },
    async openAdd() {
      document.getElementById('ltId').value        = '';
      document.getElementById('ltModalTitle').innerHTML = '<i class="bi bi-fonts me-2"></i>Add Lower Third';
      document.getElementById('ltLabel').value     = '';
      document.getElementById('ltLine1').value     = '';
      document.getElementById('ltLine2').value     = '';
      document.getElementById('ltPosition').value  = 'bottom-left';
      document.getElementById('ltFontSize').value  = '32';
      document.getElementById('ltTextColor').value = '#ffffff';
      document.getElementById('ltBgColor').value   = '#000000';
      document.getElementById('ltBgOpacity').value = '0.6';
      document.getElementById('ltTrigger').value   = '5';
      document.getElementById('ltDuration').value  = '10';
      document.getElementById('ltEnabled').checked = true;
      await this._populateScheduleItems();
      _modal('ltModal').show();
    },
    async openEdit(id) {
      const lt = this._items.find(x => x.id === id);
      if (!lt) return;
      document.getElementById('ltId').value        = id;
      document.getElementById('ltModalTitle').innerHTML = '<i class="bi bi-pencil me-2"></i>Edit Lower Third';
      document.getElementById('ltLabel').value     = lt.label || '';
      document.getElementById('ltLine1').value     = lt.line1 || '';
      document.getElementById('ltLine2').value     = lt.line2 || '';
      document.getElementById('ltPosition').value  = lt.position || 'bottom-left';
      document.getElementById('ltFontSize').value  = lt.font_size || 32;
      document.getElementById('ltTextColor').value = '#' + (lt.text_color || 'ffffff');
      document.getElementById('ltBgColor').value   = '#' + (lt.bg_color || '000000');
      document.getElementById('ltBgOpacity').value = lt.bg_opacity ?? 0.6;
      document.getElementById('ltTrigger').value   = lt.trigger_offset ?? 5;
      document.getElementById('ltDuration').value  = lt.duration ?? 10;
      document.getElementById('ltEnabled').checked = lt.enabled;
      await this._populateScheduleItems();
      document.getElementById('ltScheduleItem').value = lt.schedule_item_id || '';
      _modal('ltModal').show();
    },
    async save() {
      const id = document.getElementById('ltId').value;
      const payload = {
        label:           document.getElementById('ltLabel').value.trim(),
        line1:           document.getElementById('ltLine1').value.trim(),
        line2:           document.getElementById('ltLine2').value.trim(),
        position:        document.getElementById('ltPosition').value,
        font_size:       parseInt(document.getElementById('ltFontSize').value)    || 32,
        text_color:      document.getElementById('ltTextColor').value.replace('#', ''),
        bg_color:        document.getElementById('ltBgColor').value.replace('#', ''),
        bg_opacity:      parseFloat(document.getElementById('ltBgOpacity').value) || 0.6,
        trigger_offset:  parseInt(document.getElementById('ltTrigger').value)     || 0,
        duration:        parseInt(document.getElementById('ltDuration').value)    || 10,
        schedule_item_id: parseInt(document.getElementById('ltScheduleItem').value) || null,
        enabled:         document.getElementById('ltEnabled').checked,
      };
      try {
        if (id) await api('PUT',  `/api/lower-thirds/${id}`, payload);
        else    await api('POST', '/api/lower-thirds', payload);
        toast('Saved');
        _modal('ltModal').hide();
        this.load();
      } catch (e) { toast(e.message, 'error'); }
    },
    async toggle(id, enabled) {
      try { await api('PUT', `/api/lower-thirds/${id}`, { enabled }); this.load(); }
      catch (e) { toast(e.message, 'error'); this.load(); }
    },
    confirmDelete(id) {
      const lt = this._items.find(x => x.id === id);
      document.getElementById('deleteModalBody').textContent =
        `Delete lower third "${(lt && lt.label) || id}"?`;
      document.getElementById('btnConfirmDelete').onclick = async () => {
        try {
          await api('DELETE', `/api/lower-thirds/${id}`);
          toast('Deleted');
          _modal('deleteModal').hide();
          this.load();
        } catch (e) { toast(e.message, 'error'); }
      };
      _modal('deleteModal').show();
    },
  };

  // ── Settings ──────────────────────────────────────────────────────────────
  const settings = {
    async load() {
      try {
        const s = await api('GET', '/api/settings');
        const form = document.getElementById('settingsForm');
        Object.entries(s).forEach(([k, v]) => {
          const el = form.elements[k];
          if (!el) return;
          if (el.type === 'color') el.value = '#' + v.replace('#', '');
          else el.value = v;
        });
        // Sync bumper_enabled checkbox (backed by hidden input)
        const bumperChk = document.getElementById('bumperEnabledCheck');
        if (bumperChk) bumperChk.checked = s.bumper_enabled === 'true';
        this.onFillerTypeChange();
        await this.checkDeps();
      } catch (e) { toast('Failed to load settings: ' + e.message, 'error'); }
    },
    async save(e) {
      e.preventDefault();
      const form = document.getElementById('settingsForm');
      const data = {};
      new FormData(form).forEach((v, k) => {
        // strip leading # from color
        data[k] = k === 'filler_color' ? v.replace('#', '') : v;
      });
      try {
        await api('POST', '/api/settings', data);
        toast('Settings saved');
        await this.checkDeps();
      } catch (err) { toast(err.message, 'error'); }
    },
    onFillerTypeChange() {
      const t = document.getElementById('fillerTypeSelect').value;
      document.getElementById('fillerColorGroup').style.display =
        t === 'color' ? '' : 'none';
    },
    toggleKey() {
      const inp  = document.getElementById('streamKeyInput');
      const icon = document.getElementById('streamKeyEyeIcon');
      inp.type   = inp.type === 'password' ? 'text' : 'password';
      icon.className = inp.type === 'password' ? 'bi bi-eye' : 'bi bi-eye-slash';
    },
    async checkDeps() {
      const body = document.getElementById('depCheckBody');
      body.innerHTML = '<div class="text-secondary small">Checking…</div>';
      try {
        const r = await api('GET', '/api/check');
        body.innerHTML = Object.entries(r).map(([name, info]) => `
          <div class="d-flex align-items-center gap-2 mb-2">
            <i class="bi ${info.available ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'} fs-5"></i>
            <div>
              <span class="fw-semibold">${name}</span>
              <span class="text-secondary small ms-2 font-monospace">${escHtml(info.path)}</span>
              ${!info.available ? `<div class="text-danger small">Not found — install FFmpeg or set the path in settings</div>` : ''}
            </div>
          </div>`).join('');
      } catch (e) {
        body.innerHTML = '<div class="text-danger small">Check failed: ' + escHtml(e.message) + '</div>';
      }
    },
  };

  // ── Log helpers ───────────────────────────────────────────────────────────
  const log = {
    clear() { document.getElementById('logViewer').innerHTML = ''; },
  };

  // ── Stream preview ────────────────────────────────────────────────────────
  const preview = {
    _interval: null,
    start() {
      this._refresh();
      this._interval = setInterval(() => this._refresh(), 3000);
    },
    stop() {
      if (this._interval) { clearInterval(this._interval); this._interval = null; }
    },
    _refresh() {
      const img     = document.getElementById('previewImg');
      const overlay = document.getElementById('previewOverlay');
      if (!img) return;
      const src = '/api/preview.jpg?t=' + Date.now();
      const tmp = new Image();
      tmp.onload  = () => { img.src = src; if (overlay) overlay.style.display = 'none'; };
      tmp.onerror = () => { if (overlay) overlay.style.display = ''; };
      tmp.src = src;
    },
  };

  // ── Security helpers ──────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function escAttr(str) {
    return String(str ?? '').replace(/'/g, "\\'");
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    status.start();
    preview.start();
    // Pre-fetch videos for schedule modal
    try { _videos = await api('GET', '/api/videos'); } catch {}
    // Restore schedule view preference
    const savedView = localStorage.getItem('scheduleView') || 'table';
    if (savedView === 'timeline') {
      document.getElementById('btnViewTable')?.classList.remove('active');
      document.getElementById('btnViewTimeline')?.classList.add('active');
      document.getElementById('scheduleTableWrap')?.classList.add('d-none');
      document.getElementById('timelineView')?.classList.remove('d-none');
    }
  });

  return { stream, status, library, schedule, settings, log, preview, bumpers, lowerThirds };
})();
