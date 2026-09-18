# MagTransDB

MagTransDB 是磁输运高通量计算结果的展示与查询应用，使用 Flask 提供接口和静态页面，支持：

- 材料检索、元素筛选与晶体结构查看。
- 含自旋轨道耦合（SOC）和无 SOC 的能带、费米面展示。
- 磁阻与 Hall 曲线查看。
- 晶体结构文件及 Wannier / Fermi 数据打包下载。
- 邮箱验证注册、登录和密码重置；未登录用户不能访问材料数据。

仓库包含应用代码和部署配置，科学计算数据需单独准备。以下命令均从仓库根目录执行。

## 数据准备

应用从 `Lattice/` 建立材料索引，其他数据按材料 ID 关联。数据根目录应包含：

```text
<data-root>/
├── Lattice/
├── MR/
├── Band/
├── fermi_surface/
│   └── <material-id>/
│       ├── soc/FS3D.bxsf
│       └── wosoc/FS3D.bxsf
└── download/
    └── <material-id>/
        ├── soc/
        └── wosoc/
```

`download/` 下的 Wannier 文件支持 `*.win`、`*.wout` 和 `*hr.dat`。
费米面也兼容旧版 `soc_fermi_surface/`、`wosoc_fermi_surface/` 布局。
材料是否可用取决于实际数据及应用的隐藏规则，材料总数不作为固定部署指标。

生产部署使用 `/data/work/projects/magtransdb/data` 作为数据根目录。
先确认数据已存在；Compose 的目录挂载可能自动创建空目录，不能据此判断数据准备完成。

## 用户账号数据

账号信息保存在独立 SQLite 数据库中，不进入 Git 仓库，也不放在可下载的科学数据目录中：

```text
/data/work/projects/magtransdb/
├── data/                  # 科学数据，只读挂载
└── state/                 # 账号状态，可写挂载
    ├── auth.sqlite3
    └── backups/
```

数据库保存姓名、单位、职位、规范化邮箱、密码哈希、邮箱验证状态和登录时间；不保存明文密码。
`/data` 位于 Lustre，因此应用显式使用 SQLite rollback journal，而不使用不兼容网络文件系统的 WAL。
该部署只适用于单个应用容器和低频账号写入；需要多副本时应迁移到 PostgreSQL。

## 本地运行

使用 Python 3.12 创建虚拟环境并安装依赖：

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r server/requirements.txt
mkdir -p .local-state
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
DATA_ROOT=/data/work/projects/magtransdb/data \
AUTH_DATABASE_PATH="$PWD/.local-state/auth.sqlite3" \
MAIL_SUPPRESS_SEND=true SESSION_COOKIE_SECURE=false BASE_URL= \
  python -m flask --app server.app:create_app run --host 127.0.0.1 --port 1999
```

打开 [本地页面](http://127.0.0.1:1999/)。本地运行通过 `DATA_ROOT` 指定数据根目录；
`BASE_URL` 留空表示从网站根路径访问。Flask 开发服务用于本地调试，生产环境使用下方的 Gunicorn 容器。

## 容器部署

需要 Docker Engine、Compose v2 和 Git，以及拉取基础镜像、安装 Python 依赖的网络条件。

### 1. 配置环境

首次部署创建配置文件，已有配置则直接编辑：

```bash
test -f .env.production || cp .env.example .env.production
```

编辑 `.env.production`。至少需要设置数据目录、账号数据库目录、公开地址、随机密钥和 SMTP：

```dotenv
DATA_ROOT_HOST=/data/work/projects/magtransdb/data
AUTH_DB_HOST=/data/work/projects/magtransdb/state
AUTH_DATABASE_PATH=/state/auth.sqlite3
BASE_URL=/mtdb
PUBLIC_BASE_URL=https://cmpdc.iphy.ac.cn/mtdb
SECRET_KEY=<long-random-value>

