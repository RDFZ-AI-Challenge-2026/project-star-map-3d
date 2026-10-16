# 数据说明 / Data notes

本项目所有星体位置都来自公开星表，**没有一颗星的位置是编造的或用 AI 生成的**。

## 1. 数据来源

| 数据集 | 内容 | 版本 / 文件 | 许可 |
| --- | --- | --- | --- |
| **HYG Database**（主数据源） | 119,626 颗恒星：赤经赤纬、距离、星等、色指数、光谱型、以及**已经算好的 x/y/z 直角坐标**（单位：秒差距） | `hyg/CURRENT/hygdata_v40.csv.gz`（解压后 32.36 MB）来源：[astronexus/HYG-Database](https://github.com/astronexus/HYG-Database) | CC BY-SA 4.0 |
| **d3-celestial** 星名表 | 恒星专名（英文 4,870 条 / 中文传统星名 3,056 条，含拼音），按 Hipparcos 编号（HIP）索引 | `starnames.json`, `starnames.cn.json`，来自 npm 包 `d3-celestial@0.7.35`（作者 Olaf Frohn） | BSD-3-Clause |
| **d3-celestial** 星座线 | 88 个星座的连线（按赤经赤纬，可在天球模式下叠加） | `constellations.lines.json` | BSD-3-Clause |
| **three-starmap**（仅作对比参考） | 8,912 颗肉眼可见星的 x/y/z | npm 包 `three-starmap@0.0.5` | MIT |

HYG = **H**ipparcos + **Y**ale Bright Star Catalog + **G**liese/Jahreiss 三套星表的合并版，
由 David Nash（astronexus）维护。它已经被 Google 的 Chrome Experiment
[100,000 Stars](https://workshop.chromeexperiments.com/stars/) 使用过（该项目作者在
[case study](https://web.developers.google.cn/case-studies/100000stars) 中明确说明用了 HYG 的 xyz 坐标）。

### HYG 关键字段（官方 README 的定义）

- `ra` / `dec`：J2000 赤经（小时）/ 赤纬（度）
- `dist`：**距离，单位秒差距（pc）**；`1 pc = 3.26156 光年`。**≥100000 表示视差缺失或不可信**（占位值）
- `mag` / `absmag`：视星等 / 绝对星等
- `ci`：色指数（B−V）→ 用来决定恒星显示颜色（蓝 = 高温，红 = 低温）
- `x, y, z`：**以地球为原点的直角坐标，单位 pc**。`+X` 指向春分点，`+Z` 指向北天极，`+Y` 指向赤经 6h / 赤纬 0°
- `spect`：光谱型；`lum`：以太阳为单位的亮度；`con`：所在星座缩写；`hip/hd/hr/gl`：各星表编号

## 2. 处理流程

```bash
python tools/gunzip_hyg.py      # 解压 hygdata_v40.csv.gz -> hygdata_v40.csv
python tools/build_dataset.py   # 生成 data/processed/ 下的前端数据
```

`tools/build_dataset.py` 会做三件事：

1. 丢掉 `dist` 无效（缺失或 ≥100000）的 10,226 颗星；
2. 写出 `stars.bin`：**Float32 小端，每颗星 5 个数 `[x, y, z, mag, ci]`**，单位 pc；
3. 写出 `named_stars.json`：所有有名字的星（含中英文名、拼音、星座、光谱型、距离、坐标），按距离排序。

## 3. 产物

| 文件 | 大小 | 内容 |
| --- | --- | --- |
| `processed/stars.bin` | 2.09 MB | 109,400 颗星 × 5 个 float32 |
| `processed/named_stars.json` | 0.95 MB | 3,151 颗有名字的星（3,008 颗有中文名） |
| `processed/stats.json` | 3 KB | 统计与校验清单（最近 20 颗 / 最亮 20 颗） |

## 4. 校验（重要：这些数字和公开天文学数据对得上）

坐标自洽性检查（`tools/build_dataset.py` 自动输出）：

- `|星表半径 − dist|`：中位数 0.00000 pc，最大 0.0386 pc → **HYG 的 x/y/z 与 dist 完全自洽**
- 用 `rarad/decrad/dist` 重算 xyz 与星表 xyz 比较：中位数 0.00003 pc，最大 0.0607 pc → 两套数据一致
  （注意：HYG 的 `rarad/decrad` **本身就是弧度**，不能再转一次；第一次写脚本时踩过这个坑）

与公开数值对照（来自 `stats.json`）：

| 恒星 | HYG 距离（光年） | 公认值 |
| --- | --- | --- |
| 比邻星 Proxima Centauri | 4.227 | 4.24 |
| 南门二 A Rigil Kentaurus (α Cen A) | 4.321 | 4.37 |
| 巴纳德星 Barnard's Star | 5.948 | 5.96 |
| 天狼星 Sirius | 8.601 | 8.60 |
| 南河三 Procyon | 11.462 | 11.46 |
| 牛郎星 Altair | 16.730 | 16.73 |
| 织女星 Vega | 25.045 | 25.04 |
| 大角星 Arcturus | 36.717 | 36.7 |

**数量分布**：距离有效的星 109,400 颗；视星等 ≤6.5（肉眼可见极限）8,714 颗；
10 光年内 11 颗、50 光年内 981 颗、100 光年内 4,059 颗、1000 光年内 78,806 颗；
中位距离 633 光年，最远 3,229 光年。

## 5. 已知局限（要写进 plan.md 的 "assumptions"）

1. **距离精度随距离急剧变差。** 视差法测距的相对误差 ∝ 距离：近星（<100 光年）误差在 1% 量级，
   上千光年的恒星误差可以达到几十个百分点（例如参宿四的距离长期在 400–650 光年之间摇摆，
   HYG 给的 498 光年只是其中一个估计）。
2. `dist ≥ 100000` 的 10,226 颗星被丢弃，所以这不是"全天所有星"，而是"有可靠距离估计的星"。
3. HYG 里少数恒星没有中文传统星名，界面上会退回显示 Bayer/Flamsteed 编号或 HIP 编号
   （例如 `HYG 118080` 其实是鲸鱼座 UV / Luyten 726-8A）。
4. HYG 最后一次更新是 2024 年（v4.1）。如果要更高精度，可以后续接 **Gaia DR3**
   （[Gaia Archive](https://gea.esac.esa.int/archive/) 提供 TAP/ADQL 查询接口，本机可以访问）。

## 6. 为什么不用三个现成的库？

- `three-starmap`（npm，1.3 MB）：**把 8,912 颗星全部投影到半径恰好 200.0 的同一个球面上**
  （`tools/verify_three_starmap.py` 验证：半径 min = median = max = 200.0），
  也就是只有方向、**丢掉了距离** —— 这正是我们要解决的问题。
- `d3-celestial`：星表里只有赤经赤纬 + 星等 + 色指数，**根本没有距离字段**，只能画 2D 天球图。
- 两个库的数据我们仍然拿来用：中文星名和星座连线都取自 d3-celestial（见上表）。
