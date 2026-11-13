# Checkin

> **维护仓库**：[badarch47/glados_checkin](https://github.com/badarch47/glados_checkin)
>
> 本人是当前**积极维护者**。官方签到协议或计分规则一旦有变动，修复代码会**第一时间更新到上述仓库**。建议点 **Watch** 关注本仓库、顺手给个 **Star**，避免错过更新。

GitHub Actions 实现 [GLaDOS][glados] 自动签到

([GLaDOS][glados] 可用邀请码: `BADSEVEN`, 双方都有奖励天数)

## 2026-11-07 更新

GLaDOS 官方调整了签到积分系统（新增 challenge/proof 校验），旧脚本仍能请求成功但只拿到 1 分。**本仓库已同步修复**，按官方完整协议签到，得分恢复正常。

同时新增**协议监测系统**（`guard.js` / `guard.yml`），每天自动检测官方前端的计分与签到协议是否变化（proof 盐、签到端点、协议字段、人机验证），发现不一致时 workflow 失败并邮件通知，避免官方再次调整后脚本静默失效。

### 积分构成

签到响应里服务端会直接下发逐项构成（`breakdown`），脚本直接读取并原样打印，不在本地换算：

最终积分 = **Base + 套餐 + 连续 + 光缆 + 幸运 + 站点 + 出口 IP**

| 项目 | 加成 | 达成条件 |
| --- | --- | --- |
| Base | +1 ~ +3 | 签到即得，服务端随机 |
| 套餐 Level | +1 / +1.5 / +2 | Pro / Team / Enterprise |
| 连续 Streak | +1 / +2 | 连续 >7 天 / >14 天（封顶 +2） |
| 光缆 Cable | +1 ~ +9 | 由 `/api/user/network-insight` 的 `tiers` 下发，见下表 |
| 幸运 / 站点 / 出口 IP | 视当日情况 | 服务端下发的附加项，无固定值 |

光缆档位（服务端下发，2026-11 实测）：

| 网络质量指数 IQI | 光缆加成 |
| --- | --- |
| < 90 | **+9** |
| 90 – 94 | +7 |
| 95 – 99 | +5 |
| 100 – 109 | +3 |
| 110 – 130 | +2 |
| > 130 | +1 |

光缆加成是「线路越差补偿越多」：指数越低（晚间拥塞）拿得越多；凌晨线路空闲时指数常在 130 以上，只能拿到 +1。官方前端的原话是 `Index 130 is the ideal. The worse the network, the bigger the bonus on your daily punch.`

> 注：早期版本在代码里写死了 `80 / 85 / 90 / 95` 一套阈值，与服务端实际档位不符（会把 +7 算成 +2）。现已改为直接读服务端字段。

### 关于执行时间

GitHub Actions 的 `schedule` **不保证准时**。官方明确说明高负载时会延迟，实测延迟可达数小时。因此 `run.yml` 里的 `cron` 只是计划时间，**实际签到时刻可能晚于设定时间**，这属于 GitHub 平台固有行为，不是脚本问题。只要每天能执行一次，就不会影响连续签到与积分。

本仓库 2026-11 用 20 次定时运行实测：**延迟中位数约 +4.6 小时**（范围 +2.5 ~ +8 小时）。旧 cron 设为北京 00:10 时，实际全部落在 02:42–08:09 —— 那是线路最空闲、指数最高、光缆加成只有 +1 的时段。

因此当前 cron 按「目标时刻 − 延迟中位数」倒推：

| 项 | 值 |
| --- | --- |
| `cron` | `50 8 * * *`（UTC 08:50 = 北京 16:50） |
| 预期实际执行 | 北京 21:30 前后（波动 ±2.5 小时） |
| 分钟为何取 `:50` | 指数快照每小时 `:42` 左右重算，取 :50 可确保用上当小时的值 |

> 若你想改时间：把 cron 设成「目标北京时刻 − 4.6 小时」再换算成 UTC，不要直接填目标时刻，否则实际执行会晚 4~5 小时。

## 使用说明

1. Fork 这个仓库

1. 登录 [GLaDOS][glados] 获取 Cookie

1. 添加 Cookie 到 Secret `GLADOS`

   - 新版站点最少只需两个必需字段：

     ```
     gld:sess=对应的值; gld:sess.sig=对应的值
     ```

   - 浏览器实际会下发 4~6 项，建议**整行复制、全部带上**：

     ```
     gld:sess=...; gld:sess.sig=...; koa:sess=...; koa:sess.sig=...; gld:accts=...; gld:accts.sig=...
     ```

   - 字段名有两种命名，代码均兼容：新版为 `gld:sess` / `koa:sess`（冒号），旧版为 `gld_sess` / `koa.sess`（下划线、点）

1. Cookie 获取方式，浏览器按 F12 存储里面就是，四个都要带上

   - 推荐：F12 → **Network** → 刷新页面 → 点任一站点请求 → Request Headers → 复制 `cookie:` 后面**整行**
   - 也可以：F12 → **Application**（应用）→ Storage → Cookies → 选中站点逐条复制
   - 不要手打字段名：`gld:sess` 写成 `gld_sess` 会导致鉴权失败

1. 添加同一浏览器的浏览器代理到 Secret `GLADOS_UA` (浏览器控制台执行 `navigator.userAgent` 获取)

    - GLaDOS 签到会校验当前浏览器是否与登录时一致, UA 不一致会返回 `没有权限`
    - 浏览器大版本更新后 UA 会变化, 如再次报错需重新登录并同时更新 `GLADOS` 与 `GLADOS_UA`

1. 启用 Actions, 每天北京时间 16:50 计划签到（受 GitHub 调度延迟影响，实际约在北京 21:30 前后执行，见上文「关于执行时间」）
1. 添加了workflow控制台显示每个账号当前积分的功能和当前积分通知推送(积分兑换时可能显示原天数，第二次签到就显示已经兑换的新天数)
1. 已实现自定义签到域名，在环境机密中加入 DOMAIN railgun.info
1. 添加了满500积分自动兑换天数，默认是500积分自动兑换，需要调整可以新增Action环境变量机密，参数为下

| 变量 | 默认值 | 说明 |
| ---- | ---- | ---- |
| AUTO_EXCHANGE | true | 自动兑换开关；**未配置时视为开启**，填 `false` 关闭自动兑换 |
| EXCHANGE_THRESHOLD | 500 | 兑换触发阈值，积分 ≥ 该值时自动兑换 100 天 |

> 说明：`AUTO_EXCHANGE` 的代码实现为“只要不等于 `false` 就开启”，因此不配置该 Secret 时自动兑换是**生效**的。如需关闭，请显式创建该 Secret 并填入 `false`。

## Cookie 字段说明

GLaDOS 的登录态由多个 Cookie 共同组成，各字段作用如下：

| 字段 | 是否必需 | 说明 |
| ---- | ---- | ---- |
| `gld:sess` | **必需** | 账号会话，服务端据此识别登录身份 |
| `gld:sess.sig` | **必需** | 会话签名，与 `gld:sess` 必须配对且匹配 |
| `koa:sess` | 可选 | 旧版会话字段，新版站点可能不再下发 |
| `koa:sess.sig` | 可选 | 旧版会话签名 |
| `gld:accts` | 可选 | 多账号列表，带上更完整 |
| `gld:accts.sig` | 可选 | `gld:accts` 的签名 |

实测结论（对 `/api/user/status` 逐组验证）：

| 传入字段 | 结果 |
| ---- | ---- |
| `gld:sess` + `gld:sess.sig` | `code:0` ✅ |
| 仅 `gld:sess`（无签名） | `code:-2` ❌ |
| `gld:sess` + 错误签名 | `code:-2` ❌ |
| 仅 `koa:sess` 系字段 | `code:-2` ❌ |
| 完整 6 字段 | `code:0` ✅ |

因此：**`gld:sess` 与 `gld:sess.sig` 缺一不可，其余字段可选**。字段顺序不影响鉴权。

## 多账号

1. 除 `GLADOS` 外，可继续新增 `GLADOS2`、`GLADOS3` … 直到 `GLADOS20`，每个 Secret 独立存放一个账号的 Cookie

   - 各变量**互不覆盖**：更新某个账号的 Cookie 时不会影响其他账号
   - 未配置的变量在 Actions 中为空字符串，脚本自动跳过，不影响已有账号

1. 单个变量内仍支持换行分隔多个 Cookie，与旧写法完全兼容

1. 同一 Cookie 出现在多个变量中时会自动跳过并打印告警，避免同一账号重复签到

1. 日志前缀会标注账号序号与来源变量，便于定位是哪个账号出问题：

   ```
   [账号 2|GLADOS2] 签到接口响应码: 0
   ```

1. UA 支持三种写法，按行与 Cookie 对应：

   | 变量名 | 适用范围 |
   | ---- | ---- |
   | `GLADOS_UA` | 通用，所有账号按行对应；只写一行则所有账号共用 |
   | `GLADOS_UA2` / `GLADOS_UA3` … | 指定第 N 个变量（`GLADOS2`、`GLADOS3`…）的 UA |
   | `GLADOS2_UA` / `GLADOS3_UA` … | 同上，另一种命名习惯，两种写法等价 |

   - 优先级：`GLADOS_UA{N}` → `GLADOS{N}_UA` → 回退 `GLADOS_UA` → 内置默认 UA
   - 日志会打印实际使用的来源，例如 `UA(GLADOS_UA2)` 或 `UA(内置默认UA)`

## 日志与自检

每次运行会在日志中打印每个账号的 Cookie 字段名清单（**只显示字段名，不显示值**），用于快速判断 Cookie 是否粘贴完整：

```
[账号 1|GLADOS] Cookie 字段(4): gld:accts、gld:accts.sig、gld:sess、gld:sess.sig
[账号 1|GLADOS] ℹ️ 未包含可选项: koa:sess、koa:sess.sig（不影响鉴权）
```

若缺少必需字段，会输出告警：

```
[账号 1|GLADOS] ⚠️ 缺少必需字段: gld:sess、gld:sess.sig——实测缺任意一项都会返回 code=-2，请重新完整复制 Cookie
```

运行结束时按账号统计成功与失败数量：

```
📊 统计结果：成功 2 个 | 失败 0 个
```

## 常见问题

1. **签到返回 `code=-2 没有权限`**

   `-2` 是「会话无效」的统一响应（不带任何 Cookie 请求也会返回它），不是账号本身没权限。按顺序排查：

   1. 看日志里的 `Cookie 字段(N)` 是否包含 `gld:sess` 与 `gld:sess.sig`
   2. 检查字段名有没有被改写成下划线形式（`gld_sess`）
   3. 确认该 Cookie 是否已失效：重新登录后获取即可

1. **退出登录后 Cookie 立刻失效**

   点击「退出登录」时服务端会主动销毁对应会话，已保存的 Cookie 从那一刻起作废，更换 UA 也无法恢复。要让多个账号同时可用，正确做法是：

   1. 普通窗口保持 1 号账号登录，**不要点退出**
   2. 开**无痕窗口**登录 2 号账号
   3. 两边分别复制 Cookie，填入 `GLADOS` 与 `GLADOS2`

1. **签到接口返回 `code=1`**

   表示今日已签到过，属正常情况，脚本会继续查询剩余天数与积分，并按成功计入统计。

1. **UA 与登录浏览器不一致**

   会返回 `没有权限`。浏览器大版本升级后 UA 变化，需重新登录并同时更新 `GLADOS` 与 `GLADOS_UA`。

## 高级功能

1. 如有多个帐号, 可以写为多行 Secret `GLADOS`, 每行写一个 Cookie; `GLADOS_UA` 可同样按行对应, 只写一行则所有帐号共用

1. 如需修改时间, 可以修改文件 [run.yml](.github/workflows/run.yml#L17) 中的 `cron` 参数, 格式可参考 [crontab]

    - `cron` 使用 **UTC**, 北京时间 = UTC + 8
    - GitHub 免费级 schedule 会**系统性延迟**：本仓库实测 20 次定时运行，延迟中位数约 **+4.6 小时**（范围 +2.5 ~ +8 小时）。想让签到落在某个小时，需按「目标时刻 − 延迟中位数」倒推 `cron`，否则实际执行时间会与预期相差数小时
    - 指数快照每小时 `:42` 左右重算，分钟建议取 `:50`，确保用上当小时的指数值
    - 为什么避开凌晨：凌晨链路空闲，指数偏高（常 >130），光缆加成仅 +1；晚间拥塞时指数低，可拿到 +5 ~ +9

1. 如需其他域名, 可配置 Secret `DOMAIN`, 可填写: `railgun.info`（未配置时默认 `glados.cloud`）

1. 如需推送通知, 可配置 Secret `NOTIFY`, 已支持:
    1. [WxPusher][wxpusher]: 格式 `wxpusher:{token}:{uid}`
    1. [PushPlus][pushplus]: 格式 `pushplus:{token}`
    1. [Bark][finbbark]: 格式 `bark:{key}`
    1. [企业微信][qyweixin]: 格式 `qyweixin:{key}`
    1. Console: 格式 `console:log`, 作为日志输出, 一般用于调试
    1. 如需配置多个, 可以写为多行, 每行写一个

1. 注意: Cookie 以及接口输出数据, 包含帐号敏感信息, 因此不要随意公开

## 变更记录

本仓库在原有单账号版本基础上的改动：

| 项目 | 改动内容 |
| ---- | ---- |
| 多账号支持 | 新增 `GLADOS2` … `GLADOS20` 独立变量，各账号 Cookie 互不覆盖；单变量内多行写法保持兼容 |
| 账号去重 | 同一 Cookie 重复出现时自动跳过并告警，避免重复签到 |
| 独立 UA | 新增 `GLADOS_UA{N}` / `GLADOS{N}_UA`，可按账号指定 UA，缺省回退 `GLADOS_UA` |
| Cookie 自检 | 启动时打印各账号 Cookie 字段名清单（不含值），缺失必需字段时告警 |
| 统计修正 | 原统计以通知文本匹配计数，标题行与接口返回的“签到成功”都会被计入，导致成功数翻倍；改为按账号累加计数 |
| 日志可读性 | 账号日志前缀改为 `[账号 N\|环境变量名]`，可一眼定位账号来源 |
| 引号容错 | 环境变量取值自动去除首尾引号，避免粘贴时带引号导致鉴权失败 |
| 积分构成 | 改用签到响应返回的 `breakdown` 展示逐项加成；光缆加成改读 `network-insight` 的 `cablePoints`，不再用本地写死的档位换算 |
| 签到时间 | `cron` 由北京 00:10 改为 16:50，按 Actions 延迟中位数倒推，实际落在北京 21:30 前后，避开凌晨高指数区间（高指数 = 低加成） |
| 协议修复 | 2026-11-07 同步官方 challenge/proof 签到协议，修复旧脚本请求成功但只得 1 分的问题 |
| 协议监测 | 新增 `guard.js` / `guard.yml`，每日检测官方计分规则与签到协议变化并告警 |

---

[glados]: https://github.com/glados-network/GLaDOS
[crontab]: https://crontab.guru/
[pushplus]: https://www.pushplus.plus/
[wxpusher]: https://wxpusher.zjiecode.com/
[finbbark]: https://github.com/Finb/Bark
[qyweixin]: https://developer.work.weixin.qq.com/document/path/91770
