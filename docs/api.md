# Stream3D v0.1 API

本页描述当前源码实现。所有内存参数单位为 bytes，时间参数以名称中的 `Ms` 或方法说明为准。

## `createApp(options)`

从 `stream3d` 导入，返回一个 `StreamApp`。每个 app 拥有独立的渲染器、资源池、网络/解码调度器和 RAF。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `canvas` | 必填 | 已挂载、具有非零 CSS 尺寸的 `HTMLCanvasElement` |
| `controls` | `false` | 为当前场景启用 Three.js OrbitControls |
| `budgets.gpuBytes` | `96 * 1024 ** 2` | 估计表示驻留软预算 |
| `budgets.cacheBytes` | `64 * 1024 ** 2` | 已下载 ArrayBuffer 缓存预算 |
| `budgets.decodeConcurrency` | `2` | 同时执行的解码/解析作业数，仅构造时设置 |
| `refinementDelayMs` | `350` | 模型进入可见状态后，开始提升质量的最短停留时间 |
| `offscreenGraceMs` | `750` | 模型离开视锥后保留已显示表示的短暂宽限 |
| `maxPixelRatio` | `1.5` | 渲染像素比上限 |
| `meshoptWorkers` | `2` | Meshopt worker 数，`0` 表示不创建 worker |
| `baseUrl` | `document.baseURI` | 直接传入 manifest 对象时，相对 level URL 的解析基准 |
| `autoStart` | `true` | 自动 RAF；设为 `false` 后由宿主调用 `tick()` |

高级集成可注入 `renderer: RendererBackend`、`loader: ModelLoader` 和 `now: () => number`。它们是测试及后端适配接口，首版只有现成的 Three.js / WebGL2 后端。

### 方法与属性

```ts
const scene = app.createScene();
app.present(scene);
app.setBudgets({ gpuBytes: 32 * 1024 ** 2, cacheBytes: 48 * 1024 ** 2 });
const snapshot = app.diagnostics();
app.destroy();
```

- `createScene()` 创建一个不活动的场景。
- `present(scene)` 同步切换当前场景。旧场景的模型立即退出需求，动画暂停；新场景先请求最低档表示。它不等待资产加载。
- `controls` 是当前场景的 OrbitControls（若启用）。每次切换时会重建 controls，并保存各场景的 orbit target。
- `renderer` 为当前后端。直接操纵它需要遵守宿主生命周期。
- `tick(deltaSeconds = 0)` 执行一帧调度、动画和渲染。动画步长限制为 `0…0.1` 秒，避免恢复页面后的超大跳跃。自动 RAF 模式无需额外调用。
- `destroy()` 幂等，停止 RAF、清理监听器，销毁所有 managed scenes、资源池和渲染器。已销毁 app 无法重新创建或呈现场景。

### Diagnostics

```ts
{
  scenes, models, activeModels,
  estimatedGpuBytes, budgetGpuBytes, gpuPressure,
  resources: { entries, loading, activeLeases, bytes, hits, misses, evictions },
  bytes: { entries, loading, activeLeases, bytes, hits, misses, evictions },
  scheduler: { network: { queued, running }, decode: { queued, running } },
  pendingUploads,
  render: { calls, triangles, geometries, textures },
  levels: [{ id, name, level, pending, visible, coverage, error }]
}
```

`resources` 是解码模板池，`bytes` 是网络字节缓存。`estimatedGpuBytes` 包含模板池仍缓存的闲置表示，不仅是当前 draw call 使用的表示；它不表示真实硬件显存。`hits` 包括缓存复用与同一个进行中请求的复用。`render` 数据来自后端。

## `ManagedScene`

```ts
const scene = app.createScene();
scene.camera.position.set(0, 1, 5);
scene.camera.lookAt(0, 0, 0);
scene.root.add(new HemisphereLight(0xffffff, 0x445566, 3));
const model = scene.addModel(asset);
```

- `camera`：Three.js `PerspectiveCamera`，初始 FOV 45°、near 0.05、far 2000、位置 `(0, 0, 4)`。活动场景的 aspect 随 canvas 更新。
- `root`：Three.js `Scene`。可添加灯光、背景和自定义对象。这些原生对象的资源由应用管理。
- `addModel(input)`：立即返回稳定 `ManagedModel`。`input` 为 Stream3D manifest 对象或 manifest URL，不能直接传未经编译的 GLB URL。
- `remove(model)`：等价于销毁此场景中的模型；不是可重挂载的 detach 操作。
- `destroy()`：幂等，销毁该场景的所有 managed models 并从 app 移除。

