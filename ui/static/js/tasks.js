/* Tasks dashboard: queue visibility, live progress, slot-free approvals. */
(function () {
    'use strict';

    const state = { tab: 'active', selected: new Set(), reloadTimer: null };
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    const STATUS_META = {
        queued: { label: 'Queued', cls: 'chip-queued' },
        running: { label: 'Processing', cls: 'chip-running' },
        downloading: { label: 'Processing', cls: 'chip-running' },
        transcribing: { label: 'Processing', cls: 'chip-running' },
        extracting: { label: 'Extracting', cls: 'chip-running' },
        creating: { label: 'Creating recipe', cls: 'chip-running' },
        processing: { label: 'Processing', cls: 'chip-running' },
        uploading: { label: 'Uploading', cls: 'chip-uploading' },
        awaiting_approval: { label: 'Needs approval', cls: 'chip-approval' },
        completed: { label: 'Completed', cls: 'chip-done' },
        failed: { label: 'Failed', cls: 'chip-failed' },
        cancelled: { label: 'Cancelled', cls: 'chip-muted' },
        expired: { label: 'Expired', cls: 'chip-muted' },
    };

    function api(path, opts) {
        return fetch(path, Object.assign({
            headers: { 'Content-Type': 'application/json' },
        }, opts)).then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
            return body;
        });
    }

    function debounceReload(delay) {
        clearTimeout(state.reloadTimer);
        state.reloadTimer = setTimeout(load, delay == null ? 300 : delay);
    }

    function toast(message, isError) {
        let host = $('#tasks-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'tasks-toast';
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = 'task-toast' + (isError ? ' toast-error' : '');
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    }

    function updateCounts(counts) {
        if (!counts) return;
        const groups = {
            queued: (counts.queued || 0),
            processing: ((counts.running || 0) + (counts.uploading || 0)),
            awaiting_approval: (counts.awaiting_approval || 0),
        };
        $$('[data-count]').forEach((el) => {
            const v = groups[el.dataset.count] || 0;
            el.textContent = v ? String(v) : '';
        });

        // Sidebar badge stays live even outside the approval tab.
        const link = $('#approvals-badge');
        const n = counts.awaiting_approval || 0;
        if (link) {
            link.textContent = n;
            link.style.display = n ? '' : 'none';
        } else if (n) {
            const anchor = $('a[title="Tasks"]');
            if (anchor) {
                const span = document.createElement('span');
                span.className = 'nav-badge';
                span.id = 'approvals-badge';
                span.textContent = n;
                anchor.appendChild(span);
            }
        }
    }

    function cardFor(task) {
        const tpl = $('#task-card-template');
        const node = tpl.content.firstElementChild.cloneNode(true);
        node.dataset.jobId = task.id;

        const meta = STATUS_META[task.status] || { label: task.status, cls: 'chip-muted' };
        $('.task-status-chip', node).textContent = meta.label;
        $('.task-status-chip', node).classList.add(meta.cls);

        $('.task-title', node).textContent =
            task.video_title || task.url || 'Untitled';
        $('.task-message', node).textContent = task.stage_message || '';
        $('.task-url', node).textContent = task.url || '';
        $('.progress-bar', node).style.width = (task.progress || 0) + '%';
        $('.progress-text', node).textContent = (task.progress || 0) + '%';

        const isApproval = task.status === 'awaiting_approval';
        const isQueued = task.status === 'queued';
        const isActive = ['running', 'uploading'].includes(task.status);
        const isTerminal = ['completed', 'failed', 'cancelled', 'expired'].includes(task.status);

        $('.approve-btn', node).style.display =
            (isApproval && !isTerminal) ? '' : 'none';
        $('.reject-btn', node).style.display =
            (isApproval && !isTerminal) ? '' : 'none';
        $('.cancel-btn', node).style.display =
            (!isTerminal && !isApproval) ? '' : 'none';
        $('.priority-controls', node).style.display = isQueued ? '' : 'none';
        $('.task-progress-wrap', node).style.display =
            isActive ? '' : 'none';
        $('.task-select', node).style.display = isTerminal ? 'none' : '';

        if (isQueued) {
            $('.task-position', node).textContent = '#' + (task.queue_position || '?');
            $('.prio-up', node).addEventListener('click',
                () => shiftPriority(task, +1));
            $('.prio-down', node).addEventListener('click',
                () => shiftPriority(task, -1));
        }

        if (isApproval && task.pending_upload_id) {
            node.dataset.uploadId = task.pending_upload_id;
            $('.task-expiry', node).dataset.expires = task.approval_expires_at || '';
            attachGallery(node, task.pending_upload_id);
            $('.approve-btn', node).addEventListener('click', () =>
                decide(task.pending_upload_id, 'confirm', node.dataset.imageIndex));
            $('.reject-btn', node).addEventListener('click', () =>
                decide(task.pending_upload_id, 'cancel'));
        } else {
            $('.task-expiry', node).style.display = 'none';
        }

        $('.cancel-btn', node).addEventListener('click', async () => {
            try {
                await api('/api/jobs/' + task.id, { method: 'DELETE' });
                debounceReload(150);
            } catch (err) { toast(err.message, true); }
        });

        $('.task-select', node).addEventListener('change', function () {
            if (this.checked) state.selected.add(task.id);
            else state.selected.delete(task.id);
            syncBulkBar();
        });

        return node;
    }

    function shiftPriority(task, delta) {
        const current = Number(task.queue_priority || 0);
        api('/api/jobs/' + task.id + '/priority', {
            method: 'PATCH',
            body: JSON.stringify({ priority: current + delta }),
        }).then(() => debounceReload(150))
          .catch((err) => toast(err.message, true));
    }

    function attachGallery(node, uploadId) {
        api('/api/pending-uploads/' + uploadId).then((detail) => {
            const title = detail.recipe && detail.recipe.name;
            if (title) $('.task-title', node).textContent = title;
            const recipe = detail.recipe || {};
            const bits = [];
            if (recipe.ingredients) bits.push(recipe.ingredients.length + ' ingredients');
            if (recipe.instructions || recipe.steps) {
                bits.push((recipe.instructions || recipe.steps).length + ' steps');
            }
            if (bits.length) {
                $('.task-message', node).textContent = bits.join(' · ');
            }

            const gallery = $('.approval-gallery', node);
            const candidates = (detail.candidate_images || [])
                .filter((c) => c.data);
            if (!candidates.length && detail.image_data) {
                candidates.push({ index: 0, data: detail.image_data,
                                  is_best: true });
            }
            let chosen = null;
            candidates.forEach((cand) => {
                const img = document.createElement('img');
                img.src = 'data:image/jpeg;base64,' + cand.data;
                img.className = 'gallery-thumb' +
                    (cand.is_best ? ' best-candidate' : '');
                img.title = cand.is_best ? 'AI recommendation' : 'Candidate';
                img.addEventListener('click', () => {
                    $$('.gallery-thumb', node).forEach(
                        (t) => t.classList.remove('selected'));
                    img.classList.add('selected');
                    chosen = cand.index;
                    node.dataset.imageIndex = String(cand.index);
                });
                gallery.appendChild(img);
            });
            node.dataset.imageIndex = String(chosen != null
                ? chosen : (detail.best_image_index || 0));
        }).catch((err) => console.warn('[Tasks] detail load failed:', err));
    }

    function decide(uploadId, action, imageIndex) {
        const body = {};
        if (action === 'confirm' && imageIndex != null) {
            body.selected_image_index = Number(imageIndex);
        }
        api('/api/pending-uploads/' + uploadId + '/' + action, {
            method: 'POST',
            body: JSON.stringify(body),
        }).then(() => {
            toast(action === 'confirm' ? 'Approved — uploading…'
                                       : 'Rejected');
            debounceReload(250);
        }).catch((err) => toast(err.message, true));
    }

    function syncBulkBar() {
        const showBulk = ['active', 'awaiting_approval'].includes(state.tab)
            && state.selected.size > 0;
        $('#bulk-bar').style.display = showBulk ? '' : 'none';
        $('#bulk-summary').textContent = state.selected.size + ' selected';
        $('#select-all-label').style.display =
            ['active', 'awaiting_approval'].includes(state.tab) ? '' : 'none';
    }

    function bulkAction(action) {
        const ids = Array.from(state.selected);
        if (!ids.length) return;
        api('/api/tasks/bulk', {
            method: 'POST',
            body: JSON.stringify({ action: action, ids: ids }),
        }).then((res) => {
            toast(res.succeeded + ' ' + action + 'd, ' +
                  res.failed + ' skipped');
            state.selected.clear();
            $('#select-all').checked = false;
            debounceReload(250);
        }).catch((err) => toast(err.message, true));
    }

    function render(data) {
        updateCounts(data.counts);
        const list = $('#tasks-list');
        list.textContent = '';
        const tasks = data.tasks || [];
        $('#tasks-empty').style.display = tasks.length ? 'none' : '';
        tasks.forEach((task) => list.appendChild(cardFor(task)));
        syncBulkBar();
    }

    function load() {
        return api('/api/tasks?state=' + state.tab + '&limit=200')
            .then(render)
            .catch((err) => toast(err.message, true));
    }

    function switchTab(tabState) {
        state.tab = tabState;
        state.selected.clear();
        $('#select-all').checked = false;
        $$('.tab-btn').forEach((b) =>
            b.classList.toggle('active', b.dataset.state === tabState));
        load();
    }

    /* Expiry countdowns tick independently of reloads. */
    setInterval(() => {
        $$('[data-expires]').forEach((el) => {
            const iso = el.dataset.expires;
            if (!iso) return;
            const ms = new Date(iso.replace(' ', 'T') + 'Z') - Date.now();
            if (isNaN(ms)) return;
            if (ms <= 0) {
                el.textContent = 'expired';
                el.classList.add('expiring-soon');
            } else {
                const m = Math.floor(ms / 60000);
                const s = Math.floor((ms % 60000) / 1000);
                el.textContent = m + ':' + String(s).padStart(2, '0');
                el.classList.toggle('expiring-soon', ms < 60000);
            }
        });
    }, 1000);

    /* Live refresh: any relevant socket activity triggers one throttled reload. */
    const socket = io();
    ['job_progress', 'job_complete', 'job_failed', 'job_cancelled',
     'approval_confirmed', 'approval_rejected', 'approvals_updated']
        .forEach((evt) => socket.on(evt, () => debounceReload()));

    $('#task-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (btn) switchTab(btn.dataset.state);
    });
    $('#select-all').addEventListener('change', function () {
        state.selected.clear();
        if (this.checked) {
            $$('.task-card').forEach((card) => {
                const sel = $('.task-select', card);
                if (sel.style.display !== 'none') {
                    sel.checked = true;
                    state.selected.add(card.dataset.jobId);
                }
            });
        } else {
            $$('.task-select').forEach((c) => { c.checked = false; });
        }
        syncBulkBar();
    });
    $('#bulk-cancel').addEventListener('click', () => bulkAction('cancel'));
    $('#bulk-approve').addEventListener('click', () => bulkAction('approve'));
    $('#bulk-reject').addEventListener('click', () => bulkAction('reject'));

    load();
})();
