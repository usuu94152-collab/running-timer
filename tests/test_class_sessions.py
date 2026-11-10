import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('running_server', Path(__file__).resolve().parents[1] / 'server/running_server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ClassSessionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = server.Store(self.temp.name)
        wb = server.openpyxl.load_workbook(self.store.roster_path)
        ws = wb.active
        ws.append([3, 2, 1, '다른반학생', '이순신'])
        ws.append([2, 1, 1, '다른학년학생', '이순신'])
        wb.save(self.store.roster_path)
        wb.close()
        self.tokens = {}
        for name in ['홍길동', '다른반학생', '다른학년학생']:
            response = self.store.route({'action': 'setPassword', 'name': name, 'password': '이순신', 'newPassword': 'test-pass'}, True)
            self.assertTrue(response['ok'])
            self.tokens[name] = response['token']

    def save(self, name, at, rid):
        return self.store.route({'action': 'save', 'token': self.tokens[name], 'sec': 6,
                                 'course': '장애물', 'at': at * 1000, 'id': rid, 'classKey': '3-1'}, True)

    def test_validate_start_and_reject_other_classes(self):
        self.assertFalse(self.store.route({'action': 'teacher', 'op': 'start'}, True)['ok'])
        self.assertFalse(self.store.route({'action': 'teacher', 'op': 'start', 'classKey': '9-9'}, True)['ok'])
        self.store.start_rec('3-1')
        at = server.time.time()
        self.assertTrue(self.save('홍길동', at, 'valid')['ok'])
        self.assertTrue(self.save('다른반학생', at, 'wrong-class')['classMismatch'])
        self.assertTrue(self.save('다른학년학생', at, 'wrong-grade')['classMismatch'])
        with self.assertRaises(server.RosterError):
            self.store.start_rec('3-2')
        self.assertEqual(len(self.store.records), 1)

    def test_late_upload_after_class_switch_and_restart(self):
        now = server.time.time() - 100
        with patch.object(server.time, 'time', return_value=now):
            self.store.start_rec('3-1')
        with patch.object(server.time, 'time', return_value=now + 10):
            self.store.stop_rec()
        with patch.object(server.time, 'time', return_value=now + 11):
            self.store.start_rec('3-2')
        self.store = server.Store(self.temp.name)
        self.assertEqual(self.store.status()['classKey'], '3-2')
        self.assertTrue(self.save('홍길동', now + 9, 'late-valid')['ok'])
        self.assertTrue(self.save('다른반학생', now + 9, 'late-wrong')['classMismatch'])
        self.assertTrue(self.save('홍길동', now + 12, 'new-wrong')['classMismatch'])
        self.assertTrue(self.save('다른반학생', now + 12, 'new-valid')['ok'])
        server.ADDRESSES = []
        board = self.store.board()
        self.assertEqual([r['name'] for r in board['recent']], ['다른반학생'])

    def test_legacy_session_and_closed_time(self):
        now = server.time.time()
        self.assertTrue(self.save('홍길동', now, 'closed')['closed'])
        self.store._set_state({'open': True, 'start': now - 1, 'sessions': []})
        self.assertTrue(self.save('홍길동', now, 'legacy')['classMismatch'])


if __name__ == '__main__':
    unittest.main()