创建模型会开始解析或下载 manifest。几何/纹理表示只有在场景被呈现、模型有需求时才会加载。

## `ManagedModel`

### 稳定对象与变换

```ts
model.position.set(1, 0, 0);
model.rotation.y = Math.PI / 4;
model.scale.setScalar(0.8);
model.object3D.visible = false;
```

`position`、`rotation`、`scale` 是稳定根节点对应的 Three.js 属性。`object3D` 为稳定的 `Group`，其 `children` 属于渲染实现，可能在 LOD 升降级时替换。不要把某个内部 Mesh 或 Material 引用作为跨档位的身份。

`id` 在模型存活期间稳定。`manifest` 在解析完成前为 `null`；`currentLevel` / `pendingLevel` 为 manifest.levels 的索引或 `null`。`coverage` 是用于调度的屏幕覆盖估计；`visible` 表示运行时需求状态。

### 动画

```ts
model.animation.play('Idle');
model.animation.play('Pulse', { loop: false, timeScale: 1.2 });
console.log(model.animation.current, model.animation.time);
model.animation.stop();
```

`play()` 可在表示加载前调用。动画名称需与资产一致；manifest 已知时，未知名称会抛错。每次 `play()` 从时间 0 开始；当前模型只提供一个命名动画状态。`time` 单位为秒，在活动场景逐帧累积。换 LOD 保留当前名称、时间、循环和速度。离开场景后暂停，不会继续后台运行。

首版没有混合树、跨动画 crossfade 或可写时间游标。`stop()` 停止当前动画，不用于卸载模型。

### 材质覆盖

```ts
model.materials.set('Body', {
  color: '#b5ebdb',
  roughness: 0.5,
  metalness: 0.1,
});
```

按源材质名称匹配，覆盖属于该模型实例，LOD 替换后重新应用，不影响同资产的其他实例。重复同名材质会全部匹配；名称 `'*'` 匹配所有材质。支持字段：

`color`、`emissive`、`emissiveIntensity`、`roughness`、`metalness`、`opacity`、`transparent`、`wireframe`、`visible`。

颜色接受 Three.js `ColorRepresentation`。同一名称的多次 `set()` 会合并字段；首版没有删除单个覆盖的 API，也没有自定义纹理插槽流式编辑。

### 事件与就绪

```ts
const unsubscribe = model.on('click', ({ model, intersection, originalEvent }) => {
  model.animation.play('Pulse');
});
model.on('error', ({ error, level }) => console.error(level, error));

try {
  await model.ready('interactive');
} catch (error) {
  // 模型/场景退出会产生 AbortError；加载失败返回对应 Error。
}

unsubscribe();
```

点击通过当前可见几何进行拾取。指针移动超过 8 CSS px 不视为点击，避免旋转操作误触。`on()` 返回取消订阅函数。

`ready('interactive')` 在当前实例已有可交互表示时完成，不等待最高档。未呈现的场景不会因为调用 `ready()` 自动激活。首次加载失败时会拒绝；已活动场景退出或模型销毁时也会拒绝尚未完成的等待。

更高档加载失败时保留当前可用表示，并发出 `error` 事件，不会因此让画面消失。调用 `retry()` 清除失败标记，由下一帧重新尝试；没有无限自动重试循环。

### 生命周期

`destroy()` 幂等：撤销任务、拒绝待完成的 ready、移除根节点和事件订阅，并释放资源租约。复用同资产的其他实例保持有效；引用为零的共享资源进入可回收缓存。场景销毁会自动执行此步骤。

资源预算是软限制：最低可见档位和仍在使用的资源受到保护。浏览器后台暂停 RAF 后，按空闲时间的扫描将在恢复/再次调度时继续，不依赖每个资产单独创建定时器。

## 与已有 Three.js 代码混用

```ts
const grid = new GridHelper();
scene.root.add(grid);

function unmount() {
  grid.geometry.dispose();
  for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
    material.dispose();
  }
  app.destroy();
}
```

自定义 Three.js 对象不会自动变成可流式加载的资源。只有编译资产的 managed model 生命周期归 Stream3D 管理。此边界让现有 Three.js API 可直接使用，同时明确资源所有权。
