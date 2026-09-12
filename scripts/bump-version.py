#!/usr/bin/env python3
"""Проставляет версию во все конфиги разом.

Версия у Tauri живёт в трёх местах и попадает в имя .dmg и в Info.plist.
Разъехавшиеся значения дают образ, чьё имя не совпадает с тегом релиза —
пользователь скачивает файл с одной версией, а в релизе написана другая.
"""
import json
import pathlib
import re
import sys

if len(sys.argv) != 2:
    sys.exit("использование: bump-version.py 0.2.0")

version = sys.argv[1]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    sys.exit(f"версия должна быть вида 1.2.3, получено: {version}")

for name in ("package.json", "src-tauri/tauri.conf.json"):
    path = pathlib.Path(name)
    data = json.loads(path.read_text())
    data["version"] = version
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

cargo = pathlib.Path("src-tauri/Cargo.toml")
text = cargo.read_text()
patched, count = re.subn(r'^version = "[^"]*"', f'version = "{version}"', text, count=1, flags=re.M)
if count != 1:
    sys.exit("не нашёл строку version в Cargo.toml")
cargo.write_text(patched)

print(f"версия проставлена во все конфиги: {version}")
