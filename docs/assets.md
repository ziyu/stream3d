# 资产编译与构建集成

资产编译器把本地 glTF 2.0 转成静态可托管的 manifest 和若干独立 GLB。通常使用 Vite 的 `?asset` 导入自动完成编译；也可以在其他构建系统中调用 `compileAsset()` 或 CLI。

编译发生在 Node.js 中，浏览器只下载生成文件。当前仓库要求 Node.js `>=22.12.0`。下文包名对应仓库内工作区或自行构建的包，不代表这些版本已发布到公共 npm。

## 1. 输入和输出

| 输入特性 | 当前支持范围 |
| --- | --- |
| 容器 | glTF 2.0 的本地 `.glb` / `.gltf`。 |
| 外部依赖 | `.gltf` 引用的相对文件 URI，以及 data URI；外部 buffer 和 image 都会参与缓存失效。 |
| 几何 | 三角形网格；支持索引及非索引三角形。点、线、strip 等模式需要预先转成三角形。 |
| 纹理源文件 | PNG、JPEG、WebP。 |
| 输入网格压缩 | 支持 Draco 和 Meshopt；编译时解码，输出统一使用 Meshopt。 |
| 动画与角色 | 保留支持的 glTF 动画通道、skinning 和 morph 数据；几何简化会相应重映射顶点属性。 |
| 扩展 | 仅接受编译器和默认浏览器加载器共同支持的扩展，清单见后文。 |

远程 `https:` 依赖、`file:` URI、绝对路径、反斜杠路径和带查询串或片段的外部依赖会报错。先把完整资产下载到本地，并让 glTF 通过可移植的相对 URI 引用资源。Vite 开发模式还要求源文件及其全部依赖位于 Vite 允许读取的目录内。

输出目录内包含：

- `asset-<编译内容摘要>.stream3d.json`：manifest。
- `level-<GLB 字节的 SHA-256>.glb`：每个独特层级的完整 GLB。

每个 GLB 内嵌自己的纹理和 buffer，无额外运行时文件依赖。多个层级产生完全相同的字节时，可以指向同一个 GLB。Manifest 的层级 URL 是同目录相对文件名，因此整个输出目录可直接上传到静态站点或 CDN。

## 2. 默认层级与质量含义

| 层级 | 目标三角形比例 `ratio` | 纹理最大边长 `textureSize` | `minScreenCoverage` |
| --- | --- | --- | --- |
| `preview` | 0.15 | 256 | 0 |
| `standard` | 0.45 | 512 | 0.25 |
| `full` | 1 | 1024 | 0.65 |

`ratio` 是相对原始几何的目标比例，拓扑、简化误差限制和小网格保护可能使实际结果高于目标。非常小的 primitive 保持原样。各层从同一个源文档独立生成，不是对上一层反复简化。

纹理保持宽高比，不放大小图。**默认 `full` 仍把纹理最大边长限制到 1024**，它表示最高编译层，不等于原图分辨率或原始字节。需要更高细节时应显式配置层级。

所有纹理输出为 WebP：仅用于颜色的贴图采用质量 85 的有损编码；法线、粗糙度等数据用途采用无损通道编码。数据贴图的尺寸缩小本身仍会损失信息。输出使用 `EXT_texture_webp`，浏览器需能解码 WebP。

网格使用 Meshopt 压缩。当前流水线没有额外进行会插入补偿变换的顶点量化步骤。网格压缩和 WebP 主要减少传输字节；WebP 解码后成为普通 GPU 纹理，不能等同于 KTX2/BasisU 的 GPU 压缩。当前没有 KTX2 转码、纹理 mip 流式传输或层级间增量编码。

`minScreenCoverage` 是运行时的升级候选阈值，近似表示模型包围球的投影直径与视口高度之比。实际选择还受内存预算和细化延迟影响；配置更高层不会保证模型必定下载或显示它。详见 [运行时架构](architecture.md)。

## 3. Vite：自动资产导入

在 `vite.config.ts` 中启用插件：

