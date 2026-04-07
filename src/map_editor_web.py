from __future__ import annotations

import argparse
import json
import os
import tempfile
import zipfile
from dataclasses import dataclass
from typing import Any

from flask import Flask, Response, jsonify, render_template, request, send_file, send_from_directory


SPECIAL_ITEMS = ["trafficlight", "trafficrect", "checkpoint"]
DEFAULT_SCALES = {
    "coin.glb": (0.117, 0.117, 0.117),
    "car.glb": (0.057, 0.057, 0.057),
    "model.glb": (0.068, 0.068, 0.068),
    "rgb.glb": (0.1, 0.1, 0.1),
    "ward.glb": (0.1, 0.1, 0.1),
    "trafficlight": (0.032, 0.032, 0.032),
    "trafficrect": (1.0, 1.0, 0.24),
    "checkpoint": (0.58, 0.24, 0.19),
}


@dataclass
class WebConfig:
    map_path: str
    objects_path: str
    model_dir: str
    map_size_x: float
    map_size_z: float


def _safe_load_json(path: str, default: dict[str, Any] | list[Any]):
    if not path or not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return default


def _discover_assets(model_dir: str) -> list[str]:
    items: list[str] = []
    if os.path.isdir(model_dir):
        for entry in sorted(os.listdir(model_dir)):
            if entry.lower().endswith(".glb"):
                items.append(entry)
    items.extend(SPECIAL_ITEMS)
    return items


def _find_first_image_in_zip(zip_path: str) -> str | None:
    image_extensions = (".png", ".jpg", ".jpeg", ".bmp")
    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            image_names = [name for name in archive.namelist() if name.lower().endswith(image_extensions)]
            if not image_names:
                return None
            target_name = image_names[0]
            temp_dir = tempfile.mkdtemp(prefix="sim_map_editor_web_")
            archive.extract(target_name, path=temp_dir)
            return os.path.join(temp_dir, target_name)
    except Exception:
        return None


def _resolve_map_path(map_path: str) -> str | None:
    if not map_path:
        return None
    if os.path.isfile(map_path) and map_path.lower().endswith(".zip"):
        return _find_first_image_in_zip(map_path)
    return map_path


def _detect_repo_root(start_dir: str) -> str:
    current = os.path.abspath(start_dir)
    for _ in range(6):
        objects_path = os.path.join(current, "objects.json")
        models_path = os.path.join(current, "models")
        if os.path.exists(objects_path) and os.path.isdir(models_path):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return os.path.abspath(start_dir)


def _normalize_object_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"objects": []}
    objects = payload.get("objects", [])
    if not isinstance(objects, list):
        objects = []

    normalized: list[dict[str, Any]] = []
    for item in objects:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", ""))
        object_type = str(item.get("type", "static"))
        if object_type == "checkpoint" and "checkpoint" not in name.lower():
            name = "Checkpoint_0"

        normalized.append(
            {
                "name": name,
                "type": object_type,
                "ID": int(float(item.get("ID", 0))),
                "position": {
                    "x": float(item.get("position", {}).get("x", 0.0)),
                    "y": float(item.get("position", {}).get("y", 0.0)),
                    "z": float(item.get("position", {}).get("z", 0.0)),
                },
                "rotation": {
                    "x": float(item.get("rotation", {}).get("x", 0.0)),
                    "y": float(item.get("rotation", {}).get("y", 0.0)),
                    "z": float(item.get("rotation", {}).get("z", 0.0)),
                },
                "scale": {
                    "x": float(item.get("scale", {}).get("x", 1.0)),
                    "y": float(item.get("scale", {}).get("y", 1.0)),
                    "z": float(item.get("scale", {}).get("z", 1.0)),
                },
                "isActive": bool(item.get("isActive", True)),
                "startTime": float(item.get("startTime", 0.0)),
                "moveType": str(item.get("moveType", "None")),
                "movePoints": list(item.get("movePoints", [])),
                "speed": float(item.get("speed", 0.0)),
                "respawnTime": float(item.get("respawnTime", 5.0)),
            }
        )

    return {"objects": normalized}


def create_app(config: WebConfig) -> Flask:
    web_ui_dir = os.path.join(os.path.dirname(__file__), "web_ui")
    app = Flask(
        __name__,
        template_folder=os.path.join(web_ui_dir, "templates"),
        static_folder=os.path.join(web_ui_dir, "static"),
    )

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/config")
    def get_config():
        return jsonify(
            {
                "mapSizeX": config.map_size_x,
                "mapSizeZ": config.map_size_z,
                "objectsPath": config.objects_path,
                "assets": _discover_assets(config.model_dir),
                "defaultScales": DEFAULT_SCALES,
                "specialItems": SPECIAL_ITEMS,
                "modelBaseUrl": "/api/models",
                "zFlip": True,
            }
        )

    @app.get("/api/models/<path:model_name>")
    def get_model_file(model_name: str):
        # Restrict web access to glb files within the configured model directory.
        if not model_name.lower().endswith(".glb"):
            return Response(status=404)
        return send_from_directory(config.model_dir, model_name)

    @app.get("/api/map-image")
    def get_map_image():
        resolved = _resolve_map_path(config.map_path)
        if not resolved or not os.path.exists(resolved):
            return Response(status=404)
        return send_file(resolved)

    @app.get("/api/objects")
    def get_objects():
        payload = _safe_load_json(config.objects_path, default={"objects": []})
        normalized = _normalize_object_payload(payload)
        return jsonify(normalized)

    @app.post("/api/objects")
    def post_objects():
        incoming = request.get_json(silent=True)
        payload = _normalize_object_payload(incoming)
        os.makedirs(os.path.dirname(config.objects_path), exist_ok=True)
        with open(config.objects_path, "w", encoding="utf-8") as file:
            json.dump(payload, file, indent=2, ensure_ascii=False)
        return jsonify({"ok": True, "count": len(payload["objects"])})

    return app


def parse_args():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = _detect_repo_root(base_dir)
    parser = argparse.ArgumentParser(description="SIM Web Map Editor")
    parser.add_argument("--map", dest="map_path", default=os.path.join(repo_root, "map.png"), help="map image path")
    parser.add_argument("--objects", dest="objects_path", default=os.path.join(repo_root, "objects.json"), help="objects json path")
    parser.add_argument("--models", dest="model_dir", default=os.path.join(repo_root, "models"), help="model directory")
    parser.add_argument("--map-size-x", type=float, default=4.0, help="map world width (x)")
    parser.add_argument("--map-size-z", type=float, default=5.0, help="map world depth (z)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="bind host")
    parser.add_argument("--port", type=int, default=8787, help="bind port")
    parser.add_argument("--debug", action="store_true", help="enable flask debug mode")
    return parser.parse_args()


def main():
    args = parse_args()
    config = WebConfig(
        map_path=args.map_path,
        objects_path=args.objects_path,
        model_dir=args.model_dir,
        map_size_x=max(0.1, float(args.map_size_x)),
        map_size_z=max(0.1, float(args.map_size_z)),
    )

    missing_inputs = []
    if not args.map_path or not os.path.exists(args.map_path):
        missing_inputs.append(f"map: {args.map_path}")
    if not args.objects_path:
        missing_inputs.append("objects json: <empty>")
    if not args.model_dir or not os.path.isdir(args.model_dir):
        missing_inputs.append(f"models: {args.model_dir}")

    if missing_inputs:
        print("[MapEditorWeb] Startup notice: default paths may need override:")
        for item in missing_inputs:
            print(f"  - {item}")

    app = create_app(config)
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
