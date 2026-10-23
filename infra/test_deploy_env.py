"""Unit tests for infra/deploy_env.py. Run: python3 -m unittest infra/test_deploy_env.py (CI quality job)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import deploy_env  # noqa: E402

TEMPLATE = {
    "containers": {
        "app": {"image": ":svc.app.latest", "environment": {"NODE_ENV": "production", "PORT": "3000", "REQUIRE_PRIVILEGED_2FA": "true"}},
        "worker": {"image": ":svc.app.latest", "command": ["node", "w.js"], "environment": {"NODE_ENV": "production"}},
        "redis": {"image": "redis:7-alpine"},
    },
    "publicEndpoint": {"containerName": "app"},
}
SECRET_VALUE = "LEAK1-value-never-printed"
ACTIVE = {
    "app": {"environment": {"NODE_ENV": "production", "DATABASE_URL": SECRET_VALUE, "INTEGRATIONS_MODE": "fake", "APP_VERSION": "9553b0e", "CONSOLE_EDIT": "kept"}},
    "worker": {"environment": {"NODE_ENV": "production", "DATABASE_URL": "stale-copy", "INTEGRATIONS_MODE": "test", "APP_VERSION": "old", "WORKER_ONLY": "1", "BOOTSTRAP_OWNER_PASSWORD": SECRET_VALUE}},
    "redis": {"environment": {}},
}


class BuildTest(unittest.TestCase):
    def test_carries_console_edits_and_removes_deploy_managed_keys(self):
        new, _ = deploy_env.build(TEMPLATE, ACTIVE, {})
        app = new["containers"]["app"]["environment"]
        self.assertEqual(app["CONSOLE_EDIT"], "kept")
        self.assertEqual(app["DATABASE_URL"], SECRET_VALUE)
        self.assertNotIn("APP_VERSION", app)
        self.assertEqual(app["REQUIRE_PRIVILEGED_2FA"], "true")
        self.assertEqual(new["publicEndpoint"], TEMPLATE["publicEndpoint"])

    def test_worker_gets_the_app_values_and_keeps_its_own_keys(self):
        new, _ = deploy_env.build(TEMPLATE, ACTIVE, {})
        w = new["containers"]["worker"]["environment"]
        self.assertEqual(w["INTEGRATIONS_MODE"], "fake")  # was "test" on the worker: aligned with app
        self.assertEqual(w["DATABASE_URL"], SECRET_VALUE)
        self.assertEqual(w["WORKER_ONLY"], "1")
        self.assertNotIn("BOOTSTRAP_OWNER_PASSWORD", w)
        self.assertNotIn("APP_VERSION", w)
        self.assertEqual(new["containers"]["worker"]["command"], ["node", "w.js"])

    def test_secrets_manager_values_win_on_app_and_reach_the_worker(self):
        new, lines = deploy_env.build(TEMPLATE, ACTIVE, {"SESSION_SECRET": "s1", "DATABASE_URL": "rotated"})
        self.assertEqual(new["containers"]["app"]["environment"]["DATABASE_URL"], "rotated")
        self.assertEqual(new["containers"]["worker"]["environment"]["SESSION_SECRET"], "s1")
        self.assertIn("    ~ DATABASE_URL (Secrets Manager)", lines)
        self.assertIn("    + SESSION_SECRET (Secrets Manager)", lines)

    def test_first_deployment_without_active(self):
        new, lines = deploy_env.build(TEMPLATE, None, {})
        self.assertEqual(new["containers"]["app"]["environment"]["PORT"], "3000")
        self.assertTrue(any("+ NODE_ENV" in l for l in lines))

    def test_report_lists_key_names_only(self):
        _, lines = deploy_env.build(TEMPLATE, ACTIVE, {})
        text = "\n".join(lines)
        self.assertIn("    - APP_VERSION (deploy-managed: removed)", text)
        self.assertIn("    - BOOTSTRAP_OWNER_PASSWORD (deploy-managed: removed)", text)
        self.assertIn("    ~ INTEGRATIONS_MODE", text)
        self.assertIn("redis: environment unchanged (0 keys)", text)
        for v in (SECRET_VALUE, "stale-copy", "kept", "9553b0e", "rotated"):
            self.assertNotIn(v, text)

    def test_rejects_a_non_flat_secret(self):
        for bad in ([], {"A": 1}, {"A": {"b": "c"}}):
            with self.assertRaises(ValueError):
                deploy_env.build(TEMPLATE, ACTIVE, bad)


class CliTest(unittest.TestCase):
    def test_cli_writes_the_deployment_and_never_prints_values(self):
        with tempfile.TemporaryDirectory() as d:
            paths = {n: os.path.join(d, n) for n in ("t.json", "a.json", "s.json", "o.json")}
            for n, v in (("t.json", TEMPLATE), ("a.json", ACTIVE), ("s.json", {})):
                with open(paths[n], "w") as f:
                    json.dump(v, f)
            r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "deploy_env.py"), paths["t.json"], paths["a.json"], paths["s.json"], paths["o.json"]], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn(SECRET_VALUE, r.stdout + r.stderr)
            with open(paths["o.json"]) as f:
                self.assertIn("containers", json.load(f))
            with open(paths["s.json"], "w") as f:
                json.dump({"A": 1}, f)
            r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "deploy_env.py"), paths["t.json"], paths["a.json"], paths["s.json"], paths["o.json"]], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("flat JSON object of strings", r.stderr)


if __name__ == "__main__":
    unittest.main()
