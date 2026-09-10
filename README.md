# MagTransDB

MagTransDB 展示磁输运高通量计算结果。本仓库负责 Flask 应用、前端资源、
`web_show/Dockerfile`、Compose 与业务验证，不包含科学计算数据。
镜像构建上下文为 `web_show/`；Compose、环境配置和发布脚本保留在仓库根目录。

## 生产部署约定

- 公开地址：`https://cmpdc.iphy.ac.cn/mtdb/`，应用名称保留 MagTransDB。
- Compose project 为 `magtransdb`，service 为 `server`；容器监听 `8000`。
- 网关内部回源 `magtransdb:8000`，去除 `/mtdb/` 前缀并传递
  `X-Forwarded-Prefix: /mtdb`；公开 `/mtdb` 应跳转到 `/mtdb/`。
- 两级网关、`web-gateway` 网络接入、别名注册与数据权限由 ops-knowledge
  管理。应用 Compose 不维护这些内容。网关注册目标为
  `project=magtransdb, service=server, alias=magtransdb`。
- 容器以 root 运行，科学数据继续只读挂载到 `/data`，应用不能通过该挂载修改数据。

## 数据与可写目录

`DATA_ROOT_HOST` 必须指向已有目录，包含 `Lattice/`、`MR/`、`Band/`、
`fermi_surface/` 和 `download/`。部署前确认数据目录存在，避免短写法挂载自动创建空目录。
代码目录可以独立放在 `/home/tnzhu/projects/magtransdb`，不需要放进科学数据目录。

当前数据交接基线为 Lattice/Band/fermi_surface/download 各 726 个一致的材料 ID，
应用隐藏 11 个，预计显示 715 个。这个数量是当前验收基线，不是代码中的硬编码。

Gunicorn 心跳临时文件通过 `--worker-tmp-dir /dev/shm` 放到 Docker 的内存文件系统，
避免心跳文件操作依赖磁盘 I/O。
下载 ZIP 使用系统临时目录 `/tmp`，位于容器可写层，无需单独挂载临时卷。
不要把大 ZIP 放入 `/dev/shm`。容器删除后，其可写层中的临时文件也会删除。

ZIP 在完整压缩后才开始响应，不会把整个 ZIP 读入内存；支持 HTTP Range。
Linux 上应用在 `send_file` 打开文件后移除临时路径，响应持有的文件描述符关闭后
释放磁盘空间。压缩异常会清理文件；进程被强制杀死或主机崩溃时，仍可能留下未完成
ZIP，需要在无下载任务时清理 `/tmp` 中的残留文件。并发下载会分别生成 ZIP，应预留相应磁盘空间。
两级网关的响应等待时间须覆盖压缩完成前的等待；实际生产大包的超时与吞吐需联调验收。

## 正式部署命令（由用户安排执行）

先将已审核的改动合入部署目录，再执行以下命令。需要 Docker Engine 和 Compose v2+，
并具备拉取基础镜像和 Python 依赖的网络条件。

```bash
cd /home/tnzhu/projects/magtransdb
# 首次部署时创建；已有配置则编辑它，不覆盖现有设置。
test -f .env.production || cp .env.example .env.production
```

配置统一由 `.env.production` 加载，与 HSP 一致；该文件不进入 Git：

```dotenv
BASE_URL=/mtdb
DATA_ROOT_HOST=/data/work/cmpdc/mrht/MR_HT_web_show
GUNICORN_CMD_ARGS="--bind 0.0.0.0:8000 --worker-class gthread --workers 2 --threads 4 --worker-tmp-dir /dev/shm --timeout 120 --access-logfile - --error-logfile -"
```

容器内 `DATA_ROOT=/data` 由 Dockerfile 设置，无需重复配置；ZIP 使用系统临时目录。
Gunicorn 使用常规端口 8000；保留 `--bind 0.0.0.0:8000`，供网关跨容器访问。
Gunicorn 参数由 `GUNICORN_CMD_ARGS` 提供；调整进程数、线程数或超时后，运行
`docker compose --env-file .env.production up -d` 重建容器即可，无需重新构建镜像。
`--worker-tmp-dir /dev/shm` 将心跳文件与磁盘上的 ZIP 临时文件分开。

发布入口为 `scripts/release.sh`，从根目录 `VERSION` 读取版本（初始 `0.1.0`），
自动记录 Git revision，拉取基础镜像并构建，然后通过 Compose 后台启动服务。
与 ARPES/HSP 一致，脚本不等待健康检查；启动后用 `docker compose ps` 查看状态。

```bash
test -d /data/work/cmpdc/mrht/MR_HT_web_show/Lattice
./scripts/release.sh
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 server
docker compose --env-file .env.production exec -T server python -c \
  'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=10).read().decode())'
```

健康响应应包含 `status: "ok"`、`base_url: "/mtdb"`、`count: 715`。
健康接口只确认应用和索引加载成功，不能代替各科学数据文件的业务验收。
Compose 默认不发布宿主机端口；诊断在容器内执行，网关使用容器的 `8000` 端口。
镜像使用 `magtransdb-server:${MAGTRANSDB_VERSION:-dev}`，构建时记录来源与 revision 标签；
发布脚本自动设置版本标签与 revision，无需手动导出。
容器重建后的网关网络接入由 ops-knowledge 的注册机制负责。

网关就绪后检查：

```bash
curl --fail -I https://cmpdc.iphy.ac.cn/mtdb/
curl --fail https://cmpdc.iphy.ac.cn/mtdb/api/health
curl --fail -I https://cmpdc.iphy.ac.cn/mtdb/static/base-url.js
```

用浏览器选一个有完整数据的可见材料，验证搜索、详情、晶体结构、SOC/无 SOC 能带、
SOC/无 SOC 费米面、磁阻与 PDF，以及 Wannier/Fermi ZIP 下载。对最大的下载包记录
首字节等待时间、最终大小，并用 `unzip -t` 验证。必要时由网关维护方调整超时。
本文命令是交付说明，不代表本次已部署或已完成生产验收。

## 更新与维护

代码更新后在部署目录运行 `./scripts/release.sh`。
数据目录保持只读。停止使用 `docker compose --env-file .env.production down`；通常无需 `down -v`。
修改 `.env.production` 后重新运行发布脚本，单独 `restart` 不会应用新环境变量。

如需独立根路径部署，将 `.env.production` 中的 `BASE_URL` 显式设为空。
原有非容器方式仍可使用，需安装 `web_show/requirements.txt`、设置 `DATA_ROOT` 后运行：

```bash
cd web_show
BASE_URL= python -c 'from app import create_app; create_app().run(host="127.0.0.1", port=1999)'
```