```ts
import { defineConfig } from 'vite';
import { stream3d } from '@stream3d/vite';

export default defineConfig({
  plugins: [stream3d()],
});
```

在应用的类型声明文件中加入：

```ts
/// <reference types="@stream3d/vite/client" />
```

随后可以导入 manifest，或使用生成 manifest 的 URL：

```ts
import { createApp } from 'stream3d';
import chair, { manifestUrl } from './assets/chair.glb?asset';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const app = createApp({ canvas });
const scene = app.createScene();

const model = scene.addModel(chair);
app.present(scene);
await model.ready('interactive');

// manifestUrl 可交给按 URL 加载的另一个场景或独立应用。
console.log(manifestUrl);
```

`.gltf?asset` 用法相同。默认导出是 `AssetManifest` 对象，命名导出 `manifestUrl` 是 JSON manifest 的部署 URL。`?asset` 不能与 `?url`、`?raw` 等其他查询修饰符组合。

开发服务器按需编译到 Vite `cacheDir` 下的 `stream3d` 目录。它观察源文件及所有本地外部 buffer/image；任一依赖变化都会使相关模块失效并触发**整页刷新**。当前不是保留运行时模型状态的热更新。

开发文件服务只接受已通过 `?asset` 编译并登记的输出文件，支持 GET/HEAD，不把请求参数当作任意本地文件路径。开发资源 URL 使用 `__stream3d/assets/` 路由，并带内容类型和 immutable 缓存头。

### 自定义层级

```ts
import { defineConfig } from 'vite';
import { stream3d } from '@stream3d/vite';

export default defineConfig({
  plugins: [stream3d({
    levels: [
      { id: 'preview', ratio: 0.12, textureSize: 256, minScreenCoverage: 0 },
      { id: 'medium', ratio: 0.4, textureSize: 768, minScreenCoverage: 0.3 },
      { id: 'detail', ratio: 1, textureSize: 2048, minScreenCoverage: 0.7 },
    ],
  })],
});
```

这些配置应用于该插件处理的所有导入。当前没有每次 `?asset` 导入分别指定层级的查询语法。不同资产需要不同策略时，可用 Node API 分别预编译，然后传 manifest URL 给运行时。

编译器要求：1–8 个层级；`id` 唯一且是简单标识符；`ratio` 在 `(0, 1]`；`textureSize` 为 16–8192 的整数；`minScreenCoverage` 在 `[0, 1]`，第一层为 0，后续严格递增；三角形比例和纹理尺寸从粗到细不能下降。层级标签只用于命名，数组顺序决定运行时的粗细顺序。

## 4. CLI 与 Node API

CLI 使用默认三个层级：

```sh
stream3d compile ./assets/chair.glb --out ./public/models/chair
```

CLI 会输出 manifest 绝对路径，以及各层三角形数、传输体积和估算资源成本。当前只提供 `compile <input> --out <directory>` 和帮助参数；自定义层级请用 Node API 或 Vite 配置。

在仓库内可以先构建，然后直接调用生成的入口：

```sh
npm run build
node packages/compiler/dist/cli.js compile examples/playground/assets/orbit.glb --out ./compiled/orbit
```

若示例资产尚不存在，先运行仓库的 fixture 生成脚本。对自己的源文件不需要生成示例资产。

Node API 示例：

```ts
import { compileAsset } from '@stream3d/compiler';

const result = await compileAsset('./assets/chair.gltf', {
  outDir: './public/models/chair',
  levels: [
    { id: 'small', ratio: 0.2, textureSize: 256, minScreenCoverage: 0 },
    { id: 'large', ratio: 1, textureSize: 2048, minScreenCoverage: 0.5 },
  ],
});

console.log(result.manifestPath);
console.log(result.dependencies);
console.log(result.cached);
```

返回结果：

