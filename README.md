# Pan-European EPR Compliance Console

> **泛欧 EPR 合规交付工作量控制台** —— 一个零依赖的 Node.js 单文件 Web 应用，用于管理泛欧 EPR（生产者责任延伸）合规交付的工单台账、交付进度与团队分工。
>
> A zero-dependency Node.js web console for Pan-European EPR compliance delivery workload management.

![Node](https://img.shields.io/badge/Node.js-%E2%89%A516-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![Backend](https://img.shields.io/badge/backend-native%20http-informational)

---

## 简介 / Overview

面向跨境 EPR 合规交付团队（如德国 WEEE / 电池法、法国、意大利、西班牙等多国注册与申报业务）的**轻量工作台**。它把散落在 Excel 与聊天记录里的工单台账、每日录入量、各国交付节点、凭证文件收敛到一个可多人协同的系统里。

- **零依赖**：后端只用 Node.js 内置模块，前端是单个 `index.html`（原生 JS），不需要 `npm install`、不需要数据库。
- **数据即文件**：全部业务数据落在一个 `data.json` 里，服务端增量写入、多端共享同一份数据。
- **按需部署**：一台装了 Node.js 的机器就能跑，也可直接发布到云主机。

---

## ✨ 功能 / Features

| 模块 | 说明 |
|---|---|
| 工单台账 | 多国工单的注册号、证书号、状态、交付步骤全生命周期管理 |
| 分国别视图 | 按国家 / 服务项目 / 状态筛选，映射到具体负责人 |
| 每日记分 | 录入工作量按**工作流分步计分**（非整单结算），支持加分/纠正 |
| 数据报表 | 完成率、各国进度、专人工作量统计，支持导出 Excel |
| 凭证管理 | 凭证图片上传 / 下载 / 预览，与工单绑定 |
| 员工账号 | 账号、显示名、管辖国家、角色权限管理 |
| 外部工单系统同步 | 可选的定时/手动同步，字段映射与"进度只进不退"保护 |

---

## 🏗 技术架构 / Architecture

```
┌──────────────────────────┐
│  index.html（单文件前端） │  原生 JS，无构建步骤
│  · 登录 / 台账 / 报表     │  xlsx.full.min.js 用于 Excel 导出
└────────────┬─────────────┘
             │  fetch + X-Auth-Token
┌────────────▼─────────────┐
│  server.js（Node 原生 http）│  路由 + 鉴权 + 业务逻辑
│  crm_sync.js（可选模块）   │  外部工单系统同步 + 只读护栏
└────────────┬─────────────┘
             │
      data.json（唯一数据源） / uploads/（凭证文件）
```

- **后端**：`http` / `fs` / `crypto` 等内置模块，无任何第三方运行时依赖。
- **鉴权**：登录发放随机 token，服务端内存 + `sessions.json` 持久化；请求带 `X-Auth-Token`。
- **密码**：`scrypt` 单向哈希 + 每人独立随机盐，不可反推。

---

## 🚀 快速开始 / Quick Start

**环境要求**：Node.js ≥ v16（推荐 v18/v20），磁盘 ≥ 200MB，端口默认 3000。

```bash
git clone https://github.com/ecopv-robotics/Pan-European-EPR-Complian.git
cd Pan-European-EPR-Complian

# 方式一：直接运行
node server.js

# 方式二：使用启动脚本（Linux/macOS）
./start.sh start      # 启动    ./start.sh stop   # 停止
./start.sh status     # 状态    ./start.sh restart # 重启

# 自定义端口
PORT=8080 node server.js
```

启动后访问 <http://localhost:3000/>。

> **首个账号**：仓库**不包含任何数据文件**。首次启动时若 `data.json` 不存在，服务会自动初始化一个空库，并创建默认管理员 `admin`。初始口令取环境变量 `EPR_BOOTSTRAP_ADMIN_PW`（未设置时使用内置默认值，**公开仓库不列出该值**）——**首次登录后请立刻修改密码**。
>
> ```bash
> # 生产部署请显式指定初始口令（避免使用任何默认值）
> EPR_BOOTSTRAP_ADMIN_PW='请换成你自己的强口令' node server.js
> ```

---

## 🔐 权限模型 / Roles

三级角色，能力自下而上叠加：

| 角色 | 标识 | 能力 |
|---|---|---|
| `specialist` | 交付专员 | 只能看到**自己管辖国家**的工单与录入自己的工作量 |
| `admin` | 管理员 | 全部国家数据、员工账号管理、基础配置、外部系统同步设置 |
| `root` | 最高权限 | 拥有 admin 全部权限；**唯一额外能力**是可查看外部工单系统的接入凭据（查看时须二次输入登录密码，且操作会写入审计日志） |

---

## 📁 目录结构 / Project Structure

```
.
├── server.js            # 后端主程序（路由 / 鉴权 / 业务逻辑）
├── crm_sync.js          # 外部工单系统同步模块（可选，含只读护栏）
├── index.html           # 单文件前端（含全部页面与样式）
├── xlsx.full.min.js     # SheetJS，用于 Excel 导出
├── start.sh             # Linux/macOS 启停脚本
├── package.json
├── .gitignore           # ⚠️ 严格排除所有数据与凭据文件
└── uploads/             # 凭证图片目录（内容不入库）
```

---

## 🔒 安全与数据隔离 / Security

本仓库为**公开仓库**，因此做了强隔离设计：

1. **业务数据不入库**：`data.json`、`uploads/`、`backups/`、`sessions.json`、`audit.log` 全部由 `.gitignore` 排除。仓库里没有任何真实工单、账号或客户凭证。
2. **凭据独立文件**：外部系统接入凭据存放于独立的 `secrets.json`（权限 `0600`），**不在 `data.json` 内**，因此数据备份接口天然带不走凭据；管理员在前端填写，服务端运行时落盘。
3. **接口不回显敏感信息**：状态查询接口只返回"是否已配置"的布尔值，连掩码都不返回。
4. **同步模块只读护栏**：对外部系统的访问锁定白名单端点（仅令牌换取与查询），写操作黑名单优先级更高。
5. **不写死可用口令**：引导管理员口令由环境变量 `EPR_BOOTSTRAP_ADMIN_PW` 提供；密码一律以 `scrypt` + 独立随机盐存储，接口与日志都不回显任何口令。

> ⚠️ 如果你 fork 后要在生产环境使用：请务必设置 `EPR_BOOTSTRAP_ADMIN_PW`、修改默认管理员密码、为服务器配置 HTTPS，并把 `data.json` 纳入定期备份。

---

## 📄 License

内部项目，暂未指定开源许可证。
