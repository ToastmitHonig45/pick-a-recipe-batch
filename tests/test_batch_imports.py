"""Tests for persistent batch imports."""

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'ui'))

_test_dir = tempfile.mkdtemp()
os.environ['DATA_DIR'] = _test_dir
os.environ['BATCH_URL_TIMEOUT_SECONDS'] = '5'

from database import get_db, init_db
init_db()

from batch_imports import BatchImportManager, normalize_url, extract_urls_from_text


def _sql(query, params=()):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        conn.commit()
        return cursor


class BatchImportNormalisationTests(unittest.TestCase):
    def test_normalize_and_dedupe_urls(self):
        manager = BatchImportManager(
            runner=lambda url, work_dir: {'ok': True},
            auto_start=False,
        )
        raw = """

        https://www.tiktok.com/@chef/video/111?is_from_webapp=1
        https://www.tiktok.com/@chef/video/111?lang=en
        https://m.tiktok.com/@chef/video/222/
        """
        result = manager.create_batch_from_text(
            original_filename='urls.txt',
            text=raw,
            user_id='alice',
        )
        self.assertTrue(result['ok'])
        self.assertEqual(result['duplicates_removed'], 1)

        batch = manager.get_batch(result['batch_id'], user_id='alice')
        self.assertEqual(batch['total_count'], 2)
        self.assertEqual(
            [item['normalized_url'] for item in batch['items']],
            [
                'https://www.tiktok.com/@chef/video/111',
                'https://www.tiktok.com/@chef/video/222',
            ],
        )
        self.assertEqual(
            extract_urls_from_text(raw),
            [
                'https://www.tiktok.com/@chef/video/111',
                'https://www.tiktok.com/@chef/video/222',
            ],
        )
        self.assertEqual(normalize_url('https://m.tiktok.com/@chef/video/222/'),
                         'https://www.tiktok.com/@chef/video/222')

    def test_previously_successful_url_is_skipped(self):
        manager = BatchImportManager(
            runner=lambda url, work_dir: {'ok': True},
            auto_start=False,
        )
        _sql(
            '''
                INSERT INTO batch_success_urls
                (normalized_url, original_url, batch_id, item_id)
                VALUES (?, ?, ?, ?)
            ''',
            ('https://www.tiktok.com/@chef/video/333',
             'https://www.tiktok.com/@chef/video/333?foo=1',
             'old-batch',
             1),
        )
        result = manager.create_batch_from_text(
            original_filename='urls.txt',
            text='https://www.tiktok.com/@chef/video/333?bar=2\n'
                 'https://www.tiktok.com/@chef/video/444\n',
            user_id='alice',
        )
        self.assertTrue(result['ok'])
        self.assertEqual(result['skipped_existing'], 1)

        batch = manager.get_batch(result['batch_id'], user_id='alice')
        statuses = [item['status'] for item in batch['items']]
        self.assertIn('skipped_success', statuses)
        self.assertIn('pending', statuses)


class BatchImportResumeTests(unittest.TestCase):
    def test_restart_recovery_requeues_running_item(self):
        calls = []

        def runner(url, work_dir):
            calls.append(url)
            return {'ok': True}

        manager = BatchImportManager(runner=runner, auto_start=False)
        result = manager.create_batch_from_text(
            original_filename='resume.txt',
            text='https://www.tiktok.com/@chef/video/555\n'
                 'https://www.tiktok.com/@chef/video/666\n',
            user_id='alice',
        )
        batch_id = result['batch_id']
        batch = manager.get_batch(batch_id, user_id='alice')
        first_item_id = batch['items'][0]['id']
        _sql(
            "UPDATE batch_imports SET status = 'running' WHERE id = ?",
            (batch_id,),
        )
        _sql(
            "UPDATE batch_import_items SET status = 'running' WHERE id = ?",
            (first_item_id,),
        )

        resumed = BatchImportManager(runner=runner, auto_start=False)
        recovered = resumed.get_batch(batch_id, user_id='alice')
        self.assertEqual(recovered['items'][0]['status'], 'pending')

        resumed.start_batch(batch_id, user_id='alice')
        resumed.process_batch(batch_id)

        final = resumed.get_batch(batch_id, user_id='alice')
        self.assertEqual(final['status'], 'completed')
        self.assertEqual(final['success_count'], 2)
        self.assertEqual(calls.count('https://www.tiktok.com/@chef/video/555'), 1)
        self.assertEqual(calls.count('https://www.tiktok.com/@chef/video/666'), 1)


class BatchImportErrorHandlingTests(unittest.TestCase):
    def test_failed_item_does_not_abort_batch_and_retries_temporary_errors(self):
        temp_calls = {'count': 0}

        def runner(url, work_dir):
            if 'private' in url:
                return {
                    'ok': False,
                    'error': 'This video is private and unavailable',
                    'temporary': False,
                }
            if 'temp' in url:
                temp_calls['count'] += 1
                if temp_calls['count'] < 3:
                    return {
                        'ok': False,
                        'error': 'Connection reset by peer',
                        'temporary': True,
                    }
                return {'ok': True}
            return {'ok': True}

        manager = BatchImportManager(runner=runner, auto_start=False)
        result = manager.create_batch_from_text(
            original_filename='errors.txt',
            text='https://www.tiktok.com/@chef/video/private\n'
                 'https://www.tiktok.com/@chef/video/temp\n'
                 'https://www.tiktok.com/@chef/video/ok\n',
            user_id='alice',
        )
        batch_id = result['batch_id']
        manager.start_batch(batch_id, user_id='alice')
        manager.process_batch(batch_id)

        batch = manager.get_batch(batch_id, user_id='alice')
        statuses = [item['status'] for item in batch['items']]
        self.assertEqual(batch['status'], 'completed')
        self.assertIn('failed', statuses)
        self.assertIn('success', statuses)
        self.assertEqual(temp_calls['count'], 3)

        with get_db() as conn:
            failed_error = conn.execute(
                "SELECT error_message FROM batch_import_items WHERE batch_id = ? AND normalized_url LIKE '%private%'",
                (batch_id,),
            ).fetchone()[0]
        self.assertIn('private', failed_error.lower())


if __name__ == '__main__':
    unittest.main()
