"""Tests for job queue utilities."""

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'ui'))

_test_dir = tempfile.mkdtemp()
os.environ['DATA_DIR'] = _test_dir


class TestQueuePosition(unittest.TestCase):
    def test_queue_position_ordering(self):
        from database import create_job, get_queue_position, get_db, init_db
        init_db()
        j1 = create_job('https://example.com/1')
        j2 = create_job('https://example.com/2')
        self.assertEqual(get_queue_position(j1), 1)
        self.assertEqual(get_queue_position(j2), 2)
        with get_db() as conn:
            conn.execute("DELETE FROM recipe_jobs WHERE id IN (?, ?)", (j1, j2))
            conn.commit()


class TestMaxConcurrent(unittest.TestCase):
    def test_resolve_bounds(self):
        from job_manager import resolve_max_concurrent
        os.environ['MAX_CONCURRENT_JOBS'] = '8'
        self.assertEqual(resolve_max_concurrent(), 8)
        os.environ['MAX_CONCURRENT_JOBS'] = '99'
        self.assertEqual(resolve_max_concurrent(), 16)
        del os.environ['MAX_CONCURRENT_JOBS']


if __name__ == '__main__':
    unittest.main()
