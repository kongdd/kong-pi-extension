- 用户：20年码龄资深研究员，生态水文学家，采用Julia编写生态水文模型、陆面过程模型；采用R进行数据分析

- 遵循：**linux极简主义原则**，一次做好一件事，追求简洁、优雅、易懂的代码；但需要注意，不要违反代码的排版规范，以及代码的易读性

- 文件组织：代码、数据、图件分别存放不同的文件夹

- 精通R语言：data.table, tidyverse, ggplot2等

- 精通Julia：精通高性能科学计算

- 报告写作：遵循学术论文规范，细节充分；逻辑严谨，语言凝练。遵循总分的结构，第一句话先概括；然后再分点阐述。

- 语言表达：文字应符合中文表述习惯、书面表达，不要啰嗦（语言凝练），不要生硬的英文翻译（符合中文表达习惯）

- 不要删除有意义的注释，代码（未来复用）或解释（帮助理解）；一些凌乱的注释，可以帮忙整理

## 软件环境

```bash
alias Rscript=/opt/miniforge3/envs/r4.5/bin/Rscript
alias R=/opt/miniforge3/envs/r4.5/bin/R
alias julia=/home/kong/.local/bin/julia
```

- `网络搜索`: web_fetch > exa_search

## 电脑环境

- 90G内存，32线程，可并行、多线程

## 跨仓库检索（/mnt/z/GitHub）

- 禁止对/mnt/z，/mnt/z/GitHub执行全盘检索。
- 先用 **autojump**：`zsh -lic 'j ModernHydro'`、`j ModelParams`、`j SpatialHydro` 等定位仓库根目录

## codebase-memory-mcp 使用经验

使用codebase mcp进行大型repo的代码检索
- `index_repository`参数名为 `repo_path`
- 默认`moderate`模式，自动过滤docs/examples/target/node_modules 等，且避开二进制文件

## 图片
生成、截图的图片，放images文件夹；markdown写相对路径：`![image_title](images/img.png)`

## 后台进程（pi-processes）

提交长运行命令（Julia 模型训练、build、dev server、`tail -f` 等）时，使用 `process` 工具而非 `bash`，避免阻塞主对话：

- `process start "<command>" name="<描述名>"` — 启动后台进程，立即返回
- `process list` / `process output id=<name>` — 查看状态与输出
- `process kill id=<name>` — 终止

启动后继续其他任务，完成/失败时自动通知；**不要轮询等待**。
