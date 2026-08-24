"""Persistent batch import support for Pick-a-Recipe."""

from __future__ import annotations

import multiprocessing as mp
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlsplit, urlunsplit

from database import DATA_DIR, get_db

BATCH_ROOT = Path(DATA_DIR) / 'batch_imports'
BATCH_LOG_NAME = 'batch.log'
SOURCE_NAME = 'source.txt'

URL_TIMEOUT_SECONDS = int(os.environ.get('BATCH_URL_TIMEOUT_SECONDS', '3600'))
PAUSE_BETWEEN_URLS_SECONDS = 5
MAX_ATTEMPTS = 3

SUCCESS_STATUSES = {'success', 'skipped_success'}
TERMINAL_BATCH_STATUSES = {'completed', 'paused', 'cancelled', 'failed'}
ITEM_PENDING = 'pending'
ITEM_RUNNING = 'running'
ITEM_SUCCESS = 'success'
ITEM_SKIPPED = 'skipped_success'
ITEM_FAILED = 'failed'
ITEM_CANCELLED = 'cancelled'
ITEM_DUPLICATE = 'duplicate'

_TEMPORARY_PATTERNS = (
    'timed out', 'timeout', 'connection reset', 'connection aborted',
    'temporar', 'temporary', 'try again', 'rate limit', '429', '502', '503',
    '504', 'gateway', 'network', 'dns', 'unreachable', 'reset by peer',
)
_PERMANENT_PATTERNS = (
    'private', 'deleted', 'unavailable', 'not available', 'login required',
    'access denied', 'forbidden', '404', 'video unavailable',
    'this video is private', 'could not get video data',
)


def _batch_dir(batch_id: str) -> Path:
    return BATCH_ROOT / batch_id


def _log_path(batch_id: str) -> Path:
    return _batch_dir(batch_id) / BATCH_LOG_NAME


def _work_dir(batch_id: str, item_id: int) -> str:
    return str(_batch_dir(batch_id) / 'work' / str(item_id))


