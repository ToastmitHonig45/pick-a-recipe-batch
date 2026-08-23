/* Unified dashboard: live tasks + finished recipes ("Done") merged into one table.
 *
 * Data sources:
 *   /api/tasks?state=all  -> every job (queued/running/approval/terminal) with live data
 *   /api/recipes          -> recipe_history entries (rendered as "Done" tasks)
 *
 * History rows win over their twin terminal job rows (matched by job_id) so the
 * richer record (thumbnail, recipe name, output target) is what gets shown.
 */
(function () {
    'use strict';

    const state = {
        rows: [],            // merged, sorted row models
        selected: new Set(), // selection keys: job ids or 'h<id>' for history rows
        search: '',
        filter: '',          // '' | approval | running | queued | done | failed | cancelled
        reloadTimer: null,
    };
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    const STATUS_META = {
        queued: { label: 'Queued', cls: 'chip-queued' },
        pending: { label: 'Queued', cls: 'chip-queued' },
        running: { label: 'Processing', cls: 'chip-running' },
        downloading: { label: 'Processing', cls: 'chip-running' },
        transcribing: { label: 'Processing', cls: 'chip-running' },
        extracting: { label: 'Extracting', cls: 'chip-running' },
        creating: { label: 'Creating recipe', cls: 'chip-running' },
        processing: { label: 'Processing', cls: 'chip-running' },
        uploading: { label: 'Uploading', cls: 'chip-uploading' },
        awaiting_approval: { label: 'Needs approval', cls: 'chip-approval' },
        success: { label: 'Done', cls: 'chip-done' },
        completed: { label: 'Done', cls: 'chip-done' },
        failed: { label: 'Failed', cls: 'chip-failed' },
        cancelled: { label: 'Cancelled', cls: 'chip-muted' },
        expired: { label: 'Expired', cls: 'chip-muted' },
    };

    const TERMINAL = ['success', 'completed', 'failed', 'cancelled', 'expired'];

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

    /* ===== Row normalization & merge ===== */

    function bucketOf(status) {
        if (status === 'awaiting_approval') return 'approval';
        if (status === 'queued' || status === 'pending') return 'queued';
        if (status === 'success' || status === 'completed') return 'done';
        if (status === 'failed') return 'failed';
        if (status === 'cancelled' || status === 'expired') return 'cancelled';
        return 'running';
    }

    function tsOf(row) {
        const t = Date.parse((row.updatedAt || row.createdAt || '').replace(' ', 'T'));
        return isNaN(t) ? 0 : t;
    }

    function normalizeTask(t) {
        return {
            kind: 'job',
            key: String(t.id),
            jobId: String(t.id),
            historyId: null,
            status: t.status,
            bucket: bucketOf(t.status),
            title: t.video_title || t.url || 'Untitled',
            url: t.url || '',
            message: t.stage_message || '',
            error: t.error_message || '',
            progress: t.progress || 0,
            thumbnailData: null,
            outputTarget: null,
            pendingUploadId: t.pending_upload_id || null,
            approvalExpiresAt: t.approval_expires_at || '',
            queuePosition: t.queue_position || null,
            queuePriority: t.queue_priority || 0,
            createdAt: t.created_at || '',
            updatedAt: t.updated_at || '',
        };
    }

    function normalizeHistory(r) {
        return {
            kind: 'history',
            key: 'h' + r.id,
            jobId: r.job_id || null,
            historyId: r.id,
            status: r.status,
            bucket: bucketOf(r.status),
            title: r.recipe_name || r.video_title || r.url || 'Untitled Recipe',
            url: r.url || '',
            message: '',
            error: r.error_message || '',
            progress: 0,
            thumbnailData: r.thumbnail_data || null,
            outputTarget: r.output_target || null,
            pendingUploadId: null,
            approvalExpiresAt: '',
            queuePosition: null,
            createdAt: r.created_at || '',
            updatedAt: r.updated_at || r.created_at || '',
        };
    }

    const BUCKET_ORDER = { approval: 0, running: 1, queued: 2, done: 3, failed: 3, cancelled: 3 };

    function mergeRows(tasks, counts, recipes) {
        updateCounts(counts);

        const byJobId = new Map(tasks.map((t) => [String(t.id), t]));
        const rows = [];

        (recipes || []).forEach((r) => {
            if (r.source_type !== 'history') return; // live jobs come from /api/tasks
            // A finished recipe supersedes its terminal twin job row.
            if (r.job_id && byJobId.has(String(r.job_id))) byJobId.delete(String(r.job_id));
            rows.push(normalizeHistory(r));
        });
        byJobId.forEach((t) => rows.push(normalizeTask(t)));

        // One table: actionable items on top, finished ones newest-first below.
        rows.sort((a, b) => {
            const wa = BUCKET_ORDER[a.bucket] != null ? BUCKET_ORDER[a.bucket] : 9;
            const wb = BUCKET_ORDER[b.bucket] != null ? BUCKET_ORDER[b.bucket] : 9;
            if (wa !== wb) return wa - wb;
            return tsOf(b) - tsOf(a);
        });

        state.rows = rows;
        render();
    }

    function updateCounts(counts) {
        if (!counts) return;

        // Sidebar badge stays live at all times.
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

    /* ===== Filtering & rendering ===== */

    function visibleRows() {
        const q = state.search.trim().toLowerCase();
        return state.rows.filter((r) => {
            if (state.filter && r.bucket !== state.filter) return false;
            if (!q) return true;
            return (r.title || '').toLowerCase().includes(q)
                || (r.url || '').toLowerCase().includes(q);
        });
    }

    function findRow(key) {
        return state.rows.find((r) => r.key === key) || null;
    }

    function cardFor(row) {
        const tpl = $('#task-card-template');
        const node = tpl.content.firstElementChild.cloneNode(true);
        node.dataset.rowKey = row.key;

        const meta = STATUS_META[row.status] || { label: row.status, cls: 'chip-muted' };
        $('.task-status-chip', node).textContent = meta.label;
        $('.task-status-chip', node).classList.add(meta.cls);

        $('.task-title', node).textContent = row.title;
        $('.task-message', node).textContent =
            row.message || (row.bucket === 'done' && row.outputTarget
                ? 'Uploaded to ' + row.outputTarget : '');
        $('.task-url', node).textContent = truncateUrl(row.url);

        const thumbWrap = $('.task-thumb', node);
        if (row.thumbnailData) {
            const img = document.createElement('img');
            img.src = 'data:image/jpeg;base64,' + row.thumbnailData;
            img.alt = '';
            thumbWrap.appendChild(img);
        } else {
            thumbWrap.style.display = 'none';
        }

        const isTerminal = TERMINAL.includes(row.status);
        const isApproval = row.bucket === 'approval';
        const isActive = ['running', 'uploading'].includes(row.status);
        const isQueued = row.bucket === 'queued';

        $('.progress-bar', node).style.width = row.progress + '%';
        $('.progress-text', node).textContent = row.progress + '%';

        $('.approve-btn', node).style.display = isApproval ? '' : 'none';
        $('.reject-btn', node).style.display = isApproval ? '' : 'none';
        $('.cancel-btn', node).style.display = (!isTerminal && !isApproval) ? '' : 'none';
        $('.priority-controls', node).style.display = isQueued ? '' : 'none';
        $('.task-progress-wrap', node).style.display = isActive ? '' : 'none';

        $('.view-btn', node).style.display = row.kind === 'history' ? '' : 'none';
        $('.reupload-btn', node).style.display =
            (row.kind === 'history' && row.status === 'success') ? '' : 'none';
        $('.retry-btn', node).style.display = row.status === 'failed' ? '' : 'none';
        $('.del-btn', node).style.display = isTerminal ? '' : 'none';

        const checkbox = $('.task-select', node);
        checkbox.checked = state.selected.has(row.key);

        if (isApproval && row.pendingUploadId) {
            node.dataset.uploadId = row.pendingUploadId;
            $('.task-expiry', node).dataset.expires = row.approvalExpiresAt || '';
            attachGallery(node, row.pendingUploadId);
            $('.approve-btn', node).addEventListener('click', () =>
                decide(row.pendingUploadId, 'confirm', node.dataset.imageIndex));
            $('.reject-btn', node).addEventListener('click', () =>
                decide(row.pendingUploadId, 'cancel'));
        } else {
            $('.task-expiry', node).style.display = 'none';
        }

        if (isQueued) {
            $('.task-position', node).textContent = '#' + (row.queuePosition || '?');
            $('.prio-up', node).addEventListener('click', () =>
                shiftPriority(row.jobId, +1));
            $('.prio-down', node).addEventListener('click', () =>
                shiftPriority(row.jobId, -1));
        } else {
            $('.task-position', node).style.display = 'none';
        }

        $('.cancel-btn', node).addEventListener('click', async () => {
            try {
                await api('/api/jobs/' + row.jobId, { method: 'DELETE' });
                debounceReload(150);
            } catch (err) { toast(err.message, true); }
        });

        $('.view-btn', node).addEventListener('click', (e) => {
            e.stopPropagation();
            showRecipeDetails(row.historyId);
        });

        $('.reupload-btn', node).addEventListener('click', (e) => {
            e.stopPropagation();
            showRecipeDetails(row.historyId);
        });

        $('.retry-btn', node).addEventListener('click', (e) => {
            e.stopPropagation();
            retryAnalysis(row.url, row.historyId);
        });

        $('.del-btn', node).addEventListener('click', (e) => {
            e.stopPropagation();
            openConfirmDelete(row);
        });

        checkbox.addEventListener('change', function () {
            if (this.checked) state.selected.add(row.key);
            else state.selected.delete(row.key);
            syncBulkBar();
        });

        return node;
    }

    function render() {
        const list = $('#tasks-list');
        list.textContent = '';
        const rows = visibleRows();
        $('#tasks-empty').style.display = rows.length ? 'none' : '';
        $('#empty-text').textContent = state.rows.length
            ? 'No matches for the current search or filter.'
            : 'Nothing here right now.';
        rows.forEach((row) => list.appendChild(cardFor(row)));
        syncBulkBar();
    }

    /* ===== Actions ===== */

    function shiftPriority(jobId, delta) {
        const row = findRow(jobId);
        const current = Number((row && row.queuePriority) || 0);
        api('/api/jobs/' + jobId + '/priority', {
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

    function showRecipeDetails(historyId) {
        fetch('/api/history/' + historyId)
            .then((r) => r.json())
            .then((item) => {
                if (item.error) { toast(item.error, true); return; }
                fillRecipeModal(item);
            })
            .catch(() => toast('Failed to load recipe details', true));
    }

    function fillRecipeModal(item) {
        $('#modal-recipe-name').textContent =
            item.recipe_name || item.video_title || 'Recipe Details';

        const imageContainer = $('#modal-image-container');
        const image = $('#modal-recipe-image');
        if (item.thumbnail_data) {
            image.src = 'data:image/jpeg;base64,' + item.thumbnail_data;
            imageContainer.style.display = 'block';
        } else {
            imageContainer.style.display = 'none';
        }

        $('#modal-source-url').href = item.url || '#';
        $('#modal-source-url').textContent = truncateUrl(item.url);
        $('#modal-created-at').textContent = formatDate(item.created_at);
        $('#modal-target').textContent = item.output_target || 'N/A';

        const recipe = item.recipe_data || {};
        $('#modal-description').textContent = recipe.description || '';

        const ingredientsList = $('#modal-ingredients');
        const ingredientsSection = $('#modal-ingredients-section');
        if (recipe.recipeIngredient && recipe.recipeIngredient.length > 0) {
            ingredientsList.innerHTML = recipe.recipeIngredient.map((ing) =>
                '<li>' + escapeHtml(ing) + '</li>').join('');
            ingredientsSection.style.display = 'block';
        } else {
            ingredientsSection.style.display = 'none';
        }

        const instructionsList = $('#modal-instructions');
        const instructionsSection = $('#modal-instructions-section');
        if (recipe.recipeInstructions && recipe.recipeInstructions.length > 0) {
            instructionsList.innerHTML = recipe.recipeInstructions.map((inst) => {
                const text = typeof inst === 'object' ? inst.text : inst;
                return '<li>' + escapeHtml(text) + '</li>';
            }).join('');
            instructionsSection.style.display = 'block';
        } else {
            instructionsSection.style.display = 'none';
        }

        $('#delete-recipe-btn').dataset.historyId = item.id;
        $('#reupload-recipe-btn').style.display =
            (item.status === 'success' && item.recipe_data) ? 'inline-flex' : 'none';

        $('#recipe-modal').style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    function hideRecipeModal() {
        $('#recipe-modal').style.display = 'none';
        document.body.style.overflow = '';
    }

    function reuploadRecipe(historyId, target) {
        toast('Re-uploading to ' + target + '…');
        api('/api/history/' + historyId + '/reupload', {
            method: 'POST',
            body: JSON.stringify({ target: target }),
        }).then(() => toast('Recipe re-uploaded to ' + target + '!'))
          .catch((err) => toast(err.message, true));
    }

    function retryAnalysis(url, historyId) {
        api('/api/jobs/retry', {
            method: 'POST',
            body: JSON.stringify({ url: url, history_id: historyId }),
        }).then((data) => {
            toast('Retry started!');
            window.location.href = '/jobs/' + data.job_id;
        }).catch((err) => toast(err.message, true));
    }

    function deleteSelection(rowKey) {
        const row = findRow(rowKey);
        if (!row) return;
        const call = row.kind === 'history'
            ? api('/api/history/' + row.historyId, { method: 'DELETE' })
            : api('/api/jobs/' + row.jobId + '/delete', { method: 'DELETE' });
        call.then(() => {
            toast('Item deleted successfully');
            debounceReload(150);
        }).catch((err) => toast(err.message, true));
    }

    function bulkDeleteSelected() {
        const historyIds = [];
        const jobIds = [];
        state.selected.forEach((key) => {
            if (key.startsWith('h')) historyIds.push(parseInt(key.slice(1), 10));
            else jobIds.push(key);
        });
        if (!historyIds.length && !jobIds.length) return;
        api('/api/history/bulk-delete', {
            method: 'POST',
            body: JSON.stringify({ history_ids: historyIds, job_ids: jobIds }),
        }).then((data) => {
            toast('Deleted ' + data.deleted_count + ' items');
            state.selected.clear();
            $('#select-all').checked = false;
            debounceReload(250);
        }).catch((err) => toast(err.message, true));
    }

    /* ===== Bulk bar ===== */

    function syncBulkBar() {
        const count = state.selected.size;
        $('#bulk-summary').textContent = count + ' selected';
        $('#bulk-bar').style.display = count ? '' : 'none';
        $('#select-all-label').style.display = state.rows.length ? '' : 'none';

        let hasApproval = false;
        let hasCancellable = false;
        state.selected.forEach((key) => {
            const row = findRow(key);
            if (!row) return;
            if (row.bucket === 'approval') hasApproval = true;
            if (!TERMINAL.includes(row.status) && row.bucket !== 'approval') {
                hasCancellable = true;
            }
        });
        $('#bulk-approve').style.display = hasApproval ? '' : 'none';
        $('#bulk-reject').style.display = hasApproval ? '' : 'none';
        $('#bulk-cancel').style.display = hasCancellable ? '' : 'none';
    }

    function bulkAction(action) {
        const ids = Array.from(state.selected).filter((k) => !k.startsWith('h'));
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

    /* ===== Data loading ===== */

    function load() {
        return Promise.all([
            api('/api/tasks?state=all&limit=300'),
            api('/api/recipes?limit=300'),
        ]).then(([tasksRes, recipesRes]) => {
            mergeRows(tasksRes.tasks || [], tasksRes.counts, recipesRes.items || []);
        }).catch((err) => toast(err.message, true));
    }

    /* ===== Expiry countdowns tick independently of reloads. ===== */
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

    /* Slow poll keeps Done rows fresh even without socket coverage. */
    setInterval(load, 15000);

    /* ===== Static wiring ===== */
    $('#task-search').addEventListener('input', debounce(() => {
        state.search = $('#task-search').value;
        render();
    }, 200));

    $('#task-filter').addEventListener('change', function () {
        state.filter = this.value;
        render();
    });

    $('#refresh-tasks').addEventListener('click', load);

    $('#select-all').addEventListener('change', function () {
        state.selected.clear();
        if (this.checked) {
            $$('.task-card').forEach((card) => {
                const sel = $('.task-select', card);
                sel.checked = true;
                state.selected.add(card.dataset.rowKey);
            });
        } else {
            $$('.task-select').forEach((c) => { c.checked = false; });
        }
        syncBulkBar();
    });

    $('#bulk-cancel').addEventListener('click', () => bulkAction('cancel'));
    $('#bulk-approve').addEventListener('click', () => bulkAction('approve'));
    $('#bulk-reject').addEventListener('click', () => bulkAction('reject'));
    $('#bulk-delete').addEventListener('click', () => {
        $('#bulk-delete-count').textContent = state.selected.size;
        $('#confirm-bulk-delete-modal').style.display = 'flex';
    });

    function openConfirmDelete(row) {
        $('#confirm-delete-btn').dataset.rowKey = row.key;
        $('#confirm-delete-modal').style.display = 'flex';
    }

    /* Modal wiring */
    $('#close-recipe-modal').addEventListener('click', hideRecipeModal);

    $('#delete-recipe-btn').addEventListener('click', function () {
        const row = findRow('h' + this.dataset.historyId);
        if (row) openConfirmDelete(row);
    });


    $('#reupload-recipe-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        $('#reupload-menu').classList.toggle('show');
    });

    $$('.reupload-option').forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const historyId = $('#delete-recipe-btn').dataset.historyId;
            if (historyId) reuploadRecipe(historyId, target);
            $('#reupload-menu').classList.remove('show');
        });
    });

    $('#cancel-delete-btn').addEventListener('click', () => {
        $('#confirm-delete-modal').style.display = 'none';
    });

    $('#confirm-delete-btn').addEventListener('click', function () {
        $('#confirm-delete-modal').style.display = 'none';
        hideRecipeModal();
        deleteSelection(this.dataset.rowKey);
    });

    $('#cancel-bulk-delete-btn').addEventListener('click', () => {
        $('#confirm-bulk-delete-modal').style.display = 'none';
    });

    $('#confirm-bulk-delete-btn').addEventListener('click', () => {
        $('#confirm-bulk-delete-modal').style.display = 'none';
        bulkDeleteSelected();
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.reupload-dropdown')) {
            $('#reupload-menu').classList.remove('show');
        }
    });

    ['recipe-modal', 'confirm-delete-modal', 'confirm-bulk-delete-modal']
        .forEach((id) => {
            const modal = $('#' + id);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                    if (id === 'recipe-modal') hideRecipeModal();
                }
            });
        });

    /* ===== Utility functions ===== */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function truncateUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            return parsed.hostname + parsed.pathname.slice(0, 30)
                + (parsed.pathname.length > 30 ? '…' : '');
        } catch {
            return url.slice(0, 50) + (url.length > 50 ? '…' : '');
        }
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(String(dateStr).replace(' ', 'T'));
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' minutes ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
        if (diff < 604800000) return Math.floor(diff / 86400000) + ' days ago';

        return date.toLocaleDateString();
    }

    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait == null ? 300 : wait);
        };
    }

    load();
})();
