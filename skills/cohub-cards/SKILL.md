---
name: cohub-cards
description: 用 Cohub 在聊天卡片中生成或修改图片、制作视频、配音、合成语音、创作歌曲和背景音乐，并发布作品。用户提到 cohub、Cohub，或直接要求画图、做海报、改图、让图片动起来、做视频、配音、做音乐等创作需求时使用；无需说出插件全名。人和 Agent 共用可编辑草稿，支持展开详细设置。用户明确指定其他工具时遵循其选择。
---

# Cohub 共同创作

## 识别创作需求

把“用 cohub 做个海报”“帮我画一张猫”“让这张图动起来”“给这段文字配音”“做一段背景音乐”等自然表达路由到本插件，不要求用户输入 `Cohub Cards` 或工具名称。用户只说“cohub”且没有任务上下文时，简短询问想创作什么；不要因此自行生成或发布。

未指定工具的图片、视频、语音和音乐生成需求，可以直接采用此工作流。结合已有素材和对话填写卡片，不强迫用户先学习模型或参数。用户只是讨论创意、写文案或咨询能力时，直接回答，不自动创建生成任务。现有作品的继续修改先读取原草稿；用户明确选择其他产品或工作流时尊重该选择。

涉及 Cohub 的项目同步、会话导入或 Board 编辑时，使用对应能力，不把这些请求误当作素材生成。发布沿用下方发布流程。

默认交付是 Codex 聊天里的简单创作卡片，直接调用 `prepare_generation`，不要用侧边浏览器链接或截图代替。聊天卡保留预览、简短描述和生成入口；用户主动点击“展开编辑”才进入右侧完整设置。展开和返回聊天共用同一份草稿，不新建任务、不重新生成。

生成统一通过本插件的共享草稿。用户在卡片中的修改和 Agent 的修改属于同一份内容；不要绕过草稿直接执行 `cohub generate`，除非用户明确要求单独使用 CLI。插件工具缺席时先说明并定位接入故障，不用独立生成代替共享草稿。

首次实际操作核对 `cohub --version`、`cohub auth whoami --json` 和目标 Space，沿用有效登录与已明确的目标。其他 Cohub 指导可用于发布和验收；复杂编辑使用 Cohub 已有的 Board。

## 共同编辑与生成

| 工具 | 使用方式 |
| --- | --- |
| `prepare_generation` | 每份新创作调用一次，填写 `spaceId`、`model`、`prompt`、`media`、`parameters`、`meta`；模型可留空，让用户选择。保存返回的 `draft.id`。 |
| `read_generation_draft` | 用 `draftId` 读取双方最新内容、`draft.revision`、模型声明和校验结果。编辑或提交前读取。 |
| `update_generation_draft` | 传 `draftId`、当前版本作为 `baseRevision`、所需 `patch`。`media`、`parameters`、`meta` 是整值替换，先与最新内容合并。 |
| `add_generation_reference` | 传同一草稿与当前版本、媒体 `type`，再选一种来源：HTTPS `url`、已授权本地 `filePath`，或文件选择器提供的 `base64`。需要时保留官方声明的 `role`。 |
| `submit_generation` | 用户已要求生成或点击生成时，提交保存后的 `draftId` 和当前 `baseRevision`；可能产生模型费用。 |

出现 `REVISION_CONFLICT` 时重新读取，合并本次需要的改动，保留用户最新输入。不要拿旧版本反复重试，也不要通过重新 `prepare_generation` 回避冲突。

以返回的官方模型声明选择图片、视频、语音或音乐输入，保留参数类型、素材用途和必填设置。必要时只读查询 `cohub models ls --model-type multimodal --json`、`cohub models show <model> --json`。不要猜模型字段。Higgs 当前仅支持默认音色或单条参考音频；多音色混合需要权重，官方 CLI 暂不支持，不能省略权重后声称已实现。

本地参考文件先暂存，单个上限 20 MiB；提交时会上传到所选空间的公共素材地址。只添加用户选择或已授权的素材。

`submitting` 时继续读取原草稿；`unknown` 或提交结果不明时核对原次提交，禁止重新提交或另建草稿重复生成。`submitted` 保存的 `taskRunId` 是后续查询依据。结果展示失败只恢复读取；明确继续修改作品时另建草稿，引用原任务的真实产物。费用以实际 billing 记录为准，缺记录不能写成零。

## 查看与发布

已有生成用 `show_generation({spaceId,id})` 展示真实任务。应用仍通过官方 CLI 发布：

`cohub -s <spaceId> apps publish <slug> --source local --dir <build-dir> --visibility <public-or-space> --json`

沿用用户明确的访问范围；仅测试且未指定公开时用 `space`。更新前核对真实 App ID，保留同一应用与访问范围。发布后用 `cohub -s <spaceId> apps get <appId> --json` 读回链接、版本和范围，再调用 `show_publication({spaceId,id})`。

封面使用 App 的真实 `meta.image` 或经核对的截图。打开实际作品验收，分别报告发布结果和功能验证。原生 inline 展示与交互只有在 Codex 中实际验证后才能宣称通过。
