#!/usr/bin/env python3
"""Validate the app store against umbrelOS's actual expectations.

Checks encode rules read out of the umbrelOS source (app-repository.ts,
app-store.ts, app.ts, schema.ts) rather than guesses.
"""
from __future__ import annotations

import os
import re
import sys

import yaml

# image name -> tag, as .github/workflows/build-images.yml publishes them.
with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       ".github", "workflows", "build-images.yml"), encoding="utf-8") as _fh:
    PUBLISHED_TAGS = {
        str(e["name"]): str(e["tag"])
        for e in yaml.safe_load(_fh)["jobs"]["build"]["strategy"]["matrix"]["include"]
    }

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# --strict turns "you have not configured this yet" into a hard failure. CI uses
# it so an unconfigured store can never be published; local runs only warn.
STRICT = "--strict" in sys.argv
errors: list[str] = []
warnings: list[str] = []


def placeholder(msg: str) -> None:
    (err if STRICT else warn)(msg)


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load(rel: str):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


# --- store manifest --------------------------------------------------------
store = load("umbrel-app-store.yml")
store_id = store.get("id", "")
if not re.fullmatch(r"[a-z-]+", store_id or ""):
    err(f"store id {store_id!r} should contain only lowercase letters and dashes")
if not store.get("name"):
    err("umbrel-app-store.yml is missing 'name'")

# --- app folders -----------------------------------------------------------
app_dirs = [
    d
    for d in sorted(os.listdir(ROOT))
    if os.path.isfile(os.path.join(ROOT, d, "umbrel-app.yml"))
]
if not app_dirs:
    err("no app directories with an umbrel-app.yml found")

REQUIRED = [
    "manifestVersion", "id", "name", "tagline", "category",
    "version", "port", "description", "website", "support", "gallery",
]

