/* Unified dashboard: live tasks + finished recipes merged into one table.
 *
 * Rows come from two sources and are reconciled by job_id:
 *   /api/tasks?state=all  -> every job (queued/running/approval/terminal)
 *   /api/recipes          -> recipe_history records (shown as Done/Failed rows)
 *
 * A history record always supersedes its twin terminal job row. While a retry
 * is in flight, the job's retry_from_history_id marks the old record as
 * superseded: neither the stale failure nor its twin job row is shown.
 */
(function () {
    'use strict';

    const state = {
        rows: [],
        selected: new Set(),
        search: '',
        filter: '',
        loaded: false,
        reloadTimer: null,
    };
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    const STATUS_META = {
        queued: { label: 'Queued', cls: 'is-queued' },
        pending: { label: 'Queued', cls: 'is-queued' },
        running: { label: 'Processing', cls: 'is-running' },
        downloading: { label: 'Downloading', cls: 'is-running' },
        transcribing: { label: 'Transcribing', cls: 'is-running' },
        extracting: { label: 'Extracting', cls: 'is-running' },
        creating: { label: 'Creating recipe', cls: 'is-running' },
        processing: { label: 'Processing', cls: 'is-running' },
        uploading: { label: 'Uploading', cls: 'is-running' },
        awaiting_approval: { label: 'Needs approval', cls: 'is-approval' },
        success: { label: 'Done', cls: 'is-done' },
        completed: { label: 'Done', cls: 'is-done' },
        failed: { label: 'Failed', cls: 'is-failed' },
        cancelled: { label: 'Cancelled', cls: 'is-muted' },
        expired: { label: 'Expired', cls: 'is-muted' },
    };

    const TERMINAL = ['success', 'completed', 'failed', 'cancelled', 'expired'];
    const GROUP_OF = {
        approval: 'Needs you',
        running: 'In flight',
        queued: 'In flight',
        done: 'Settled',
        failed: 'Settled',
        cancelled: 'Settled',
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

    /* ===== Row model ===== */

    function bucketOf(status) {
        if (status === 'awaiting_approval') return 'approval';
        if (status === 'queued' || status === 'pending') return 'queued';
        if (status === 'success' || status === 'completed') return 'done';
        if (status === 'failed') return 'failed';
        if (status === 'cancelled' || status === 'expired') return 'cancelled';
        return 'running';
    }

    function tsOf(row) {
        const t = Date.parse(String(row.updatedAt || row.createdAt || '').replace(' ', 'T'));
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
            title: t.video_title || hostOf(t.url) || 'Untitled',
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
            title: r.recipe_name || r.video_title || hostOf(r.url) || 'Untitled Recipe',
            url: r.url || '',
            message: '',
            error: r.error_message || '',
            progress: 0,
            thumbnailData: r.thumbnail_data || null,
            outputTarget: r.output_target || null,
            pendingUploadId: null,
            approvalExpiresAt: '',
            queuePosition: null,
            queuePriority: 0,
            createdAt: r.created_at || '',
            updatedAt: r.updated_at || r.created_at || '',
        };
    }

    function hostOf(url) {
        if (!url) return '';
        try { return new URL(url).hostname.replace(/^www\./, ''); }
        catch { return ''; }
    }

    /* ===== Merge ===== */

    const BUCKET_ORDER = { approval: 0, running: 1, queued: 2, done: 3, failed: 3, cancelled: 3 };

    function mergeRows(tasks, counts, recipes) {
        updateCounts(counts);

        const byJobId = new Map(tasks.map((t) => [String(t.id), t]));

        // Retries in flight supersede the failure record they were launched from.
        const superseded = new Set(tasks
            .filter((t) => !TERMINAL.includes(t.status) && t.retry_from_history_id)
            .map((t) => String(t.retry_from_history_id)));

        const rows = [];
        (recipes || []).forEach((r) => {
            if (r.source_type !== 'history') return;
            const twinKey = r.job_id ? String(r.job_id) : null;
            const twin = twinKey ? byJobId.get(twinKey) : null;
            if (superseded.has(String(r.id))) {
                if (twin) byJobId.delete(twinKey);
                return;
            }
            if (twin) byJobId.delete(twinKey);
            rows.push(normalizeHistory(r));
        });
        byJobId.forEach((t) => rows.push(normalizeTask(t)));

        rows.sort((a, b) => {
            const wa = BUCKET_ORDER[a.bucket] != null ? BUCKET_ORDER[a.bucket] : 9;
            const wb = BUCKET_ORDER[b.bucket] != null ? BUCKET_ORDER[b.bucket] : 9;
            if (wa !== wb) return wa - wb;
            return tsOf(b) - tsOf(a);
        });

        state.rows = rows;
        state.loaded = true;
        render();
    }

    function updateCounts(counts) {
        if (!counts) return;
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

    /* ===== Rendering ===== */

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

    function groupLabelNode(label, count) {
        const el = document.createElement('div');
        el.className = 'task-group-label';
        const name = document.createElement('span');
        name.textContent = label;
        const num = document.createElement('i');
        num.textContent = count;
        el.append(name, num);
        return el;
    }

    function render() {
        const list = $('#tasks-list');
        list.textContent = '';

        if (!state.loaded) {
            for (let i = 0; i < 4; i++) {
                const sk = document.createElement('div');
                sk.className = 'task-card skeleton';
                list.appendChild(sk);
            }
            $('#tasks-empty').style.display = 'none';
            return;
        }

        const rows = visibleRows();
        $('#tasks-empty').style.display = rows.length ? 'none' : '';
        $('#empty-text').textContent = state.rows.length
            ? 'Nothing matches the current search or filter.'
            : 'Nothing here right now.';

        const countsByGroup = {};
        rows.forEach((r) => {
            const g = GROUP_OF[r.bucket];
            countsByGroup[g] = (countsByGroup[g] || 0) + 1;
        });

        let lastGroup = null;
        let delay = 0;
        rows.forEach((row) => {
            const group = GROUP_OF[row.bucket];
            if (group !== lastGroup) {
                lastGroup = group;
                list.appendChild(groupLabelNode(group, countsByGroup[group]));
                delay = 0;
            }
            const card = cardFor(row);
            card.style.animationDelay = Math.min(delay * 40, 240) + 'ms';
            delay++;
            list.appendChild(card);
        });

        syncBulkBar();
    }

    function menuButton(label, icon, handler, danger) {
        const btn = document.createElement('button');
        btn.className = 'menu-item' + (danger ? ' is-danger' : '');
        btn.innerHTML = '<i class="fas ' + icon + '"></i>' + escapeHtml(label);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenus();
            handler();
        });
        return btn;
    }

    function cardFor(row) {
        const tpl = $('#task-card-template');
        const node = tpl.content.firstElementChild.cloneNode(true);
        node.dataset.rowKey = row.key;

        const meta = STATUS_META[row.status] || { label: row.status, cls: 'is-muted' };
        const chip = $('.status-pill', node);
        chip.classList.add(meta.cls);
        $('.pill-dot', node).classList.add(meta.cls);
        $('.pill-text', node).textContent = meta.label;

        $('.task-title', node).textContent = row.title;

        const bits = [relativeTime(row.updatedAt || row.createdAt)];
        if (row.bucket === 'done' && row.outputTarget) bits.push('→ ' + row.outputTarget);
        const host = hostOf(row.url);
        if (host && row.bucket === 'done') bits.push(host);
        if (row.kind === 'history' && row.status === 'failed' && row.error) {
            bits.push(row.error.length > 80 ? row.error.slice(0, 80) + '…' : row.error);
        }
        $('.task-meta', node).innerHTML = bits.filter(Boolean).map(escapeHtml)
            .join('<span class="meta-sep">·</span>');

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

        const primary = $('.primary-action', node);
        const menu = $('.task-menu-items', node);

        if (isApproval) {
            primary.innerHTML = '<i class="fas fa-check"></i> Approve';
            primary.classList.add('btn-approve');
            primary.addEventListener('click', () =>
                decide(row.pendingUploadId, 'confirm', node.dataset.imageIndex));
            menu.appendChild(menuButton('Reject', 'fa-times',
                () => decide(row.pendingUploadId, 'cancel'), true));
        } else if (row.status === 'failed') {
            primary.innerHTML = '<i class="fas fa-redo"></i> Retry';
            primary.classList.add('btn-retry');
            primary.addEventListener('click', () => retryAnalysis(row.url, row.historyId));
        } else if (row.kind === 'history' && row.status === 'success') {
            primary.innerHTML = '<i class="fas fa-eye"></i> View';
            primary.classList.add('btn-view');
            primary.addEventListener('click', () => showRecipeDetails(row.historyId));
        } else {
            primary.style.display = 'none';
        }

        if (isApproval && row.pendingUploadId) {
            node.dataset.uploadId = row.pendingUploadId;
            $('.expiry', node).dataset.expires = row.approvalExpiresAt || '';
            attachGallery(node, row.pendingUploadId);
            node.classList.add('card-approval');
        }

        if (isQueued) {
            const pos = $('.queue-pos', node);
            pos.textContent = '#' + (row.queuePosition || '?');
            pos.style.display = '';
            menu.appendChild(menuButton('Move earlier', 'fa-arrow-up',
                () => shiftPriority(row.jobId, +1)));
            menu.appendChild(menuButton('Move later', 'fa-arrow-down',
                () => shiftPriority(row.jobId, -1)));
        }

        if (!isTerminal && !isApproval) {
            menu.appendChild(menuButton('Cancel job', 'fa-ban', async () => {
                try {
                    await api('/api/jobs/' + row.jobId, { method: 'DELETE' });
                    debounceReload(150);
                } catch (err) { toast(err.message, true); }
            }, true));
        }

        if (row.kind === 'history' && row.status === 'success') {
            menu.appendChild(menuButton('Re-upload to Tandoor', 'fa-utensils',
                () => reuploadRecipe(row.historyId, 'tandoor')));
            menu.appendChild(menuButton('Re-upload to Mealie', 'fa-book',
                () => reuploadRecipe(row.historyId, 'mealie')));
        }

        if (isTerminal) {
            menu.appendChild(menuButton('Delete', 'fa-trash',
                () => openConfirmDelete(row), true));
        }

        const kebab = $('.kebab-btn', node);
        kebab.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = $('.task-menu', node).classList.contains('open');
            closeMenus();
            if (!wasOpen) $('.task-menu', node).classList.add('open');
        });
        if (!menu.children.length && primary.style.display === 'none') {
            $('.task-side', node).style.display = 'none';
        }

        const checkbox = $('.task-select', node);
        checkbox.checked = state.selected.has(row.key);
        checkbox.addEventListener('change', function () {
            if (this.checked) state.selected.add(row.key);
            else state.selected.delete(row.key);
            syncBulkBar();
        });

        if (row.kind === 'history' && row.status === 'success') {
            node.addEventListener('click', (e) => {
                if (e.target.closest('.task-select, .task-side')) return;
                showRecipeDetails(row.historyId);
            });
        }

        return node;
    }

    function closeMenus() {
        $$('.task-menu.open').forEach((m) => m.classList.remove('open'));
    }

    document.addEventListener('click', closeMenus);

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
                $('.gallery-summary', node).textContent = bits.join(' · ');
            }

            const gallery = $('.approval-gallery', node);
            const candidates = (detail.candidate_images || []).filter((c) => c.data);
            if (!candidates.length && detail.image_data) {
                candidates.push({ index: 0, data: detail.image_data, is_best: true });
            }
            let chosen = null;
            candidates.forEach((cand) => {
                const img = document.createElement('img');
                img.src = 'data:image/jpeg;base64,' + cand.data;
                img.className = 'gallery-thumb' + (cand.is_best ? ' best-candidate' : '');
                img.title = cand.is_best ? 'AI recommendation' : 'Candidate';
                img.addEventListener('click', () => {
                    $$('.gallery-thumb', node).forEach((t) => t.classList.remove('selected'));
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
            toast(action === 'confirm' ? 'Approved — uploading…' : 'Rejected');
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
        $('#modal-source-url').textContent = item.url || '';
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
        $('#select-all-label').style.display =
            state.loaded && state.rows.length ? '' : 'none';

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
            toast(res.succeeded + ' ' + action + 'd, ' + res.failed + ' skipped');
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
        }).catch((err) => {
            state.loaded = true;
            render();
            toast(err.message, true);
        });
    }

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

    const socket = io();
    ['job_progress', 'job_complete', 'job_failed', 'job_cancelled',
     'approval_confirmed', 'approval_rejected', 'approvals_updated']
        .forEach((evt) => socket.on(evt, () => debounceReload()));

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

    /* ===== Utilities ===== */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function relativeTime(dateStr) {
        if (!dateStr) return '';
        const date = new Date(String(dateStr).replace(' ', 'T'));
        const diff = Date.now() - date;
        if (isNaN(diff)) return '';
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
        return date.toLocaleDateString();
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(String(dateStr).replace(' ', 'T'));
        return date.toLocaleString();
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
