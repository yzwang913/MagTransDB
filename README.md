# MagTransDB

MagTransDB 是磁输运高通量计算结果的网页展示程序。本仓库只包含 Flask
应用、前端资源和 Docker 部署配置，**不包含科学计算数据**。

## 1. 部署结构

服务器上的数据目录应包含：

```text
/data/work/cmpdc/mrht/MR_HT_web_show/
├── Band/
├── download/
├── fermi_surface/
├── Lattice/
└── MR/
```

推荐把本仓库克隆为数据目录中的独立子目录：

```text
/data/work/cmpdc/mrht/MR_HT_web_show/
├── Band/               # 数据，不进入 Git
├── download/           # 数据，不进入 Git
├── fermi_surface/      # 数据，不进入 Git
├── Lattice/            # 数据，不进入 Git
├── MR/                 # 数据，不进入 Git
├── web_show/           # 以前同步遗留的目录，可以保留，不会被使用
└── MagTransDB/         # 从本仓库克隆的部署代码
```

不要把仓库直接克隆为已经存在的 `web_show/`，也不要在非空的
`MR_HT_web_show/` 上直接执行不带目标目录的 `git clone`。

## 2. 前置条件

部署主机需要：

- Docker Engine
- Docker Compose v2，可通过 `docker compose version` 检查
- 能够访问 Docker Hub，以拉取 `python:3.12-slim`
- 对数据目录具有读取和目录遍历权限
- 足够的磁盘空间用于镜像和临时 ZIP 文件

首次构建前建议检查：

```bash
docker --version
docker compose version
test -d /data/work/cmpdc/mrht/MR_HT_web_show/Lattice
test -d /data/work/cmpdc/mrht/MR_HT_web_show/MR
test -d /data/work/cmpdc/mrht/MR_HT_web_show/Band
test -d /data/work/cmpdc/mrht/MR_HT_web_show/fermi_surface
test -d /data/work/cmpdc/mrht/MR_HT_web_show/download
```

## 3. 克隆和配置

```bash
cd /data/work/cmpdc/mrht/MR_HT_web_show
git clone https://github.com/yzwang913/MagTransDB.git MagTransDB
cd MagTransDB
cp .env.example .env
```

编辑 `.env`：

```dotenv
# 根路径部署时留空；子路径部署时填写 /xxx，开头有斜杠，末尾无斜杠。
BASE_URL=/plausible

# 必须指向包含 Lattice、MR、Band、fermi_surface 和 download 的目录。
DATA_ROOT_HOST=/data/work/cmpdc/mrht/MR_HT_web_show

# Nginx 与 Docker 在同一主机时，建议只监听回环地址。
HOST_BIND=127.0.0.1
HOST_PORT=2000

IMAGE_NAME=magtransdb:local
```

## 4. 启动服务

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 magtransdb
```

默认情况下，应用只在部署主机的以下地址监听：

```text
http://127.0.0.1:2000
```

检查应用和数据索引：

```bash
curl http://127.0.0.1:2000/api/health
```

正常响应示例：

```json
{
  "base_url": "/plausible",
  "count": 715,
  "lattice_dir": "/data/Lattice",
  "status": "ok"
}
```

材料数量会随数据更新而变化，不要求始终等于示例中的 `715`。

## 5. 部署在域名子路径

以下配置将网页发布到 `https://example.org/plausible/`。

`.env` 中设置：

```dotenv
BASE_URL=/plausible
```

Nginx 配置：

```nginx
location = /plausible {
    return 301 /plausible/;
}

location /plausible/ {
    proxy_pass http://127.0.0.1:2000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /plausible;
}
```

应用 Nginx 配置：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

验证：

```bash
curl -I https://example.org/plausible/
curl https://example.org/plausible/api/health
```

### Nginx 尾部斜杠

下面两处末尾的 `/` 都必须保留：

```nginx
location /plausible/ {
    proxy_pass http://127.0.0.1:2000/;
}
```

这种写法会让 Nginx 在转发时去掉 `/plausible/` 前缀。网页会在浏览器端自动为
静态资源、材料链接、API 和下载地址补回公开路径前缀。

