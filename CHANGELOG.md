# Changelog

Zerion 的版本变更记录，版本遵循语义化版本（SemVer）。

## [0.2.0] - 2026-08-31

### Added

- 设备端状态记录：安装时写入 `/data/adb/zerion/state.json`（模块版本、目标 Android 版本、管理器、安装时间），并维护 apply/reset 计数。
- `action.sh collect-oat <path>`：导出设备端 OAT/VDEX 文件头部，用于核对编译产物。
- 按 Android 版本区间处理编译原因（compilation reason），适配不同版本差异。

### Changed

- `action.sh status` 输出当前值、预期值与安装前原值三列。
- 模块版本号统一为 0.2.0。

### Fixed

- 部分非真实编译原因被误判为真实原因。
- OAT 产物解析的状态标记缺失。

### Known Limitations

- 属性修改在系统下次 dexopt 或重启后生效，运行时生效时序未验证。
- 产物级核对尚未在真实设备上端到端验证。

## [0.1.0] - 2026-08-30

### Added

- 初始版本：按目标 Android 版本管理 dexopt 相关系统属性的 Root 模块。
- 安装时快照原始属性值，卸载与重置可恢复。
- `action.sh` 提供 status / apply / reset / collect 操作。
- 兼容 Magisk、KernelSU、APatch。

### Known Limitations

- 属性生效依赖系统 dexopt 消费路径，尚未在真实设备上端到端验证。