def _ensure_schema() -> None:
    BATCH_ROOT.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS batch_imports (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                original_filename TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                total_count INTEGER NOT NULL DEFAULT 0,
                pending_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                skipped_count INTEGER NOT NULL DEFAULT 0,
                current_item_position INTEGER DEFAULT 0,
                log_path TEXT NOT NULL,
                source_path TEXT NOT NULL,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                paused_at TIMESTAMP,
                cancelled_at TIMESTAMP
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS batch_import_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                original_url TEXT NOT NULL,
                normalized_url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                recipe_job_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP,
                finished_at TIMESTAMP,
                FOREIGN KEY(batch_id) REFERENCES batch_imports(id)
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS batch_success_urls (
                normalized_url TEXT PRIMARY KEY,
                original_url TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                item_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_batch_imports_user_status '
                       'ON batch_imports(user_id, status, created_at)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_batch_items_batch_pos '
                       'ON batch_import_items(batch_id, position)')
        conn.commit()


def _append_log(batch_id: str, message: str) -> None:
    path = _log_path(batch_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    safe = _redact_sensitive(message)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(f'[{timestamp}] {safe}\n')


def _redact_sensitive(value: str) -> str:
    text = str(value)
    text = re.sub(r'(?i)\b(api[_ -]?key|token|secret|password)\b[^,\n]*', r'\1 [REDACTED]', text)
    text = re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._\-=/+]+\b', 'Bearer [REDACTED]', text)
    text = re.sub(r'(?i)\bsk-[A-Za-z0-9]{8,}\b', 'sk-[REDACTED]', text)
    text = re.sub(r'(?i)\bAIza[0-9A-Za-z\-_]{8,}\b', 'AIza[REDACTED]', text)
    return text


def normalize_url(raw_url: str) -> Optional[str]:
    """Normalize a TikTok URL for deduplication and persistence."""
    if not raw_url:
        return None

    candidate = raw_url.strip().strip('<>,"\'')
    candidate = re.sub(r'[\u200b\u200c\u200d]+', '', candidate)
    match = re.search(r'https?://\S+', candidate)
    if match:
        candidate = match.group(0)

    try:
        parsed = urlsplit(candidate)
    except Exception:
        return None

    if not parsed.scheme or not parsed.netloc:
        return None

    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    if netloc.startswith('m.'):
        netloc = 'www.' + netloc[2:]
    if netloc.endswith('tiktok.com') and not netloc.startswith('www.'):
        netloc = 'www.' + netloc

    path = re.sub(r'//+', '/', parsed.path or '/')
    path = path.rstrip('/') or '/'
    query = ''
    fragment = ''

    # TikTok share URLs often carry tracking parameters that should not count
    # as distinct URLs. We drop the query entirely for stable deduplication.
    normalized = urlunsplit((scheme, netloc, path, query, fragment))
    return normalized


def extract_urls_from_text(text: str) -> list[str]:
    """Return a deduplicated list of normalized URLs from plain text."""
    seen: set[str] = set()
    urls: list[str] = []
    for raw_line in (text or '').splitlines():
        line = raw_line.strip()
        if not line:
            continue
        normalized = normalize_url(line)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
    return urls


def _url_looks_temporary(error_text: str) -> bool:
    text = error_text.lower()
    if any(pattern in text for pattern in _PERMANENT_PATTERNS):
        return False
    return any(pattern in text for pattern in _TEMPORARY_PATTERNS)


def _url_looks_permanent(error_text: str) -> bool:
    text = error_text.lower()
    return any(pattern in text for pattern in _PERMANENT_PATTERNS)


def _batch_row_to_dict(row) -> dict[str, Any]:
    item = dict(row)
    item['progress'] = _batch_progress(item)
    return item


def _batch_progress(batch: dict[str, Any]) -> int:
    total = int(batch.get('total_count') or 0)
    if total <= 0:
        return 0
    done = int(batch.get('success_count') or 0) + int(batch.get('failed_count') or 0)
    return min(100, round(done * 100 / total))


def _refresh_batch_counts(batch_id: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT COUNT(*) FROM batch_import_items WHERE batch_id = ?',
            (batch_id,),
        )
        total = cursor.fetchone()[0]
        cursor.execute(
            "SELECT COUNT(*) FROM batch_import_items WHERE batch_id = ? AND status IN (?, ?)",
            (batch_id, ITEM_PENDING, ITEM_RUNNING),
        )
        pending = cursor.fetchone()[0]
        cursor.execute(
            "SELECT COUNT(*) FROM batch_import_items WHERE batch_id = ? AND status IN (?, ?)",
            (batch_id, ITEM_SUCCESS, ITEM_SKIPPED),
        )
        success = cursor.fetchone()[0]
        cursor.execute(
            "SELECT COUNT(*) FROM batch_import_items WHERE batch_id = ? AND status = ?",
            (batch_id, ITEM_FAILED),
        )
        failed = cursor.fetchone()[0]
        cursor.execute(
            "SELECT COUNT(*) FROM batch_import_items WHERE batch_id = ? AND status = ?",
            (batch_id, ITEM_DUPLICATE),
        )
        skipped = cursor.fetchone()[0]
        cursor.execute(
            '''
                UPDATE batch_imports
                SET total_count = ?, pending_count = ?, success_count = ?,
                    failed_count = ?, skipped_count = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (total, pending, success, failed, skipped, batch_id),
        )
        conn.commit()


def _parse_uploaded_text(text: str) -> tuple[list[tuple[str, str]], int]:
    seen: set[str] = set()
    items: list[tuple[str, str]] = []
    duplicates = 0
    for raw_line in (text or '').splitlines():
        line = raw_line.strip()
        if not line:
            continue
        normalized = normalize_url(line)
        if not normalized:
            continue
        if normalized in seen:
            duplicates += 1
            continue
        seen.add(normalized)
        items.append((line, normalized))
    return items, duplicates


def _success_exists(normalized_url: str) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT 1 FROM batch_success_urls WHERE normalized_url = ?',
            (normalized_url,),
        )
        return cursor.fetchone() is not None


def _mark_success(batch_id: str, item_id: int, normalized_url: str, original_url: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            '''
                INSERT OR REPLACE INTO batch_success_urls
                (normalized_url, original_url, batch_id, item_id)
                VALUES (?, ?, ?, ?)
            ''',
            (normalized_url, original_url, batch_id, item_id),
        )
        cursor.execute(
            '''
                UPDATE batch_import_items
                SET status = ?, error_message = NULL, finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (ITEM_SUCCESS, item_id),
        )
        conn.commit()
    _append_log(batch_id, f'SUCCESS {normalized_url}')


def _mark_skipped(batch_id: str, item_id: int, normalized_url: str, original_url: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            '''
                UPDATE batch_import_items
                SET status = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (ITEM_SKIPPED, 'Already imported successfully', item_id),
        )
        conn.commit()
    _append_log(batch_id, f'SKIP {normalized_url} already imported')


def _mark_failed(batch_id: str, item_id: int, error_message: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            '''
                UPDATE batch_import_items
                SET status = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (ITEM_FAILED, error_message[:1000], item_id),
        )
        conn.commit()
    _append_log(batch_id, f'FAILED {error_message}')


def _mark_cancelled(batch_id: str, item_id: int, error_message: str = 'Batch cancelled') -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            '''
                UPDATE batch_import_items
                SET status = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (ITEM_CANCELLED, error_message[:1000], item_id),
        )
        conn.commit()
    _append_log(batch_id, f'CANCELLED {error_message}')


def _set_item_running(item_id: int, batch_id: str, attempt: int) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            '''
                UPDATE batch_import_items
                SET status = ?, attempts = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (ITEM_RUNNING, attempt, item_id),
        )
        cursor.execute(
            '''
                UPDATE batch_imports
                SET current_item_position = (
                    SELECT position FROM batch_import_items WHERE id = ?
                ),
                updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''',
            (item_id, batch_id),
        )
        conn.commit()


