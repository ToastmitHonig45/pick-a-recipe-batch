document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('batch-upload-form');
    const fileInput = document.getElementById('batch-file');
    const uploadBtn = document.getElementById('batch-upload-btn');
    const refreshBtn = document.getElementById('batch-refresh-btn');
    const startBtn = document.getElementById('batch-start-btn');
    const pauseBtn = document.getElementById('batch-pause-btn');
    const resumeBtn = document.getElementById('batch-resume-btn');
    const cancelBtn = document.getElementById('batch-cancel-btn');
    const emptyState = document.getElementById('batch-empty-state');
    const shell = document.getElementById('batch-shell');
    const itemsEl = document.getElementById('batch-items');
    const totalEl = document.getElementById('batch-total');
    const pendingEl = document.getElementById('batch-pending');
    const successEl = document.getElementById('batch-success');
    const failedEl = document.getElementById('batch-failed');
    const progressBar = document.getElementById('batch-progress-bar');
    const progressText = document.getElementById('batch-progress-text');
    const statusPill = document.getElementById('batch-status-pill');
    const statusMessage = document.getElementById('batch-status-message');
    const downloadSuccessful = document.getElementById('download-successful');
    const downloadFailed = document.getElementById('download-failed');
    const downloadLog = document.getElementById('download-log');
    const storedKey = 'pick-a-recipe-active-batch-id';

    let activeBatch = (window.BATCH_CONFIG && window.BATCH_CONFIG.activeBatch) || null;
    let pollTimer = null;

    function setStoredBatchId(id) {
        if (!id) {
            localStorage.removeItem(storedKey);
            return;
        }
        localStorage.setItem(storedKey, id);
    }

    function humanizeStatus(value) {
        const map = {
            pending: 'Pending',
            running: 'Running',
            paused: 'Paused',
            cancelled: 'Cancelled',
            completed: 'Completed',
            failed: 'Failed',
            success: 'Successful',
            skipped_success: 'Already imported',
            duplicate: 'Duplicate',
            failed_item: 'Failed',
        };
        return map[value] || value || 'Unknown';
    }

    function renderBatch(batch) {
        activeBatch = batch || null;
        setStoredBatchId(activeBatch ? activeBatch.id : null);

        if (!activeBatch) {
            emptyState.style.display = 'block';
            shell.style.display = 'none';
            itemsEl.innerHTML = '';
            return;
        }

        emptyState.style.display = 'none';
        shell.style.display = 'block';

        totalEl.textContent = activeBatch.total_count ?? 0;
        pendingEl.textContent = activeBatch.pending_count ?? 0;
        successEl.textContent = activeBatch.success_count ?? 0;
        failedEl.textContent = activeBatch.failed_count ?? 0;

        const progress = activeBatch.progress ?? 0;
        progressBar.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;

        statusPill.textContent = humanizeStatus(activeBatch.status);
        statusMessage.textContent = activeBatch.error_message || 'Processing URLs sequentially';

        downloadSuccessful.href = `/api/batches/${activeBatch.id}/download/successful`;
        downloadFailed.href = `/api/batches/${activeBatch.id}/download/failed`;
        downloadLog.href = `/api/batches/${activeBatch.id}/download/log`;

        startBtn.disabled = activeBatch.status === 'running';
        pauseBtn.disabled = activeBatch.status !== 'running';
        resumeBtn.disabled = activeBatch.status !== 'paused';
        cancelBtn.disabled = ['completed', 'cancelled', 'failed'].includes(activeBatch.status);

        renderItems(activeBatch.items || []);
    }

    function renderItems(items) {
        if (!items.length) {
            itemsEl.innerHTML = '<div class="batch-empty-state"><p>No URLs found.</p></div>';
            return;
        }
        itemsEl.innerHTML = items.map((item) => {
            const status = humanizeStatus(item.status);
            const error = item.error_message ? `<p class="batch-item-error">${escapeHtml(item.error_message)}</p>` : '';
            return `
                <article class="batch-item">
                    <div class="batch-item-main">
                        <div class="batch-item-head">
                            <span class="status-pill mono">${escapeHtml(status)}</span>
                            <span class="mono">#${item.position}</span>
                            <span class="mono">Attempts: ${item.attempts || 0}</span>
                        </div>
                        <p class="batch-item-url">${escapeHtml(item.normalized_url || item.original_url)}</p>
                        ${error}
                    </div>
                </article>
            `;
        }).join('');
    }

    function escapeHtml(text) {
        return String(text || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    async function refreshActiveBatch() {
        try {
            const response = await fetch('/api/batches/active');
            const data = await response.json();
            renderBatch(data.batch || null);
        } catch (error) {
            console.error('Batch refresh failed', error);
        }
    }

    async function refreshBatchById(batchId) {
        if (!batchId) {
            await refreshActiveBatch();
            return;
        }
        try {
            const response = await fetch(`/api/batches/${batchId}`);
            const data = await response.json();
            renderBatch(data.batch || null);
        } catch (error) {
            console.error('Batch refresh failed', error);
        }
    }

    async function sendAction(action) {
        if (!activeBatch) {
            return;
        }
        const response = await fetch(`/api/batches/${activeBatch.id}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Batch action failed');
        }
        renderBatch(data.batch || activeBatch);
    }

    async function startUpload(event) {
        event.preventDefault();
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
            return;
        }
        uploadBtn.disabled = true;
        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/batches', {
                method: 'POST',
                body: formData,
            });
            const data = await response.json();
            if (!response.ok || data.error) {
                throw new Error(data.error || 'Upload failed');
            }
            renderBatch(data.batch || null);
            fileInput.value = '';
        } catch (error) {
            alert(error.message || 'Upload failed');
        } finally {
            uploadBtn.disabled = false;
        }
    }

    if (form) {
        form.addEventListener('submit', startUpload);
    }
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => refreshBatchById(activeBatch && activeBatch.id));
    }
    if (startBtn) {
        startBtn.addEventListener('click', () => sendAction('start').catch((error) => alert(error.message)));
    }
    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => sendAction('pause').catch((error) => alert(error.message)));
    }
    if (resumeBtn) {
        resumeBtn.addEventListener('click', () => sendAction('resume').catch((error) => alert(error.message)));
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => sendAction('cancel').catch((error) => alert(error.message)));
    }

    const storedBatchId = localStorage.getItem(storedKey);
    if (activeBatch) {
        setStoredBatchId(activeBatch.id);
    } else if (storedBatchId) {
        refreshBatchById(storedBatchId);
    } else {
        refreshActiveBatch();
    }

    pollTimer = window.setInterval(() => {
        if (activeBatch && !['completed', 'cancelled', 'failed'].includes(activeBatch.status)) {
            refreshBatchById(activeBatch.id);
        } else {
            refreshActiveBatch();
        }
    }, 5000);

    window.addEventListener('beforeunload', () => {
        if (pollTimer) {
            window.clearInterval(pollTimer);
        }
    });
});