for app_dir in app_dirs:
    manifest = load(f"{app_dir}/umbrel-app.yml")
    app_id = manifest.get("id", "")

    for field in REQUIRED:
        if field not in manifest:
            err(f"{app_dir}: manifest is missing required field '{field}'")

    # umbrelOS resolves the install source as <repo>/<app-id>; a mismatch means
    # the app lists in the store and then fails to install.
    if app_id != app_dir:
        err(f"{app_dir}: manifest id {app_id!r} must equal the folder name")
    if not re.fullmatch(r"[a-zA-Z0-9._-]+", app_id or ""):
        err(f"{app_dir}: app id {app_id!r} contains characters umbrelOS rejects")
    # app-repository.ts filters community apps with app.id.startsWith(store.id)
    if not app_id.startswith(store_id):
        err(f"{app_dir}: app id must start with the store id {store_id!r} or it is filtered out")

    if not isinstance(manifest.get("port"), int):
        err(f"{app_dir}: 'port' must be an integer")

    # For community stores, icon/gallery values are used verbatim by the UI —
    # they must be absolute URLs, not repo-relative paths.
    icon = manifest.get("icon")
    if not icon:
        err(f"{app_dir}: community-store apps must set 'icon' to an absolute URL")
    elif not str(icon).startswith("http"):
        err(f"{app_dir}: 'icon' must be an absolute URL, got {icon!r}")
    elif "YOUR-GITHUB-USERNAME" in str(icon):
        placeholder(f"{app_dir}: 'icon' still contains the placeholder — run scripts/configure.sh")

    # An absolute URL that 404s is worse than no URL: umbrelOS shows a broken
    # image and there is nothing in any log to explain it. The URL points at
    # this repo, so the file has to exist here.
    def asset_must_exist(url: str, label: str) -> None:
        match = re.match(
            r"https://raw\.githubusercontent\.com/[^/]+/[^/]+/[^/]+/(.+)$", str(url)
        )
        if not match:
            return
        path = os.path.join(ROOT, match.group(1))
        if not os.path.isfile(path):
            err(f"{app_dir}: {label} points at {match.group(1)}, which is not in this repo")

    if icon and str(icon).startswith("http"):
        asset_must_exist(icon, "'icon'")

    for item in manifest.get("gallery") or []:
        asset_must_exist(item, "gallery entry")
        if not str(item).startswith("http"):
            err(f"{app_dir}: gallery entry {item!r} must be an absolute URL")
        elif "YOUR-GITHUB-USERNAME" in str(item):
            placeholder(f"{app_dir}: gallery still contains the placeholder — run scripts/configure.sh")

    for path in manifest.get("backupIgnore") or []:
        if not re.fullmatch(r"[-a-zA-Z0-9._/*]+", path):
            err(f"{app_dir}: backupIgnore entry {path!r} fails umbrelOS's path validation")
        if path.startswith("/") or ".." in path:
            err(f"{app_dir}: backupIgnore entry {path!r} must stay inside the app data dir")

    # --- compose ----------------------------------------------------------
    compose = load(f"{app_dir}/docker-compose.yml")
    services = compose.get("services") or {}

    if "app_proxy" not in services:
        err(f"{app_dir}: docker-compose.yml has no app_proxy service")
    else:
        proxy_env = services["app_proxy"].get("environment") or {}
        app_host = str(proxy_env.get("APP_HOST", ""))
        # umbrelOS injects container_name as <app-id>_<service>_1
        m = re.fullmatch(rf"{re.escape(app_id)}_([A-Za-z0-9_-]+)_1", app_host)
        if not m:
            err(f"{app_dir}: APP_HOST {app_host!r} must be '<app-id>_<service>_1'")
        elif m.group(1) not in services:
            err(f"{app_dir}: APP_HOST points at service {m.group(1)!r} which does not exist")
        if not proxy_env.get("APP_PORT"):
            err(f"{app_dir}: app_proxy is missing APP_PORT")

    # Widget endpoints are resolved by umbreld against the bare compose service
    # name, so the host part must match a service key exactly.
    # umbreld resolves dependencies by app id against installed apps, with no
    # store restriction — but a dependency naming an app that exists nowhere
    # breaks the install dialog outright (undefined.id in the umbrelOS UI).
    for dep in manifest.get("dependencies") or []:
        if dep in app_dirs:
            continue
        warn(
            f"{app_dir}: depends on {dep!r}, which is not in this store — it must "
            "come from the official store or another store the user has added"
        )

    widgets = manifest.get("widgets") or []
    if len(widgets) > 3:
        err(f"{app_dir}: umbrelOS allows at most 3 widgets, found {len(widgets)}")
    valid_types = {
        "text-with-buttons", "text-with-progress", "two-stats-with-guage",
        "three-stats", "four-stats", "list-emoji", "list",
    }
    for widget in widgets:
        wtype = widget.get("type")
        if wtype not in valid_types:
            err(f"{app_dir}: widget type {wtype!r} is not a umbrelOS widget type")
        endpoint = str(widget.get("endpoint", ""))
        host = endpoint.split(":")[0]
        if host not in services:
            err(f"{app_dir}: widget endpoint host {host!r} is not a compose service name")
        if wtype == "four-stats":
            items = (widget.get("example") or {}).get("items") or []
            if len(items) != 4:
                err(f"{app_dir}: four-stats widget example must have exactly 4 items")

    # Every service that is not app_proxy should be pinned to an explicit tag.
    for name, svc in services.items():
        if name == "app_proxy":
            continue
        image = svc.get("image")
        if not image:
            err(f"{app_dir}: service {name!r} has no image")
        elif ":" not in str(image).rsplit("/", 1)[-1]:
            err(f"{app_dir}: service {name!r} image {image!r} is not pinned to a tag")
        elif str(image).endswith(":latest"):
            warn(f"{app_dir}: service {name!r} uses the ':latest' tag")
        # Our own images: a digest that is well formed, and a tag that is the
        # one the publish workflow builds — a compose file pointing at a tag
        # the workflow no longer publishes would install something nobody
        # built from this repository. test/image_pins.sh checks the digest
        # against the registry itself.
        m = re.match(r"ghcr\.io/[^/]+/([a-z0-9-]+):([0-9A-Za-z.-]+)(?:@(.+))?$", str(image))
        if m:
            img, tag, digest = m.group(1), m.group(2), m.group(3)
            if digest is not None and not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                err(f"{app_dir}: service {name!r} pins {digest!r}, which is not a sha256 digest")
            if img in PUBLISHED_TAGS and PUBLISHED_TAGS[img] != tag:
                err(f"{app_dir}: service {name!r} uses {img}:{tag}, but the publish workflow builds {img}:{PUBLISHED_TAGS[img]}")
        if str(image).startswith(("127.0.0.1:", "localhost:")):
            placeholder(
                f"{app_dir}: service {name!r} pulls from a local registry ({image}) — "
                "fine for testing on your own Umbrel, not publishable"
            )

    # Data must live under APP_DATA_DIR so that umbrelOS backups pick it up.
    for name, svc in services.items():
        for volume in svc.get("volumes") or []:
            src = str(volume).split(":")[0]
            if src.startswith("/") and not src.startswith("${"):
                err(f"{app_dir}: service {name!r} mounts host path {src!r} directly")

    if os.path.exists(os.path.join(ROOT, app_dir, "exports.sh")):
        with open(os.path.join(ROOT, app_dir, "exports.sh"), encoding="utf-8") as fh:
            exports = fh.read()
        if "derive_entropy" in exports and "$(derive_entropy" not in exports:
            warn(f"{app_dir}: exports.sh mentions derive_entropy but never calls it")

# --- report ----------------------------------------------------------------
for w in warnings:
    print(f"warning: {w}")
for e in errors:
    print(f"error: {e}", file=sys.stderr)

if errors:
    print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)", file=sys.stderr)
    sys.exit(1)

print(f"manifest validation passed ({len(app_dirs)} app(s), {len(warnings)} warning(s))")
