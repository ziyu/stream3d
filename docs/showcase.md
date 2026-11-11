# 内容流演示与测量

主示例包含 **30 个场景、每页 18–24 个托管对象、6 套共享资产**：穹顶建筑、机械装置、树木、地形、珊瑚和灯具。场景通过布局、材质、光照和动画组合这些资产，使用同一个 canvas 与 runtime。它用于观察完整浏览过程中的加载、复用和回收，并提供当前设备上的受控比较。

## 运行与复现

需要 Node.js 22.12+，建议 Node.js 24。在仓库根目录运行：

```bash
npm ci
npm run dev
```

默认打开 `http://127.0.0.1:5173`。开发命令会自动构建库、生成源资产；首次资产编译需要一些时间。

为了比较生产构建的加载过程，使用：

```bash
npm run build:demo
npm run preview
```

打开 `http://127.0.0.1:4173`，保持 DevTools 的网络设置为 **No throttling**，由页面的 Network laboratory 统一控制条件。

| 路径 | 用途 |
| --- | --- |
| `/`、`/feed.html` | 同一套 30 场景内容流和测量面板 |
| `/inspector.html` | 单资产 API 调试台，可添加共享实例 |
| `/minimal.html` | 三个雕塑构成的最小滚动示例 |

几何、纹理和动画由 `scripts/generate-showcase.ts` 与 `scripts/showcase/` 生成；雕塑来自 `scripts/generate-fixtures.ts`。仓库保留生成源码，不附带生成的 GLB 二进制，不下载第三方模型。`npm run fixtures` 可单独生成全部示例；生成器会复用未变化的输出。浏览器通过普通 `?asset` 管线加载编译后的独立档位。

当前默认构建中，六套资产各计一次的产物如下；同一场景会重复使用其中多个资产。这些是文件体积与几何统计，不是耗时或帧率结果。

| 档位 | 六套 GLB 合计字节数 | 六套资产合计三角形数 |
| --- | ---: | ---: |
| preview | 1,848,860 | 100,889 |
| standard | 4,563,032 | 299,643 |
| full | 9,977,136 | 664,054 |

六个源 GLB 共 49,943,740 字节，约 47.63 MiB；浏览器加载的是编译档位。源体积和最高档体积也不等于某一页实际收到的字节，后者受该页使用的资产、所经档位和缓存命中影响。

## 操作与观察

1. **浏览与交互。** 纵向滚动、滑动或使用上下页按钮切换场景，横向拖动旋转。点击对象后使用 Change finish 修改该实例；Move closer 接近主体，动画按钮播放对应动作。质量替换会保留该逻辑对象的变换、材质覆盖与动画状态。
2. **打开 Runtime 面板。** 观察 preview / standard / full 分布、对象就绪数、响应体字节、共享获取次数、请求取消和驻留估计。浏览模式的精度仍受屏幕占比、停留时间与预算控制。
3. **快速划走。** Rapid browse 每 600 ms 切换一页，最多浏览 30 页。下一页仍需要的共享请求会继续，只有失去全部消费者的任务才会取消，因此取消数不会等于切页次数。
4. **调整驻留预算。** 16 / 48 / 96 / 192 MiB 对应不同的估计驻留软预算。可见最低档和仍在使用的资源受到保护；预算过低时会出现压力提示，而不是强制销毁活动对象。
5. **检查缓存与导出。** Release idle cache 仅清除无消费者的已完成缓存，活动对象保持有效。Export session metrics 下载当前快照及最近的采样记录。切换网络档位或 Progressive / Whole asset 会创建新的 runtime 与缓存会话。

分享页面 URL 可保留 `card`、`profile` 和 `mode`，例如 `/?card=7&profile=slow&mode=progressive`。它不保存已加载缓存、设备条件或测量结果。

## 网络档位实际控制了什么

`dev` 和 `preview` 都安装了[HTTP 实验室中间件](../examples/playground/network-lab.ts)。它对带实验会话参数的 GLB 响应分块发送真实字节，同一会话的并发请求共享一个速率额度。

| 页面档位 | 共享响应体速率 | 每个响应加入的等待 |
| --- | ---: | ---: |
| Native connection | 不加入速率限制 | 0 ms |
| 8 Mbps · 80 ms | 1,000,000 字节/秒 | 80 ms |
| 1.6 Mbps · 180 ms | 200,000 字节/秒 | 180 ms |

限速采用有界的令牌桶，允许短时分块突发；多个请求不会各自获得一整份带宽。加入的等待是服务器响应调度延迟，不是测得的网络 RTT。HTML、引擎 JavaScript、解码器启动、浏览器 CPU、丢包和真实连接状态不由这个实验室模拟。

实验响应使用 `Cache-Control: no-store`。同一次浏览内，Stream3D 自己的字节缓存和表示缓存仍然生效。页面会检查实验室状态；普通静态服务器或 CDN 不包含这个中间件，此时使用直接交付并禁用受控比较。