| 字段 | 含义 |
| --- | --- |
| `manifest` | 已校验的 manifest 对象，层级 URL 相对生成 manifest 所在目录。 |
| `manifestPath` | 生成 JSON 的绝对路径。 |
| `files` | 需要部署的去重文件列表，含 `fileName`、`absolutePath`、`mimeType`、`byteLength` 和 `role`。`role` 是 `level` 或 `manifest`。 |
| `dependencies` | 源文件及所有本地外部 buffer/image 的绝对路径，供其他构建系统观察变化。 |
| `cached` | 本次是否复用了已校验的磁盘编译结果。 |

`compileAsset()` 仅编译和写入本地文件；它不会上传文件或自动注册 HTTP 路由。浏览器中的运行时也不会调用这个 Node API。

## 5. Manifest 契约

```ts
interface AssetManifest {
  format: 'stream3d';
  version: 1;
  id: string;
  name: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  animations: string[];
  levels: {
    id: string;
    url: string;
    byteLength: number;
    estimatedGpuBytes: number;
    triangles: number;
    minScreenCoverage: number;
  }[];
}
```

| 字段 | 生成规则 / 使用方式 |
| --- | --- |
| `id` | 不可变的编译内容身份，包含源数据、依赖数据、源文件名、编译选项及流水线版本信息。 |
| `name` | 源文件去掉扩展名后的名称。 |
| `bounds` | 默认场景；若未指定默认场景则使用第一个场景的静态边界。不是完整动画运动范围。 |
| `animations` | 编译后可通过名称播放的片段名称。 |
| `levels` | 从粗到细的完整表示。最粗层必须已经能独立显示。 |
| `byteLength` | 该 GLB 文件实际字节数。 |
| `estimatedGpuBytes` | 解码 accessor 字节加上 RGBA8 纹理完整 mip 链的估算；用于预算，不是真实显存测量。 |
| `triangles` | 该文档各 mesh primitive 的几何三角形数之和；不是含实例重复绘制、可见性和多 pass 的每帧三角形数。 |
| `minScreenCoverage` | 运行时考虑升级到该层的投影尺寸阈值。 |

`stream3d` 导出的 `validateManifest()` 可校验不可信 JSON，并返回脱离输入对象的 manifest；`defineAsset()` 也是校验入口。校验覆盖类型、有限边界、数量和层级顺序，不会证明对应 URL 的几何内容正确或其成本估算精确。

### URL 的解析规则

```ts
// 字符串表示 manifest JSON 的 URL，不是原始 GLB URL。
const model = scene.addModel('/models/chair/asset-<实际摘要>.stream3d.json');
```

通过字符串加载时，内部相对层级 URL 相对于该 manifest 的绝对 URL 解析。直接传入 manifest 对象时，层级相对 URL 使用 App 的 `baseUrl`，默认是 `document.baseURI`。所以不要把 Node API 返回的相对 URL 对象原样放到任意网页路径后，期待运行时知道它的磁盘位置；可以传部署后的 manifest URL，或配置正确的 `baseUrl`。

Vite 导出的对象已经把层级 URL 变成适用于当前部署的 URL，应用通常无需手动处理。

## 6. 构建、部署与缓存

生产构建通过 Vite 的资产输出机制写入 manifest 和 GLB，默认在构建的 `assets/stream3d/` 目录下；位置遵循 `build.assetsDir`。同名内容资产只输出一次。

| Vite `base` | 当前行为 |
| --- | --- |
| `/` 或 `/app/` | 使用对应站点路径。 |
| `https://cdn.example.com/app/` | 使用指定绝对 URL 前缀。 |
| `./` 或空字符串 | 相对于导入它的 JavaScript 模块计算资产 URL；要求 ES module 输出格式。 |

部署完整的构建输出即可，服务器不需要运行资产编译器。跨域 CDN 需要允许应用读取资产的 CORS 响应。原始 manifest 仍使用同目录相对 GLB URL，所以不要把 manifest 和它引用的文件分别移动到没有保持相对关系的位置。

内容哈希文件可设置长期 immutable 缓存；指向新 manifest 的应用入口或业务索引应按发布策略更新。Vite 开发服务器已设置对应缓存头；生产服务的响应头由部署平台配置。部署时先保证新 GLB 可访问，再发布引用它们的 manifest / 应用版本，保留旧版本仍在使用的哈希资产。