如果 Nginx 自身也是同一 Docker Compose 网络中的容器，可以改为：

```nginx
proxy_pass http://magtransdb:1999/;
```

这种情况下需要确保 Nginx 和 `magtransdb` 服务加入同一个 Docker 网络。

## 6. 部署在域名根路径

如果网页发布在 `https://example.org/`，将 `.env` 改为：

```dotenv
BASE_URL=
```

Nginx 可以使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:2000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

修改 `.env` 后需要重新创建容器：

```bash
docker compose up -d --force-recreate
```

## 7. 数据与下载文件

Compose 将数据目录挂载为：

```yaml
/data/work/cmpdc/mrht/MR_HT_web_show:/data:ro
```

末尾的 `:ro` 表示容器只能读取数据。网页下载功能生成 ZIP 时使用
`magtransdb_tmp` Docker 命名卷，不会修改原始数据目录。

部分材料的下载包可能超过 1 GB。部署主机应为 Docker 数据目录预留足够空间。
临时 ZIP 会在响应结束后由应用删除。

## 8. 更新网页代码

```bash
cd /data/work/cmpdc/mrht/MR_HT_web_show/MagTransDB
git pull --ff-only
docker compose up -d --build
docker compose ps
```

更新代码不会修改只读挂载的数据目录。

## 9. 停止或重启

```bash
# 重启
docker compose restart

# 停止并移除容器，保留镜像和临时卷
docker compose down

# 查看日志
docker compose logs -f --tail=200 magtransdb
```

一般不要使用 `docker compose down -v`，因为 `-v` 会删除 Compose 管理的临时卷。
它不会删除只读挂载的科学数据，但通常没有必要执行。

## 10. 常见问题

### 端口已经被占用

修改 `.env` 中的端口，例如：

```dotenv
HOST_PORT=2001
```

然后同步修改 Nginx 的 `proxy_pass` 并重新创建容器：

```bash
docker compose up -d --force-recreate
```

### 网页能打开，但静态资源或 API 返回 404

检查：

1. `.env` 中的 `BASE_URL` 是否与 Nginx 的 `location` 完全一致。
2. `BASE_URL` 是否以 `/` 开头且末尾没有 `/`。
3. `location /plausible/` 和 `proxy_pass .../` 的尾部斜杠是否保留。
4. 是否设置了 `X-Forwarded-Prefix /plausible`。

### 数据目录存在，但网页显示 0 个材料

检查容器实际读取的路径：

```bash
docker compose exec magtransdb ls -la /data/Lattice | head
docker compose exec magtransdb python -c \
  'import os; print(os.environ.get("DATA_ROOT"))'
```

同时确认 Docker 进程对 `/data/work/cmpdc/mrht/MR_HT_web_show` 及其父目录具有
读取和目录遍历权限。

### 构建时无法拉取基础镜像

如果出现 Docker Hub 超时或连接被重置，需要先配置服务器网络或 Docker 镜像
加速器，然后重新执行：

```bash
docker compose build --pull
docker compose up -d
```

## 11. Git 仓库内容

`.gitignore` 和 `.dockerignore` 已排除：

```text
Lattice/
MR/
Band/
fermi_surface/
soc_fermi_surface/
wosoc_fermi_surface/
download/
web_show/logs/
web_show/backups/
```

提交前可以检查：

```bash
git status --short
git ls-files | grep -E '^(Lattice|MR|Band|fermi_surface|download)/' && \
  echo "ERROR: data files are tracked"
```

正常情况下，第二条命令不应输出任何数据文件。

## 12. 不使用 Docker 的原有运行方式

代码仍兼容根路径下的原有 Flask 和 Cloudflare Quick Tunnel 部署：

```bash
cd web_show
python -c 'from app import create_app; create_app().run(host="0.0.0.0", port=1999)'
```

这种方式应保持 `BASE_URL` 为空。Cloudflare Quick Tunnel 地址是临时地址，重启
`cloudflared` 后通常会变化。
