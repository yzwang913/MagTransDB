# MagTransDB web deployment

This repository contains only the Flask application and deployment files. The
scientific datasets remain outside Git and are mounted read-only at runtime.

## Data layout

`DATA_ROOT_HOST` must point to a directory with this layout:

```text
MR_HT_web_show/
├── Band/
├── download/
├── fermi_surface/
├── Lattice/
└── MR/
```

The current shared dataset is located at:

```text
/data/work/cmpdc/mrht/MR_HT_web_show
```

The container mounts that directory at `/data` with read-only permissions. ZIP
downloads are assembled in the `magtransdb_tmp` Docker volume, so downloading
data does not modify the mounted dataset or consume a large in-memory `tmpfs`.

## Start with Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

The default host endpoint is `http://127.0.0.1:2000`. Change `HOST_PORT` in
`.env` if that port is already in use.

For deployment at the domain root, set:

```dotenv
BASE_URL=
```

For deployment at `https://example.org/plausible/`, set:

```dotenv
BASE_URL=/plausible
```

## Nginx subpath proxy

When Nginx runs on the Docker host and port `2000` is published to loopback:

```nginx
location = /plausible {
    return 301 /plausible/;
}

location /plausible/ {
    proxy_pass http://127.0.0.1:2000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /plausible;
}
```

The trailing slash in `proxy_pass` is intentional: Nginx removes `/plausible/`
before forwarding the request to Flask. Browser-facing links and API requests
retain the public prefix.

If Nginx is another service in the same Compose network, do not publish the
application port. Proxy directly to `http://magtransdb:1999/` instead.

## Health check

```bash
curl http://127.0.0.1:2000/api/health
```

The response reports the configured base URL, data path, and indexed material
count.

## Existing direct deployment

The application remains compatible with root-path execution without Docker:

```bash
cd web_show
python -c 'from app import create_app; create_app().run(host="0.0.0.0", port=1999)'
```

Leaving `BASE_URL` empty preserves direct root-path and Cloudflare Quick Tunnel
access.