编译缓存会读取并哈希源文件及所有相对 buffer/image，因此只修改外部纹理也会触发新结果。相同输入、配置和固定的编码工具版本可复用同一个内容身份。源文件的 basename 改变也会改变资产名称及编译身份。

命中磁盘缓存时，编译器校验 manifest 结构，并检查每个 GLB 的文件名摘要、实际 SHA-256 和文件长度。文件缺失或损坏时会重新编译。写入采用临时文件与重命名，manifest 在所有层级完成后写入。输出目录不会自动删除旧版本资产；清理历史文件属于构建缓存或部署保留策略。

## 7. 保留规则、扩展与失败处理

编译器保留已有的节点及材质名称、节点关系和局部变换、动画通道结构及 skin 绑定，并在每个层级写出前检查这些结构。未命名节点会获得确定性的 `__stream3d_node_N` 名称，避免实例克隆后失去动画绑定。未命名动画获得 `animation_N` 名称，并避开已有名称；重复的已命名动画会报错，要求先为片段提供唯一名称。

结构检查不是视觉等价证明。简化、纹理缩小和有损颜色压缩会改变画面；特写、透明层、法线细节、morph 形变与关节附近的低模效果应使用实际资产检查。编译器也不会自动合并材质、生成碰撞体或补出缺失的动画数据。

当前接受的扩展如下；导出的 `SUPPORTED_INPUT_EXTENSIONS` 是程序化清单：

| 类别 | 扩展 |
| --- | --- |
| 几何编码 | `KHR_draco_mesh_compression`、`EXT_meshopt_compression`、`KHR_mesh_quantization` |
| 纹理与 UV | `EXT_texture_webp`、`KHR_texture_transform` |
| 灯光 | `KHR_lights_punctual` |
| 材质 | `KHR_materials_anisotropy`、`KHR_materials_clearcoat`、`KHR_materials_dispersion`、`KHR_materials_emissive_strength`、`KHR_materials_ior`、`KHR_materials_iridescence`、`KHR_materials_sheen`、`KHR_materials_specular`、`KHR_materials_transmission`、`KHR_materials_unlit`、`KHR_materials_volume` |

未知扩展及编译器虽能读取、但默认浏览器加载链未支持的扩展会显式拒绝。例如当前不接受 `KHR_materials_variants`、`KHR_node_visibility`、旧式 `KHR_materials_pbrSpecularGlossiness`、`EXT_mesh_gpu_instancing`、KTX2 或 AVIF 纹理扩展。对这些资产，应先在导出工具中转换成受支持的表示，而不是删除声明后继续保留扩展数据。

常见问题：

| 错误或现象 | 处理方式 |
| --- | --- |
| 外部纹理 / buffer 找不到 | 保持 glTF 引用的相对目录结构；检查文件名与大小写。 |
| 非三角形 draw mode | 在 DCC / 导出步骤中三角化。 |
| KTX2 / AVIF 输入被拒绝 | 导出 PNG、JPEG 或 WebP 源纹理；当前编译器需要可调整尺寸的这些输入格式。 |
| Duplicate animation name | 在源资产中为每个动画片段命名，确保唯一。 |
| 实际三角形比例高于 `ratio` | 简化受拓扑和误差限制，小 primitive 也会被保护；检查源几何及视觉质量。 |
| `full` 纹理不够清晰 | 调高最高层的 `textureSize`；默认是 1024。 |
| JSON 能加载，但 GLB 404 | 检查部署路径、Vite `base`、manifest 相对路径与 CDN 文件是否齐全。 |
| 取消后仍看到少量解码耗时 | 已执行的解析未必能硬中断，运行时会清理晚到结果，并保留执行槽直到它结束。 |

实现入口：[编译器](../packages/compiler/src/index.ts)、[CLI](../packages/compiler/src/cli.ts)、[Vite 插件](../packages/vite/src/index.ts)、[Manifest 类型与校验](../packages/core/src/manifest.ts)。
