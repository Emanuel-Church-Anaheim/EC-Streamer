/* ──────────────────────────────────────────────────────────────────────────
   EC-Streamer — Frontend Application
   Single-file vanilla JS app. Polls /api/status every 3 s.
   ────────────────────────────────────────────────────────────────────────── */

const App = (() => {
  'use strict';

  // ── Shared state ──────────────────────────────────────────────────────────
  let _videos  = [];   // cached video list
  let _bumpersList = []; // cached bumper list (for duration lookup)
  let _lastStatus = {};
  let _tlDrag  = null; // active timeline drag state
  let _tlZoom  = 1;    // timeline zoom level (1 | 2 | 4 | 8)
  let _tlSnap  = 15;   // drag/drop time-grid snap in minutes
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const TL_VIDEO_COLOR = '#4e79a7'; // consistent colour for all video slots

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
        if (tab === 'library')  { libraries.load(); library.load(); }
        if (tab === 'schedule') schedule.load();
        if (tab === 'settings') settings.load();
        if (tab === 'bumpers')  { autoBumper.load(); bumpers.load(); }
        if (tab === 'overlays') lowerThirds.load();
        if (tab === 'restream') restream.load();
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
  // Format raw seconds as H:MM:SS or M:SS
  function _fmtSec(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function fmtLocalTime(hhmm) {
    if (!hhmm) return '—';
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

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
  // ── Folder Libraries ─────────────────────────────────────────────────────
  const libraries = {
    _items: [],
    async load() {
      try {
        this._items = await api('GET', '/api/libraries');
        this.render();
      } catch (e) { toast('Failed to load libraries: ' + e.message, 'error'); }
    },
    render() {
      const tbody = document.getElementById('libsBody');
      if (!tbody) return;
      document.getElementById('libsEmpty').classList.toggle('d-none', this._items.length > 0);
      document.getElementById('libsTableWrap').classList.toggle('d-none', this._items.length === 0);
      tbody.innerHTML = this._items.map(lib => `
        <tr>
          <td class="text-secondary">${lib.id}</td>
          <td class="fw-semibold">${escHtml(lib.name)}</td>
          <td class="small font-monospace text-secondary">${escHtml(lib.folder_path)}</td>
          <td class="text-center">
            <div class="form-check form-switch mb-0 d-flex justify-content-center">
              <input class="form-check-input" type="checkbox" ${lib.auto_scan ? 'checked' : ''}
                onchange="App.libraries.setAutoScan(${lib.id}, this.checked)" />
            </div>
          </td>
          <td class="text-end">
            <button class="btn btn-sm btn-outline-success me-1" title="Scan now"
              onclick="App.libraries.scan(${lib.id}, '${escAttr(lib.name)}')">
              <i class="bi bi-arrow-repeat"></i> Scan</button>
            <button class="btn btn-sm btn-outline-danger" title="Remove library"
              onclick="App.libraries.confirmDelete(${lib.id}, '${escAttr(lib.name)}')">
              <i class="bi bi-trash"></i></button>
          </td>
        </tr>`).join('');
    },
    openAdd() {
      document.getElementById('libId').value        = '';
      document.getElementById('libPath').value      = '';
      document.getElementById('libName').value      = '';
      document.getElementById('libAutoScan').checked = true;
      document.getElementById('libScanResult').classList.add('d-none');
      document.getElementById('libPath').disabled   = false;
      document.getElementById('libModalTitle').innerHTML = '<i class="bi bi-folder-plus me-2"></i>Add Folder Library';
      document.getElementById('btnLibSave').innerHTML = '<i class="bi bi-folder-check me-1"></i>Add &amp; Scan';
      _modal('libModal').show();
    },
    async save() {
      const path = document.getElementById('libPath').value.trim();
      const name = document.getElementById('libName').value.trim();
      const auto = document.getElementById('libAutoScan').checked;
      if (!path) { toast('Enter a folder path', 'error'); return; }
      const btn = document.getElementById('btnLibSave');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Scanning…';
      try {
        const r = await api('POST', '/api/libraries', { folder_path: path, name, auto_scan: auto });
        const msg = document.getElementById('libScanMsg');
        msg.textContent = `Done — ${r.added} video(s) added, ${r.skipped} already known.`;
        document.getElementById('libScanResult').classList.remove('d-none');
        document.getElementById('libPath').disabled = true;
        btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Close';
        btn.onclick = () => {
          _modal('libModal').hide();
          btn.onclick = () => App.libraries.save();
        };
        this.load();
        library.load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
        if (btn.innerHTML.includes('spinner')) {
          btn.innerHTML = '<i class="bi bi-folder-check me-1"></i>Add &amp; Scan';
        }
      }
    },
    async scan(id, name) {
      try {
        const r = await api('POST', `/api/libraries/${id}/scan`);
        toast(`"${name}" scanned — ${r.added} added, ${r.skipped} already known`);
        library.load();
      } catch (e) { toast(e.message, 'error'); }
    },
    async setAutoScan(id, val) {
      try { await api('PUT', `/api/libraries/${id}`, { auto_scan: val }); }
      catch (e) { toast(e.message, 'error'); this.load(); }
    },
    confirmDelete(id, name) {
      document.getElementById('deleteModalBody').innerHTML =
        `<p>Remove library folder "<strong>${escHtml(name)}</strong>"?</p>` +
        `<p class="mb-0 text-secondary small">Videos already imported will stay in the library unless you check the box below.</p>` +
        `<div class="form-check mt-2"><input class="form-check-input" type="checkbox" id="libDeleteVideos" />` +
        `<label class="form-check-label" for="libDeleteVideos">Also remove imported videos from this folder</label></div>`;
      const btn = document.getElementById('btnConfirmDelete');
      btn.onclick = async () => {
        const removeVids = document.getElementById('libDeleteVideos')?.checked || false;
        try {
          await api('DELETE', `/api/libraries/${id}?remove_videos=${removeVids}`);
          toast('Library removed');
          _modal('deleteModal').hide();
          this.load();
          library.load();
        } catch (e) { toast(e.message, 'error'); }
      };
      _modal('deleteModal').show();
    },
  };

  const library = {
    _file: null,
    _filter: '',
    async load() {
      try {
        _videos = await api('GET', '/api/videos');
        this.render();
      } catch (e) { toast('Failed to load library: ' + e.message, 'error'); }
    },
    filter(q) {
      this._filter = q.toLowerCase();
      this.render();
    },
    render() {
      const tbody = document.getElementById('libraryBody');
      const q     = this._filter;
      const shown = q
        ? _videos.filter(v =>
            v.title.toLowerCase().includes(q) ||
            v.filename.toLowerCase().includes(q))
        : _videos;
      document.getElementById('libraryEmpty').classList.toggle('d-none', _videos.length > 0);
      document.getElementById('libraryTable').classList.toggle('d-none', _videos.length === 0);
      tbody.innerHTML = shown.map(v => {
        const src = v.library_id
          ? `<span class="badge bg-warning text-dark" title="From folder library">Folder</span>`
          : `<span class="badge bg-secondary">Uploaded</span>`;
        const enriched = v.title_enriched
          ? '<span class="badge bg-success ms-1" title="Title has been enriched">Enriched</span>'
          : '';
        return `
        <tr>
          <td class="text-secondary">${v.id}</td>
          <td>
            <div class="fw-semibold">${escHtml(v.title)}</div>
            ${v.title !== v.filename ? `<div class="text-secondary small font-monospace">${escHtml(v.filename)}</div>` : ''}
          </td>
          <td class="text-secondary small font-monospace">${escHtml(v.filename)}</td>
          <td>${fmtDuration(v.duration)}</td>
          <td>${fmtSize(v.size)}</td>
          <td>${src}${enriched}</td>
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
        </tr>`;
      }).join('');
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
    async enrichEdit() {
      const id  = parseInt(document.getElementById('editVideoId').value);
      const btn = document.getElementById('btnEditVideoEnrich');
      if (!id) return;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Enriching...';
      try {
        const results = await api('POST', '/api/videos/enrich-preview', {
          video_ids: [id],
          force: true,
        });
        const match = results[0]?.candidates?.[0];
        if (!match?.title) {
          toast('No enrichment match found', 'warning');
          return;
        }
        await api('PUT', `/api/videos/${id}`, {
          title: match.title,
          title_enriched: true,
        });
        document.getElementById('editVideoTitle').value = match.title;
        toast('Title enriched');
        _modal('editVideoModal').hide();
        this.load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-magic me-1"></i>Enrich';
      }
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

        const slotType = item.slot_type || 'video';
        let contentCell = '';
        if (slotType === 'bumper') {
          contentCell = `<span class="badge bg-success me-1"><i class="bi bi-collection-play-fill"></i> Bumper</span> ${escHtml(item.video_title)}`;
        } else if (slotType === 'auto_bumper') {
          contentCell = `<span class="badge bg-success me-1"><i class="bi bi-calendar-range"></i> Auto Bumper</span>`;
        } else {
          contentCell = escHtml(item.video_title);
        }

        const isVideo = slotType === 'video';
        return `
          <tr class="${item.enabled ? '' : 'opacity-50'}">
            <td class="fw-bold">${fmtLocalTime(item.start_time)}</td>
            <td>
              <span class="badge ${badge} me-1">${item.recurrence}</span>
              ${escHtml(when)}
            </td>
            <td>${contentCell}</td>
            <td>${fmtDuration(item.video_duration)}</td>
            <td>${item.priority}</td>
            <td>
              <div class="form-check form-switch mb-0">
                <input class="form-check-input" type="checkbox" ${item.enabled ? 'checked' : ''}
                  onchange="App.schedule.toggle(${item.id}, this.checked)" />
              </div>
            </td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary me-1"
                onclick="${isVideo ? `App.schedule.openEdit(${item.id})` : `App.schedule.openEditBumperSlot(${item.id})`}">
                <i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-danger"
                onclick="App.schedule.confirmDelete(${item.id}, '${escAttr(item.video_title)}')">
                <i class="bi bi-trash"></i></button>
            </td>
          </tr>`;
      }).join('');
    },
    _populateVideoSelect() {
      // No-op: searchable picker is built on demand in filterVideoSearch
    },
    _renderVideoDropdown(filter) {
      const drop = document.getElementById('schedVideoDropdown');
      if (!drop) return;
      const q = (filter || '').toLowerCase();
      const matches = q
        ? _videos.filter(v => v.title.toLowerCase().includes(q)).slice(0, 80)
        : _videos.slice(0, 80);
      if (!matches.length) {
        drop.innerHTML = '<div class="px-3 py-2 text-secondary small">No videos match</div>';
        return;
      }
      drop.innerHTML = matches.map(v =>
        `<div class="px-3 py-2 small video-pick-item" style="cursor:pointer"
          data-id="${v.id}" data-title="${escHtml(v.title)}"
          onmousedown="App.schedule.selectVideo(${v.id}, '${escAttr(v.title)}')">${escHtml(v.title)}</div>`
      ).join('');
    },
    showVideoDropdown() {
      const drop = document.getElementById('schedVideoDropdown');
      if (!drop) return;
      const q = document.getElementById('schedVideoSearch')?.value || '';
      this._renderVideoDropdown(q);
      drop.classList.remove('d-none');
    },
    hideVideoDropdown() {
      // Delay so mousedown on an item fires first
      setTimeout(() => {
        const drop = document.getElementById('schedVideoDropdown');
        if (drop) drop.classList.add('d-none');
      }, 180);
    },
    filterVideoSearch() {
      const q = document.getElementById('schedVideoSearch')?.value || '';
      this._renderVideoDropdown(q);
      const drop = document.getElementById('schedVideoDropdown');
      if (drop) drop.classList.remove('d-none');
      // Clear selection if user edits the text
      document.getElementById('schedVideo').value = '';
      document.getElementById('schedVideoSelected').textContent = '';
    },
    selectVideo(id, title) {
      document.getElementById('schedVideo').value = id;
      document.getElementById('schedVideoSearch').value = title;
      document.getElementById('schedVideoSelected').textContent = '\u2713 Selected';
      const drop = document.getElementById('schedVideoDropdown');
      if (drop) drop.classList.add('d-none');
    },
    _setVideoPickerValue(videoId) {
      const v = _videos.find(x => x.id === videoId);
      if (v) {
        document.getElementById('schedVideo').value = v.id;
        document.getElementById('schedVideoSearch').value = v.title;
        document.getElementById('schedVideoSelected').textContent = '\u2713 Selected';
      } else {
        document.getElementById('schedVideo').value = '';
        document.getElementById('schedVideoSearch').value = '';
        document.getElementById('schedVideoSelected').textContent = '';
      }
    },
    async _populateBumperSelects() {
      try {
        _bumpersList = await api('GET', '/api/bumpers');
        const none1 = '<option value="">None (use global if enabled)</option>';
        const none2 = '<option value="">None</option>';
        const opts  = _bumpersList.map(b =>
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
      document.getElementById('schedVideoSearch').value = '';
      document.getElementById('schedVideo').value = '';
      document.getElementById('schedVideoSelected').textContent = '';
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
      const afterVideos = () => this._setVideoPickerValue(item.video_id);
      if (!_videos.length) api('GET', '/api/videos').then(v => { _videos = v; afterVideos(); });
      else afterVideos();
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
      const startTime = document.getElementById('schedTime').value;
      const videoId  = parseInt(document.getElementById('schedVideo').value) || null;

      if (!videoId) {
        toast('Please select a video from the search dropdown first', 'warning');
        document.getElementById('schedVideoSearch')?.focus();
        return;
      }
      const payload  = {
        video_id:     videoId,
        start_time:   startTime,
        recurrence:   rec,
        date:         rec === 'once' ? document.getElementById('schedDate').value : null,
        days_of_week: rec === 'weekly' ? days : null,
        title:        document.getElementById('schedTitle').value.trim() || null,
        priority:     parseInt(document.getElementById('schedPriority').value) || 0,
        enabled:      document.getElementById('schedEnabled').checked,
        bumper_pre_id:  null,   // no longer stored on the video slot
        bumper_post_id: null,
      };
      try {
        if (id) await api('PUT',  `/api/schedule/${id}`, payload);
        else    await api('POST', '/api/schedule', payload);

        // Auto-insert pre/post bumper as separate bumper slots
        if (!id) {  // only on create (not edit) to avoid duplicating
          const base = { recurrence: rec, date: payload.date,
                         days_of_week: payload.days_of_week,
                         priority: payload.priority + 1,
                         enabled: payload.enabled,
                         slot_type: 'bumper', video_id: null };
          // Helper: add minutes to HH:MM string
          const addMins = (hhmm, delta) => {
            const [h, m] = hhmm.split(':').map(Number);
            const total  = Math.max(0, Math.min(1439, h * 60 + m + delta));
            return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
          };
          if (bPre) {
            const bDur = Math.ceil((_bumpersList.find(b => b.id === bPre)?.duration || 30) / 60);
            await api('POST', '/api/schedule', {
              ...base, bumper_id: bPre,
              start_time: addMins(startTime, -bDur),
              title: null,
            });
          }
          if (bPost) {
            const vidDur  = Math.ceil((_videos.find(v => v.id === payload.video_id)?.duration || 300) / 60);
            await api('POST', '/api/schedule', {
              ...base, bumper_id: bPost,
              start_time: addMins(startTime, vidDur),
              title: null,
            });
          }
        }

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

    // ── Bumper slot methods ─────────────────────────────────────────────────
    async openAddBumper() {
      // Populate bumper select
      let bList = [];
      try { bList = await api('GET', '/api/bumpers'); } catch {}
      const sel = document.getElementById('bSlotBumperId');
      sel.innerHTML = bList.length
        ? bList.filter(b => b.enabled).map(b =>
            `<option value="${b.id}">${escHtml(b.title || b.filename)} (${fmtDuration(b.duration)})</option>`
          ).join('')
        : '<option disabled value="">No bumpers uploaded yet</option>';

      document.getElementById('bSlotId').value = '';
      document.getElementById('bSlotTypeManual').checked = true;
      document.getElementById('bSlotTime').value = '12:00';
      document.getElementById('bSlotRecurrence').value = 'once';
      document.getElementById('bSlotDate').value = new Date().toISOString().split('T')[0];
      document.getElementById('bSlotDuration').value = '30';
      document.getElementById('bSlotTitle').value = '';
      document.getElementById('bSlotPriority').value = '0';
      document.getElementById('bSlotEnabled').checked = true;
      document.querySelectorAll('.bslot-day').forEach(c => c.checked = false);
      this.onBSlotTypeChange();
      this.onBSlotRecurrenceChange();
      _modal('bumperSlotModal').show();
    },
    openEditBumperSlot(id) {
      const item = this._items.find(x => x.id === id);
      if (!item) return;
      this.openAddBumper().then(() => {
        document.getElementById('bSlotId').value = id;
        const isAuto = item.slot_type === 'auto_bumper';
        document.getElementById(isAuto ? 'bSlotTypeAuto' : 'bSlotTypeManual').checked = true;
        document.getElementById('bSlotTime').value = item.start_time;
        document.getElementById('bSlotRecurrence').value = item.recurrence;
        document.getElementById('bSlotDate').value = item.date || '';
        const days = (item.days_of_week || '').split(',').map(Number);
        document.querySelectorAll('.bslot-day').forEach(c => c.checked = days.includes(parseInt(c.value)));
        document.getElementById('bSlotTitle').value = item.title || '';
        document.getElementById('bSlotPriority').value = item.priority || 0;
        document.getElementById('bSlotEnabled').checked = item.enabled;
        if (item.slot_duration) document.getElementById('bSlotDuration').value = item.slot_duration;
        if (!isAuto && item.bumper_id) document.getElementById('bSlotBumperId').value = item.bumper_id;
        this.onBSlotTypeChange();
        this.onBSlotRecurrenceChange();
      });
    },
    onBSlotTypeChange() {
      const isAuto = document.getElementById('bSlotTypeAuto').checked;
      document.getElementById('bSlotBumperGroup').classList.toggle('d-none', isAuto);
      document.getElementById('bSlotDurationGroup').classList.toggle('d-none', !isAuto);
    },
    onBSlotRecurrenceChange() {
      const rec = document.getElementById('bSlotRecurrence').value;
      document.getElementById('bSlotDateGroup').style.display = rec === 'once' ? '' : 'none';
      document.getElementById('bSlotDaysGroup').classList.toggle('d-none', rec !== 'weekly');
    },
    async saveBumperSlot() {
      const id      = document.getElementById('bSlotId').value;
      const isAuto  = document.getElementById('bSlotTypeAuto').checked;
      const slotType = isAuto ? 'auto_bumper' : 'bumper';
      const rec     = document.getElementById('bSlotRecurrence').value;
      const days    = [...document.querySelectorAll('.bslot-day:checked')].map(c => c.value).join(',');
      const bId     = !isAuto ? (parseInt(document.getElementById('bSlotBumperId').value) || null) : null;
      const dur     = isAuto  ? (parseFloat(document.getElementById('bSlotDuration').value) || 30) : null;
      const payload = {
        slot_type:    slotType,
        bumper_id:    bId,
        slot_duration: dur,
        video_id:     null,
        start_time:   document.getElementById('bSlotTime').value,
        recurrence:   rec,
        date:         rec === 'once' ? document.getElementById('bSlotDate').value : null,
        days_of_week: rec === 'weekly' ? days : null,
        title:        document.getElementById('bSlotTitle').value.trim() || null,
        priority:     parseInt(document.getElementById('bSlotPriority').value) || 0,
        enabled:      document.getElementById('bSlotEnabled').checked,
      };
      try {
        if (id) await api('PUT', `/api/schedule/${id}`, payload);
        else    await api('POST', '/api/schedule', payload);
        toast('Bumper slot saved');
        _modal('bumperSlotModal').hide();
        this.load();
      } catch (e) { toast(e.message, 'error'); }
    },

    setView(v) {
      localStorage.setItem('scheduleView', v);
      document.getElementById('btnViewTable').classList.toggle('active', v === 'table');
      document.getElementById('btnViewTimeline').classList.toggle('active', v === 'timeline');
      document.getElementById('scheduleTableWrap').classList.toggle('d-none', v !== 'table');
      document.getElementById('timelineView').classList.toggle('d-none', v !== 'timeline');
      const zoomCtrl = document.getElementById('tlZoomControls');
      if (zoomCtrl) zoomCtrl.classList.toggle('d-none', v !== 'timeline');
      const snapCtrl = document.getElementById('tlSnapControls');
      if (snapCtrl) snapCtrl.classList.toggle('d-none', v !== 'timeline');
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
      const trackW     = Math.max(720, _tlZoom * 1440) + 'px';

      // Ruler tick/label density scales with zoom
      const tickMin    = _tlZoom <= 1 ? 60 : _tlZoom <= 2 ? 30 : 15;
      const labelMin   = _tlZoom <= 1 ? 180 : _tlZoom <= 2 ? 60 : _tlZoom <= 4 ? 30 : 15;

      let rulerHtml = '';
      for (let m = 0; m <= 1440; m += tickMin) {
        const h = Math.floor(m / 60), min = m % 60;
        const timeStr = min === 0 ? `${pad(h)}:00` : `${pad(h)}:${pad(min)}`;
        const lbl = (m % labelMin === 0) ? `<span>${timeStr}</span>` : '';
        rulerHtml += `<div class="tl-ruler-mark" style="left:${pct(m)}">${lbl}</div>`;
      }
      let html = `
        <div class="tl-ruler-row">
          <div class="tl-side-label"></div>
          <div class="tl-ruler" style="min-width:${trackW}">${rulerHtml}</div>
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
          const slotType = item.slot_type || 'video';
          const durMin   = Math.max(5, Math.ceil((item.video_duration || 300) / 60));
          const width    = Math.min(durMin, 1440 - startMin);
          if (width <= 0) continue;

          let col, tlClass, editFn;
          if (slotType === 'bumper') {
            col = '#22c55e'; tlClass = ' tl-slot-bumper'; editFn = `App.schedule.openEditBumperSlot(${item.id})`;
          } else if (slotType === 'auto_bumper') {
            col = '#10b981'; tlClass = ' tl-slot-auto-bumper'; editFn = `App.schedule.openEditBumperSlot(${item.id})`;
          } else {
            col = TL_VIDEO_COLOR; tlClass = ''; editFn = `App.schedule.openEdit(${item.id})`;
          }
          const endMin    = startMin + width;
          const endFmt    = fmtLocalTime(pad(Math.floor(endMin / 60) % 24) + ':' + pad(endMin % 60));
          const title     = escHtml(item.title || item.video_title || '?');
          const hasBumper = item.bumper_pre_id ? ' tl-has-bumper' : '';
          itemsHtml += `
            <div class="tl-item${hasBumper}${tlClass}"
              draggable="true"
              style="left:${pct(startMin)};width:${pct(width)};background:${col}"
              title="${title} @ ${fmtLocalTime(item.start_time)} \u2192 ${endFmt} (${fmtDuration(item.video_duration)})"
              ondragstart="App.schedule.tlDragStart(event,${item.id},${startMin},${rowDow})"
              ondragend="App.schedule.tlDragEnd(event)"
              onclick="App.schedule.tlItemClick(event,${item.id})"
              oncontextmenu="App.schedule.tlItemRightClick(event,${item.id})">
              <span class="tl-item-label">${title}</span><span class="tl-item-endtime">${endFmt}</span>
            </div>`;
        }

        const nowLine = (isDailyRow || isToday)
          ? `<div class="tl-now-line" style="left:${pct(nowMins)}"></div>` : '';

        html += `
          <div class="tl-row${isToday ? ' tl-today' : ''}">
            <div class="tl-side-label">${label}</div>
            <div class="tl-track" style="min-width:${trackW}"
              data-dow="${isDailyRow ? 'all' : rowDow}"
              ondragover="App.schedule.tlDragOver(event)"
              ondragleave="App.schedule.tlDragLeave(event)"
              ondrop="App.schedule.tlDrop(event)">${nowLine}${itemsHtml}</div>
          </div>`;
      }
      el.innerHTML = html;

      // Scroll to centre on current time when zoomed in
      if (_tlZoom > 1) {
        const tw = parseInt(trackW);
        const sideLabelW = 56; // matches .tl-side-label in CSS
        const cw = el.clientWidth - sideLabelW;
        el.scrollLeft = Math.max(0, (nowMins / 1440) * tw - cw / 2);
      }
    },

    // ── Timeline zoom ────────────────────────────────────────────────────
    tlZoom(dir) {
      const levels = [1, 2, 4, 8];
      const idx = levels.indexOf(_tlZoom);
      _tlZoom = levels[Math.max(0, Math.min(levels.length - 1, idx + dir))];
      const lbl = document.getElementById('tlZoomLabel');
      if (lbl) lbl.textContent = _tlZoom + '\u00d7';
      this.renderTimeline();
    },

    tlSnapChange(v) {
      _tlSnap = parseFloat(v) || 15;
    },

    // ── Timeline element-snap helpers ───────────────────────────────────
    _itemsInRow(dow) {
      const isDailyRow = (dow === 'all');
      const rowDowInt  = parseInt(dow);
      return this._items.filter(item => {
        if (!item.enabled) return false;
        if (isDailyRow) return item.recurrence === 'daily';
        if (item.recurrence === 'weekly')
          return (item.days_of_week || '').split(',').map(Number).includes(rowDowInt);
        if (item.recurrence === 'once' && item.date) {
          const dt = new Date(item.date + 'T12:00:00');
          return ((dt.getDay() + 6) % 7) === rowDowInt;
        }
        return false;
      });
    },
    _elementSnapPoints(dow, excludeId) {
      return this._itemsInRow(dow).flatMap(item => {
        if (item.id === excludeId) return [];
        const [hh, mm] = (item.start_time || '00:00').split(':').map(Number);
        const s   = hh * 60 + mm;
        const dur = Math.max(5, Math.ceil((item.video_duration || 300) / 60));
        const lbl = (item.title || item.video_title || '?').substring(0, 20);
        return [
          { min: s,       label: 'Start: ' + lbl },
          { min: s + dur, label: 'End: '   + lbl },
        ];
      });
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

    // click on item → show info popover; right-click → context menu
    tlItemClick(e, id) {
      e.stopPropagation();
      const item = this._items.find(x => x.id === id);
      if (!item) return;
      // Remove any existing popover/menu
      document.querySelector('.tl-popover')?.remove();
      const slotType = item.slot_type || 'video';
      const editFn = slotType === 'video'
        ? `App.schedule.openEdit(${id})`
        : `App.schedule.openEditBumperSlot(${id})`;
      const typeLabel = slotType === 'auto_bumper' ? 'Auto Bumper'
                      : slotType === 'bumper'      ? 'Bumper'
                      : 'Video';
      const [ciHH, ciMM] = (item.start_time || '00:00').split(':').map(Number);
      const ciEnd   = ciHH * 60 + ciMM + Math.max(5, Math.ceil((item.video_duration || 300) / 60));
      const ciEndFmt = fmtLocalTime(pad(Math.floor(ciEnd / 60) % 24) + ':' + pad(ciEnd % 60));
      const pop = document.createElement('div');
      pop.className = 'tl-popover';
      pop.innerHTML = `
        <div class="fw-semibold mb-1">${escHtml(item.title || item.video_title || '?')}</div>
        <div class="text-secondary small">${typeLabel} &mdash; ${fmtLocalTime(item.start_time)} &rarr; ${ciEndFmt}</div>
        <div class="text-secondary small">${fmtDuration(item.video_duration)}</div>
        <div class="d-flex gap-2 mt-2">
          <button class="btn btn-sm btn-outline-primary" onclick="${editFn};document.querySelector('.tl-popover')?.remove()">
            <i class="bi bi-pencil me-1"></i>Edit</button>
          <button class="btn btn-sm btn-outline-danger" onclick="App.schedule.tlDelete(${id});document.querySelector('.tl-popover')?.remove()">
            <i class="bi bi-trash me-1"></i>Delete</button>
        </div>`;
      // Position near the clicked element
      const rect = e.currentTarget.getBoundingClientRect();
      pop.style.cssText = `position:fixed;z-index:1080;left:${Math.min(rect.left, window.innerWidth-220)}px;top:${rect.bottom+4}px`;
      document.body.appendChild(pop);
      const dismiss = ev => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', dismiss); } };
      setTimeout(() => document.addEventListener('click', dismiss), 10);
    },
    tlItemRightClick(e, id) {
      e.preventDefault();
      e.stopPropagation();
      document.querySelector('.tl-popover')?.remove();
      document.querySelector('.tl-ctx-menu')?.remove();
      const item = this._items.find(x => x.id === id);
      if (!item) return;
      const menu = document.createElement('div');
      menu.className = 'tl-ctx-menu';
      const slotType = item.slot_type || 'video';
      const editFn = slotType === 'video'
        ? `App.schedule.openEdit(${id})`
        : `App.schedule.openEditBumperSlot(${id})`;
      menu.innerHTML = `
        <div class="tl-ctx-item" onclick="${editFn};document.querySelector('.tl-ctx-menu')?.remove()">
          <i class="bi bi-pencil me-2"></i>Edit</div>
        <div class="tl-ctx-item text-danger" onclick="App.schedule.tlDelete(${id});document.querySelector('.tl-ctx-menu')?.remove()">
          <i class="bi bi-trash me-2"></i>Delete</div>`;
      menu.style.cssText = `position:fixed;z-index:1080;left:${e.clientX}px;top:${e.clientY}px`;
      document.body.appendChild(menu);
      const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
      setTimeout(() => document.addEventListener('click', dismiss), 10);
    },
    tlDelete(id) {
      const item = this._items.find(x => x.id === id);
      if (!item) return;
      const name = item.title || item.video_title || 'this slot';
      document.getElementById('deleteModalBody').textContent = `Remove schedule for "${name}"?`;
      document.getElementById('btnConfirmDelete').onclick = async () => {
        try {
          await api('DELETE', `/api/schedule/${id}`);
          toast('Removed');
          _modal('deleteModal').hide();
          this.load();
        } catch (e2) { toast(e2.message, 'error'); }
      };
      _modal('deleteModal').show();
    },
    tlDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drag-over');
      // Compute snapped time and show tooltip next to cursor
      const track  = e.currentTarget;
      const rect   = track.getBoundingClientRect();
      const relX        = Math.max(0, e.clientX - rect.left);
      const rawFracMin  = (relX / rect.width) * 1440;
      const threshMin   = 20 / (rect.width / 1440);  // 20px in minutes
      const sPts        = this._elementSnapPoints(track.dataset.dow, _tlDrag?.id);
      let   elSnap      = null;
      for (const pt of sPts) {
        const d = Math.abs(rawFracMin - pt.min);
        if (d < threshMin && (elSnap === null || d < Math.abs(rawFracMin - elSnap.min))) elSnap = pt;
      }
      const snapMin = elSnap
        ? Math.min(1439, Math.max(0, elSnap.min))
        : Math.min(1440 - _tlSnap, Math.round(rawFracMin / _tlSnap) * _tlSnap);
      const label = elSnap
        ? pad(Math.floor(snapMin / 60)) + ':' + pad(snapMin % 60) + ' \u2192 ' + elSnap.label.substring(0, 18)
        : pad(Math.floor(snapMin / 60)) + ':' + pad(snapMin % 60);
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
      const relX       = Math.max(0, e.clientX - rect.left);
      const rawFracMin = (relX / rect.width) * 1440;
      const threshMin  = 20 / (rect.width / 1440);
      const sPts       = this._elementSnapPoints(track.dataset.dow, _tlDrag?.id);
      let   elSnap     = null;
      for (const pt of sPts) {
        const d = Math.abs(rawFracMin - pt.min);
        if (d < threshMin && (elSnap === null || d < Math.abs(rawFracMin - elSnap.min))) elSnap = pt;
      }
      const newMin  = elSnap
        ? Math.min(1439, Math.max(0, elSnap.min))
        : Math.min(1440 - _tlSnap, Math.round(rawFracMin / _tlSnap) * _tlSnap);
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
      tbody.innerHTML = this._items.map((b, i) => `
        <tr>
          <td class="text-secondary">${i + 1}</td>
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
      } catch (e) { toast('Failed to load overlays: ' + e.message, 'error'); }
    },
    render() {
      const tbody = document.getElementById('ltBody');
      if (!tbody) return;
      document.getElementById('ltEmpty').classList.toggle('d-none', this._items.length > 0);
      document.getElementById('ltTable').classList.toggle('d-none', this._items.length === 0);
      tbody.innerHTML = this._items.map(lt => {
        const timing = lt.duration > 0
          ? `${lt.trigger_offset}s – ${lt.trigger_offset + lt.duration}s`
          : (lt.trigger_offset > 0 ? `from ${lt.trigger_offset}s` : 'Entire video');
        const scope = lt.schedule_item_id ? `Slot #${lt.schedule_item_id}` : 'Global';
        return `
          <tr class="${lt.enabled ? '' : 'opacity-50'}">
            <td class="text-secondary">${lt.id}</td>
            <td>
              <img src="/api/lower-thirds/${lt.id}/image" alt="${escHtml(lt.label||'')}"
                   class="img-thumbnail" style="height:40px;width:auto;cursor:pointer;"
                   onclick="window.open('/api/lower-thirds/${lt.id}/image','_blank')" />
            </td>
            <td class="fw-semibold">${escHtml(lt.label || '—')}<br>
              <span class="text-secondary small font-monospace">${escHtml(lt.filename || '')}</span>
            </td>
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
          opt.textContent = `${fmtLocalTime(item.start_time)} – ${item.video_title} (${item.recurrence})`;
          sel.appendChild(opt);
        });
      } catch {}
    },
    async openAdd() {
      document.getElementById('ltId').value        = '';
      document.getElementById('ltModalTitle').innerHTML = '<i class="bi bi-image me-2"></i>Upload Overlay Graphic';
      document.getElementById('ltLabel').value     = '';
      document.getElementById('ltTrigger').value   = '0';
      document.getElementById('ltDuration').value  = '0';
      document.getElementById('ltEnabled').checked = true;
      document.getElementById('ltFile').value      = '';
      // show file picker, hide preview
      document.getElementById('ltFileRow').classList.remove('d-none');
      document.getElementById('ltPreviewRow').classList.add('d-none');
      document.getElementById('btnLtSave').innerHTML = '<i class="bi bi-upload me-1"></i>Upload &amp; Save';
      await this._populateScheduleItems();
      _modal('ltModal').show();
    },
    async openEdit(id) {
      const lt = this._items.find(x => x.id === id);
      if (!lt) return;
      document.getElementById('ltId').value        = id;
      document.getElementById('ltModalTitle').innerHTML = '<i class="bi bi-pencil me-2"></i>Edit Overlay';
      document.getElementById('ltLabel').value     = lt.label || '';
      document.getElementById('ltTrigger').value   = lt.trigger_offset ?? 0;
      document.getElementById('ltDuration').value  = lt.duration ?? 0;
      document.getElementById('ltEnabled').checked = lt.enabled;
      // hide file picker, show preview
      document.getElementById('ltFileRow').classList.add('d-none');
      document.getElementById('ltPreviewRow').classList.remove('d-none');
      document.getElementById('ltPreviewImg').src  = `/api/lower-thirds/${lt.id}/image`;
      document.getElementById('ltCurrentFilename').textContent = lt.filename || '';
      document.getElementById('btnLtSave').innerHTML = '<i class="bi bi-check-lg me-1"></i>Save';
      await this._populateScheduleItems();
      document.getElementById('ltScheduleItem').value = lt.schedule_item_id || '';
      _modal('ltModal').show();
    },
    async save() {
      const id      = document.getElementById('ltId').value;
      const label   = document.getElementById('ltLabel').value.trim();
      const trigger = parseInt(document.getElementById('ltTrigger').value) || 0;
      const dur     = parseInt(document.getElementById('ltDuration').value) || 0;
      const sid     = parseInt(document.getElementById('ltScheduleItem').value) || null;
      const enabled = document.getElementById('ltEnabled').checked;

      try {
        if (id) {
          // Edit — JSON update, no file change
          await api('PUT', `/api/lower-thirds/${id}`, {
            label, trigger_offset: trigger, duration: dur,
            schedule_item_id: sid, enabled,
          });
        } else {
          // Upload — multipart
          const fileInput = document.getElementById('ltFile');
          if (!fileInput.files.length) { toast('Please select a PNG file', 'error'); return; }
          const fd = new FormData();
          fd.append('file', fileInput.files[0]);
          fd.append('label', label);
          fd.append('trigger_offset', trigger);
          fd.append('duration', dur);
          if (sid) fd.append('schedule_item_id', sid);
          const resp = await fetch('/api/lower-thirds', { method: 'POST', body: fd });
          if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || resp.statusText); }
        }
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
        `Delete overlay "${(lt && lt.label) || id}"?`;
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
    toggleYtKey() {
      const inp  = document.getElementById('ytApiKeyInput');
      const icon = document.getElementById('ytKeyEyeIcon');
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
    // Library search filter
    document.getElementById('librarySearch')?.addEventListener('input', e => {
      library.filter(e.target.value);
    });
    // Restore schedule view preference
    const savedView = localStorage.getItem('scheduleView') || 'table';
    if (savedView === 'timeline') {
      document.getElementById('btnViewTable')?.classList.remove('active');
      document.getElementById('btnViewTimeline')?.classList.add('active');
      document.getElementById('scheduleTableWrap')?.classList.add('d-none');
      document.getElementById('timelineView')?.classList.remove('d-none');
      document.getElementById('tlZoomControls')?.classList.remove('d-none');
      document.getElementById('tlSnapControls')?.classList.remove('d-none');
    }
  });

  // ── Auto Schedule Bumper ──────────────────────────────────────────────────
  const autoBumper = {
    async load() {
      try {
        // Load settings
        const s = await api('GET', '/api/settings');
        const enabled  = s.auto_bumper_enabled === 'true';
        const duration = parseInt(s.auto_bumper_duration || '30');
        const el = document.getElementById('autoBumperEnabled');
        const du = document.getElementById('autoBumperDuration');
        if (el) el.checked  = enabled;
        if (du) du.value    = duration;
        await this.refreshStatus();
        await this.refreshUpcoming();
      } catch(e) { console.error('autoBumper.load', e); }
    },
    async refreshStatus() {
      try {
        const st = await api('GET', '/api/bumper/status');
        const el  = document.getElementById('autoBumperStatus');
        if (!el) return;
        const pw = st.playwright_available;
        const fe = st.file_exists;
        const lr = st.last_rendered
          ? new Date(st.last_rendered).toLocaleString()
          : 'Never';
        if (!pw) {
          el.className = 'p-3 rounded bg-warning bg-opacity-10 text-warning-emphasis small';
          el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>' +
            '<strong>Playwright not installed.</strong> ' +
            'Run: <code>pip install playwright &amp;&amp; playwright install chromium</code>';
        } else if (!fe) {
          el.className = 'p-3 rounded bg-body-secondary text-secondary small';
          el.innerHTML = '<i class="bi bi-hourglass me-1"></i>No video rendered yet. ' +
            'Enable the auto bumper and click <strong>Regenerate Now</strong>.';
        } else {
          el.className = 'p-3 rounded bg-success bg-opacity-10 text-success-emphasis small';
          el.innerHTML = '<i class="bi bi-check-circle me-1"></i>' +
            `<strong>Ready.</strong> Last rendered: ${escHtml(lr)}`;
        }
      } catch {}
    },
    async refreshUpcoming() {
      const tbody = document.getElementById('upcomingBody');
      if (!tbody) return;
      try {
        const items = await api('GET', '/api/schedule-upcoming');
        if (!items || items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" class="text-secondary small text-center py-2">No upcoming items.</td></tr>';
          return;
        }
        tbody.innerHTML = items.map(item => `
          <tr>
            <td class="font-monospace">${escHtml(item.time)}</td>
            <td>${escHtml(item.title || '—')}</td>
            <td class="text-secondary">${escHtml(item.speaker || '')}</td>
          </tr>`).join('');
      } catch {
        tbody.innerHTML = '<tr><td colspan="3" class="text-secondary small text-center py-2">Error loading.</td></tr>';
      }
    },
    async setEnabled(val) {
      try {
        await api('POST', '/api/settings', { auto_bumper_enabled: val ? 'true' : 'false' });
        if (val) toast('Auto bumper enabled — regenerating…');
        else toast('Auto bumper disabled');
        await this.refreshStatus();
      } catch(e) { toast(e.message, 'error'); }
    },
    async setDuration(val) {
      const n = Math.max(5, parseInt(val) || 30);
      document.getElementById('autoBumperDuration').value = n;
      try {
        await api('POST', '/api/settings', { auto_bumper_duration: String(n) });
      } catch(e) { toast(e.message, 'error'); }
    },
    async regenerate() {
      const btn = document.getElementById('btnRegen');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Rendering…'; }
      try {
        await api('POST', '/api/bumper/regenerate');
        toast('Rendering started — this may take ~30s');
        // Poll for completion
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          await this.refreshStatus();
          const st = await api('GET', '/api/bumper/status').catch(() => ({}));
          if (st.file_exists || attempts > 24) {
            clearInterval(poll);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Regenerate Now'; }
          }
        }, 5000);
      } catch(e) {
        toast(e.message, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Regenerate Now'; }
      }
    },
  };

  // ── YouTube Title Enrichment ───────────────────────────────────────────────
  const enrich = {
    _results: [],
    async open() {
      // Populate library scope dropdown
      try {
        const libs = await api('GET', '/api/libraries');
        const sel = document.getElementById('enrichLibId');
        sel.innerHTML = '<option value="">\u2014 All Videos \u2014</option>' +
          libs.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('');
      } catch {}
      document.getElementById('enrichResultsWrap').classList.add('d-none');
      document.getElementById('enrichStatus').textContent = '';
      document.getElementById('btnEnrichApply').textContent = 'Apply 0 Selected';
      document.getElementById('btnEnrichApply').disabled = true;
      _modal('enrichModal').show();
    },
    async search() {
      const libId = document.getElementById('enrichLibId').value;
      const btn = document.getElementById('btnEnrichSearch');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Searching\u2026';
      document.getElementById('enrichResultsWrap').classList.add('d-none');
      document.getElementById('enrichStatus').innerHTML =
        '<span class="text-secondary"><i class="bi bi-hourglass-split me-1"></i>Querying YouTube\u2026 this may take a moment.</span>';
      try {
        const body = libId ? { library_id: parseInt(libId) } : {};
        const results = await api('POST', '/api/videos/enrich-preview', body);
        this._results = results;
        this._render(results);
      } catch (e) {
        document.getElementById('enrichStatus').innerHTML =
          `<span class="text-danger"><i class="bi bi-exclamation-triangle me-1"></i>${escHtml(e.message)}</span>`;
      }
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-search me-1"></i>Match from Sermon List';
    },
    _render(results) {
      const wrap  = document.getElementById('enrichResultsWrap');
      const tbody = document.getElementById('enrichBody');
      if (!results.length) {
        document.getElementById('enrichStatus').innerHTML =
          '<span class="text-secondary">No unenriched videos found for the selected scope.</span>';
        wrap.classList.add('d-none');
        return;
      }
      tbody.innerHTML = results.map((r, i) => {
        const has = r.candidates && r.candidates.length > 0;
        const opts = has
          ? r.candidates.map((c, ci) =>
              `<option value="${escHtml(c.title)}"${ci === 0 ? ' selected' : ''}>${escHtml(c.title)} \u2014 ${escHtml(c.channel)}</option>`
            ).join('')
          : '<option value="">No match found</option>';
        const badge = has
          ? '<span class="badge bg-success">Match</span>'
          : '<span class="badge bg-secondary">No match</span>';
        return `
          <tr>
            <td class="text-center">
              <input type="checkbox" class="form-check-input enrich-chk" data-idx="${i}"
                ${has ? 'checked' : 'disabled'}
                onchange="App.enrich._updateApplyBtn()" />
            </td>
            <td class="small font-monospace text-truncate" style="max-width:170px"
              title="${escHtml(r.filename)}">${escHtml(r.filename)}</td>
            <td class="small text-truncate text-secondary" style="max-width:200px"
              title="${escHtml(r.current_title)}">${escHtml(r.current_title)}</td>
            <td>
              <select class="form-select form-select-sm enrich-sel" data-idx="${i}"
                ${!has ? 'disabled' : ''}>${opts}</select>
            </td>
            <td>${badge}</td>
          </tr>`;
      }).join('');
      const matched = results.filter(r => r.candidates && r.candidates.length).length;
      document.getElementById('enrichStatus').innerHTML =
        `<span class="text-success small"><i class="bi bi-check2 me-1"></i>${results.length} searched, ${matched} matched.</span>`;
      wrap.classList.remove('d-none');
      this._updateApplyBtn();
    },
    _updateApplyBtn() {
      const count = document.querySelectorAll('.enrich-chk:checked').length;
      const btn = document.getElementById('btnEnrichApply');
      btn.innerHTML = `<i class="bi bi-check-lg me-1"></i>Apply ${count} Selected`;
      btn.disabled = count === 0;
    },
    toggleAll(checked) {
      document.querySelectorAll('.enrich-chk:not(:disabled)').forEach(c => { c.checked = checked; });
      this._updateApplyBtn();
    },
    async apply() {
      const payload = [];
      document.querySelectorAll('.enrich-chk:checked').forEach(chk => {
        const idx = parseInt(chk.dataset.idx);
        const r   = this._results[idx];
        const sel = document.querySelector(`.enrich-sel[data-idx="${idx}"]`);
        if (sel && sel.value) payload.push({ video_id: r.video_id, title: sel.value });
      });
      if (!payload.length) return;
      try {
        const res = await api('POST', '/api/videos/enrich-apply', payload);
        toast(`Updated ${res.updated} video title(s)`);
        _modal('enrichModal').hide();
        library.load();
      } catch (e) { toast(e.message, 'error'); }
    },
  };

  // ── Re-stream ─────────────────────────────────────────────────────────────
  const restream = {
    _videos:    [],
    _selected:  null,   // { filepath, title, duration, size }
    _pollTimer: null,
    _uploadFile: null,  // File object pending upload

    // ── Tab lifecycle ──────────────────────────────────────────────────────
    async load() {
      try {
        // Prefill settings from stored main settings
        const s = await api('GET', '/api/settings');
        document.getElementById('rsRtmpUrl').value     = s.rtmp_url      || '';
        document.getElementById('rsStreamKey').value   = s.stream_key    || '';
        document.getElementById('rsResolution').value  = s.resolution    || '1280x720';
        document.getElementById('rsFps').value         = s.fps           || '30';
        document.getElementById('rsVideoBitrate').value= s.video_bitrate || '4500k';
        document.getElementById('rsAudioBitrate').value= s.audio_bitrate || '160k';
        document.getElementById('rsEncoder').value     = s.encoder       || 'libx264';
      } catch {}
      await this._loadVideos();
      // Sync status in case a re-stream is already running
      await this._syncStatus();
    },

    async _loadVideos() {
      try {
        this._videos = await api('GET', '/api/videos');
      } catch { this._videos = []; }
      this.filterLib();
    },

    filterLib() {
      const q     = (document.getElementById('rsLibSearch')?.value || '').toLowerCase();
      const items = this._videos.filter(v =>
        !q || (v.title || v.filename || '').toLowerCase().includes(q)
      );
      const el = document.getElementById('rsLibList');
      if (!el) return;
      if (!items.length) {
        el.innerHTML = '<div class="text-secondary small p-2">No videos found.</div>';
        return;
      }
      el.innerHTML = items.map(v => {
        const title   = escHtml(v.title || v.filename || '?');
        const dur     = fmtDuration(v.duration);
        const sz      = fmtSize(v.size);
        const active  = this._selected?.filepath === v.filepath ? ' active' : '';
        return `<button class="list-group-item list-group-item-action list-group-item-dark py-2${active}"
          onclick="App.restream.selectVideo(${v.id})">
          <div class="fw-semibold text-truncate">${title}</div>
          <div class="text-secondary small">${dur} &bull; ${sz}</div>
        </button>`;
      }).join('');
    },

    selectVideo(id) {
      const v = this._videos.find(x => x.id === id);
      if (!v) return;
      this._selected = { filepath: v.filepath, title: v.title || v.filename, duration: v.duration, size: v.size };
      this._renderSelected();
      this.filterLib(); // re-render to highlight active
    },

    clearSelection() {
      this._selected = null;
      this._renderSelected();
      this.filterLib();
    },

    _renderSelected() {
      const wrap  = document.getElementById('rsSelectedWrap');
      const title = document.getElementById('rsSelectedTitle');
      const meta  = document.getElementById('rsSelectedMeta');
      if (!this._selected) {
        wrap?.classList.add('d-none');
        return;
      }
      title.textContent = this._selected.title;
      meta.textContent  = [fmtDuration(this._selected.duration), fmtSize(this._selected.size)].filter(Boolean).join(' \u2022 ');
      wrap?.classList.remove('d-none');
    },

    showSourceTab(which) {
      const libPane    = document.getElementById('rsSourceLib');
      const uploadPane = document.getElementById('rsSourceUpload');
      const libBtn     = document.getElementById('rsTabLibBtn');
      const upBtn      = document.getElementById('rsTabUploadBtn');
      if (which === 'lib') {
        libPane?.classList.remove('d-none');
        uploadPane?.classList.add('d-none');
        libBtn?.classList.add('active');
        upBtn?.classList.remove('active');
      } else {
        libPane?.classList.add('d-none');
        uploadPane?.classList.remove('d-none');
        libBtn?.classList.remove('active');
        upBtn?.classList.add('active');
      }
    },

    onUploadChange(e) {
      const f = e.target.files[0];
      this._uploadFile = f || null;
      document.getElementById('rsUploadBtn').disabled = !f;
    },

    async uploadFile() {
      const f = this._uploadFile;
      if (!f) return;
      const btn  = document.getElementById('rsUploadBtn');
      const prog = document.getElementById('rsUploadProgress');
      const bar  = document.getElementById('rsUploadBar');
      const stat = document.getElementById('rsUploadStatus');
      btn.disabled = true;
      prog.classList.remove('d-none');
      stat.textContent = 'Uploading…';
      bar.style.width  = '0%';
      const fd = new FormData();
      fd.append('file', f);
      fd.append('title', f.name.replace(/\.[^.]+$/, ''));
      try {
        const xhr = new XMLHttpRequest();
        await new Promise((resolve, reject) => {
          xhr.upload.onprogress = ev => {
            if (ev.lengthComputable) bar.style.width = Math.round(ev.loaded / ev.total * 100) + '%';
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
            else reject(new Error(`Upload failed: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('POST', '/api/videos/upload');
          xhr.send(fd);
        });
        stat.textContent = 'Upload complete!';
        bar.style.width  = '100%';
        bar.classList.remove('progress-bar-animated');
        await this._loadVideos();
        // Auto-select the newly uploaded file
        if (this._videos.length) {
          this.selectVideo(this._videos[0].id);
          this.showSourceTab('lib');
        }
        toast('Video uploaded');
      } catch (err) {
        toast(err.message, 'error');
        stat.textContent = 'Upload failed';
      } finally {
        btn.disabled = false;
        document.getElementById('rsUploadInput').value = '';
        this._uploadFile = null;
      }
    },

    // ── Stream controls ────────────────────────────────────────────────────
    async start() {
      if (!this._selected) { toast('Select a video first', 'warn'); return; }
      const rtmpUrl = document.getElementById('rsRtmpUrl').value.trim();
      const key     = document.getElementById('rsStreamKey').value.trim();
      if (!rtmpUrl) { toast('RTMP URL is required', 'warn'); return; }
      const body = {
        filepath:      this._selected.filepath,
        title:         this._selected.title,
        duration:      this._selected.duration || null,
        rtmp_url:      rtmpUrl,
        stream_key:    key,
        resolution:    document.getElementById('rsResolution').value,
        fps:           document.getElementById('rsFps').value,
        video_bitrate: document.getElementById('rsVideoBitrate').value,
        audio_bitrate: document.getElementById('rsAudioBitrate').value,
        encoder:       document.getElementById('rsEncoder').value,
      };
      try {
        const r = await api('POST', '/api/restream/start', body);
        toast(r.status === 'started' ? 'Re-stream started' : r.status);
        this._startPolling();
      } catch (e) { toast(e.message, 'error'); }
    },

    async stop() {
      try {
        await api('POST', '/api/restream/stop');
        toast('Re-stream stopped');
        this._stopPolling();
        this._renderStatus({ running: false });
      } catch (e) { toast(e.message, 'error'); }
    },

    // ── Status polling ─────────────────────────────────────────────────────
    _startPolling() {
      this._stopPolling();
      this._pollTimer = setInterval(() => this._syncStatus(), 2000);
    },
    _stopPolling() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },
    async _syncStatus() {
      try {
        const s = await api('GET', '/api/restream/status');
        this._renderStatus(s);
        if (!s.running && this._pollTimer) this._stopPolling();
      } catch {}
    },

    _renderStatus(s) {
      const badge     = document.getElementById('rsBadge');
      const startBtn  = document.getElementById('rsStartBtn');
      const stopBtn   = document.getElementById('rsStopBtn');
      const nowWrap   = document.getElementById('rsNowPlaying');
      const nowTitle  = document.getElementById('rsNowPlayingTitle');
      const logEl     = document.getElementById('rsLogViewer');
      const progWrap  = document.getElementById('rsProgressWrap');
      const progBar   = document.getElementById('rsProgressBar');
      const progElap  = document.getElementById('rsProgressElapsed');
      const progDur   = document.getElementById('rsProgressDuration');

      const live = s.running && s.process_alive;
      if (badge) {
        badge.className  = live ? 'badge ms-auto bg-danger' : 'badge ms-auto bg-secondary';
        badge.textContent = live ? 'LIVE' : (s.running ? 'STARTING' : 'IDLE');
      }
      if (startBtn) startBtn.classList.toggle('d-none', !!s.running);
      if (stopBtn)  stopBtn.classList.toggle('d-none', !s.running);
      if (nowWrap)  nowWrap.classList.toggle('d-none', !live);
      if (nowTitle && s.video_title) nowTitle.textContent = s.video_title;

      // Progress bar
      const hasDur = live && s.video_duration > 0;
      if (progWrap) progWrap.classList.toggle('d-none', !hasDur);
      if (hasDur && progBar) {
        const elapsed = Math.max(0, s.elapsed_seconds || 0);
        const dur     = s.video_duration;
        const pct     = Math.min(100, (elapsed / dur) * 100);
        progBar.style.width    = pct.toFixed(1) + '%';
        progBar.setAttribute('aria-valuenow', pct.toFixed(0));
        if (progElap) progElap.textContent = _fmtSec(elapsed);
        if (progDur)  progDur.textContent  = _fmtSec(dur);
      } else if (!live && progBar) {
        progBar.style.width = '0%';
      }

      // Append new log lines
      if (logEl && Array.isArray(s.logs)) {
        const prev = parseInt(logEl.dataset.logLen || '0');
        const newLines = s.logs.slice(prev);
        newLines.forEach(line => {
          const d = document.createElement('div');
          d.className = 'log-line';
          d.textContent = line;
          logEl.appendChild(d);
        });
        logEl.dataset.logLen = s.logs.length;
        if (newLines.length) logEl.scrollTop = logEl.scrollHeight;
      }
    },

    clearLog() {
      const el = document.getElementById('rsLogViewer');
      if (el) { el.innerHTML = ''; el.dataset.logLen = '0'; }
    },

    toggleKey() {
      const inp = document.getElementById('rsStreamKey');
      const ico = document.getElementById('rsKeyEyeIcon');
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      ico?.classList.toggle('bi-eye', inp.type === 'password');
      ico?.classList.toggle('bi-eye-slash', inp.type !== 'password');
    },
  };

  return { stream, status, library, libraries, schedule, settings, log, preview, bumpers, lowerThirds, autoBumper, enrich, restream };
})();
