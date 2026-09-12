# Slaive — сборка и релиз.
#
# Адаптация шаблона релиза из jira-cli под Tauri. Главное отличие: там версия
# инжектится линковщиком через -ldflags, здесь она ЛЕЖИТ В ТРЁХ КОНФИГАХ
# (package.json, tauri.conf.json, Cargo.toml) и попадает в имя .dmg и в
# Info.plist. Поэтому release обязан прописать её туда ДО сборки — иначе тег
# скажет v0.1.1, а образ останется Slaive_0.1.0_aarch64.dmg, и пользователь
# скачает не то, что написано в релизе.

.PHONY: dev build test validate clean version bump release

DIST := src-tauri/target/release/bundle
DMG_DIR := $(DIST)/dmg
VERSION := $(shell python3 -c "import json;print(json.load(open('package.json'))['version'])")

dev:
	npm run tauri dev

build:
	npm run tauri build

test:
	cd src-tauri && cargo test
	npm test

validate:
	npx tsc --noEmit
	cd src-tauri && cargo build 2>&1 | grep -q '^warning' && { echo "cargo build дал warnings"; exit 1; } || true
	$(MAKE) test

clean:
	rm -rf $(DIST)
	rm -rf dist

version:
	@echo $(VERSION)

# Прописывает версию во все три конфига разом. Вызывается из release;
# отдельно полезен, если версию надо поправить руками.
# Использование: make bump TO=0.2.0
bump:
	@test -n "$(TO)" || { echo "Укажи версию: make bump TO=0.2.0"; exit 1; }
	@python3 scripts/bump-version.py $(TO)

# Релиз. Порядок шагов важен: сначала отказы на грязном дереве и неотправленных
# коммитах, потом проверки, и только затем что-то необратимое — тег и публикация.
release:
	@set -e; \
	git diff --quiet && git diff --cached --quiet || { echo "Дерево грязное — закоммить или спрячь изменения."; exit 1; }; \
	git rev-parse --abbrev-ref @{u} >/dev/null 2>&1 || { echo "Нет upstream-ветки — сначала push."; exit 1; }; \
	test -z "$$(git log @{u}.. --oneline)" || { echo "Есть неотправленные коммиты — сначала push."; exit 1; }; \
	command -v gh >/dev/null || { echo "Нужен gh CLI."; exit 1; }; \
	$(MAKE) validate; \
	current=$$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"); \
	echo "Текущая версия: $$current"; \
	printf "Как поднимать? [major/minor/patch] (по умолчанию patch): "; \
	read bump; \
	bump=$${bump:-patch}; \
	ver=$${current#v}; \
	major=$$(echo $$ver | cut -d. -f1); \
	minor=$$(echo $$ver | cut -d. -f2); \
	patch=$$(echo $$ver | cut -d. -f3); \
	case $$bump in \
		major) major=$$((major+1)); minor=0; patch=0 ;; \
		minor) minor=$$((minor+1)); patch=0 ;; \
		*)     patch=$$((patch+1)) ;; \
	esac; \
	new="v$${major}.$${minor}.$${patch}"; \
	plain="$${major}.$${minor}.$${patch}"; \
	printf "Выпустить %s? [y/N]: " "$$new"; \
	read confirm; \
	case $$confirm in [yY]*) ;; *) echo "Отменено."; exit 1 ;; esac; \
	$(MAKE) bump TO=$$plain; \
	git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock; \
	git commit -m "chore: версия $$new"; \
	git push; \
	$(MAKE) build; \
	dmg=$$(ls $(DMG_DIR)/Slaive_$${plain}_aarch64.dmg); \
	test -f "$$dmg" || { echo "Образ $$dmg не собрался."; exit 1; }; \
	git tag $$new; \
	git push origin $$new; \
	gh release create $$new "$$dmg" \
		--generate-notes \
		--notes-start-tag $$current \
		--title "Slaive $$new"; \
	notes=$$(gh release view $$new --json body -q .body); \
	gh release edit $$new --notes "$$(printf '%s\n\n%s\n' \
		'> Сборка не подписана: первый запуск — правый клик по Slaive.app → «Открыть». Требуется macOS 12+ на Apple silicon. При первом запуске откроются настройки — выберите модель whisper и скачайте её.' \
		"$$notes")" >/dev/null; \
	echo "Готово: $$new"
