# 网页备份与恢复

## 在设置页创建备份

使用已解锁的账号打开“设置 → 备份 → 创建并下载备份”，阅读说明并确认。浏览器会下载一个 `.tar` 归档。导出是一个数据库时间点快照，包含该快照引用的对象。

服务端在传输期间持有对象删除协调锁，避免快照引用的对象在导出过程中被清理。对象会边传输边计算 SHA-256；服务端只在本机暂存 SQLite 快照，不会再复制一份完整对象目录。下载完成后，刷新设置页可看到最近一次成功备份时间。若连接中断、下载失败或文件校验失败，请丢弃该归档并重新下载。

归档中的文件对象仍是浏览器端密文，但数据库和归档整体没有额外密码加密。请通过 HTTPS 下载，并把备份保存到 VPS 以外的受控位置。备份不能替代账号密码：恢复后仍需原有密码解密云盘。

网页备份是用户手动发起的一次性下载，不是自动计划任务，也不会在服务器上保留一份可供后续下载的备份。

## 校验下载文件

在可信任的 Linux 主机上解压到一个新目录，并用 XDrive CLI 检查完整性。归档内含一个 `xdrive-backup-*` 顶层目录；将下面的 `<backup-root>` 替换为解压后的该目录路径：

```sh
mkdir -m 700 /tmp/xdrive-backup-check
tar -xf xdrive-backup-*.tar -C /tmp/xdrive-backup-check
xdrive verify-backup /tmp/xdrive-backup-check/xdrive-backup-*
```

校验失败的备份不能用于恢复。通配符应只匹配本次解压生成的一个目录。

## 恢复到新 VPS

建议先在新 VPS 安装与备份来源兼容的 XDrive 版本；首次恢复优先使用相同版本。继续升级前先确认该版本支持此备份格式。配置好新 VPS 的域名、HTTPS 和服务后，按以下顺序操作：

1. 将 `.tar` 文件安全传到新 VPS，并解压到数据目录之外的临时位置。
2. 停止 XDrive：`sudo systemctl stop xdrive`。
3. 确认配置文件 `/etc/xdrive/config.toml` 中的数据库、对象存储和 secret 路径都位于同一个数据目录。恢复要求这个目标数据目录为空。安装后首次启动可能已创建初始数据库；如果这是刚安装的新 VPS，请先把这份初始目录改名留作回退，再创建同名空目录并设置属主为 `xdrive:xdrive`。不要对已有数据的实例执行清空或替换。
4. 校验备份，再恢复。将 `<backup-root>` 替换成实际解压出的顶层目录：

   ```sh
   sudo /usr/local/libexec/xdrive/xdrive verify-backup <backup-root>
   sudo /usr/local/libexec/xdrive/xdrive restore --config /etc/xdrive/config.toml <backup-root>
   sudo chown -R xdrive:xdrive /var/lib/xdrive
   ```

   若安装时使用了不同的 `--data-dir`，`chown` 命令也要改成该实际路径。

5. 启动并检查服务：`sudo systemctl start xdrive && sudo systemctl --no-pager status xdrive`，再打开新 VPS 的 HTTPS 地址登录。

恢复会迁移备份数据库到当前程序支持的 schema，并生成新的服务器 secret；旧 session 不会恢复，需要重新登录。恢复目标目录必须为空，备份归档本身不要解压到 XDrive 的数据目录内。

## 注意事项

- 恢复前先在新 VPS 留出足够磁盘空间；恢复期间会同时存在已解压的备份对象和新数据目录。
- 保留刚安装时改名保存的空白初始目录，直到确认恢复后的服务和文件正常。
- 文件名和内容仍由原密码解密；如果忘记密码，备份无法找回 Vault Key。
- 同一备份格式跨版本恢复前，请先查看对应正式版的发布说明和格式兼容记录。
