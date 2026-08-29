#!/usr/bin/env python3
"""Export SerpBear rank data and generate an idempotent OpenSEO D1 import.

The export deliberately excludes SerpBear settings, credentials, Search Console
credential blobs, and raw SERP payloads. It keeps only projects, keywords, tags,
search volume, current rank state, and historical rank snapshots.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


NAMESPACE = uuid.UUID("8d98dbbe-e392-4e97-9644-7352936162c9")
PROJECT_NAMES = {
    "aprilwray.com": "April Wray",
    "kre8media.com": "Kre8Media",
    "luxurylimousineoflasvegas.com": "Luxury Limousines of Las Vegas",
    "tsbpodiatry.com": "TSB Podiatry",
}


def stable_id(value: str) -> str:
    return str(uuid.uuid5(NAMESPACE, value))


def sql(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def parse_json(value: Any, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def normalize_day(value: str) -> str:
    date = value.split("T", 1)[0].split(" ", 1)[0]
    year, month, day = (int(part) for part in date.split("-"))
    return f"{year:04d}-{month:02d}-{day:02d}"


def normalize_timestamp(value: str | None, day: str) -> str:
    if value:
        candidate = value.strip().replace(" ", "T")
        if candidate.endswith("Z"):
            return candidate
        if "T" in candidate:
            return f"{candidate}Z"
    return f"{day}T12:00:00.000Z"


def devices_label(devices: set[str]) -> str:
    return "both" if len(devices) > 1 else next(iter(devices))


def normalize_location_name(value: str) -> str:
    """Return DataForSEO's canonical comma-delimited location name."""
    return ",".join(part.strip() for part in value.split(",") if part.strip())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-db", required=True)
    parser.add_argument("--export-json", required=True)
    parser.add_argument("--import-sql", required=True)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--kre8-project-id", required=True)
    parser.add_argument("--kre8-national-config-id", required=True)
    parser.add_argument("--kre8-existing-keyword-id", required=True)
    parser.add_argument("--schedule", choices=["daily", "weekly", "monthly", "manual"], default="weekly")
    parser.add_argument("--serp-depth", type=int, default=20)
    parser.add_argument("--national-location-code", type=int, default=2840)
    parser.add_argument("--las-vegas-location-code", type=int, default=1022639)
    args = parser.parse_args()

    source = Path(args.source_db)
    connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT ID, keyword, device, country, city, domain, lastUpdated, added,
               position, history, volume, url, tags
        FROM keyword
        ORDER BY domain, city, lower(keyword), device, ID
        """
    ).fetchall()
    connection.close()

    configs: dict[tuple[str, str], dict[str, Any]] = {}
    source_rows: list[dict[str, Any]] = []
    for row in rows:
        domain = row["domain"].strip().lower()
        if domain not in PROJECT_NAMES:
            continue
        city = (row["city"] or "").strip()
        config_key = (domain, city)
        config = configs.setdefault(
            config_key,
            {
                "domain": domain,
                "city": city,
                "location_name": normalize_location_name(city) if city else None,
                "devices": set(),
                "keywords": {},
                "last_checked_at": None,
            },
        )
        device = (row["device"] or "desktop").lower()
        config["devices"].add(device)
        keyword_key = row["keyword"].strip().lower()
        keyword = config["keywords"].setdefault(
            keyword_key,
            {
                "keyword": row["keyword"].strip(),
                "volume": 0,
                "tags": set(),
                "added": row["added"],
            },
        )
        keyword["volume"] = max(keyword["volume"], int(row["volume"] or 0))
        keyword["tags"].update(
            tag.strip() for tag in parse_json(row["tags"], []) if isinstance(tag, str) and tag.strip()
        )
        if row["added"] and (not keyword["added"] or row["added"] < keyword["added"]):
            keyword["added"] = row["added"]
        if row["lastUpdated"] and (
            not config["last_checked_at"] or row["lastUpdated"] > config["last_checked_at"]
        ):
            config["last_checked_at"] = row["lastUpdated"]
        source_rows.append(dict(row))

    project_ids = {
        domain: args.kre8_project_id if domain == "kre8media.com" else stable_id(f"project|{domain}")
        for domain in PROJECT_NAMES
    }
    config_ids: dict[tuple[str, str], str] = {}
    keyword_ids: dict[tuple[tuple[str, str], str], str] = {}
    for config_key, config in configs.items():
        domain, city = config_key
        config_id = (
            args.kre8_national_config_id
            if domain == "kre8media.com" and not city
            else stable_id(f"config|{domain}|{city or 'national'}")
        )
        config_ids[config_key] = config_id
        for keyword_key in config["keywords"]:
            keyword_ids[(config_key, keyword_key)] = (
                args.kre8_existing_keyword_id
                if config_id == args.kre8_national_config_id
                and keyword_key == "kre8 media outdoor advertising"
                else stable_id(f"rank-keyword|{config_id}|{keyword_key}")
            )

    snapshots: dict[tuple[tuple[str, str], str], dict[tuple[str, str], dict[str, Any]]] = defaultdict(dict)
    for row in source_rows:
        domain = row["domain"].strip().lower()
        city = (row["city"] or "").strip()
        config_key = (domain, city)
        keyword_key = row["keyword"].strip().lower()
        tracking_keyword_id = keyword_ids[(config_key, keyword_key)]
        device = (row["device"] or "desktop").lower()
        history = parse_json(row["history"], {})
        if isinstance(history, dict):
            for raw_day, raw_position in history.items():
                day = normalize_day(str(raw_day))
                position = int(raw_position or 0)
                snapshots[(config_key, day)][(tracking_keyword_id, device)] = {
                    "tracking_keyword_id": tracking_keyword_id,
                    "keyword": row["keyword"].strip(),
                    "device": device,
                    "position": position if position > 0 else None,
                    "url": None,
                    "checked_at": f"{day}T12:00:00.000Z",
                }
        if row["lastUpdated"]:
            day = normalize_day(row["lastUpdated"])
            position = int(row["position"] or 0)
            snapshots[(config_key, day)][(tracking_keyword_id, device)] = {
                "tracking_keyword_id": tracking_keyword_id,
                "keyword": row["keyword"].strip(),
                "device": device,
                "position": position if position > 0 else None,
                "url": (row["url"] or "").strip() or None,
                "checked_at": normalize_timestamp(row["lastUpdated"], day),
            }

    exported_configs = []
    for config_key, config in sorted(configs.items()):
        domain, city = config_key
        exported_configs.append(
            {
                "project_id": project_ids[domain],
                "project_name": PROJECT_NAMES[domain],
                "domain": domain,
                "config_id": config_ids[config_key],
                "location_code": args.las_vegas_location_code if city else args.national_location_code,
                "location_name": config["location_name"],
                "devices": devices_label(config["devices"]),
                "keywords": [
                    {
                        "id": keyword_ids[(config_key, key)],
                        "keyword": value["keyword"],
                        "search_volume": value["volume"] or None,
                        "tags": sorted(value["tags"]),
                        "created_at": value["added"],
                    }
                    for key, value in sorted(config["keywords"].items())
                ],
            }
        )

    export = {
        "format": "openseo-serpbear-migration-v1",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_rows": len(source_rows),
        "unique_keywords": sum(len(config["keywords"]) for config in configs.values()),
        "historical_snapshots": sum(len(items) for items in snapshots.values()),
        "projects": exported_configs,
    }
    export_path = Path(args.export_json)
    export_path.write_text(json.dumps(export, indent=2, sort_keys=True) + "\n")

    statements: list[str] = [
        "-- Generated by scripts/migrate-serpbear.py; contains no credentials.",
        "PRAGMA foreign_keys = ON;",
    ]
    for domain, name in PROJECT_NAMES.items():
        project_id = project_ids[domain]
        statements.append(
            "INSERT INTO projects (id, organization_id, name, domain, location_code, language_code, created_at, archived_at) "
            f"VALUES ({sql(project_id)}, {sql(args.organization_id)}, {sql(name)}, {sql(domain)}, {args.national_location_code}, 'en', current_timestamp, NULL) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, domain=excluded.domain, archived_at=NULL;"
        )

    for config_key, config in sorted(configs.items()):
        domain, city = config_key
        config_id = config_ids[config_key]
        location_code = args.las_vegas_location_code if city else args.national_location_code
        statements.append(
            "INSERT INTO rank_tracking_configs "
            "(id, project_id, domain, location_code, language_code, devices, serp_depth, schedule_interval, location_name, is_active, last_checked_at, next_check_at, last_skip_reason, created_at) "
            f"VALUES ({sql(config_id)}, {sql(project_ids[domain])}, {sql(domain)}, {location_code}, 'en', {sql(devices_label(config['devices']))}, {args.serp_depth}, {sql(args.schedule)}, {sql(config['location_name'])}, 1, {sql(config['last_checked_at'])}, NULL, NULL, current_timestamp) "
            "ON CONFLICT(id) DO UPDATE SET devices=excluded.devices, serp_depth=excluded.serp_depth, schedule_interval=excluded.schedule_interval, location_name=excluded.location_name, is_active=1, last_checked_at=excluded.last_checked_at;"
        )
        for keyword_key, keyword in sorted(config["keywords"].items()):
            keyword_id = keyword_ids[(config_key, keyword_key)]
            statements.append(
                "INSERT INTO rank_tracking_keywords (id, config_id, keyword, search_volume, created_at) "
                f"VALUES ({sql(keyword_id)}, {sql(config_id)}, {sql(keyword['keyword'])}, {sql(keyword['volume'] or None)}, {sql(keyword['added'] or datetime.now(timezone.utc).isoformat())}) "
                "ON CONFLICT(id) DO UPDATE SET search_volume=COALESCE(excluded.search_volume, rank_tracking_keywords.search_volume);"
            )
            saved_keyword_id = stable_id(f"saved-keyword|{project_ids[domain]}|{location_code}|{keyword_key}")
            statements.append(
                "INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code, created_at) "
                f"VALUES ({sql(saved_keyword_id)}, {sql(project_ids[domain])}, {sql(keyword['keyword'])}, {location_code}, 'en', {sql(keyword['added'] or datetime.now(timezone.utc).isoformat())}) "
                "ON CONFLICT(project_id, keyword, location_code, language_code) DO NOTHING;"
            )
            for tag_name in sorted(keyword["tags"]):
                normalized = " ".join(tag_name.lower().split())
                tag_id = stable_id(f"tag|{project_ids[domain]}|{normalized}")
                statements.append(
                    "INSERT INTO saved_keyword_tags (id, project_id, name, normalized_name, created_at) "
                    f"VALUES ({sql(tag_id)}, {sql(project_ids[domain])}, {sql(tag_name)}, {sql(normalized)}, current_timestamp) "
                    "ON CONFLICT(project_id, normalized_name) DO NOTHING;"
                )
                statements.append(
                    "INSERT INTO saved_keyword_tag_assignments (saved_keyword_id, tag_id, created_at) "
                    f"VALUES ({sql(saved_keyword_id)}, {sql(tag_id)}, current_timestamp) "
                    "ON CONFLICT(saved_keyword_id, tag_id) DO NOTHING;"
                )

    for (config_key, day), day_snapshots in sorted(snapshots.items()):
        domain, _city = config_key
        config_id = config_ids[config_key]
        run_id = stable_id(f"serpbear-run|{config_id}|{day}")
        checked_keywords = len({item["tracking_keyword_id"] for item in day_snapshots.values()})
        statements.append(
            "INSERT INTO rank_check_runs (id, config_id, project_id, status, keywords_total, keywords_checked, is_subset_run, started_at, completed_at) "
            f"VALUES ({sql(run_id)}, {sql(config_id)}, {sql(project_ids[domain])}, 'completed', {len(configs[config_key]['keywords'])}, {checked_keywords}, 1, {sql(day + 'T12:00:00.000Z')}, {sql(day + 'T12:00:00.000Z')}) "
            "ON CONFLICT(id) DO UPDATE SET status='completed', keywords_checked=excluded.keywords_checked, completed_at=excluded.completed_at;"
        )
        for item in sorted(day_snapshots.values(), key=lambda value: (value["keyword"].lower(), value["device"])):
            statements.append(
                "INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position, url, serp_features, checked_at) "
                f"VALUES ({sql(run_id)}, {sql(item['tracking_keyword_id'])}, {sql(item['keyword'])}, {sql(item['device'])}, {sql(item['position'])}, {sql(item['url'])}, NULL, {sql(item['checked_at'])}) "
                "ON CONFLICT(run_id, tracking_keyword_id, device) DO UPDATE SET position=excluded.position, url=COALESCE(excluded.url, rank_snapshots.url), checked_at=excluded.checked_at;"
            )

    import_path = Path(args.import_sql)
    import_path.write_text("\n".join(statements) + "\n")
    print(json.dumps({
        "source_rows": export["source_rows"],
        "unique_keywords": export["unique_keywords"],
        "historical_snapshots": export["historical_snapshots"],
        "configs": len(configs),
        "sql_statements": len(statements),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