def _item_row_to_dict(row) -> dict[str, Any]:
    return dict(row)


def _default_runner(url: str, work_dir: str) -> dict[str, Any]:
    ctx = mp.get_context('spawn')
    result_queue = ctx.Queue(maxsize=1)
    proc = ctx.Process(
        target=_child_pipeline_runner,
        args=(url, work_dir, result_queue),
        daemon=True,
    )
    proc.start()
    proc.join(URL_TIMEOUT_SECONDS)
    if proc.is_alive():
        proc.terminate()
        proc.join(10)
        return {
            'ok': False,
            'error': f'URL processing timed out after {URL_TIMEOUT_SECONDS} seconds',
            'temporary': True,
        }
    if not result_queue.empty():
        return result_queue.get()
    return {
        'ok': False,
        'error': f'Worker exited with code {proc.exitcode} before returning a result',
        'temporary': True,
    }


def _child_pipeline_runner(url: str, work_dir: str, result_queue) -> None:
    try:
        from pipeline import PipelineStats, run_extraction_pipeline

        class _SilentReporter:
            def is_cancelled(self) -> bool:
                return False

            def update(self, stage: str, message: str, percent: int,
                       video_title: str | None = None) -> None:
                return None

        stats = PipelineStats()
        result = run_extraction_pipeline(
            url,
            _SilentReporter(),
            work_dir=work_dir,
            stats=stats,
            preview=None,
            skip_upload=False,
        )
        payload: dict[str, Any] = {
            'ok': not bool(result.error),
            'error': result.error,
            'recipe_data': result.recipe_data,
            'image_path': result.image_path,
            'output_target': result.output_target,
            'llm_tokens_estimate': result.llm_tokens_estimate,
            'awaiting_approval': result.awaiting_approval,
        }
        result_queue.put(payload)
    except Exception as exc:  # pragma: no cover - defensive in child process
        result_queue.put({
            'ok': False,
            'error': str(exc),
            'temporary': _url_looks_temporary(str(exc)),
        })


@dataclass
class BatchItemResult:
    ok: bool
    error: str | None = None
    temporary: bool = False
    skipped: bool = False