MAIL_SERVER=<smtp-host>
MAIL_PORT=587
MAIL_USE_TLS=true
MAIL_USE_SSL=false
MAIL_USERNAME=<smtp-user>
MAIL_PASSWORD=<smtp-password>
MAIL_DEFAULT_SENDER=MagTransDB <no-reply@example.org>
```

生成 `SECRET_KEY`：

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
```

生产环境必须保持 `AUTH_ENABLED=true`、`MAIL_SUPPRESS_SEND=false` 和
`SESSION_COOKIE_SECURE=true`。SMTP 密码与 `SECRET_KEY` 只能保存在被 Git 忽略的
`.env.production` 中。

保留模板中的 `GUNICORN_CMD_ARGS`，按负载调整进程数、线程数和超时。
监听地址应保留 `0.0.0.0:8000`。Compose 默认不发布宿主机端口。
`BASE_URL` 表示应用的公开访问路径前缀，根路径访问时显式设为空。
`.env.production` 已被 Git 忽略，用于保存各环境的实际配置。

Compose 将科学数据只读挂载到 `/data`，将账号状态目录可写挂载到 `/state`。
启动前必须创建账号状态目录，并确保运行容器的账号具有写权限：

```bash
mkdir -p /data/work/projects/magtransdb/state/backups
```

不要将 `/state` 暴露为 Nginx 静态目录，也不要加入材料下载接口。
完整运行参数以 `.env.example`、`compose.yaml` 和 `server/Dockerfile` 为准。

### 2. 构建并启动

```bash
./scripts/release.sh
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 server
```

发布脚本读取 `VERSION` 和当前 Git revision，拉取基础镜像、构建应用并后台启动服务。
脚本结束仅代表启动命令完成；确认 `server` 状态为 `healthy` 后，再执行下面的业务验收。

### 3. 验证服务

在容器内检查健康接口：

```bash
docker compose --env-file .env.production exec -T server python -c \
  'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=10).read().decode())'
```

确认 `status` 为 `ok`、`base_url` 与配置一致、`count` 与预期可见材料数量一致。
健康接口可在材料索引为空或关联数据不完整时返回成功，不能代替数据完整性检查。

通过应用访问地址检查首页、`api/health` 和 `static/base-url.js`，
注册测试账号，完成邮箱验证、登录、退出和密码重置，再选择数据完整的材料验证检索、
晶体结构、两种 SOC 模式的能带与费米面及磁阻。
下载 Wannier / Fermi ZIP，使用 `unzip -t` 检查压缩包，并用较大数据包确认等待时间和传输是否正常。

未登录访问首页应跳转到 `/mtdb/auth/login`；未登录访问数据 API 应返回 HTTP 401。
`/api/health` 与登录页面所需静态文件保持公开。

## 更新与维护

更新代码或环境配置后，运行 `./scripts/release.sh` 重新发布。
单独执行 `restart` 不会应用新的环境变量。数据索引在应用启动时加载，更新数据后需重启服务以刷新索引。

停止服务：

```bash
docker compose --env-file .env.production down
```

下载 ZIP 会先在系统临时目录完成压缩，再开始响应；并发请求分别占用临时磁盘空间。
Gunicorn 的超时需覆盖压缩等待时间。正常请求结束后临时文件会清理，
进程被强制终止时可能残留，应在无下载任务时检查清理。
Gunicorn 的心跳临时文件使用内存文件系统，ZIP 临时文件应使用有足够容量的磁盘空间。

### 备份账号数据库

在容器运行时使用 SQLite backup API 创建一致备份：

```bash
docker compose --env-file .env.production exec -T server python - <<'PY'
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

source = sqlite3.connect('/state/auth.sqlite3')
target_path = Path('/state/backups') / f"auth-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.sqlite3"
target = sqlite3.connect(target_path)
with target:
    source.backup(target)
target.close()
source.close()
print(target_path)
PY
```

备份文件包含个人信息和密码哈希，权限应与主数据库相同，不应提交到 GitHub。