## 渐进加载与直接加载最高档的比较

在 Runtime 面板选择网络档位，再点击 **Run a cold-load comparison**。工具先销毁普通内容流的 runtime，按随机顺序依次运行一轮 Progressive 和一轮 Whole asset，结束后重建内容流：

- 两轮使用相同场景、对象、相机、画布尺寸与像素比，停止动画，并使用 512 MiB 的估计驻留预算。
- Progressive 从 preview 开始，目标提升到所有对象的最高档；Whole asset 直接请求**相同的最高档 GLB**。比较的基准是相同目标资产，不是未编译的源文件。
- 每轮创建新 app、新资源池和独立会话 URL。响应采用 `no-store`，防止上一轮的资产响应被复用。JavaScript、解码器与 GPU 驱动缓存仍可能处于热状态。
- 计时从创建 app 与场景之前开始；首次有用画面、所有对象就绪和全部最高档分别独立计时。测量不包含页面导航与引擎首次下载。
- 隐藏页面、改变画布尺寸或 DPR、手动取消或超过 120 秒会中止该次比较。完成后可下载包含顺序、条件、目标 URL 和实测计数的 JSON。

这是一次顺序执行的测量对，不是统计分布。需要比较配置时，应在同一设备、相同窗口与页面可见条件下重复运行，并保留导出的条件。渐进模式先提供较低档内容，也可能因为下载中间档而传输更多总字节。结果不承诺固定帧率、固定首帧时间或通用加速比例。

## 指标含义

| 指标 | 来源与边界 |
| --- | --- |
| First useful view | 地形和主体都准备好后，再经过两个 RAF 回调。内容流从本次场景激活前计时，比较从 app 构建前计时；不代表物理屏幕已显示或 GPU 已完成全部工作。 |
| All objects ready | 所有对象的首个可用表示准备好，再经过两个 RAF 回调。渐进模式此时可以仍是低档。 |
| All highest detail | 所有对象都处于同一目标最高档且没有待替换档位，再经过两个 RAF 回调；在比较中独立记录。 |
| Received payload | 实际交给 `Response.body` 读取器的字节，包括取消或失败请求已经收到的部分；不含 HTTP 头、重传等线路开销。runtime 缓存命中不增加此计数。 |
| Requests cancelled | 实际开始后被取消的 HTTP 请求；没有发出的排队任务不计入。 |
| Shared acquisitions | 资源池对已有条目的获取命中，包含正在加载、活动和空闲条目；它不是节省字节数，也不是帧率收益。 |
| Resident estimate / sampled peak | 托管表示的驻留估计及采样最大值。内容流每 250 ms 采样，比较在 RAF 和完成时采样；不等于驱动报告的实际显存或精确峰值。 |
| RAF interval p95 | 最近最多 **180 个可见页面 RAF 间隔**的 95 分位数，反映主线程调度。它是末段滚动窗口，不是完整比较过程的 p95 或 GPU 帧率。 |
| Highest-detail payload | 编译 manifest 中去重后的最高档 `byteLength` 之和；这是目标文件大小，实际收取字节另由网络计数记录。 |

Runtime 自身的 `model.timing.firstReadyMs` / `lastReadyMs` 记录粗档请求到准备完成并挂载的时间，不包括 manifest 获取与上述两个 RAF 回调，不能直接替代页面的 First useful view。完整定义见 [API](api.md)。

## 场景所有权与资产缓存

内容流最多保留当前页及前后相邻页，共三个逻辑场景；只有当前页处于活动状态。30 个场景目录不会同时建立全部模型。窗口外的场景会销毁，活动场景退出后释放表示需求；已知下一页仍需要的共享租约先接续，避免中断仍有用的加载。

资产缓存的寿命独立于场景窗口：同一 app 内的对象共享解码模板、几何和纹理，各自保留材质、变换和动画状态。失去全部消费者的表示可进入受预算和空闲期限约束的缓存，也可由 Release idle cache 清除。逻辑场景只剩三个并不意味着缓存中只剩三个资产；资源共享也不自动等于 GPU instancing。

`app.clearCache()` 保留活动租约和仍有消费者的加载，不会重置累计计数、已解析的模型 manifest、浏览器缓存或 GPU 驱动缓存。比较工具通过新 app 和新会话隔离 runtime 资产缓存；“冷加载”在这里指资产层面的条件。框架只管理 `scene.addModel()` 创建的资源，经 `scene.root` 加入的自定义 Three.js 资源仍由调用方负责释放。

实现入口：[内容目录](../examples/playground/src/showcase/catalog.ts)、[场景构建](../examples/playground/src/showcase/scenes.ts)、[浏览控制器](../examples/playground/src/showcase/controller.ts)、[比较工具](../examples/playground/src/showcase/benchmark.ts)。更底层的资源策略见[架构说明](architecture.md)。