class BatchImportManager:
    """Sequential, persistent batch importer with restart resume support."""

    def __init__(
        self,
        *,
        runner: Optional[Callable[[str, str], dict[str, Any]]] = None,
        auto_start: bool = True,
    ) -> None:
        _ensure_schema()
        self._runner = runner or _default_runner
        self._auto_start = auto_start
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._wakeup = threading.Event()
        self._current_batch_id: str | None = None
        self._current_item_id: int | None = None
        self._current_proc = None
        self._background_started = False
        self._recover_interrupted_batches()
        self._runner = runner or self._run_url_with_timeout
        if auto_start:
            self.start_background_loop()

    def start_background_loop(self) -> None:
        with self._lock:
            if self._background_started:
                return
            self._background_started = True
            threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            batch = self._next_runnable_batch()
            if not batch:
                self._wakeup.wait(timeout=2.0)
                self._wakeup.clear()
                continue
            try:
                self.process_batch(batch['id'])
            except Exception as exc:  # pragma: no cover - defensive
                self._append_batch_error(batch['id'], f'Unhandled batch error: {exc}')

    def _run_url_with_timeout(self, url: str, work_dir: str) -> dict[str, Any]:
        ctx = mp.get_context('spawn')
        result_queue = ctx.Queue(maxsize=1)
        proc = ctx.Process(
            target=_child_pipeline_runner,
            args=(url, work_dir, result_queue),
            daemon=True,
        )
        with self._lock:
            self._current_proc = proc
        try:
            proc.start()
            proc.join(URL_TIMEOUT_SECONDS)
            if proc.is_alive():
                proc.terminate()
                proc.join(10)
                return {
                    'ok': False,
                    'error': f'URL processing timed out after {URL_TIMEOUT_SECONDS} seconds',
                    'temporary': True,
                }
            if not result_queue.empty():
                return result_queue.get()
            return {
                'ok': False,
                'error': f'Worker exited with code {proc.exitcode} before returning a result',
                'temporary': True,
            }
        finally:
            with self._lock:
                self._current_proc = None

    def stop(self) -> None:
        self._stop_event.set()
        self._wakeup.set()

    def wake(self) -> None:
        self._wakeup.set()

    def create_batch_from_text(
        self,
        *,
        original_filename: str,
        text: str,
        user_id: Optional[str],
    ) -> dict[str, Any]:
        items, duplicates = _parse_uploaded_text(text)
        if not items:
            return {
                'ok': False,
                'error': 'No valid URLs found in the uploaded TXT file.',
            }

        batch_id = str(uuid.uuid4())
        batch_dir = _batch_dir(batch_id)
        batch_dir.mkdir(parents=True, exist_ok=True)
        source_path = batch_dir / SOURCE_NAME
        source_path.write_text(text, encoding='utf-8')
        log_path = _log_path(batch_id)
        log_path.touch(exist_ok=True)

        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''
                    INSERT INTO batch_imports
                    (id, user_id, original_filename, status, total_count,
                     pending_count, success_count, failed_count, skipped_count,
                     current_item_position, log_path, source_path)
                    VALUES (?, ?, ?, 'pending', 0, 0, 0, 0, 0, 0, ?, ?)
                ''',
                (batch_id, user_id, original_filename, str(log_path), str(source_path)),
            )
            position = 0
            inserted = 0
            skipped = 0
            for original_url, normalized_url in items:
                if _success_exists(normalized_url):
                    skipped += 1
                    cursor.execute(
                        '''
                            INSERT INTO batch_import_items
                            (batch_id, position, original_url, normalized_url, status,
                             error_message, attempts, finished_at)
                            VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                        ''',
                        (batch_id, position + 1, original_url, normalized_url,
                         ITEM_SKIPPED, 'Already imported successfully'),
                    )
                    cursor.execute(
                        '''
                            INSERT OR REPLACE INTO batch_success_urls
                            (normalized_url, original_url, batch_id, item_id)
                            VALUES (?, ?, ?, COALESCE((
                                SELECT id FROM batch_import_items
                                WHERE batch_id = ? AND position = ?
                            ), 0))
                        ''',
                        (normalized_url, original_url, batch_id, batch_id, position + 1),
                    )
                    position += 1
                    inserted += 1
                    continue

                cursor.execute(
                    '''
                        INSERT INTO batch_import_items
                        (batch_id, position, original_url, normalized_url, status)
                        VALUES (?, ?, ?, ?, 'pending')
                    ''',
                    (batch_id, position + 1, original_url, normalized_url),
                )
                position += 1
                inserted += 1
            cursor.execute(
                '''
                    UPDATE batch_imports
                    SET total_count = ?, skipped_count = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''',
                (inserted, skipped, batch_id),
            )
            conn.commit()

        _append_log(batch_id, f'Created batch from {original_filename} with {inserted} unique URLs')
        if duplicates:
            _append_log(batch_id, f'Deduplicated {duplicates} duplicate line(s)')
        self.wake()
        return {
            'ok': True,
            'batch_id': batch_id,
            'duplicates_removed': duplicates,
            'skipped_existing': skipped,
        }

    def _next_runnable_batch(self) -> Optional[dict[str, Any]]:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''
                    SELECT * FROM batch_imports
                    WHERE status = 'running'
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT 1
                '''
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def _batch_items(self, batch_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''
                    SELECT * FROM batch_import_items
                    WHERE batch_id = ?
                    ORDER BY position ASC, id ASC
                ''',
                (batch_id,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def _get_batch_row(self, batch_id: str) -> Optional[dict[str, Any]]:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT * FROM batch_imports WHERE id = ?', (batch_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_batch(self, batch_id: str, *, user_id: Optional[str] = None,
                  is_admin: bool = False) -> Optional[dict[str, Any]]:
        batch = self._get_batch_row(batch_id)
        if not batch:
            return None
        if not is_admin and user_id and batch.get('user_id') not in (None, user_id):
            return None
        batch['items'] = self._batch_items(batch_id)
        batch['progress'] = _batch_progress(batch)
        return batch

    def get_active_batch(self, *, user_id: Optional[str] = None,
                         is_admin: bool = False) -> Optional[dict[str, Any]]:
        with get_db() as conn:
            cursor = conn.cursor()
            if is_admin or not user_id:
                cursor.execute(
                    '''
                        SELECT * FROM batch_imports
                        WHERE status NOT IN ('completed', 'cancelled', 'failed')
                        ORDER BY created_at DESC, rowid DESC
                        LIMIT 1
                    '''
                )
            else:
                cursor.execute(
                    '''
                        SELECT * FROM batch_imports
                        WHERE user_id = ?
                        AND status NOT IN ('completed', 'cancelled', 'failed')
                        ORDER BY created_at DESC, rowid DESC
                        LIMIT 1
                    ''',
                    (user_id,),
                )
            row = cursor.fetchone()
            if not row:
                return None
        return self.get_batch(row['id'], user_id=user_id, is_admin=is_admin)

    def list_batches(self, *, user_id: Optional[str] = None,
                     is_admin: bool = False, limit: int = 20) -> list[dict[str, Any]]:
        with get_db() as conn:
            cursor = conn.cursor()
            if is_admin or not user_id:
                cursor.execute(
                    '''
                        SELECT * FROM batch_imports
                        ORDER BY created_at DESC, rowid DESC
                        LIMIT ?
                    ''',
                    (limit,),
                )
            else:
                cursor.execute(
                    '''
                        SELECT * FROM batch_imports
                        WHERE user_id = ?
                        ORDER BY created_at DESC, rowid DESC
                        LIMIT ?
                    ''',
                    (user_id, limit),
                )
            return [dict(row) for row in cursor.fetchall()]

    def start_batch(self, batch_id: str, *, user_id: Optional[str] = None,
                    is_admin: bool = False) -> bool:
        with get_db() as conn:
            cursor = conn.cursor()
            if is_admin or not user_id:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                            error_message = NULL, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status IN ('pending', 'paused')
                    ''',
                    (batch_id,),
                )
            else:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                            error_message = NULL, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND user_id = ? AND status IN ('pending', 'paused')
                    ''',
                    (batch_id, user_id),
                )
            conn.commit()
            changed = cursor.rowcount > 0
        if changed:
            _append_log(batch_id, 'Batch started')
            self.wake()
        return changed

    def pause_batch(self, batch_id: str, *, user_id: Optional[str] = None,
                    is_admin: bool = False) -> bool:
        with get_db() as conn:
            cursor = conn.cursor()
            if is_admin or not user_id:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'paused', paused_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status = 'running'
                    ''',
                    (batch_id,),
                )
            else:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'paused', paused_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND user_id = ? AND status = 'running'
                    ''',
                    (batch_id, user_id),
                )
            conn.commit()
            changed = cursor.rowcount > 0
        if changed:
            _append_log(batch_id, 'Batch paused')
        if self._current_batch_id == batch_id and self._current_proc is not None:
            try:
                self._current_proc.terminate()
            except Exception:
                pass
        return changed

    def resume_batch(self, batch_id: str, *, user_id: Optional[str] = None,
                     is_admin: bool = False) -> bool:
        return self.start_batch(batch_id, user_id=user_id, is_admin=is_admin)

    def cancel_batch(self, batch_id: str, *, user_id: Optional[str] = None,
                     is_admin: bool = False) -> bool:
        with get_db() as conn:
            cursor = conn.cursor()
            if is_admin or not user_id:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')
                    ''',
                    (batch_id,),
                )
            else:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND user_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')
                    ''',
                    (batch_id, user_id),
                )
            conn.commit()
            changed = cursor.rowcount > 0
        if changed:
            with get_db() as conn:
                conn.execute(
                    '''
                        UPDATE batch_import_items
                        SET status = 'cancelled', error_message = 'Batch cancelled',
                            finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                        WHERE batch_id = ? AND status IN ('pending', 'running')
                    ''',
                    (batch_id,),
                )
                conn.commit()
            _append_log(batch_id, 'Batch cancelled')
        if self._current_batch_id == batch_id and self._current_proc is not None:
            try:
                self._current_proc.terminate()
            except Exception:
                pass
        return changed

    def _append_batch_error(self, batch_id: str, message: str) -> None:
        _append_log(batch_id, message)
        with get_db() as conn:
            conn.execute(
                '''
                    UPDATE batch_imports
                    SET error_message = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''',
                (message[:1000], batch_id),
            )
            conn.commit()

    def _next_pending_item(self, batch_id: str) -> Optional[dict[str, Any]]:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''
                    SELECT * FROM batch_import_items
                    WHERE batch_id = ? AND status IN ('pending', 'running')
                    ORDER BY position ASC, id ASC
                    LIMIT 1
                ''',
                (batch_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def _set_batch_status(self, batch_id: str, status: str, message: Optional[str] = None) -> None:
        with get_db() as conn:
            conn.execute(
                '''
                    UPDATE batch_imports
                    SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''',
                (status, message, batch_id),
            )
            conn.commit()

    def _maybe_finalize(self, batch_id: str) -> None:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''
                    SELECT COUNT(*) FROM batch_import_items
                    WHERE batch_id = ? AND status IN ('pending', 'running')
                ''',
                (batch_id,),
            )
            remaining = cursor.fetchone()[0]
            if remaining == 0:
                cursor.execute(
                    '''
                        UPDATE batch_imports
                        SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status = 'running'
                    ''',
                    (batch_id,),
                )
                conn.commit()
                if cursor.rowcount > 0:
                    _append_log(batch_id, 'Batch completed')

    def _process_item(self, batch: dict[str, Any], item: dict[str, Any]) -> None:
        batch_id = batch['id']
        item_id = item['id']
        normalized_url = item['normalized_url']
        original_url = item['original_url']

        if _success_exists(normalized_url):
            _mark_skipped(batch_id, item_id, normalized_url, original_url)
            return

        attempts = int(item.get('attempts') or 0)
        attempt = attempts + 1
        while attempt <= MAX_ATTEMPTS:
            current_batch = self._get_batch_row(batch_id)
            if not current_batch or current_batch.get('status') != 'running':
                return

            _set_item_running(item_id, batch_id, attempt)
            self._current_batch_id = batch_id
            self._current_item_id = item_id
            _append_log(batch_id, f'START attempt={attempt} url={normalized_url}')

            result = self._runner(normalized_url, _work_dir(batch_id, item_id))
            latest_batch = self._get_batch_row(batch_id)
            if not latest_batch:
                return
            if latest_batch.get('status') == 'cancelled':
                _mark_cancelled(batch_id, item_id)
                _refresh_batch_counts(batch_id)
                return
            if latest_batch.get('status') == 'paused':
                with get_db() as conn:
                    conn.execute(
                        '''
                            UPDATE batch_import_items
                            SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                        ''',
                        (ITEM_PENDING, 'Paused by user', item_id),
                    )
                    conn.commit()
                _append_log(batch_id, f'PAUSED url={normalized_url}')
                _refresh_batch_counts(batch_id)
                return

            if result.get('ok'):
                _mark_success(batch_id, item_id, normalized_url, original_url)
                _refresh_batch_counts(batch_id)
                return

            error = str(result.get('error') or 'Unknown error')
            temporary = bool(result.get('temporary')) or _url_looks_temporary(error)
            permanent = _url_looks_permanent(error)

            with get_db() as conn:
                conn.execute(
                    '''
                        UPDATE batch_import_items
                        SET attempts = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    ''',
                    (attempt, error[:1000], item_id),
                )
                conn.commit()

            if permanent or not temporary or attempt >= MAX_ATTEMPTS:
                _mark_failed(batch_id, item_id, error)
                _refresh_batch_counts(batch_id)
                return

            _append_log(batch_id, f'RETRY url={normalized_url} after temporary error: {error}')
            attempt += 1
            time.sleep(PAUSE_BETWEEN_URLS_SECONDS)

        _mark_failed(batch_id, item_id, f'Failed after {MAX_ATTEMPTS} attempts')
        _refresh_batch_counts(batch_id)

    def process_batch(self, batch_id: str) -> None:
        batch = self._get_batch_row(batch_id)
        if not batch or batch.get('status') != 'running':
            return
        _refresh_batch_counts(batch_id)

        while True:
            batch = self._get_batch_row(batch_id)
            if not batch or batch.get('status') != 'running':
                break

            item = self._next_pending_item(batch_id)
            if not item:
                self._maybe_finalize(batch_id)
                break

            try:
                self._process_item(batch, item)
            finally:
                self._current_batch_id = None
                self._current_item_id = None
                self._current_proc = None
                _refresh_batch_counts(batch_id)

            batch = self._get_batch_row(batch_id)
            if not batch or batch.get('status') != 'running':
                break
            time.sleep(PAUSE_BETWEEN_URLS_SECONDS)

        _refresh_batch_counts(batch_id)

    def recover_interrupted_batches(self) -> int:
        return self._recover_interrupted_batches()

    def _recover_interrupted_batches(self) -> int:
        _ensure_schema()
        with get_db() as conn:
            cursor = conn.cursor()
            # One release could download a video successfully but fail before
            # transcription because the per-video cache directory had not
            # been created. Requeue only that exact infrastructure failure;
            # genuine private/deleted/bad videos must remain failed.
            cursor.execute(
                '''
                    UPDATE batch_import_items
                    SET status = 'pending', attempts = 0, error_message = NULL,
                        finished_at = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE status = 'failed'
                      AND error_message LIKE '%No such file or directory:%'
                      AND error_message LIKE '%/transcription_%.txt%'
                '''
            )
            repaired_items = cursor.rowcount
            cursor.execute(
                '''
                    UPDATE batch_import_items
                    SET status = 'pending', updated_at = CURRENT_TIMESTAMP
                    WHERE status = 'running'
                '''
            )
            restored_items = cursor.rowcount
            cursor.execute(
                '''
                    UPDATE batch_imports
                    SET status = 'running', completed_at = NULL,
                        error_message = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE id IN (
                        SELECT DISTINCT batch_id FROM batch_import_items
                        WHERE status = 'pending'
                    )
                      AND status = 'completed'
                '''
            )
            cursor.execute(
                '''
                    UPDATE batch_imports
                    SET status = 'running', updated_at = CURRENT_TIMESTAMP
                    WHERE status = 'running'
                '''
            )
            restored_batches = cursor.rowcount
            conn.commit()
        total_restored = repaired_items + restored_items
        if total_restored or restored_batches:
            _append_log(
                'recovery',
                f'Restored {total_restored} item(s) after restart '
                f'({repaired_items} cache-directory failure(s))',
            )
        return total_restored

    def download_text(self, batch_id: str, kind: str) -> tuple[str, str]:
        batch = self._get_batch_row(batch_id)
        if not batch:
            raise KeyError(batch_id)

        items = self._batch_items(batch_id)
        if kind == 'successful':
            lines = [item['normalized_url'] for item in items if item['status'] in SUCCESS_STATUSES]
            body = '\n'.join(lines) + ('\n' if lines else '')
            return body, 'successful.txt'
        if kind == 'failed':
            lines = [
                f"{item['normalized_url']} :: {_redact_sensitive(item.get('error_message') or 'failed')}"
                for item in items if item['status'] == ITEM_FAILED
            ]
            body = '\n'.join(lines) + ('\n' if lines else '')
            return body, 'failed.txt'
        if kind == 'log':
            path = Path(batch['log_path'])
            body = path.read_text(encoding='utf-8') if path.exists() else ''
            return body, 'batch.log'
        raise KeyError(kind)

    def export_batch_file(self, batch_id: str, kind: str) -> tuple[str, str]:
        return self.download_text(batch_id, kind)


_batch_manager: Optional[BatchImportManager] = None


def init_batch_import_manager(*, runner: Optional[Callable[[str, str], dict[str, Any]]] = None,
                              auto_start: bool = True) -> BatchImportManager:
    global _batch_manager
    _ensure_schema()
    _batch_manager = BatchImportManager(runner=runner, auto_start=auto_start)
    return _batch_manager


def get_batch_import_manager() -> Optional[BatchImportManager]:
    return _batch_manager
