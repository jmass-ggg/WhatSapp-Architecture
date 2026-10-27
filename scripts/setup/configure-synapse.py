#!/usr/bin/env python3
"""Apply local-only settings to the official generated Synapse configuration."""

import os
from pathlib import Path

import yaml


config_path = Path(os.environ["SYNAPSE_CONFIG_PATH"])
config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
if not isinstance(config, dict):
    raise SystemExit("Generated Synapse config must be a YAML mapping")

jwt_signing_key = os.environ.get("SYNAPSE_JWT_SIGNING_KEY", "")
if len(jwt_signing_key.encode("utf-8")) < 32:
    raise SystemExit("SYNAPSE_JWT_SIGNING_KEY must contain at least 32 bytes")

config["server_name"] = os.environ["SYNAPSE_SERVER_NAME"]
config["public_baseurl"] = os.environ["SYNAPSE_PUBLIC_URL"].rstrip("/") + "/"
config["report_stats"] = False
config["enable_registration"] = False
config["allow_guest_access"] = False
config["jwt_config"] = {
    "enabled": True,
    "secret": jwt_signing_key,
    "algorithm": "HS256",
    "subject_claim": "sub",
    "display_name_claim": "display_name",
    "issuer": os.environ["SYNAPSE_JWT_ISSUER"],
    "audiences": [os.environ["SYNAPSE_JWT_AUDIENCE"]],
}
config["federation_domain_whitelist"] = []
config["trusted_key_servers"] = []
config["media_store_path"] = "/data/media_store"
config["signing_key_path"] = (
    f"/data/{os.environ['SYNAPSE_SERVER_NAME']}.signing.key"
)

listeners = config.get("listeners")
if not isinstance(listeners, list) or not listeners:
    raise SystemExit("Official generator did not produce a listener")

client_listener = next(
    (
        listener
        for listener in listeners
        if any(
            "client" in resource.get("names", [])
            for resource in listener.get("resources", [])
        )
    ),
    None,
)
if client_listener is None:
    raise SystemExit("Official generator did not produce a client listener")

client_listener["port"] = 8008
client_listener["tls"] = False
client_listener["type"] = "http"
client_listener["x_forwarded"] = False
client_listener["bind_addresses"] = ["0.0.0.0"]
client_listener["resources"] = [
    {"names": ["client"], "compress": False}
]
config["listeners"] = [client_listener]

config["database"] = {
    "name": "psycopg2",
    "args": {
        "user": os.environ["SYNAPSE_DATABASE_USER"],
        "password": os.environ["SYNAPSE_DATABASE_PASSWORD"],
        "database": os.environ["SYNAPSE_DATABASE_NAME"],
        "host": os.environ["POSTGRES_HOST"],
        "port": int(os.environ["POSTGRES_PORT"]),
        "cp_min": 5,
        "cp_max": 10,
    },
}

temporary_path = config_path.with_suffix(".yaml.tmp")
temporary_path.write_text(
    yaml.safe_dump(config, sort_keys=False),
    encoding="utf-8",
)
temporary_path.chmod(0o600)
temporary_path.replace(config_path)
