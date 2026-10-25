# Cognote 云端同步服务端

零依赖 Node.js 服务（兼容 Node 16+），为 Cognote 桌面端提供云端笔记存储与双向同步。

## 特性

- **Token 鉴权**：所有 API 需要 `Authorization: Bearer <token>`
- **差异同步**：客户端按文件 hash 比对，只传输变更内容
- **冲突保护**：双方同时修改时按修改时间新者胜，败方保存为「冲突副本」，不丢数据
- **删除传播**：本地删除会同步删除云端，云端删除会同步删除本地（带 tombstone，避免误删新内容）
- **零依赖**：只用 Node 内置模块，无需 npm install
- **原子写盘**：清单文件 temp + rename，避免断电写坏

## 文件结构

```
sync-server/
├── server.js          # 同步服务
├── config.json        # 配置（首次启动自动生成 token）
└── data/
    ├── files/         # 笔记与附件（按相对路径存储）
    └── manifest.json  # 文件清单（hash / mtime / 版本号）
```

`config.json`：

```json
{
  "token": "随机 Token",
  "port": 8600,
  "host": "127.0.0.1",
  "dataDir": "/www/wwwroot/knowledge/sync-server/data",
  "maxFileMb": 20,
  "inlineBudgetMb": 24
}
```

## 部署（CentOS 7 / 宝塔面板）

前提：已安装 Node.js（宝塔「Node 版本管理器」安装的 v16+ 即可）。

```bash
# 1. 上传目录
mkdir -p /www/wwwroot/knowledge/sync-server
# 将 server.js / package.json / config.json 上传到该目录

# 2. 权限
chown -R www:www /www/wwwroot/knowledge/sync-server
chmod 600 /www/wwwroot/knowledge/sync-server/config.json

# 3. systemd 守护
cat > /etc/systemd/system/cognote-sync.service <<'UNIT'
[Unit]
Description=Cognote Cloud Sync Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/knowledge/sync-server
ExecStart=/www/server/nodejs/v16.20.2/bin/node /www/wwwroot/knowledge/sync-server/server.js
Restart=always
RestartSec=3
User=www
Group=www

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cognote-sync

# 4. nginx 反向代理（走 80 端口，无需额外开放端口）
cat > /www/server/panel/vhost/nginx/knowledge-sync.conf <<'NGINX'
server {
    listen 80;
    server_name 你的服务器IP;
    client_max_body_size 100m;

    location = /knowledge-sync { return 301 /knowledge-sync/; }
    location /knowledge-sync/ {
        proxy_pass http://127.0.0.1:8600/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

> 若服务器开启了防火墙，需要放行 80（通常已放行）。若使用云服务器，确保安全组已放行 80。
>
> 也可以不使用 nginx，直接把 `config.json` 的 `host` 改为 `0.0.0.0`，开放 `port` 端口直连；但**推荐 nginx 反代**，便于后续加 HTTPS。

## 客户端配置

在 Cognote 设置 → ☁️ 云端同步：

| 项 | 示例 |
| --- | --- |
| 云端服务器地址 | `http://8.138.140.186/knowledge-sync` |
| 云端访问 Token | `config.json` 中的 `token` |
| 本地云端同步目录 | 留空使用默认（程序目录下 `云端同步`） |
| 自动同步间隔 | 60 秒 |

保存后目录树会出现「☁️ 云端同步」根分类，在它下面新建的分类和笔记会自动上传；
其它电脑配置相同地址 + Token 即可同步同一份云端笔记。

## API

所有接口都需要 Token（`Authorization: Bearer <token>` 或 `?token=`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ping` | 连通性与 Token 校验 |
| POST | `/api/sync` | 双向差异同步（`local` 清单 + `known` 上次同步 hash） |
| GET | `/api/file?path=` | 下载单个文件（base64） |
| PUT | `/api/file` | 上传/覆盖 `{path, content(base64), mtimeMs}` |
| POST | `/api/file/delete` | 删除云端文件 `{path}` |

## 备份

直接备份 `data/` 目录即可。笔记就是普通文件，可随时用文件管理器查看或迁移。

## 安全建议

- Token 相当于密码，不要公开；泄露后修改 `config.json` 的 `token` 并重启服务。
- 当前默认 HTTP 传输。对公网使用时建议在 nginx 上配置 HTTPS（宝塔可一键申请证书），
  然后把客户端地址改为 `https://你的域名/knowledge-sync`。
