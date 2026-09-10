# MagTransDB

MagTransDB 是磁输运高通量计算结果的展示与查询应用，使用 Flask 提供接口和静态页面，支持：

- 材料检索、元素筛选与晶体结构查看。
- 含自旋轨道耦合（SOC）和无 SOC 的能带、费米面展示。
- 磁阻曲线与 PDF 查看。
- 晶体结构文件及 Wannier / Fermi 数据打包下载。

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

下文以 `../magtransdb-data` 为数据根目录示例，使用前替换为自己的数据位置。
先确认数据已存在；Compose 的目录挂载可能自动创建空目录，不能据此判断数据准备完成。

## 本地运行

使用 Python 3.12 创建虚拟环境并安装依赖：

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r server/requirements.txt
DATA_ROOT=../magtransdb-data BASE_URL= \
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

编辑 `.env.production`，将 `DATA_ROOT_HOST` 替换为已准备好的数据目录，并按访问方式设置 `BASE_URL`：

```dotenv
DATA_ROOT_HOST=../magtransdb-data
BASE_URL=/mtdb
```

保留模板中的 `GUNICORN_CMD_ARGS`，按负载调整进程数、线程数和超时。
监听地址应保留 `0.0.0.0:8000`。Compose 默认不发布宿主机端口。
`BASE_URL` 表示应用的公开访问路径前缀，根路径访问时显式设为空。
`.env.production` 已被 Git 忽略，用于保存各环境的实际配置。

Compose 将科学数据只读挂载到容器，容器内的数据位置由 Dockerfile 配置。
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
再选择数据完整的材料验证检索、晶体结构、两种 SOC 模式的能带与费米面、磁阻及 PDF。
下载 Wannier / Fermi ZIP，使用 `unzip -t` 检查压缩包，并用较大数据包确认等待时间和传输是否正常。

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
