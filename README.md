# Zerion

## Zerion 是什么

Zerion 是一个 Android Root 模块，用于管理 dexopt / ART 编译相关系统属性，让属性调整可查看、可应用、可恢复。

## 核心能力

- **按版本适配**：针对目标 Android 版本生成对应的属性配置，处理不同版本之间的差异。
- **可恢复**：安装时快照原始属性值，卸载或一键重置即可恢复。
- **可查看**：随时对比当前值、预期值与安装前原值。
- **兼容主流 Root 方案**：Magisk、KernelSU、APatch。
- **轻量**：设备端仅依赖 POSIX sh，与 CPU 架构无关。

## 为什么做 Zerion

直接修改 dexopt 相关系统属性时，很难确认改动是否生效，也很难在不需要时恢复原状。Zerion 把这类调整变成可查看、可恢复的简单操作。

## 工作方式

1. 下载与设备 Android 版本匹配的 Zerion 安装包。
2. 在模块管理器中安装并重启。
3. 在设备端使用 `action.sh` 查看状态、应用或恢复属性。

## 安装

- 需要已 Root 设备，并已安装 Magisk、KernelSU 或 APatch 之一。
- 从 [GitHub Releases](https://github.com/pakhozako/Zerion/releases) 下载与设备 Android 版本匹配的 `Zerion-vX.Y.Z.zip`。
- 在模块管理器中安装该 ZIP，重启后生效。

## 使用

安装并重启后：

- **KernelSU / APatch**：在模块管理器中打开 Zerion，使用内置 WebUI 查看状态、应用或恢复属性。
- **Magisk / 任意环境**：在设备端 root shell 中执行：

```sh
cd /data/adb/modules/zerion
sh ./action.sh status      # 查看当前值 / 预期值 / 原值
sh ./action.sh apply       # 立即应用预期值
sh ./action.sh reset       # 恢复安装前的原值
sh ./action.sh collect     # 导出设备快照
```

属性修改在系统下次 dexopt 或重启后生效。

## 支持

- **Android**：9–17。
- **架构**：与 CPU 架构无关（纯 POSIX sh）。
- **Root 方案**：Magisk、KernelSU、APatch。
