# XDrive

**XDrive 是一款可自行托管的个人云盘。文件在浏览器内加密后再上传，服务端保存密文。**

> **当前稳定版：v1.3.6。** 修复 v1.3.4 用户通过网页更新到 HEIC 支持版时的安装包兼容问题，并继续支持 HEIC/HEIF 图片预览与缩略图。

## 功能

- 单用户、自托管的 Web 云盘，可部署在自己的 Linux VPS。
- 浏览器端加密文件及目录索引；服务器不保存文件名、文件夹名或文件内容的明文副本。
- 文件和文件夹管理、上传续传、回收站、图片与视频预览，以及 PDF、文本、Markdown 和代码预览。HEIC/HEIF 图片保留原文件加密存储；本机浏览器无法原生显示时，使用按需加载的本地解码器生成预览和缩略图，解码输入上限为 32 MiB。
- 流式单文件下载和 ZIP64 文件夹导出。
- 本地 SQLite 与文件系统存储；部署可使用现有 Nginx 或 Caddy。无需 Docker。

## 隐私与安全

XDrive 在浏览器中使用 Argon2id 派生密钥，并使用 AES-256-GCM 加密文件数据。密码和未解包的 Vault Key 不会发送给服务器。登录所需的认证材料会通过 HTTPS 发送，服务器也能看到密文对象大小和数量、访问时间、客户端 IP 等运行信息。

客户端加密不能抵御被攻陷的浏览器、恶意扩展，或能替换 XDrive 网页代码的服务器。密码遗忘后，XDrive 无法恢复加密密钥；服务器备份也不能代替密码。使用前请先在测试环境验证，并实际演练备份与恢复。

## 安装与部署

从 [GitHub Releases](https://github.com/jareyxu/XDrive/releases/tag/v1.3.6) 下载稳定版安装包与 `SHA256SUMS`。选择与你的 VPS 架构相符的 `amd64` 或 `arm64` 包；校验归档后解压其中的 `install.sh`，再按提示安装。

安装时提供域名、管理员用户名、数据目录和反向代理。若使用已有 Nginx 网站，可选择 `--proxy nginx`，安装器会为 XDrive 增加独立虚拟主机；也可以选择 Caddy。建议使用独立子域名（例如 `drive.example.com`），目前不支持挂载在 `example.com/drive` 这样的 URL 子路径下。已安装旧候选版的用户应先备份并校验备份，再使用对应版本包内的升级脚本。

Linux 安装脚本目前面向 Ubuntu 24.04 或 Debian 12（amd64／arm64），可配置 Nginx 或 Caddy。Nginx 模式会为 XDrive 添加独立的虚拟主机，不会改写原有网站配置。使用子域名（例如 `drive.example.com`）；当前不支持把应用挂在 `example.com/drive` 这样的 URL 子路径下。升级前请创建并验证外部备份；不要在没有可用备份时执行升级。

v1.3.6 恢复了 v1.3.4 网页更新器所要求的安装包成员布局，v1.3.4 可直接通过网页更新到 v1.3.6。已经手动升级到 v1.3.5 的安装保留着 v1.3.5 的七成员校验器，需要用 v1.3.6 安装包中的 `upgrade.sh` 手动升级一次。

设置页现已支持检查并安装 GitHub 上的最新稳定版。新安装会自动配置独立的 root systemd 更新任务；从 v1.3.1 手动升级到 v1.3.2 后，需要以 root 运行一次 `xdrive enable-web-updates`。更新按钮会显示官方 GitHub 发布页并要求再次确认；服务器只安装该仓库的最新稳定版，并核对该发布页提供的 SHA-256 清单。归档与清单来自同一 GitHub 发布源，此检查不等于独立离线签名；使用此功能需要 VPS 能通过 HTTPS 访问 GitHub，并信任 XDrive 的 GitHub 发布账号。

## 本地开发

开发环境需要 Go 1.27.1、Node.js 26.0.0 和 pnpm 11.24.0：

```sh
make web-install
make build
./dist/xdrive init
./dist/xdrive serve
```

`init` 会生成一次性设置链接。默认服务只监听本机回环地址。开发、构建和测试命令见 [Makefile](Makefile)。 维护者发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 重要限制

- V1 面向单个用户，不提供注册、多用户、分享链接或密码找回。
- 备份不会自动运行；已登录用户可在设置页生成并下载完整备份。请把备份保存到 VPS 以外，并定期验证恢复流程。备份包整体不额外使用密码加密，应按敏感文件保护。
- 浏览器和移动设备的后台挂起、下载与媒体播放行为各不相同；未列出的设备和浏览器组合不作兼容承诺。
- 加密格式升级后不能静默降级到旧版；升级前请创建并验证备份，遇到回退提示时先阅读数据影响说明。

网页备份的下载、校验和迁移说明见 [备份恢复指南](docs/web-backup.md)。

## 许可证

XDrive 自有代码采用 [MIT License](LICENSE)。HEIC/HEIF 本地解码使用 heic-to 1.6.5（LGPL-3.0）；详见 [第三方许可说明](THIRD_PARTY_NOTICES.txt)。Linux 安装包在 `RELEASE.txt` 中附带完整第三方许可证，保持归档成员兼容既有升级脚本。
