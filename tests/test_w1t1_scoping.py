"""Failing-first proof for W1.T1 — schema columns and owner scoping."""

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'ui'))

_test_dir = tempfile.mkdtemp()
os.environ['DATA_DIR'] = _test_dir


class TestW1T1SchemaAndScoping(unittest.TestCase):
    def test_create_job_persists_user_id(self):
        from database import create_job, get_job
        job_id = create_job('https://example.com/u', user_id='alice')
        try:
            self.assertEqual(get_job(job_id)['user_id'], 'alice')
        finally:
            from database import get_db
            with get_db() as conn:
                conn.execute('DELETE FROM recipe_jobs WHERE id = ?', (job_id,))
                conn.commit()

    def test_active_jobs_scoped_to_owner(self):
        from database import create_job, get_active_jobs
        mine = create_job('https://example.com/mine', user_id='alice')
        theirs = create_job('https://example.com/theirs', user_id='bob')
        try:
            ids = {j['id'] for j in get_active_jobs(user_id='alice')}
            self.assertIn(mine, ids)
            self.assertNotIn(theirs, ids)
            admin_ids = {j['id'] for j in get_active_jobs(is_admin=True)}
            self.assertIn(mine, admin_ids)
            self.assertIn(theirs, admin_ids)
        finally:
            from database import get_db
            with get_db() as conn:
                conn.execute(
                    'DELETE FROM recipe_jobs WHERE id IN (?, ?)',
                    (mine, theirs),
                )
                conn.commit()

    def test_pending_uploads_scoped_to_owner(self):
        from database import (
            create_pending_upload, get_db, get_pending_upload,
            get_pending_uploads,
        )
        up_alice = 'up_' + os.urandom(8).hex()
        up_bob = 'up_' + os.urandom(8).hex()
        create_pending_upload(
            upload_id=up_alice, job_id='jx', recipe_data={'name': 'A'},
            image_path=None, image_candidates=[], output_target='mealie',
            best_image_index=0, timeout_minutes=5, user_id='alice',
        )
        create_pending_upload(
            upload_id=up_bob, job_id='jy', recipe_data={'name': 'B'},
            image_path=None, image_candidates=[], output_target='mealie',
            best_image_index=0, timeout_minutes=5, user_id='bob',
        )
        try:
            scoped = {u['id'] for u in get_pending_uploads(user_id='alice')}
            self.assertIn(up_alice, scoped)
            self.assertNotIn(up_bob, scoped)
            self.assertEqual(get_pending_upload(up_alice)['user_id'], 'alice')
            admin = {u['id'] for u in get_pending_uploads(is_admin=True)}
            self.assertIn(up_alice, admin)
            self.assertIn(up_bob, admin)
        finally:
            with get_db() as conn:
                conn.execute(
                    'DELETE FROM pending_uploads WHERE id IN (?, ?)',
                    (up_alice, up_bob),
                )
                conn.commit()

    def test_migrations_are_idempotent(self):
        from database import get_db, init_db
        init_db()
        with get_db() as conn:
            from database import _migrate_schema
            _migrate_schema(conn)

    def test_queue_position_unified_created_at_ordering(self):
        from database import create_job, get_queue_position, get_db
        a = create_job('https://example.com/o1', user_id='alice')
        b = create_job('https://example.com/o2', user_id='alice')
        try:
            self.assertLess(get_queue_position(a), get_queue_position(b))
        finally:
            with get_db() as conn:
                conn.execute(
                    'DELETE FROM recipe_jobs WHERE id IN (?, ?)', (a, b)
                )
                conn.commit()


if __name__ == '__main__':
    unittest.main()
