# Cohub — 旧插件安装入口

**Cohub 已统一在 [atou42/cohub-skill](https://github.com/atou42/cohub-skill) 维护。**

新用户请从主仓库选择安装方式：

| 使用环境 | 安装方式 |
| --- | --- |
| 命令行或支持 Skill 的 AI 助手 | 独立安装 Cohub Skill |
| Codex 桌面端或 Codex CLI | 安装 Cohub 插件，已包含同一份 Skill；可视卡片需宿主支持 |

两种方式使用同一份能力说明和工作规则。插件增加卡片编辑、确认和作品展示。已安装插件的客户端无需再重复安装 Skill；需要在其他环境使用时，可独立安装 Skill。

## 已有用户照常更新

在原来的 `cohub-plugin` 克隆目录执行，命令不变：

```sh
git pull --ff-only
bash scripts/install.sh
```

完成后完全退出并重新打开 Codex。无需重新克隆，也不需要修改原仓库地址。

旧安装命令也继续有效：

```sh
git clone https://github.com/atou42/cohub-plugin.git
cd cohub-plugin
bash scripts/install.sh
```

此仓库现在只负责把安装请求交给主仓库指定的正式版本。脚本会核对版本和完整提交编号，再运行主仓库的安装程序；不会跟随开发分支安装。下载失败、版本不符或缓存被修改时会明确停止，不会改装旧版本。

安装前仍需要 Node.js 24+、npm、Git、`codex`、官方 `cohub` 命令行工具，以及支持插件的 Codex。登录方式、独立 Skill 安装和完整使用说明，请查看 [主仓库安装说明](https://github.com/atou42/cohub-skill#readme)。

## 安装选项和重复入口

旧入口会原样传递主安装程序的选项，包括：

```sh
bash scripts/install.sh --language zh-CN --skill-mode auto
```

- `--language en|zh-CN`：选择 Skill 语言。
- `--skill-mode auto|bundled|external`：由主安装程序处理使用内置 Skill 或已有独立 Skill，避免重复入口。
- `--skill-path /path/to/cohub`：指定已有独立 Skill 的位置；路径带空格时请加引号。
- `--check`：只检查主安装程序的安装计划；通过此兼容入口首次运行时，仍会下载并核对固定版本的源码。

这些选项的具体适用条件以主仓库说明为准。不要为了消除重复入口手动删除其他 AI 助手正在使用的 Skill。

## 已有数据与历史版本

- 插件身份继续为 `cohub-cards@cohub-cards-local`，已有用户沿用同一插件。
- 草稿继续保存在 `~/.local/state/cohub-cards`，迁移入口不会移动、删除或重建草稿。
- 主仓库版本缓存放在原克隆目录的 `.cohub-source/<完整提交编号>`；不要把这个目录当作临时下载目录删除，插件安装可能仍引用其中的文件。
- 已有缓存必须保持版本正确、没有未提交修改。发生错误时保留现场，按错误信息检查，不会自动清空重建。
- 原版代码和发行记录仍保留在本仓库历史和已有标签中。目前目录里的旧运行时代码仅作为历史参考，不再在这里开发或发布。

## 维护此兼容入口

发布时先在主仓库发布正式标签，再更新 `migration.json` 中的 `tag` 和完整 `commit`。两者必须匹配，不能填写分支名。全零的提交编号是未发布占位符，安装程序会拒绝执行；必须替换并完成验证后才能发布此兼容入口。

支持统一发布标签 `cohub-vX.Y.Z`，也支持独立插件发布标签 `cohub-plugin-vX.Y.Z`。今后只更新插件时，可固定到已经验证的插件正式版本，不必同时提高 Skill 的版本号；完整提交编号校验仍然生效。

离线迁移检查：

```sh
node --test test/migration.test.mjs
```

检查会建立隔离的本地仓库，验证固定版本、参数和退出码传递、网络失败、脏缓存和损坏缓存保护；不会安装真实插件或访问个人配置。修改旧运行时代码时仍须遵守 [AGENTS.md](AGENTS.md) 的完整检查要求。
