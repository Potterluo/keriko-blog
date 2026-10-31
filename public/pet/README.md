# 看板娘素材

`*.webm` 都是 **VP9-alpha 透明视频**，640×360，取自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的 `dsh-pet/assets/webm/`，**全部 109 段**都在这里。

`manifest.json` 是清单，组件按它随机抽动作：

```json
[{ "file": "idle.webm", "label": "待机呼吸休闲", "kind": "idle", "size": 441000 }]
```

| 字段    | 含义                                                                                         |
| :------ | :------------------------------------------------------------------------------------------- |
| `file`  | 实际文件名。常驻的十二段用了语义名（`idle`、`tap-joy`、`sleep-in`…），其余按 `clip-NNN` 编号 |
| `label` | 原始中文动画名，方便对照上游                                                                 |
| `kind`  | 分类，见下表，决定何时播                                                                     |
| `size`  | 字节数，用于校验下载完整性                                                                   |

| `kind`                                               | 数量 | 用途                                     |
| :--------------------------------------------------- | :--- | :--------------------------------------- |
| `idle`                                               | 2    | 待机循环                                 |
| `tap`                                                | 5    | 点一下的回应                             |
| `sleep`                                              | 3    | 双击睡觉：入睡、循环、醒来               |
| `play` / `eat` / `season` / `talk` / `move` / `misc` | 86   | 随机小动作池                             |
| `balance` / `work`                                   | 12   | 上游用于余额与工作状态，这里也进了随机池 |
| `drag`                                               | 1    | 拖拽反馈，暂未用                         |

## 表情包

`memes/meme-01.png` … `meme-27.png`，384×384，同样取自上游的 `dsh-pet/assets/memes/`，共 27 张。说话时按概率随机配一张（大肥鱼自己的梗图，部分带字）。

## 署名与许可

- 素材仓库：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（**素材禁止商用**）
- 形象：社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），非官方形象。原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/4168597)
- 形象许可：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，署名 · 非商业 · 相同方式共享

本站是个人非商业博客，按上述条款署名使用。若你复用这些文件，请保留本文件与署名。
