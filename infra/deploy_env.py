"""Builds the environment of a new Lightsail deployment and reports what changes, by key name only.

Used by infra/deploy.sh:  python3 infra/deploy_env.py TEMPLATE ACTIVE SECRETS OUT
  TEMPLATE  infra/lightsail.json after substitution (containers + publicEndpoint)
  ACTIVE    the "containers" object of the ACTIVE deployment (or null for the first deployment)
  SECRETS   flat JSON object of strings from Secrets Manager (or {})
  OUT       where to write the deployment input for create-container-service-deployment

Rules (docs/runbook.md, "Deploy"):
  - The ACTIVE deployment's environment is the base, so variables edited in the console are carried over, never dropped.
  - The template wins for the keys it declares (NODE_ENV, PORT, REQUIRE_PRIVILEGED_2FA); Secrets Manager values win for the
    app container.
  - Deploy-managed keys are removed: APP_VERSION (the version is baked into the image) and BOOTSTRAP_* (the env-var owner
    bootstrap was removed; the API refuses to boot with them in production).
  - The worker gets the app's final environment (its own template keys still win), so app and worker can never disagree
    on INTEGRATIONS_MODE or any secret; worker-only keys are kept.
  - The report lists added, removed and changed KEY NAMES per container. Values are never printed.
"""
import json
import sys

REMOVED_KEYS = ("APP_VERSION",)
REMOVED_PREFIXES = ("BOOTSTRAP_",)


def _removed(key):
    return key in REMOVED_KEYS or key.startswith(REMOVED_PREFIXES)


def _env(containers, name):
    c = (containers or {}).get(name) or {}
    env = c.get("environment") or {}
    if not isinstance(env, dict):
        raise ValueError(f"container {name}: environment must be an object")
    return dict(env)


def build(template, active, secrets):
    """Returns (deployment, report_lines). Pure: no I/O."""
    if not isinstance(secrets, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in secrets.items()):
        raise ValueError("Secrets Manager value must be a flat JSON object of strings")
    new = json.loads(json.dumps(template))
    containers = new["containers"]
    for name, c in containers.items():
        base = {k: v for k, v in _env(active, name).items() if not _removed(k)}
        own = c.get("environment") or {}
        merged = {**base, **own}
        if name == "app":
            merged = {**merged, **secrets}
        c["environment"] = merged
    if "app" in containers and "worker" in containers:
        w = containers["worker"]
        worker_template = template["containers"]["worker"].get("environment") or {}
        w["environment"] = {**w["environment"], **containers["app"]["environment"], **worker_template}
        app_mode = containers["app"]["environment"].get("INTEGRATIONS_MODE")
        if w["environment"].get("INTEGRATIONS_MODE") != app_mode:
            raise ValueError("worker INTEGRATIONS_MODE differs from app after merge")
    return new, report(active, new, secrets)


def report(active, new, secrets):
    lines = []
    for name in sorted(new["containers"]):
        before = _env(active, name)
        after = new["containers"][name].get("environment") or {}
        added = sorted(set(after) - set(before))
        removed = sorted(set(before) - set(after))
        changed = sorted(k for k in set(before) & set(after) if before[k] != after[k])
        if not (added or removed or changed):
            lines.append(f"  {name}: environment unchanged ({len(after)} keys)")
            continue
        lines.append(f"  {name}: {len(after)} keys")
        for k in added:
            lines.append(f"    + {k}" + (" (Secrets Manager)" if name == "app" and k in secrets else ""))
        for k in removed:
            lines.append(f"    - {k}" + (" (deploy-managed: removed)" if _removed(k) else ""))
        for k in changed:
            lines.append(f"    ~ {k}" + (" (Secrets Manager)" if name == "app" and k in secrets else ""))
    return lines


def main(argv):
    template_path, active_path, secrets_path, out_path = argv
    with open(template_path) as f:
        template = json.load(f)
    with open(active_path) as f:
        active = json.load(f)
    with open(secrets_path) as f:
        secrets = json.load(f) or {}
    new, lines = build(template, active, secrets)
    with open(out_path, "w") as f:
        json.dump(new, f)
    print("Environment changes (key names only, values never shown):")
    print("\n".join(lines))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError) as e:  # never echo values: messages above name keys and rules only
        sys.exit(f"deploy_env: {e}")
